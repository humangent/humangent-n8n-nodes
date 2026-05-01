import { describe, expect, it } from "vitest";

import { NodeApiError } from "n8n-workflow";

import {
  buildEmptyBranches,
  HINT_COPY,
  humangentApiError,
  mapHint,
  syntheticTimedOutPayload,
} from "./errors";

const NODE = {
  id: "node_789",
  name: "Humangent",
  type: "@humangent/n8n-nodes-humangent.humangent",
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
};

describe("mapHint", () => {
  it("returns the catalogue entry for each known hint", () => {
    for (const [hint, copy] of Object.entries(HINT_COPY)) {
      expect(mapHint(hint, "fallback")).toBe(copy);
    }
  });

  it("surfaces the field id on field_validation_failed:<id>", () => {
    expect(mapHint("field_validation_failed:customer", "x")).toContain(
      "`customer`",
    );
  });

  it("surfaces the detail on resume_urls_mismatch:<detail>", () => {
    expect(mapHint("resume_urls_mismatch:missing:dismiss", "x")).toContain(
      "missing:dismiss",
    );
  });

  it("falls back to the server message for unknown hints", () => {
    expect(mapHint("unfamiliar_future_hint", "server said so")).toBe(
      "server said so",
    );
  });
});

describe("humangentApiError", () => {
  it("produces a NodeApiError with the mapped copy as its message", () => {
    const err = humangentApiError(NODE, {
      ok: false,
      code: "missing_or_invalid_api_key",
      message: "invalid api key",
      status: 403,
    });
    expect(err).toBeInstanceOf(NodeApiError);
    expect(err.message).toMatch(/missing, invalid, or revoked/i);
  });

  it("falls back to the server message when the hint is unknown", () => {
    const err = humangentApiError(NODE, {
      ok: false,
      code: "something_weird",
      message: "server explanation",
    });
    expect(err.message).toBe("server explanation");
  });
});

describe("buildEmptyBranches", () => {
  it("returns N empty arrays", () => {
    const out = buildEmptyBranches(4);
    expect(out).toHaveLength(4);
    for (const branch of out) expect(branch).toEqual([]);
  });

  it("returns a fresh array per branch so caller mutations don't alias", () => {
    const out = buildEmptyBranches(3);
    out[0].push({ json: { x: 1 } });
    expect(out[1]).toEqual([]);
    expect(out[2]).toEqual([]);
  });
});

describe("syntheticTimedOutPayload", () => {
  const REQUEST_ROW = {
    id: "00000000-0000-0000-0000-000000000010",
    org_id: "00000000-0000-0000-0000-000000000002",
    task_type_id: "00000000-0000-0000-0000-000000000001",
    fields: { customer: "Acme" },
    outcomes_snapshot: [{ id: "approve", label: "Approve" }],
    status: "open" as const,
    is_test: true,
    metadata: {},
    expected_timeout_at: null,
    assignee_id: null,
    created_by_api_key_id: null,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
  };

  it("emits an outcome_id=timed_out payload with is_dismiss=false", () => {
    const item = syntheticTimedOutPayload(REQUEST_ROW);
    expect(item.json.outcome_id).toBe("timed_out");
    expect(item.json.is_dismiss).toBe(false);
  });

  it("forwards fields + is_test from the request row (last saved state)", () => {
    const item = syntheticTimedOutPayload(REQUEST_ROW);
    expect(item.json.fields).toEqual({ customer: "Acme" });
    expect(item.json.is_test).toBe(true);
  });

  it("omits fields_before / decided_by / decided_at (R22 presence rules)", () => {
    const item = syntheticTimedOutPayload(REQUEST_ROW);
    expect(item.json).not.toHaveProperty("fields_before");
    expect(item.json).not.toHaveProperty("decided_by_profile_id");
    expect(item.json).not.toHaveProperty("decided_at");
  });

  it("emits decisionNote='' for shape parity with named-branch payloads (alpha-14)", () => {
    // Downstream nodes can read `decisionNote` on every branch
    // (named outcomes, Dismissed, Timed Out) without conditional
    // access — Timed Out fires when the reviewer never acted, so the
    // empty string is the correct value here.
    const item = syntheticTimedOutPayload(REQUEST_ROW);
    expect(item.json.decisionNote).toBe("");
  });
});
