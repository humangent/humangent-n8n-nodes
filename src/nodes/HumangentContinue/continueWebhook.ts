// Humangent Continue trigger — webhook() handler.
//
// Fires when Humangent's `deliver-decision` Edge Function POSTs an
// HMAC-signed decision body to the Continue node's registered
// `webhook_url`. Mirrors the inline node's `webhookResume` flow
// (verify → parse → route) with two divergences:
//
//   * **Replay protection.** Defense-in-depth on top of the
//     backend's pgmq `delivery_id` dedup. We track recent
//     `delivery_id` values in `getWorkflowStaticData('node')` and
//     return 200 `{deduped: true}` on a repeat without firing the
//     workflow. Eviction at 100 entries OR 24-hour TTL, whichever
//     fires first. The body's `delivery_id` (signed) is the trust
//     boundary — never the X-Humangent-Delivery-Id header (outside
//     the HMAC envelope).
//
//   * **Audience-claim check (R27).** After HMAC verifies, we check
//     `target_kind === 'subscription'`. Anything else (inline,
//     missing) is treated as cross-audience replay or tampered
//     delivery and rejected with 401. Old inline-shape payloads
//     don't reach Continue because they're routed by the deliverer
//     based on `requests.subscription_id IS NULL`.
//
// Branch routing matches the inline node: outcome_id matches
// snapshot → that branch; outcome_id NOT in snapshot → Dismissed
// with `drift_detected: true` + `unmatched_outcome_id`;
// `is_dismiss === true` → Dismissed; `outcome_id === 'timed_out'`
// → Timed Out (last index). Snapshot decoded from the resourceLocator
// `value` (`<task-type-id>#o=<encoded>`), same as the inline node.

import type {
  IDataObject,
  IWebhookFunctions,
  IWebhookResponseData,
} from "n8n-workflow";

import type { HumangentCredentials } from "../../lib/api";
import { denyWith, verifyAndParseDelivery } from "../../lib/webhookHelpers";
import { decodeSnapshot } from "../Humangent/errors";
import { routeDecisionToBranches } from "../Humangent/webhook";

const SEEN_KEY = "humangentContinueSeenDeliveries";
const SEEN_MAX_ENTRIES = 100;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const TIMED_OUT_OUTCOME_ID = "timed_out";

interface SeenEntry {
  id: string;
  ts: number;
}

function filterByTtl(seen: SeenEntry[], now: number): SeenEntry[] {
  // Drop entries older than the TTL window. Defensive on element
  // shape so a hand-edited or earlier-version-shape staticData blob
  // doesn't crash the handler. The replay window backend-side is
  // bounded by the Svix retry budget (~24h) which is why we mirror
  // the same horizon here.
  const cutoff = now - SEEN_TTL_MS;
  return seen.filter(
    (e): e is SeenEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as SeenEntry).id === "string" &&
      typeof (e as SeenEntry).ts === "number" &&
      (e as SeenEntry).ts >= cutoff,
  );
}

function trimToCap(seen: SeenEntry[]): SeenEntry[] {
  // Leave headroom for a single subsequent push so the post-push
  // count stays at or below SEEN_MAX_ENTRIES. Count caps the
  // worst-case memory footprint while TTL caps the wall-clock window.
  if (seen.length >= SEEN_MAX_ENTRIES) {
    return seen.slice(seen.length - (SEEN_MAX_ENTRIES - 1));
  }
  return seen;
}

export async function continueWebhookHandler(
  this: IWebhookFunctions,
): Promise<IWebhookResponseData> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;

  const verified = await verifyAndParseDelivery(this, creds);
  if (!verified.ok) return verified.response;
  const delivery = verified.delivery;

  // R27 audience-claim check. Continue only receives subscription-
  // bound deliveries; an inline-bound payload reaching this URL is
  // a misrouted (or replayed) delivery from a different audience.
  // Reject before touching workflow state.
  if (delivery.target_kind !== "subscription") {
    return denyWith(401, {
      error: "invalid_audience",
      expected: "subscription",
      received: delivery.target_kind ?? null,
    });
  }

  // Replay protection (defense-in-depth on top of the backend's
  // pgmq dedup). The signed body's `delivery_id` is the trust
  // boundary — never the header. Static data is mutated in place:
  // n8n persists workflow static data across executions of the
  // same workflow.
  //
  // Order matters here: dedup-check runs against the TTL-filtered
  // list BEFORE the count cap is applied, otherwise a replay of the
  // oldest retained id would slip through whenever the cache sat at
  // the cap. (Trimming before the dedup check would silently drop
  // exactly the entry we'd need to recognize.) Count trimming only
  // happens on the push path, after we know the delivery is fresh.
  const staticData = this.getWorkflowStaticData("node") as IDataObject;
  const now = Date.now();
  const seenRaw = Array.isArray(staticData[SEEN_KEY])
    ? (staticData[SEEN_KEY] as SeenEntry[])
    : [];
  const unexpired = filterByTtl(seenRaw, now);
  if (unexpired.some((e) => e.id === delivery.delivery_id)) {
    this.logger?.info?.("humangent.continue.deduped", {
      delivery_id: delivery.delivery_id,
      request_id: delivery.request_id,
    } as IDataObject);
    staticData[SEEN_KEY] = unexpired as unknown as IDataObject;
    return {
      webhookResponse: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, deduped: true }),
      },
    };
  }
  const seen = trimToCap(unexpired);
  seen.push({ id: delivery.delivery_id, ts: now });
  staticData[SEEN_KEY] = seen as unknown as IDataObject;

  // Snapshot-driven branch routing. Continue's resourceLocator
  // value carries the same `<task-type-id>#o=<encoded>` shape as
  // inline; configuredOutputs decodes it for the canvas, decodeSnapshot
  // decodes it here for runtime routing — and decoders.cross.test.ts
  // pins the two in agreement.
  const taskTypeParam = this.getNodeParameter("taskType") as {
    value?: unknown;
  } | null;
  const rawValue =
    typeof taskTypeParam?.value === "string" ? taskTypeParam.value : "";
  const snapshot = decodeSnapshot(rawValue);
  return routeDecisionToBranches(delivery, snapshot, {
    timedOutOutcomeId: TIMED_OUT_OUTCOME_ID,
  });
}
