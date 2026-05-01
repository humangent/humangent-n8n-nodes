import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { encodeTaskTypeValue } from "./listSearch";
import { webhookResume } from "./webhook";

// The API key doubles as the HMAC secret for decision-delivery
// verification — one secret, two directions. Humangent's backend
// signs with the same value the node authenticates with.
const API_KEY = "hmk_live_0123456789abcdef01234567";

function signRaw(rawBody: string, ts: number): string {
  const sig = createHmac("sha256", API_KEY)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

/**
 * Build a valid delivery body object. The outbox function produces
 * the JSON with keys in the order declared in the object literal;
 * this helper mirrors that order so a JSON.stringify round-trip on
 * the verifier side matches the signed bytes.
 */
function buildBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    delivery_id: "42",
    request_id: "00000000-0000-0000-0000-000000000010",
    outcome_id: "approve",
    is_dismiss: false,
    fields: { customer: "Acme" },
    fields_before: { customer: "Acme Inc" },
    decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
    decided_at: "2026-04-23T12:34:56Z",
    duration_ms: 1234,
    is_test: false,
    ...overrides,
  };
}

type WebhookOverrides = {
  body?: Record<string, unknown>;
  /** Full signature header value to use, overriding the auto-signed one. */
  signature?: string;
  /** Explicit raw body bytes (overrides stringify of `body`). */
  rawBody?: string;
  /**
   * Outcomes encoded into the snapshot fragment of the RL `value`.
   * Drives webhook routing — the webhook decodes this exact list
   * and matches `outcome_id` against it via `findIndex`.
   */
  snapshotOutcomes?: Array<{ id: string; label: string }>;
  /**
   * Pass `null` to make the RL value just the bare task-type id —
   * simulates an old workflow saved before alpha.14, where the
   * webhook falls back to Dismissed-with-drift_detected.
   */
  snapshotOverride?: null;
  taskTypeId?: string;
  /** Headers to mix into the default set. */
  headers?: Record<string, string>;
  /** When true, don't populate req.rawBody so the verifier falls back to JSON.stringify(body). */
  omitRawBody?: boolean;
};

function buildTaskTypeRL(
  taskTypeId: string,
  outcomes: Array<{ id: string; label: string }>,
  snapshotOverride: null | undefined,
) {
  const rl: {
    __rl: true;
    mode: "list";
    value: string;
    cachedResultName: string;
  } = {
    __rl: true,
    mode: "list",
    value:
      snapshotOverride === null
        ? taskTypeId // bare id — pre-alpha.14 shape
        : encodeTaskTypeValue(taskTypeId, outcomes),
    cachedResultName: "Default approval",
  };
  return rl;
}

function makeWebhookCtx(overrides: WebhookOverrides = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const body = overrides.body ?? buildBody();
  const raw = overrides.rawBody ?? JSON.stringify(body);
  const signature = overrides.signature ?? signRaw(raw, ts);
  const snapshotOutcomes = overrides.snapshotOutcomes ?? [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ];
  const taskTypeId =
    overrides.taskTypeId ?? "00000000-0000-0000-0000-000000000001";
  const taskTypeRL = buildTaskTypeRL(
    taskTypeId,
    snapshotOutcomes,
    overrides.snapshotOverride,
  );

  const headerBag: Record<string, string> = {
    "x-humangent-signature": signature,
    "x-humangent-delivery-id": String(
      (body as { delivery_id?: unknown }).delivery_id ?? "",
    ),
    ...overrides.headers,
  };

  return {
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: API_KEY,
    }),
    getHeaderData: vi.fn().mockReturnValue(headerBag),
    getBodyData: vi.fn().mockReturnValue(body),
    getRequestObject: vi
      .fn()
      .mockReturnValue(overrides.omitRawBody ? {} : { rawBody: raw }),
    getNodeParameter: vi
      .fn()
      .mockImplementation((name: string, fallback?: unknown) => {
        if (name === "taskType") return taskTypeRL;
        return fallback;
      }),
  } as unknown as never;
}

