// HMAC-SHA256 verifier for decision-delivery webhooks.
//
// The Humangent outbox worker (public-API v2 Unit 4 — not yet
// shipped) POSTs decision payloads to the n8n resume URL and signs
// each body with an `X-Humangent-Signature` header shaped like:
//
//     t=<unix_ts>,v1=<hex>
//
// where `v1 = HMAC-SHA256("<ts>.<body>", <signing_secret>)`. The
// timestamp prefix defeats replay of a captured body outside the
// acceptance window; the secret is per-API-key (minted by
// create_api_key RPC, returned once on creation alongside the API
// key plaintext).
//
// This module is pure — no n8n deps — so it can be unit-tested
// directly and reused in any Node runtime. The shape mirrors Stripe's
// webhook-signing convention, which n8n users are likely to recognise.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySignatureOptions {
  /** Raw `X-Humangent-Signature` header value. */
  header: string | undefined;
  /** Raw request body as UTF-8 string. Do NOT JSON.parse first; the signature covers bytes. */
  body: string;
  /** Per-key signing secret plaintext (`hmk_wh_...`). */
  secret: string;
  /** Current unix seconds. Injected for deterministic tests. */
  now: number;
  /** Acceptable timestamp skew in seconds. Default 300 (±5 min). */
  maxSkewSeconds?: number;
}

export type VerifyFailureReason =
  | "header_missing"
  | "header_malformed"
  | "timestamp_out_of_window"
  | "signature_mismatch";

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason };

/**
 * Verify an HMAC-SHA256 signature over `<ts>.<body>` where `<ts>` is
 * the unix-second value parsed from the header. Returns a tagged
 * result so the caller can pick distinct error responses for each
 * failure class.
 *
 * Uses `crypto.timingSafeEqual` for the final comparison — defeats
 * length / content-based side channels on slow CPUs.
 */
export function verifySignature(options: VerifySignatureOptions): VerifyResult {
  const { header, body, secret, now } = options;
  const maxSkew = options.maxSkewSeconds ?? 300;

  if (!header) return { valid: false, reason: "header_missing" };

  const parts = header
    .split(",")
    .reduce<Record<string, string>>((acc, part) => {
      const eq = part.indexOf("=");
      if (eq > 0) {
        acc[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      return acc;
    }, {});

  const tsStr = parts["t"];
  const sig = parts["v1"];
  if (!tsStr || !sig) return { valid: false, reason: "header_malformed" };

  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { valid: false, reason: "header_malformed" };
  }
  if (!/^[0-9a-f]+$/i.test(sig)) {
    return { valid: false, reason: "header_malformed" };
  }

  if (Math.abs(now - ts) > maxSkew) {
    return { valid: false, reason: "timestamp_out_of_window" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(sig.toLowerCase(), "hex");
  if (expectedBuf.length !== receivedBuf.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}
