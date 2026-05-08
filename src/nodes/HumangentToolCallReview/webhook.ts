// Humangent Tool Call Review — webhook() resume handler.
//
// Invoked by n8n when the deliver-decision Edge Function POSTs a
// signed decision to one of the per-outcome resume URLs the
// execute() handler registered. Returns the `{approved, chatInput?}`
// shape n8n's processHitlResponses
// (packages/@n8n/nodes-langchain/utils/agent-execution/processHitlResponses.ts)
// reads off `actionResponse.data.data.ai_tool[0][0].json`.
//
// Outcome → approved-mapping:
//   - outcome_id === "approve" && !is_dismiss   → { approved: true }
//   - outcome_id === "deny"                     → { approved: false, chatInput: <note> }
//   - is_dismiss === true                       → { approved: false, dismissed: true, chatInput }
//   - any other outcome (system contract drift) → { approved: false, drift_detected: true }
//
// Fail-closed posture: invalid HMAC, malformed body, or anything
// that prevents us from confirming the reviewer's decision returns
// 401/400 with NO workflowData. n8n keeps the execution waiting and
// the deliver-decision pgmq retry kicks in.
//
// Idempotency on duplicate delivery: the deliver-decision producer
// sends a stable X-Humangent-Delivery-Id header (also echoed in the
// signed body's delivery_id field). When n8n's first webhook hit
// resumes the execution, putExecutionToWait is no longer pending —
// the second hit will fail to resume the execution at all, so n8n's
// own dispatch is the idempotency boundary. We additionally guard
// against the rare race by short-circuiting on a previously-seen
// delivery_id stored in workflow static data; this keeps the
// behavior obvious to reviewers debugging duplicate-delivery logs.
//
// Plan: humangent app —
// docs/plans/2026-05-07-002-feat-humangent-tool-call-review-plan.md U5.

import type {
  IDataObject,
  INodeExecutionData,
  IWebhookFunctions,
  IWebhookResponseData,
} from "n8n-workflow";

import { verifySignature } from "../../lib/hmac";
import {
  DecisionDeliverySchema,
  type DecisionDelivery,
} from "../../lib/schemas";
import type { HumangentCredentials } from "../../lib/api";

const SIGNATURE_HEADER_LOWER = "x-humangent-signature";
const DELIVERY_ID_HEADER_LOWER = "x-humangent-delivery-id";

/**
 * Read the raw UTF-8 body bytes n8n received. The HMAC signature
 * covers exactly these bytes; a JSON.parse → JSON.stringify round
 * trip works for the flat decision payloads but only if V8's
 * insertion order is preserved (it is) AND no Unicode escapes are
 * present. Prefer the rawBody path; fall back to re-stringify.
 */
function readRawBody(ctx: IWebhookFunctions): string {
  const parsed = ctx.getBodyData();
  const req = ctx.getRequestObject() as {
    rawBody?: string | Buffer;
  } | null;
  const raw = req?.rawBody;
  if (typeof raw === "string") return raw;
  if (raw && typeof (raw as Buffer).toString === "function") {
    return (raw as Buffer).toString("utf8");
  }
  return JSON.stringify(parsed);
}

