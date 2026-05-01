// Humangent node — webhook() resume handler.
//
// Invoked by n8n when the Humangent `deliver-decision` Edge Function
// (apps/api/supabase/functions/deliver-decision/index.ts) POSTs a
// signed decision to one of the per-outcome resume URLs this node
// registered via getSignedResumeUrl.
//
// Signing contract (Stripe-shape, pinned by the shipped
// apps/api/supabase/functions/_shared/signing.ts):
//   header name: x-humangent-signature
//   header value: `t=<unix_ts>,v1=<hex>`
//   signed input: `${timestamp}.${raw_body_bytes}`
//   algorithm:   HMAC-SHA256 over UTF-8 bytes
//
// The deliver-decision function signs the BYTES of the body it
// POSTs — `JSON.stringify({delivery_id, request_id, ...})` in
// insertion order. We verify against the raw bytes when n8n exposes
// them via `getRequestObject().rawBody`; when unavailable, we
// re-stringify the parsed body. V8 preserves JSON-parse key order,
// so a JSON.stringify round-trip reproduces the signed bytes for
// flat-ish payloads — the narrow fallback we need.
//
// Flow:
//   1. Verify the X-Humangent-Signature header.
//   2. Parse the body against DecisionDeliverySchema.
//   3. Decode the snapshot from the resourceLocator's `value` field
//      (alpha.14+ encodes the snapshot inline as
//      `<task-type-id>#o=<encoded>` on the value string).
//   4. Route onto the matching output branch:
//        - is_dismiss=true       → Dismissed (snapshot.length-th branch)
//        - outcome_id in snapshot → that branch (snapshot.findIndex)
//        - outcome_id NOT in snapshot (mid-wait drift; outcome added
//          live AFTER the workflow saved its snapshot) → Dismissed
//          with `drift_detected: true` + `unmatched_outcome_id` in
//          the payload JSON. Per origin AE4, the workflow does NOT
//          silently drop the decision.
//      Timed Out lane fires from n8n's own waitTill expiry, not
//      from a webhook hit — see execute.ts's synthetic emit.
//   5. Return `{webhookResponse, workflowData}`. On verification
//      failure return 401 + no workflowData; n8n keeps the execution
//      waiting and the outbox worker retries (pgmq visibility timer).

import type {
  IDataObject,
  INodeExecutionData,
  IWebhookFunctions,
  IWebhookResponseData,
} from "n8n-workflow";

import type { HumangentCredentials } from "../../lib/api";
import { verifySignature } from "../../lib/hmac";
import {
  DecisionDeliverySchema,
  type DecisionDelivery,
} from "../../lib/schemas";
import { buildEmptyBranches, decodeSnapshot } from "./errors";

const SIGNATURE_HEADER_LOWER = "x-humangent-signature";
const DELIVERY_ID_HEADER_LOWER = "x-humangent-delivery-id";
const TEST_MODE_HEADER_LOWER = "x-humangent-test-mode";

