// Tests for HumangentToolCallReview's webhook() handler.
//
// Covers:
//   * approve outcome → { approved: true, chatInput: <note> }
//   * deny outcome    → { approved: false, chatInput: <note> }
//   * is_dismiss=true → { approved: false, dismissed: true }
//   * unknown outcome → { approved: false, drift_detected: true }
//   * invalid HMAC    → 401, no workflowData (fail-closed)
//   * malformed body  → 400, no workflowData
//   * duplicate delivery → 200 deduped, no second workflowData
//
// HMAC contract is the same as the existing Humangent approval node:
// `t=<unix>,v1=<hex>` over `<ts>.<rawBody>`. We re-use the API key as
// the signing secret per the public-API contract.

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  mapDeliveryToHitlResponse,
  webhookToolCallReviewResume,
} from "./webhook";

const API_KEY = "hmk_live_0123456789abcdef01234567";

function signRaw(rawBody: string, ts: number): string {
  const sig = createHmac("sha256", API_KEY)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

function buildBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    delivery_id: "42",
    request_id: "00000000-0000-0000-0000-000000000010",
    outcome_id: "approve",
    is_dismiss: false,
    fields: {},
    fields_before: null,
    decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
    decided_at: "2026-05-08T12:34:56Z",
    duration_ms: 1234,
    is_test: false,
    decision_note: "",
    ...overrides,
  };
}

interface CtxOverrides {
  body?: Record<string, unknown>;
  signature?: string;
  rawBody?: string;
  staticData?: { seen?: string[] };
}

function makeWebhookCtx(overrides: CtxOverrides = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const body = overrides.body ?? buildBody();
  const raw = overrides.rawBody ?? JSON.stringify(body);
  const signature = overrides.signature ?? signRaw(raw, ts);
  const headerBag: Record<string, string> = {
    "x-humangent-signature": signature,
    "x-humangent-delivery-id": String(
      (body as { delivery_id?: unknown }).delivery_id ?? "",
    ),
  };
  const staticData = overrides.staticData ?? {};
  return {
    getCredentials: vi.fn().mockResolvedValue({ apiKey: API_KEY }),
    getHeaderData: vi.fn().mockReturnValue(headerBag),
    getBodyData: vi.fn().mockReturnValue(body),
    getRequestObject: vi.fn().mockReturnValue({ rawBody: raw }),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
  } as unknown as never;
}

describe("mapDeliveryToHitlResponse — outcome → approved mapping", () => {
  it("maps outcome_id=approve to {approved: true} and forwards the note via chatInput", () => {
    const json = mapDeliveryToHitlResponse(
      buildBody({ outcome_id: "approve", decision_note: "go ahead" }) as never,
    );
    expect(json).toMatchObject({
      approved: true,
      request_id: "00000000-0000-0000-0000-000000000010",
      delivery_id: "42",
      chatInput: "go ahead",
    });
  });

  it("maps outcome_id=deny to {approved: false} with the reviewer note as chatInput", () => {
    const json = mapDeliveryToHitlResponse(
      buildBody({
        outcome_id: "deny",
        decision_note: "Sending to that domain is blocked.",
      }) as never,
    );
    expect(json).toMatchObject({
      approved: false,
      chatInput: "Sending to that domain is blocked.",
    });
  });

  it("maps deny without a note to {approved: false} with a default chatInput", () => {
    const json = mapDeliveryToHitlResponse(
      buildBody({ outcome_id: "deny", decision_note: "" }) as never,
    );
    expect(json).toMatchObject({
      approved: false,
      chatInput: "Reviewer denied the tool call.",
    });
  });

  it("maps is_dismiss=true to {approved: false, dismissed: true}", () => {
    const json = mapDeliveryToHitlResponse(
      buildBody({
        outcome_id: "dismiss",
        is_dismiss: true,
        decision_note: "",
      }) as never,
    );
    expect(json).toMatchObject({ approved: false, dismissed: true });
  });

  it("maps an unknown outcome_id to {approved: false, drift_detected: true}", () => {
    const json = mapDeliveryToHitlResponse(
      buildBody({ outcome_id: "needs_revision" }) as never,
    );
    expect(json).toMatchObject({
      approved: false,
      drift_detected: true,
      unmatched_outcome_id: "needs_revision",
    });
  });
});

describe("webhookToolCallReviewResume — end-to-end webhook flow", () => {
  it("returns the agent-friendly approval payload on a valid signature + approve", async () => {
    const ctx = makeWebhookCtx();
    const result = await webhookToolCallReviewResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 200 });
    expect(result.workflowData).toHaveLength(1);
    const json = result.workflowData?.[0]?.[0]?.json as Record<string, unknown>;
    expect(json.approved).toBe(true);
  });

  it("fails closed (401) on invalid HMAC and emits no workflowData", async () => {
    const ctx = makeWebhookCtx({ signature: "t=1,v1=deadbeef" });
    const result = await webhookToolCallReviewResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 401 });
    expect(result.workflowData).toBeUndefined();
  });

  it("fails (400) on a malformed delivery body and emits no workflowData", async () => {
    // Strip a required field. The body+sig still match because we
    // pass a custom raw body string; only the schema parse should fail.
    const malformedBody = { not_a_decision: true };
    const raw = JSON.stringify(malformedBody);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signRaw(raw, ts);
    const ctx = makeWebhookCtx({
      body: malformedBody,
      rawBody: raw,
      signature: sig,
    });
    const result = await webhookToolCallReviewResume.call(ctx);
    expect(result.webhookResponse).toMatchObject({ status: 400 });
    expect(result.workflowData).toBeUndefined();
  });

  it("dedupes a duplicate delivery_id and emits no second workflowData", async () => {
    const staticData: { seen?: string[] } = {};
    const first = await webhookToolCallReviewResume.call(
      makeWebhookCtx({ staticData }),
    );
    expect(first.workflowData).toHaveLength(1);
    // Second hit with the same delivery_id (default "42") shares the
    // same staticData store. The dedupe shortcut must trigger.
    const second = await webhookToolCallReviewResume.call(
      makeWebhookCtx({ staticData }),
    );
    expect(second.webhookResponse).toMatchObject({ status: 200 });
    expect(second.workflowData).toBeUndefined();
    const body = JSON.parse(
      String(
        (second.webhookResponse as { body: string } | undefined)?.body ?? "{}",
      ),
    ) as { deduped?: boolean };
    expect(body.deduped).toBe(true);
  });
});
