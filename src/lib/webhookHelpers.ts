// Shared helpers for HMAC-signed decision-delivery webhooks.
//
// Both the inline (Humangent) and detached (HumangentContinue) trigger
// nodes verify the same signed envelope and parse the same payload
// shape. The handlers diverge afterwards — replay protection,
// audience checks, branch routing — but the verify/parse prelude is
// identical and lives here.

import type { IWebhookFunctions, IWebhookResponseData } from "n8n-workflow";

import type { HumangentCredentials } from "./api";
import { verifySignature } from "./hmac";
import {
  DecisionDeliverySchema,
  type DecisionDelivery,
} from "./schemas";

const SIGNATURE_HEADER_LOWER = "x-humangent-signature";

/**
 * Recover the exact bytes the HMAC was computed over. n8n's body-
 * parser exposes the raw buffer on `request.rawBody` (set by the
 * upstream Express body-parser); when present we use it directly.
 * When absent (older n8n versions or test harnesses), fall back to
 * re-stringifying the parsed body. For the canonical shape
 * deliver-decision emits (flat object, string keys, no Unicode
 * escapes), JSON.stringify after JSON.parse reproduces the bytes
 * exactly — V8 preserves insertion order on round-trip.
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
  // `JSON.stringify(undefined)` is `undefined`, not a string. Coalesce
  // so signature verification gets a real string and reports
  // `invalid_signature` cleanly instead of crashing on a TypeError.
  return JSON.stringify(parsed) ?? "";
}

export function denyWith(
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

export type VerifyAndParseResult =
  | { ok: true; delivery: DecisionDelivery; rawBody: string }
  | { ok: false; response: IWebhookResponseData };

/**
 * Verify the signature and parse the decision payload. Returns
 * `{ ok: true, delivery }` on success or a ready-to-return error
 * `{ ok: false, response }` on either failure mode (401 invalid
 * signature, 400 malformed body).
 *
 * Caller is responsible for additional checks (audience, replay,
 * routing) — those diverge between inline and detached handlers.
 */
export async function verifyAndParseDelivery(
  ctx: IWebhookFunctions,
  creds: HumangentCredentials,
): Promise<VerifyAndParseResult> {
  const headers = ctx.getHeaderData() as Record<string, string | undefined>;
  const signatureHeader = headers[SIGNATURE_HEADER_LOWER];
  const rawBody = readRawBody(ctx);

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
    return {
      ok: false,
      response: denyWith(401, {
        error: "invalid_signature",
        reason: verifyResult.reason,
      }),
    };
  }

  const parsedBody = ctx.getBodyData();
  const parsed = DecisionDeliverySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return {
      ok: false,
      response: denyWith(400, {
        error: "malformed_decision_payload",
        detail: parsed.error.message,
      }),
    };
  }

  return { ok: true, delivery: parsed.data, rawBody };
}
