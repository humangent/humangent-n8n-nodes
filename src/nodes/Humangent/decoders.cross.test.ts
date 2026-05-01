// Cross-decoder consistency check.
//
// Two decoders read the same resourceLocator-`value` snapshot
// (`<task-type-id>#o=<encoded>` produced by listSearch.ts's
// `encodeTaskTypeValue`):
//
//   * `configuredOutputs` in outputs.ts — runs in n8n's expression
//     sandbox at canvas-render time. Sandbox-strict (only JSON,
//     decodeURIComponent, string/array methods). Returns
//     `[...{type, displayName}, Dismissed, Timed Out]`.
//
//   * `decodeSnapshot` in errors.ts — runs in regular Node.js
//     (execute.ts + webhook.ts). Returns the raw `[{id, label}, ...]`
//     decoded from the snapshot fragment.
//
// They have different return shapes (the sandbox decoder maps to
// canvas-output configs; the Node decoder returns the raw outcomes),
// so we can't compare outputs byte-by-byte. What MUST stay aligned is
// their *acceptance set*: both must accept or reject the same inputs,
// and on accepted inputs, the IDs/labels they pull out must match
// position-for-position.
//
// This test feeds both decoders an identical fixture set and asserts:
//   * Acceptance: empty named-list ⇔ empty Node array (rejection)
//   * Order + content: per-index labels in `configuredOutputs` (minus
//     the trailing two synthetic branches) match the per-index labels
//     in `decodeSnapshot`
//   * IDs in `decodeSnapshot` round-trip the source fixture
//
// Drift in either decoder — a different parser, a stricter validator,
// a missed edge case — will fail this test. That's the whole point.

import { describe, expect, it } from "vitest";

import {
  DecisionDeliverySchema,
  OutcomeSchema,
  TaskTypeRowSchema,
} from "../../lib/schemas";
import { decodeSnapshot } from "./errors";
import { configuredOutputs } from "./outputs";

const TASK_TYPE_ID = "00000000-0000-0000-0000-000000000001";

function withFragment(outcomes: unknown): string {
  return `${TASK_TYPE_ID}#o=${encodeURIComponent(JSON.stringify(outcomes))}`;
}

function buildParameter(value: string | undefined | null) {
  // alpha.14+: configuredOutputs receives `parameter.taskType` as a
  // string (n8n's WorkflowDataProxy unwraps RL params to `.value`).
  if (typeof value !== "string") return { taskType: undefined };
  return { taskType: value };
}

type Fixture = {
  name: string;
  /** The full RL `value` string, or null/undefined to simulate "no task type picked". */
  value: string | null | undefined;
  /** Expected outcome list both decoders should produce, or [] for rejection. */
  expectedOutcomes: Array<{ id: string; label: string }>;
};