describe("webhookResume — valid signature, branch routing", () => {
  it("routes to the matching outcome branch on a valid signature", async () => {
    const ctx = makeWebhookCtx();
    const result = await webhookResume.call(ctx);

    expect(result.webhookResponse).toMatchObject({ status: 200 });
    // Branch layout for outcomes=[approve,reject]: approve(0), reject(1), Dismissed(2), Timed Out(3).
    expect(result.workflowData).toHaveLength(4);
    expect(result.workflowData?.[0]).toHaveLength(1);
    expect(result.workflowData?.[1]).toHaveLength(0);
    expect(result.workflowData?.[2]).toHaveLength(0);
    expect(result.workflowData?.[3]).toHaveLength(0);

    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.outcome_id).toBe("approve");
    expect(emitted.delivery_id).toBe("42");
    expect(emitted.fields).toEqual({ customer: "Acme" });
    expect(emitted.fields_before).toEqual({ customer: "Acme Inc" });
    expect(emitted.is_test).toBe(false);
  });

  it("routes to the Dismissed branch when is_dismiss=true", async () => {
    const body = buildBody({
      outcome_id: "dismiss",
      is_dismiss: true,
      fields_before: null,
    });
    const ctx = makeWebhookCtx({ body });
    const result = await webhookResume.call(ctx);
    expect(result.workflowData?.[0]).toHaveLength(0);
    expect(result.workflowData?.[1]).toHaveLength(0);
    expect(result.workflowData?.[2]).toHaveLength(1);
    expect(result.workflowData?.[3]).toHaveLength(0);

    const emitted = result.workflowData?.[2]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.is_dismiss).toBe(true);
    expect(emitted.fields_before).toBeUndefined();
  });

  it("falls back to Dismissed with drift_detected when outcome_id is not in the snapshot (mid-wait drift)", async () => {
    // Decision arrives carrying outcome_id=needs_changes, but the
    // snapshot only knows [approve, reject] — task-type author added
    // needs_changes after the workflow saved its snapshot. Per origin
    // AE4, the workflow does NOT silently drop the decision: it
    // routes to Dismissed with drift_detected:true so downstream
    // nodes can switch on the flag.
    const body = buildBody({ outcome_id: "needs_changes" });
    const ctx = makeWebhookCtx({
      body,
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    const result = await webhookResume.call(ctx);
    expect(result.workflowData?.[0]).toHaveLength(0); // approve
    expect(result.workflowData?.[1]).toHaveLength(0); // reject
    expect(result.workflowData?.[2]).toHaveLength(1); // Dismissed
    expect(result.workflowData?.[3]).toHaveLength(0); // Timed Out

    const emitted = result.workflowData?.[2]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.drift_detected).toBe(true);
    expect(emitted.unmatched_outcome_id).toBe("needs_changes");
    expect(emitted.outcome_id).toBe("needs_changes"); // signed body's outcome_id, preserved
  });

  it("falls back to Dismissed with drift_detected when the RL value has no `#o=` fragment (old workflow, no snapshot)", async () => {
    // Old workflow saved before alpha.14. Snapshot decoder returns
    // [], so any outcome_id (including ones registered live) routes
    // to Dismissed with drift_detected:true rather than disappearing.
    const ctx = makeWebhookCtx({ snapshotOverride: null });
    const result = await webhookResume.call(ctx);
    // Snapshot empty → 0 + 2 = 2 branches: Dismissed(0), Timed Out(1).
    expect(result.workflowData).toHaveLength(2);
    expect(result.workflowData?.[0]).toHaveLength(1); // Dismissed
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.drift_detected).toBe(true);
    expect(emitted.unmatched_outcome_id).toBe("approve");
  });

  it("omits decided_by_profile_id on synthetic-decision deliveries (null in body)", async () => {
    const body = buildBody({
      decided_by_profile_id: null,
      fields_before: null,
    });
    const ctx = makeWebhookCtx({ body });
    const result = await webhookResume.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.decided_by_profile_id).toBeUndefined();
    expect(emitted.fields_before).toBeUndefined();
  });

  it("uses the signed body's delivery_id, not the unsigned header", async () => {
    // The x-humangent-delivery-id header is outside the HMAC envelope,
    // so trusting it over the signed body would let a compromised
    // transport rewrite the delivery identity downstream.
    const body = buildBody({ delivery_id: "42" });
    const ctx = makeWebhookCtx({
      body,
      headers: { "x-humangent-delivery-id": "99-forged" },
    });
    const result = await webhookResume.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.delivery_id).toBe("42");
  });

  it("propagates is_test through to the emitted payload", async () => {
    const body = buildBody({ is_test: true });
    const ctx = makeWebhookCtx({ body });
    const result = await webhookResume.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.is_test).toBe(true);
  });

  it("falls back to JSON.stringify(parsed) when req.rawBody is missing", async () => {
    // Simulates an n8n deployment that doesn't stash raw body. The
    // JSON.parse → JSON.stringify round-trip preserves key order for
    // our flat body, so the signature still verifies.
    const ctx = makeWebhookCtx({ omitRawBody: true });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    expect(result.workflowData?.[0]).toHaveLength(1);
  });
});

