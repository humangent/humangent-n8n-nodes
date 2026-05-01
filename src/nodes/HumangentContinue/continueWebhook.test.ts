// Tests for the Humangent Continue trigger node's webhook handler.
// Covers HMAC verification, replay protection (defense-in-depth on
// top of the backend's pgmq dedup), R27 audience-claim check, and
// the same outcome-routing semantics as the inline node.

import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { encodeTaskTypeValue } from "../Humangent/listSearch";
import { continueWebhookHandler } from "./continueWebhook";

// Same secret model as the inline node: API key plaintext doubles
// as the HMAC secret (one secret, two directions).
const API_KEY = "hmk_live_0123456789abcdef01234567";

function signRaw(rawBody: string, ts: number): string {
  const sig = createHmac("sha256", API_KEY)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

function buildBody(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery-100",
    request_id: "00000000-0000-0000-0000-000000000010",
    outcome_id: "approve",
    is_dismiss: false,
    fields: { customer: "Acme" },
    fields_before: { customer: "Acme Inc" },
    decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
    decided_at: "2026-04-29T12:34:56Z",
    duration_ms: 1234,
    is_test: false,
    decision_note: "",
    target_kind: "subscription",
    target_id: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

interface WebhookOverrides {
  body?: Record<string, unknown>;
  signature?: string;
  rawBody?: string;
  taskTypeId?: string;
  snapshotOutcomes?: Array<{ id: string; label: string }>;
  staticData?: Record<string, unknown>;
  headers?: Record<string, string>;
  omitRawBody?: boolean;
}

const TASK_TYPE_ID = "00000000-0000-0000-0000-000000000001";

function buildTaskTypeRL(
  taskTypeId: string,
  outcomes: Array<{ id: string; label: string }>,
) {
  return {
    __rl: true,
    mode: "list",
    value: encodeTaskTypeValue(taskTypeId, outcomes),
  };
}

function makeCtx(overrides: WebhookOverrides = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const body = overrides.body ?? buildBody();
  const raw = overrides.rawBody ?? JSON.stringify(body);
  const signature = overrides.signature ?? signRaw(raw, ts);
  const taskTypeId = overrides.taskTypeId ?? TASK_TYPE_ID;
  const snapshotOutcomes = overrides.snapshotOutcomes ?? [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ];
  const taskTypeRL = buildTaskTypeRL(taskTypeId, snapshotOutcomes);
  const staticData = overrides.staticData ?? {};

  const headerBag: Record<string, string> = {
    "x-humangent-signature": signature,
    ...overrides.headers,
  };

  return {
    getCredentials: vi.fn().mockResolvedValue({ apiKey: API_KEY }),
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
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // Probe the same `staticData` reference back out of the test for
    // assertions without touching the mock internals.
    __getStaticData: () => staticData,
  } as unknown as never;
}

describe("continueWebhookHandler — happy path", () => {
  it("routes to the matching outcome branch on a valid signature + correct audience", async () => {
    const ctx = makeCtx();
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    // Branches: approve(0), reject(1), Dismissed(2), Timed Out(3).
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
    expect(emitted.fields).toEqual({ customer: "Acme" });
  });

  it("routes is_dismiss=true to the Dismissed branch", async () => {
    const body = buildBody({
      outcome_id: "dismiss",
      is_dismiss: true,
      fields_before: null,
    });
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.workflowData?.[2]).toHaveLength(1);
  });

  it("routes outcome_id=timed_out to the Timed Out branch (last index)", async () => {
    const body = buildBody({ outcome_id: "timed_out" });
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.workflowData?.[3]).toHaveLength(1);
    const emitted = result.workflowData?.[3]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.outcome_id).toBe("timed_out");
  });

  it("routes drift (outcome not in snapshot) to Dismissed with drift_detected: true", async () => {
    const body = buildBody({ outcome_id: "escalate" });
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.workflowData?.[2]).toHaveLength(1);
    const emitted = result.workflowData?.[2]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.drift_detected).toBe(true);
    expect(emitted.unmatched_outcome_id).toBe("escalate");
  });

  it("emits the same shape as the inline node (parity with decisionItem)", async () => {
    const ctx = makeCtx();
    const result = await continueWebhookHandler.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted).toMatchObject({
      delivery_id: "delivery-100",
      request_id: "00000000-0000-0000-0000-000000000010",
      outcome_id: "approve",
      is_dismiss: false,
      fields: { customer: "Acme" },
      fields_before: { customer: "Acme Inc" },
      decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
      duration_ms: 1234,
      is_test: false,
      decisionNote: "",
    });
  });

  it("omits fields_before when null on the wire", async () => {
    const body = buildBody({ fields_before: null });
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    const emitted = result.workflowData?.[0]?.[0]?.json as Record<
      string,
      unknown
    >;
    expect(emitted.fields_before).toBeUndefined();
  });
});