/**
 * Extract the raw UTF-8 body bytes n8n received. When n8n's request
 * object carries the raw buffer / string (most production setups do
 * via body-parser's `verify` callback), use it directly — that's
 * the exact byte string deliver-decision signed. Otherwise re-encode
 * the parsed body via JSON.stringify.
 *
 * The fallback is best-effort: for the narrow payload
 * deliver-decision emits (flat object, string keys, no Unicode
 * escapes), JSON.stringify after JSON.parse reproduces the bytes
 * exactly — V8 preserves insertion order on round-trip. If n8n ever
 * augments the parsed body with synthetic keys, verification will
 * fail loudly (401) rather than silently accept a tampered payload.
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

export function decisionItem(
  delivery: DecisionDelivery,
  drift?: { unmatched_outcome_id: string },
): INodeExecutionData {
  const json: IDataObject = {
    // Always use the body's delivery_id — the signed bytes are the
    // trust boundary. The X-Humangent-Delivery-Id header carries the
    // same value but is OUTSIDE the HMAC, so a man-in-the-middle
    // with access to the resume URL could rewrite it. Prefer the
    // signed field.
    delivery_id: delivery.delivery_id,
    request_id: delivery.request_id,
    outcome_id: delivery.outcome_id,
    is_dismiss: delivery.is_dismiss,
    fields: delivery.fields as IDataObject,
    decided_at: delivery.decided_at,
    duration_ms: delivery.duration_ms,
    is_test: delivery.is_test,
    // `decisionNote` is always emitted (per R22) — empty string when
    // the reviewer didn't add guidance, populated when they did. The
    // schema's `default("")` upstream means `delivery.decision_note`
    // is guaranteed to be a string by the time it reaches here, even
    // when an alpha-13 Edge Function deploy omitted the key entirely.
    decisionNote: delivery.decision_note,
  };
  if (delivery.fields_before !== null) {
    json.fields_before = delivery.fields_before as IDataObject;
  }
  if (delivery.decided_by_profile_id !== null) {
    json.decided_by_profile_id = delivery.decided_by_profile_id;
  }
  if (drift) {
    // Mid-wait drift signal: the live decision carries an outcome_id
    // the saved snapshot doesn't know about (e.g., the task-type
    // author added a new outcome between save and decide). Workflow
    // authors can switch on `drift_detected` downstream of Dismissed
    // to escalate, log, or re-route. Per origin AE4, the workflow
    // does not silently drop the decision.
    json.drift_detected = true;
    json.unmatched_outcome_id = drift.unmatched_outcome_id;
  }
  return { json };
}

export async function webhookResume(
  this: IWebhookFunctions,
): Promise<IWebhookResponseData> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const headers = this.getHeaderData() as Record<string, string | undefined>;

  const signatureHeader = headers[SIGNATURE_HEADER_LOWER];
  // The x-humangent-delivery-id / x-humangent-test-mode headers are
  // NOT part of the HMAC envelope — they're hints sent alongside for
  // logging + pgmq retry-dedupe at the transport layer. We never
  // trust them over the signed body fields.
  void headers[DELIVERY_ID_HEADER_LOWER];
  void headers[TEST_MODE_HEADER_LOWER];

  const rawBody = readRawBody(this);

  // HMAC secret IS the API key plaintext. The Humangent backend signs
  // decision deliveries with the same value the node uses to
  // authenticate outbound calls — one secret, two directions.
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

  // Decode the snapshot from the saved workflow's resourceLocator
  // value (captured at task-type pick time by listSearch.ts's
  // `encodeTaskTypeValue`). Branch indices are snapshot-driven so
  // the canvas (configuredOutputs in outputs.ts) and the runtime
  // routing here agree by construction.
  const taskTypeParam = this.getNodeParameter("taskType") as {
    value?: unknown;
  } | null;
  const rawValue =
    typeof taskTypeParam?.value === "string" ? taskTypeParam.value : "";
  const snapshot = decodeSnapshot(rawValue);
  const totalBranches = snapshot.length + 2; // + Dismissed + Timed Out
  const dismissedIndex = snapshot.length;

  const branches = buildEmptyBranches(totalBranches);

  if (delivery.is_dismiss) {
    branches[dismissedIndex] = [decisionItem(delivery)];
  } else {
    const matchedIndex = snapshot.findIndex(
      (o) => o.id === delivery.outcome_id,
    );
    if (matchedIndex >= 0) {
      branches[matchedIndex] = [decisionItem(delivery)];
    } else {
      // Mid-wait drift OR snapshot empty (extreme edge case — old
      // workflow waiting before alpha.10 reload). Emit on Dismissed
      // with the drift signal so the workflow can react. Per origin
      // AE4, decisions are NEVER silently dropped.
      branches[dismissedIndex] = [
        decisionItem(delivery, {
          unmatched_outcome_id: delivery.outcome_id,
        }),
      ];
    }
  }

  return {
    webhookResponse: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
    workflowData: branches,
  };
}