const FIXTURES: Fixture[] = [
  // ── Happy paths ──────────────────────────────────────────────
  {
    name: "single outcome",
    value: withFragment([{ id: "approve", label: "Approve" }]),
    expectedOutcomes: [{ id: "approve", label: "Approve" }],
  },
  {
    name: "two outcomes",
    value: withFragment([
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]),
    expectedOutcomes: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
  },
  {
    name: "three outcomes preserve declared order",
    value: withFragment([
      { id: "ship", label: "Ship it" },
      { id: "block", label: "Block" },
      { id: "escalate", label: "Escalate" },
    ]),
    expectedOutcomes: [
      { id: "ship", label: "Ship it" },
      { id: "block", label: "Block" },
      { id: "escalate", label: "Escalate" },
    ],
  },
  {
    name: "labels with unicode characters",
    value: withFragment([
      { id: "approve", label: "Approve ✓" },
      { id: "reject", label: "Reject ✗" },
    ]),
    expectedOutcomes: [
      { id: "approve", label: "Approve ✓" },
      { id: "reject", label: "Reject ✗" },
    ],
  },
  {
    name: "labels with spaces, ampersands, and quotes",
    value: withFragment([
      { id: "ship_v2", label: "Ship & deploy" },
      { id: "needs_review", label: 'Needs "manager" review' },
    ]),
    expectedOutcomes: [
      { id: "ship_v2", label: "Ship & deploy" },
      { id: "needs_review", label: 'Needs "manager" review' },
    ],
  },
  {
    name: "extra unknown keys on outcome objects are ignored, not rejected",
    // role lives on outcomes_json server-side; the snapshot strips it.
    // But if a future encoding passes it through, both decoders must
    // tolerate the extra key without rejecting the whole snapshot.
    value: withFragment([
      { id: "approve", label: "Approve", role: "default-positive" },
      { id: "reject", label: "Reject", role: "destructive" },
    ]),
    expectedOutcomes: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
  },
  {
    name: "task-type id with embedded #o= earlier in the string still parses (lastIndexOf wins)",
    // The marker should always be the LAST `#o=` so any future
    // suffix structure stays appendable. UUIDs only contain hex so
    // a real id never contains `#o=`, but the lastIndexOf safety
    // path is worth exercising.
    value:
      "weird-prefix#o=earlier#o=" +
      encodeURIComponent(JSON.stringify([{ id: "approve", label: "Approve" }])),
    expectedOutcomes: [{ id: "approve", label: "Approve" }],
  },

  // ── Rejection paths ──────────────────────────────────────────
  {
    name: "no fragment marker → empty",
    value: TASK_TYPE_ID, // bare id, no #o=
    expectedOutcomes: [],
  },
  {
    name: "fragment but malformed JSON → empty",
    value: `${TASK_TYPE_ID}#o=${encodeURIComponent("not-json")}`,
    expectedOutcomes: [],
  },
  {
    name: "JSON not an array → empty",
    value: withFragment({ id: "approve", label: "Approve" }),
    expectedOutcomes: [],
  },
  {
    name: "empty array → empty",
    value: withFragment([]),
    expectedOutcomes: [],
  },
  {
    name: "missing id on any item → reject WHOLE snapshot",
    value: withFragment([
      { id: "approve", label: "Approve" },
      { label: "Reject" }, // missing id
    ]),
    expectedOutcomes: [],
  },
  {
    name: "missing label on any item → reject WHOLE snapshot",
    value: withFragment([
      { id: "approve", label: "Approve" },
      { id: "reject" }, // missing label
    ]),
    expectedOutcomes: [],
  },
  {
    name: "empty-string id → reject",
    value: withFragment([{ id: "", label: "Approve" }]),
    expectedOutcomes: [],
  },
  {
    name: "empty-string label → reject",
    value: withFragment([{ id: "approve", label: "" }]),
    expectedOutcomes: [],
  },
  {
    name: "non-string id → reject",
    value: withFragment([{ id: 42, label: "Approve" }]),
    expectedOutcomes: [],
  },
  {
    name: "non-string label → reject",
    value: withFragment([{ id: "approve", label: 42 }]),
    expectedOutcomes: [],
  },
  {
    name: "null item in array → reject",
    value: withFragment([{ id: "approve", label: "Approve" }, null]),
    expectedOutcomes: [],
  },
  {
    name: "primitive item in array → reject",
    value: withFragment([{ id: "approve", label: "Approve" }, "not-an-object"]),
    expectedOutcomes: [],
  },
  {
    name: "value undefined → empty",
    value: undefined,
    expectedOutcomes: [],
  },
  {
    name: "value null → empty",
    value: null,
    expectedOutcomes: [],
  },
  {
    name: "value empty string → empty",
    value: "",
    expectedOutcomes: [],
  },

  // ── Continue-side fixtures (alpha.21 — U5) ───────────────────
  // The Humangent Continue trigger node reuses `configuredOutputs`
  // verbatim from the inline node. These fixtures explicitly cover
  // the Continue-side path with shapes that exercise registration
  // realities the inline path doesn't see (very long task type
  // names, encoded paths, large outcome sets). If the two decoders
  // ever diverge for these inputs, Continue's canvas branches
  // would drift from the inline node's even when both pick the
  // same task type.
  {
    name: "Continue: long task-type name with whitespace + punctuation in labels",
    value: withFragment([
      { id: "approve_v3", label: "Approve (final review)" },
      { id: "request_revision", label: "Request revision · cycle 2" },
      { id: "escalate_to_legal", label: "Escalate — legal hold" },
    ]),
    expectedOutcomes: [
      { id: "approve_v3", label: "Approve (final review)" },
      { id: "request_revision", label: "Request revision · cycle 2" },
      { id: "escalate_to_legal", label: "Escalate — legal hold" },
    ],
  },
  {
    name: "Continue: max-realistic outcome set (six branches + Dismissed + Timed Out)",
    value: withFragment([
      { id: "approve", label: "Approve" },
      { id: "approve_with_changes", label: "Approve with changes" },
      { id: "request_revision", label: "Request revision" },
      { id: "needs_legal", label: "Needs legal" },
      { id: "needs_finance", label: "Needs finance" },
      { id: "reject", label: "Reject" },
    ]),
    expectedOutcomes: [
      { id: "approve", label: "Approve" },
      { id: "approve_with_changes", label: "Approve with changes" },
      { id: "request_revision", label: "Request revision" },
      { id: "needs_legal", label: "Needs legal" },
      { id: "needs_finance", label: "Needs finance" },
      { id: "reject", label: "Reject" },
    ],
  },
  {
    name: "Continue: outcome labels matching reserved synthetic branches stay user-visible",
    // The Dismissed + Timed Out branches at the tail are synthesized
    // by configuredOutputs, not derived from outcomes_json. A user-
    // declared outcome happening to share the EXACT display name of
    // a synthetic branch ("Dismissed" / "Timed Out") is still distinct
    // on the wire because routing keys on the snapshot's `id`, not
    // its label. Both decoders must keep the user-declared outcomes
    // in the per-outcome positions and append the synthetic Dismissed
    // + Timed Out at the tail unconditionally — no de-duplication by
    // label, no swap-in. (Earlier shape used "Dismissed (user-
    // defined)" / "Timed Out (user-defined)" labels which never
    // actually exercised the collision path.)
    value: withFragment([
      { id: "user_dismissed", label: "Dismissed" },
      { id: "user_timed_out", label: "Timed Out" },
    ]),
    expectedOutcomes: [
      { id: "user_dismissed", label: "Dismissed" },
      { id: "user_timed_out", label: "Timed Out" },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────
// Schema cross-tests for the alpha-14 wire-shape changes.
//
// These fixtures verify that the schema layer accepts the same wire
// shapes the deliver-decision Edge Function (apps/api) emits and the
// task-type API returns. Schema drift between the n8n node and the
// API is silent until a real decision body arrives in production —
// these tests are the early-warning trip wire.
//
// Covers:
//   * `OutcomeSchema.role` accepts the new `revision-request` value.
//   * `TaskTypeRowSchema` parses a fetched task type whose
//     `outcomes_json` includes a revision-request outcome.
//   * `DecisionDeliverySchema` parses three deploy-window shapes
//     identically:
//       - revision-request outcome + non-empty `decision_note`
//         (alpha-14 EF + reviewer guidance)
//       - default-positive outcome + empty `decision_note: ""`
//         (alpha-14 EF + no reviewer guidance)
//       - alpha-13 EF body (no `decision_note` key) → fills `""` via
//         the schema default — forward-compat anchor.
// ─────────────────────────────────────────────────────────────────

const VALID_TASK_TYPE_WITH_REVISION = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: null,
  scope_label: "org-wide",
  field_schema_json: [],
  outcomes_json: [
    { id: "approve", label: "Approve", role: "default-positive" },
    {
      id: "request_revision",
      label: "Request revision",
      role: "revision-request",
    },
    { id: "reject", label: "Reject", role: "destructive" },
  ],
  is_system: false,
  archived_at: null,
  version: 1,
  created_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
};

const VALID_DELIVERY_BASE = {
  delivery_id: "42",
  request_id: "00000000-0000-0000-0000-000000000010",
  outcome_id: "approve",
  is_dismiss: false,
  fields: { customer: "Acme" },
  fields_before: { customer: "Acme Inc" },
  decided_by_profile_id: "00000000-0000-0000-0000-000000000050",
  decided_at: "2026-04-28T12:34:56Z",
  duration_ms: 1234,
  is_test: false,
};

describe("schema cross-tests: alpha-14 wire-shape acceptance", () => {
  it("OutcomeSchema accepts the new revision-request role", () => {
    const parsed = OutcomeSchema.safeParse({
      id: "request_revision",
      label: "Request revision",
      role: "revision-request",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe("revision-request");
    }
  });

  it("OutcomeSchema continues to accept the existing roles", () => {
    for (const role of [
      "default-positive",
      "secondary",
      "destructive",
    ] as const) {
      expect(
        OutcomeSchema.safeParse({ id: "x", label: "X", role }).success,
      ).toBe(true);
    }
  });

  it("OutcomeSchema rejects an unknown role", () => {
    const parsed = OutcomeSchema.safeParse({
      id: "x",
      label: "X",
      role: "definitely-not-a-role",
    });
    expect(parsed.success).toBe(false);
  });

  it("TaskTypeRowSchema parses a fetched task type whose outcomes_json includes a revision-request outcome", () => {
    const parsed = TaskTypeRowSchema.safeParse(VALID_TASK_TYPE_WITH_REVISION);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const roles = parsed.data.outcomes_json.map((o) => o.role);
      expect(roles).toContain("revision-request");
    }
  });

  it("DecisionDeliverySchema parses a revision-request outcome + non-empty decision_note", () => {
    const body = {
      ...VALID_DELIVERY_BASE,
      outcome_id: "request_revision",
      decision_note: "Make the headline shorter and re-run.",
    };
    const parsed = DecisionDeliverySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome_id).toBe("request_revision");
      expect(parsed.data.decision_note).toBe(
        "Make the headline shorter and re-run.",
      );
    }
  });

  it("DecisionDeliverySchema parses a default-positive outcome + empty decision_note", () => {
    const body = {
      ...VALID_DELIVERY_BASE,
      outcome_id: "approve",
      decision_note: "",
    };
    const parsed = DecisionDeliverySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision_note).toBe("");
    }
  });

  it("DecisionDeliverySchema fills decision_note='' when the key is absent (alpha-13 EF forward-compat)", () => {
    // Simulates an alpha-13 deploy of deliver-decision that never
    // emitted decision_note. Without z.string().default(""), parse
    // would fail and the node would 400 on otherwise-valid deliveries
    // during the rollout window.
    const body = { ...VALID_DELIVERY_BASE };
    const parsed = DecisionDeliverySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision_note).toBe("");
    }
  });
});

