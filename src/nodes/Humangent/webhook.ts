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
import { type DecisionDelivery } from "../../lib/schemas";
import { verifyAndParseDelivery } from "../../lib/webhookHelpers";
import { buildEmptyBranches, decodeSnapshot } from "./errors";

const DELIVERY_ID_HEADER_LOWER = "x-humangent-delivery-id";
const TEST_MODE_HEADER_LOWER = "x-humangent-test-mode";

function decisionItem(
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

/**
 * Snapshot-driven branch routing shared between the inline node and
 * Humangent Continue. The two callers diverge on whether
 * `outcome_id === options.timedOutOutcomeId` should route to a
 * separate Timed Out lane: inline waits get their Timed Out emit
 * synthesized by execute.ts on n8n's waitTill expiry, while Continue
 * receives an explicit `timed_out` outcome from deliver-decision.
 * Pass `timedOutOutcomeId: undefined` (the default) to skip that
 * branch.
 */
export function routeDecisionToBranches(
  delivery: DecisionDelivery,
  snapshot: ReadonlyArray<{ id: string; label: string }>,
  options: { timedOutOutcomeId?: string } = {},
): IWebhookResponseData {
  const totalBranches = snapshot.length + 2; // + Dismissed + Timed Out
  const dismissedIndex = snapshot.length;
  const timedOutIndex = snapshot.length + 1;
  const branches = buildEmptyBranches(totalBranches);

  if (
    options.timedOutOutcomeId !== undefined &&
    delivery.outcome_id === options.timedOutOutcomeId
  ) {
    branches[timedOutIndex] = [decisionItem(delivery)];
  } else if (delivery.is_dismiss) {
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

export async function webhookResume(
  this: IWebhookFunctions,
): Promise<IWebhookResponseData> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;

  // The x-humangent-delivery-id / x-humangent-test-mode headers are
  // NOT part of the HMAC envelope — they're hints sent alongside for
  // logging + pgmq retry-dedupe at the transport layer. We never
  // trust them over the signed body fields.
  const headers = this.getHeaderData() as Record<string, string | undefined>;
  void headers[DELIVERY_ID_HEADER_LOWER];
  void headers[TEST_MODE_HEADER_LOWER];

  const verified = await verifyAndParseDelivery(this, creds);
  if (!verified.ok) return verified.response;
  const delivery = verified.delivery;

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
  return routeDecisionToBranches(delivery, snapshot);
}