describe("webhookResume — signature failures", () => {
  it("returns 401 when the signature header is missing", async () => {
    const ctx = makeWebhookCtx({ headers: { "x-humangent-signature": "" } });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("returns 401 when the HMAC signature is wrong", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const ctx = makeWebhookCtx({
      signature: `t=${ts},v1=deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567`,
    });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("returns 401 when the signed body differs from the posted body", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const otherRaw = JSON.stringify(buildBody({ outcome_id: "reject" }));
    const ctx = makeWebhookCtx({
      body: buildBody(), // what we POST
      signature: signRaw(otherRaw, ts), // but signed a different body
    });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
  });

  it("returns 401 when the timestamp is outside the ±5min window", async () => {
    const stale = Math.floor(Date.now() / 1000) - 600; // 10min old
    const raw = JSON.stringify(buildBody());
    const ctx = makeWebhookCtx({ signature: signRaw(raw, stale) });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
  });
});

describe("webhookResume — body shape failures", () => {
  it("returns 400 on a malformed body (missing required key)", async () => {
    const bad = buildBody();
    delete (bad as Record<string, unknown>).outcome_id;
    const ctx = makeWebhookCtx({ body: bad });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 400 });
    expect(result.workflowData).toBeUndefined();
  });
});

describe("webhookResume — decisionNote on resume payload (alpha-14)", () => {
  it("emits decisionNote with the reviewer's guidance on the named branch when populated", async () => {
    // Re-sign a body that includes a non-empty decision_note so the
    // HMAC envelope stays valid.
    const ts = Math.floor(Date.now() / 1000);
    const body = buildBody({
      decision_note: "Make the headline shorter.",
    });
    const raw = JSON.stringify(body);
    const ctx = makeWebhookCtx({
      body,
      rawBody: raw,
      signature: signRaw(raw, ts),
    });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.decisionNote).toBe("Make the headline shorter.");
  });

  it("emits decisionNote='' on the named branch when the reviewer didn't add guidance", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = buildBody({ decision_note: "" });
    const raw = JSON.stringify(body);
    const ctx = makeWebhookCtx({
      body,
      rawBody: raw,
      signature: signRaw(raw, ts),
    });
    const result = await webhookResume.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.decisionNote).toBe("");
  });

  it("fills decisionNote='' when the Edge Function payload omits decision_note (alpha-13 forward-compat)", async () => {
    // Simulates a delivery from an alpha-13 deploy of deliver-decision
    // that doesn't yet emit decision_note. The schema's
    // z.string().default("") fills in "" after parse, so the node still
    // emits a stable shape downstream.
    const ts = Math.floor(Date.now() / 1000);
    const body = buildBody();
    delete (body as Record<string, unknown>).decision_note;
    const raw = JSON.stringify(body);
    const ctx = makeWebhookCtx({
      body,
      rawBody: raw,
      signature: signRaw(raw, ts),
    });
    const result = await webhookResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.decisionNote).toBe("");
  });

  it("emits decisionNote on the Dismissed branch too (drift fallback)", async () => {
    // Mid-wait drift: outcome_id not in the snapshot routes to
    // Dismissed with drift_detected=true. decisionNote must still
    // come through so downstream nodes can read the same key on every
    // branch without conditional access.
    const ts = Math.floor(Date.now() / 1000);
    const body = buildBody({
      outcome_id: "needs_changes",
      decision_note: "Try again with more detail.",
    });
    const raw = JSON.stringify(body);
    const ctx = makeWebhookCtx({
      body,
      rawBody: raw,
      signature: signRaw(raw, ts),
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    const result = await webhookResume.call(ctx);
    const emitted = result.workflowData?.[2]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.drift_detected).toBe(true);
    expect(emitted.decisionNote).toBe("Try again with more detail.");
  });
});
