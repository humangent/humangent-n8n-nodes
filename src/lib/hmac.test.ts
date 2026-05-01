import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySignature } from "./hmac";

// Helper: compute a valid signature for a given body + ts + secret.
function signBody(body: string, ts: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
}

function headerFor(body: string, ts: number, secret: string): string {
  return `t=${ts},v1=${signBody(body, ts, secret)}`;
}

const SECRET =
  "hmk_wh_0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const BODY = '{"outcome_id":"approve"}';

describe("verifySignature", () => {
  it("accepts a valid signature with the timestamp inside the window", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: BODY,
      secret: SECRET,
      now: ts + 30,
    });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a missing header", () => {
    const result = verifySignature({
      header: undefined,
      body: BODY,
      secret: SECRET,
      now: 1_700_000_000,
    });
    expect(result).toEqual({ valid: false, reason: "header_missing" });
  });

  it("rejects an empty header", () => {
    const result = verifySignature({
      header: "",
      body: BODY,
      secret: SECRET,
      now: 1_700_000_000,
    });
    expect(result).toEqual({ valid: false, reason: "header_missing" });
  });

  it.each([
    ["no t", "v1=deadbeef"],
    ["no v1", "t=1700000000"],
    ["garbage", "garbage"],
    ["t is non-numeric", "t=notanumber,v1=deadbeef"],
    ["t is a float", "t=1700000000.5,v1=deadbeef"],
    ["sig is non-hex", "t=1700000000,v1=zzznothex"],
  ])("rejects malformed header (%s)", (_label, header) => {
    const result = verifySignature({
      header,
      body: BODY,
      secret: SECRET,
      now: 1_700_000_000,
    });
    expect(result).toEqual({ valid: false, reason: "header_malformed" });
  });

  it("rejects a timestamp beyond the default 5-minute window", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: BODY,
      secret: SECRET,
      now: ts + 301,
    });
    expect(result).toEqual({
      valid: false,
      reason: "timestamp_out_of_window",
    });
  });

  it("rejects a timestamp from the past beyond the window", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: BODY,
      secret: SECRET,
      now: ts - 301,
    });
    expect(result).toEqual({
      valid: false,
      reason: "timestamp_out_of_window",
    });
  });

  it("accepts a custom maxSkewSeconds override", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: BODY,
      secret: SECRET,
      now: ts + 9_000,
      maxSkewSeconds: 10_000,
    });
    expect(result).toEqual({ valid: true });
  });

  it("rejects when the body has been tampered with", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: '{"outcome_id":"reject"}', // different body
      secret: SECRET,
      now: ts,
    });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects when the wrong secret is used to verify", () => {
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: headerFor(BODY, ts, SECRET),
      body: BODY,
      secret: "hmk_wh_not_the_same_secret_at_all_different_bytes_here___",
      now: ts,
    });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects when the signature is shorter than the expected digest", () => {
    // A valid-looking hex signature that is too short — should hit
    // the length guard before the timing-safe compare.
    const ts = 1_700_000_000;
    const result = verifySignature({
      header: `t=${ts},v1=deadbeef`,
      body: BODY,
      secret: SECRET,
      now: ts,
    });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("accepts uppercase hex in the signature (case-insensitive)", () => {
    const ts = 1_700_000_000;
    const sig = signBody(BODY, ts, SECRET).toUpperCase();
    const result = verifySignature({
      header: `t=${ts},v1=${sig}`,
      body: BODY,
      secret: SECRET,
      now: ts,
    });
    expect(result).toEqual({ valid: true });
  });
});