function denyWith(
  status: number,
  body: Record<string, unknown>,
): IWebhookResponseData {
  return {
    webhookResponse: {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Map a verified DecisionDelivery into the JSON shape n8n's HITL
 * agent processor expects. The processor reads `approved` (boolean)
 * and `chatInput` (optional string) off `ai_tool[0][0].json`.
 */
export function mapDeliveryToHitlResponse(
  delivery: DecisionDelivery,
): IDataObject {
  const note = delivery.decision_note ?? "";
  if (delivery.is_dismiss) {
    return {
      approved: false,
      dismissed: true,
      request_id: delivery.request_id,
      delivery_id: delivery.delivery_id,
      chatInput:
        note.length > 0
          ? note
          : "The reviewer dismissed the request without a decision.",
    };
  }
  if (delivery.outcome_id === "approve") {
    return {
      approved: true,
      request_id: delivery.request_id,
      delivery_id: delivery.delivery_id,
      // Reviewer guidance even on approve flows back to the agent so
      // it can take the note into account when running the gated
      // tool. Empty string when the reviewer didn't add a note.
      chatInput: note,
    };
  }
  if (delivery.outcome_id === "deny") {
    return {
      approved: false,
      request_id: delivery.request_id,
      delivery_id: delivery.delivery_id,
      chatInput: note.length > 0 ? note : "Reviewer denied the tool call.",
    };
  }
  // Drift: the system task type's outcomes are pinned by the backend
  // lockdown trigger, so reaching this branch implies a backend
  // contract change that out-shipped the node. Treat as denied so
  // the gated tool does not execute.
  return {
    approved: false,
    drift_detected: true,
    unmatched_outcome_id: delivery.outcome_id,
    request_id: delivery.request_id,
    delivery_id: delivery.delivery_id,
    chatInput: `Reviewer chose an unexpected outcome (${delivery.outcome_id}); the tool call was not executed.`,
  };
}

interface DuplicateDeliveryStore {
  seen?: string[];
}

const SEEN_DELIVERY_LIMIT = 32;

/**
 * Track delivery_ids the node has already resumed on. n8n's own
 * dispatch is the primary idempotency boundary (a resumed execution
 * cannot be resumed again), but a duplicate POST that arrives WHILE
 * the first is still being processed could otherwise produce two
 * resume attempts. We bound the stored set so a long-running
 * workflow does not accumulate deliveries forever.
 */
function isDuplicateDelivery(
  ctx: IWebhookFunctions,
  deliveryId: string,
): boolean {
  const staticData = ctx.getWorkflowStaticData("node") as DuplicateDeliveryStore;
  const seen = Array.isArray(staticData.seen) ? staticData.seen : [];
  if (seen.includes(deliveryId)) return true;
  seen.push(deliveryId);
  // FIFO trim — keep recent ids, drop the oldest beyond the cap.
  while (seen.length > SEEN_DELIVERY_LIMIT) seen.shift();
  staticData.seen = seen;
  return false;
}

export async function webhookToolCallReviewResume(
  this: IWebhookFunctions,
): Promise<IWebhookResponseData> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const headers = this.getHeaderData() as Record<string, string | undefined>;

  const signatureHeader = headers[SIGNATURE_HEADER_LOWER];
  // Header values are NOT part of the HMAC envelope. Read the
  // delivery_id header for the dedupe shortcut only — the signed
  // body's `delivery_id` is the trust boundary.
  void headers[DELIVERY_ID_HEADER_LOWER];

  const rawBody = readRawBody(this);

  const verifyResult = verifySignature({
    header: signatureHeader,
    body: rawBody,
    secret: creds.apiKey,
    now: Math.floor(Date.now() / 1000),
  });
  if (!verifyResult.valid) {
    return denyWith(401, {
      error: "invalid_signature",
      reason: verifyResult.reason,
    });
  }

  const parsedBody = this.getBodyData();
  const parsed = DecisionDeliverySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return denyWith(400, {
      error: "malformed_decision_payload",
      detail: parsed.error.message,
    });
  }
  const delivery = parsed.data;

  if (isDuplicateDelivery(this, delivery.delivery_id)) {
    // n8n's first hit already resumed the execution. Acknowledge so
    // the deliver-decision producer does not mark this as a retry,
    // but emit no workflowData — the original resume already handed
    // the agent its `{approved, chatInput}` payload.
    return {
      webhookResponse: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, deduped: true }),
      },
    };
  }

  const json = mapDeliveryToHitlResponse(delivery);
  const item: INodeExecutionData = { json };

  return {
    webhookResponse: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
    workflowData: [[item]],
  };
}