describe("continueWebhookHandler — verification failures", () => {
  it("returns 401 on invalid HMAC", async () => {
    const ctx = makeCtx({ signature: "t=1,v1=deadbeef" });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("returns 401 on stale timestamp (outside ±5min skew)", async () => {
    const tooOld = Math.floor(Date.now() / 1000) - 10 * 60;
    const body = buildBody();
    const raw = JSON.stringify(body);
    const ctx = makeCtx({
      signature: signRaw(raw, tooOld),
      body,
      rawBody: raw,
    });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
  });

  it("returns 400 on a malformed body that fails schema parse", async () => {
    const body = { delivery_id: "x" } as unknown as Record<string, unknown>;
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const ctx = makeCtx({ body, rawBody: raw, signature: signRaw(raw, ts) });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 400 });
  });
});

describe("continueWebhookHandler — R27 audience claim", () => {
  it("returns 401 when target_kind is missing", async () => {
    const body = buildBody({ target_kind: undefined });
    delete (body as Record<string, unknown>).target_kind;
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("returns 401 when target_kind is 'inline' (cross-audience replay)", async () => {
    const body = buildBody({ target_kind: "inline" });
    const ctx = makeCtx({ body });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("accepts target_kind: 'subscription'", async () => {
    const ctx = makeCtx({ body: buildBody({ target_kind: "subscription" }) });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
  });
});

describe("continueWebhookHandler — replay protection", () => {
  it("dedups a repeat delivery_id with 200 + deduped: true and no workflow firing", async () => {
    const staticData: Record<string, unknown> = {};
    const ctx1 = makeCtx({ staticData });
    const first = await continueWebhookHandler.call(ctx1);
    expect(first.webhookResponse).toMatchObject({ status: 200 });
    expect(first.workflowData).toBeDefined();

    // Second delivery with the same delivery_id — same staticData so
    // n8n's persistence is simulated.
    const ctx2 = makeCtx({ staticData });
    const second = await continueWebhookHandler.call(ctx2);
    expect(second.webhookResponse).toMatchObject({ status: 200 });
    const respBody = JSON.parse(
      (second.webhookResponse as unknown as { body: string }).body,
    );
    expect(respBody).toMatchObject({ ok: true, deduped: true });
    expect(second.workflowData).toBeUndefined();
  });

  it("evicts entries older than the 24h TTL on next push", async () => {
    const stale = {
      humangentContinueSeenDeliveries: [
        { id: "ancient-1", ts: Date.now() - 25 * 60 * 60 * 1000 },
        { id: "ancient-2", ts: Date.now() - 25 * 60 * 60 * 1000 },
      ],
    };
    const ctx = makeCtx({ staticData: stale });
    await continueWebhookHandler.call(ctx);
    const after = (
      ctx as unknown as { __getStaticData: () => Record<string, unknown> }
    ).__getStaticData().humangentContinueSeenDeliveries as Array<{
      id: string;
    }>;
    // Ancient entries gone, current delivery_id added.
    expect(after.find((e) => e.id === "ancient-1")).toBeUndefined();
    expect(after.find((e) => e.id === "ancient-2")).toBeUndefined();
    expect(after.find((e) => e.id === "delivery-100")).toBeDefined();
  });

  it("trims to 100 entries when the count cap is hit", async () => {
    const fresh = Array.from({ length: 105 }, (_, i) => ({
      id: `id-${i}`,
      ts: Date.now() - 1000,
    }));
    const staticData: Record<string, unknown> = {
      humangentContinueSeenDeliveries: fresh,
    };
    const ctx = makeCtx({ staticData });
    await continueWebhookHandler.call(ctx);
    const after = staticData.humangentContinueSeenDeliveries as Array<{
      id: string;
    }>;
    expect(after.length).toBeLessThanOrEqual(100);
    // Most recent entries preserved (id-104 must survive). Oldest
    // entries (id-0 ... id-4) should be evicted to fit under the cap
    // after we push the new delivery.
    expect(after.find((e) => e.id === "id-104")).toBeDefined();
    expect(after.find((e) => e.id === "id-0")).toBeUndefined();
    expect(after.find((e) => e.id === "delivery-100")).toBeDefined();
  });

  it("treats a replay of the oldest retained id as deduped even at the count cap (regression)", async () => {
    // Earlier shape trimmed BEFORE the dedup check, so a replay of the
    // oldest retained id would slip through whenever the cache sat at
    // the cap. Lock the order: TTL-filter → dedup-check → trim → push.
    // Cap is 100, so 100 fresh entries means none have been trimmed
    // yet. Replay the oldest (`id-0`) and verify the handler dedups it
    // rather than firing the workflow.
    const fresh = Array.from({ length: 100 }, (_, i) => ({
      id: `id-${i}`,
      ts: Date.now() - 1000,
    }));
    const staticData: Record<string, unknown> = {
      humangentContinueSeenDeliveries: fresh,
    };
    const ctx = makeCtx({
      staticData,
      body: buildBody({ delivery_id: "id-0" }),
    });
    const result = await continueWebhookHandler.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    const respBody = JSON.parse(
      (result.webhookResponse as unknown as { body: string }).body,
    );
    expect(respBody).toMatchObject({ ok: true, deduped: true });
    expect(result.workflowData).toBeUndefined();
  });

  it("populates static data on first delivery (empty seenDeliveries baseline)", async () => {
    const staticData: Record<string, unknown> = {};
    const ctx = makeCtx({ staticData });
    await continueWebhookHandler.call(ctx);
    const after = staticData.humangentContinueSeenDeliveries as Array<{
      id: string;
    }>;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("delivery-100");
  });
});
