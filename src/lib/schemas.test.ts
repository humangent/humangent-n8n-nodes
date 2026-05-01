import { describe, expect, it } from "vitest";

import {
  DecisionDeliverySchema,
  OutcomeSchema,
  RequestRowSchema,
  TaskTypeListSchema,
  TaskTypeRowSchema,
} from "./schemas";

const VALID_TASK_TYPE = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: null,
  scope_label: "org-wide",
  field_schema_json: [
    { id: "customer", displayName: "Customer", type: "string", required: true },
    { id: "amount", type: "number", required: false },
  ],
  outcomes_json: [
    { id: "approve", label: "Approve", role: "default-positive" as const },
    { id: "reject", label: "Reject", role: "destructive" as const },
  ],
  is_system: true,
  archived_at: null,
  version: 1,
  created_at: "2026-04-22T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

describe("OutcomeSchema", () => {
  it("accepts minimal outcome with id + label", () => {
    const parsed = OutcomeSchema.safeParse({ id: "approve", label: "Approve" });
    expect(parsed.success).toBe(true);
  });

  it("accepts outcome with id + label + role", () => {
    const parsed = OutcomeSchema.safeParse({
      id: "approve",
      label: "Approve",
      role: "default-positive",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an outcome with an empty id", () => {
    const parsed = OutcomeSchema.safeParse({ id: "", label: "Approve" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an outcome with a missing id", () => {
    const parsed = OutcomeSchema.safeParse({ label: "Approve" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an outcome with a missing label", () => {
    const parsed = OutcomeSchema.safeParse({ id: "approve" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an outcome with an empty label", () => {
    const parsed = OutcomeSchema.safeParse({ id: "approve", label: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an outcome with an unknown role", () => {
    const parsed = OutcomeSchema.safeParse({
      id: "approve",
      label: "Approve",
      role: "made-up-role",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("TaskTypeRowSchema", () => {
  it("accepts a fully-populated row", () => {
    const parsed = TaskTypeRowSchema.safeParse(VALID_TASK_TYPE);
    expect(parsed.success).toBe(true);
  });

  it("rejects a row with zero outcomes (DB CHECK forbids this too)", () => {
    const parsed = TaskTypeRowSchema.safeParse({
      ...VALID_TASK_TYPE,
      outcomes_json: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a row missing required keys", () => {
    const { slug: _slug, ...rest } = VALID_TASK_TYPE;
    const parsed = TaskTypeRowSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("accepts a row with an archived_at timestamp", () => {
    const parsed = TaskTypeRowSchema.safeParse({
      ...VALID_TASK_TYPE,
      archived_at: "2026-05-01T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("TaskTypeListSchema", () => {
  it("accepts an empty page", () => {
    const parsed = TaskTypeListSchema.safeParse({
      items: [],
      next_cursor: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a populated page with a cursor", () => {
    const parsed = TaskTypeListSchema.safeParse({
      items: [VALID_TASK_TYPE],
      next_cursor: "opaque-cursor-value",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a page whose items contain a malformed row", () => {
    const parsed = TaskTypeListSchema.safeParse({
      items: [{ ...VALID_TASK_TYPE, outcomes_json: [] }],
      next_cursor: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("RequestRowSchema", () => {
  const VALID_REQUEST = {
    id: "00000000-0000-0000-0000-000000000010",
    org_id: "00000000-0000-0000-0000-000000000002",
    task_type_id: VALID_TASK_TYPE.id,
    fields: { customer: "Acme", amount: 1000 },
    outcomes_snapshot: VALID_TASK_TYPE.outcomes_json,
    status: "open",
    is_test: false,
    metadata: { n8n_execution_id: "exec_123" },
    expected_timeout_at: null,
    assignee_id: null,
    created_by_api_key_id: "00000000-0000-0000-0000-000000000099",
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
  };

  it("accepts a valid open request", () => {
    const parsed = RequestRowSchema.safeParse(VALID_REQUEST);
    expect(parsed.success).toBe(true);
  });

  it.each([
    "open",
    "assigned",
    "decided",
    "dismissed",
    "timed_out",
    "cancelled",
  ])("accepts status '%s'", (status) => {
    const parsed = RequestRowSchema.safeParse({ ...VALID_REQUEST, status });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const parsed = RequestRowSchema.safeParse({
      ...VALID_REQUEST,
      status: "completed", // legacy PR-#30 value, dropped in v2
    });
    expect(parsed.success).toBe(false);
  });
});

describe("DecisionDeliverySchema", () => {
  // Matches the body shape emitted by
  // apps/api/supabase/functions/deliver-decision/index.ts — keys
  // in that exact declaration order, fields_before +
  // decided_by_profile_id are nullable (never absent), no
  // audit_url / dismiss_reason at the wire level.
  const VALID_DELIVERY = {
    delivery_id: "42",
    request_id: "00000000-0000-0000-0000-000000000010",
    outcome_id: "approve",
    is_dismiss: false,
    fields: { customer: "Acme", amount: 1000 },
    fields_before: { customer: "Acme", amount: 900 },
    decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
    decided_at: "2026-04-23T12:34:56Z",
    duration_ms: 12345,
    is_test: false,
  };

  it("accepts a fully-populated decision delivery", () => {
    const parsed = DecisionDeliverySchema.safeParse(VALID_DELIVERY);
    expect(parsed.success).toBe(true);
  });

  it("accepts a dismiss delivery with fields_before=null", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      outcome_id: "dismiss",
      is_dismiss: true,
      fields_before: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a delivery with decided_by_profile_id=null", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      decided_by_profile_id: null,
      fields_before: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a delivery missing is_test (the contract is nullable-not-optional)", () => {
    const { is_test: _it, ...rest } = VALID_DELIVERY;
    const parsed = DecisionDeliverySchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("rejects a delivery missing delivery_id", () => {
    const { delivery_id: _d, ...rest } = VALID_DELIVERY;
    const parsed = DecisionDeliverySchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("rejects a delivery with a non-integer duration_ms", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      duration_ms: 12.5,
    });
    expect(parsed.success).toBe(false);
  });

  // U20 — multi-level-approval audit extensions. Both fields are
  // optional so older Edge Function payloads (alpha-11..alpha-20)
  // continue to parse cleanly during the rollout window.

  it("accepts a delivery with decided_via='human' + a chain audit", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      decided_via: "human",
      chain: [
        {
          level: 1,
          activation_index: 1,
          decision: "approve",
          comment: null,
          at: "2026-04-28T01:00:00Z",
          outcome_id: "approve",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decided_via).toBe("human");
      expect(parsed.data.chain).toHaveLength(1);
    }
  });

  it("accepts a delivery with decided_via='auto_approve'", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      decided_by_profile_id: null,
      decided_via: "auto_approve",
      chain: [
        {
          level: 1,
          activation_index: 1,
          decision: "auto_approve",
          comment: null,
          at: "2026-04-28T01:00:00Z",
          outcome_id: "approve",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an escalate chain entry with target_active flag", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      chain: [
        {
          level: 2,
          activation_index: 1,
          decision: "escalate",
          comment: null,
          at: "2026-04-28T02:00:00Z",
          target_active: true,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a stall chain entry with reason", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      chain: [
        {
          level: 1,
          activation_index: 1,
          decision: "stall",
          comment: null,
          at: "2026-04-28T00:30:00Z",
          reason: "direct_assignee_disabled",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a delivery without decided_via or chain (legacy EF rollout)", () => {
    const parsed = DecisionDeliverySchema.safeParse(VALID_DELIVERY);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decided_via).toBeUndefined();
      expect(parsed.data.chain).toBeUndefined();
    }
  });

  it("rejects a chain entry with an unknown decision verb", () => {
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      chain: [
        {
          level: 1,
          activation_index: 1,
          decision: "rubber_stamp",
          comment: null,
          at: "2026-04-28T01:00:00Z",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("passes through extra chain-entry fields (forward-compat)", () => {
    // Future chain-entry additions (new metadata keys) should flow
    // through cleanly without an n8n-node release.
    const parsed = DecisionDeliverySchema.safeParse({
      ...VALID_DELIVERY,
      chain: [
        {
          level: 1,
          activation_index: 1,
          decision: "approve",
          comment: null,
          at: "2026-04-28T01:00:00Z",
          outcome_id: "approve",
          future_metadata_key: "tomorrow",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data.chain![0] as Record<string, unknown>).future_metadata_key,
      ).toBe("tomorrow");
    }
  });
});