describe("cross-decoder consistency: outputs.ts ↔ errors.ts", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: both decoders agree`, () => {
      const sandboxResult = configuredOutputs(buildParameter(fixture.value));
      const nodeResult = decodeSnapshot(fixture.value);

      // Acceptance set: both reject (empty) or both accept (non-empty).
      if (fixture.expectedOutcomes.length === 0) {
        // Sandbox returns [] on rejection (no Dismissed/Timed Out
        // tail when there's no valid snapshot).
        expect(sandboxResult).toEqual([]);
        expect(nodeResult).toEqual([]);
        return;
      }

      // Sandbox returns named outcomes + Dismissed + Timed Out.
      // Strip the trailing two synthetic entries to compare against
      // the Node decoder's raw output.
      expect(sandboxResult.length).toBe(fixture.expectedOutcomes.length + 2);
      expect(sandboxResult[sandboxResult.length - 2]).toEqual({
        type: "main",
        displayName: "Dismissed",
      });
      expect(sandboxResult[sandboxResult.length - 1]).toEqual({
        type: "main",
        displayName: "Timed Out",
      });

      const sandboxNamed = sandboxResult.slice(0, -2);
      // Per-index label parity.
      for (let i = 0; i < fixture.expectedOutcomes.length; i++) {
        expect(sandboxNamed[i]).toEqual({
          type: "main",
          displayName: fixture.expectedOutcomes[i].label,
        });
      }

      // Node decoder: id + label round-trip the source fixture.
      expect(nodeResult).toEqual(fixture.expectedOutcomes);
    });
  }
});
