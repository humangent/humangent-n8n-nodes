// Verification that the Humangent Continue node's `outputs`
// expression renders the same per-outcome branches as the inline
// Humangent node. Continue reuses `configuredOutputs` from the
// inline node verbatim — so this test confirms the descriptor
// wiring lines up with the canvas-rendering decoder.
//
// The cross-decoder consistency between sandbox + Node-runtime
// decoders is exercised in `Humangent/decoders.cross.test.ts` (which
// also covers Continue's path since it uses the same
// `configuredOutputs` source).

import { describe, expect, it } from "vitest";

import { Humangent } from "../Humangent/Humangent.node";
import { encodeTaskTypeValue } from "../Humangent/listSearch";
import { configuredOutputs } from "../Humangent/outputs";
import { HumangentContinue } from "./HumangentContinue.node";

const TASK_TYPE_ID = "00000000-0000-0000-0000-000000000001";
const continueDescriptor = new HumangentContinue().description;
const inlineDescriptor = new Humangent().description;

describe("HumangentContinue outputs expression", () => {
  it("outputs expression embeds configuredOutputs source", () => {
    // The descriptor declares
    // `={{(${configuredOutputs.toString()})($parameter)}}`. Continue
    // and the inline node share the same source string, so the
    // canvas branches render identically when both nodes pick the
    // same task type.
    const expr = continueDescriptor.outputs as string;
    expect(expr.startsWith("={{")).toBe(true);
    expect(expr).toContain("$parameter");
    // The function body is embedded verbatim — proven by checking a
    // canonical token configuredOutputs produces.
    expect(expr).toContain("Dismissed");
    expect(expr).toContain("Timed Out");
  });

  it("renders one per-outcome branch + Dismissed + Timed Out for a two-outcome task type", () => {
    const value = encodeTaskTypeValue(TASK_TYPE_ID, [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]);
    const branches = configuredOutputs({ taskType: value });
    expect(branches.map((b) => b.displayName)).toEqual([
      "Approve",
      "Reject",
      "Dismissed",
      "Timed Out",
    ]);
    for (const b of branches) {
      expect(b.type).toBe("main");
    }
  });

  it("returns an empty array when task type has zero outcomes (degenerate snapshot)", () => {
    // Empty snapshot — return an empty list. n8n renders a
    // zero-output node (the "needs configuration" hint state).
    // configuredOutputs is intentionally strict here so the canvas
    // doesn't fabricate branches that cannot fire.
    const value = encodeTaskTypeValue(TASK_TYPE_ID, []);
    const branches = configuredOutputs({ taskType: value });
    expect(branches).toEqual([]);
  });

  it("returns an empty array when no task type is picked (freshly placed Continue)", () => {
    // Default RL value is `{ mode: 'list', value: '' }`, which
    // unwraps to the empty string. configuredOutputs returns [] so
    // the canvas shows the no-config state.
    expect(configuredOutputs({ taskType: "" })).toEqual([]);
  });

  it("matches the inline Humangent node's outputs expression character-for-character", () => {
    // Continue and the inline node MUST share the same expression
    // body so picking the same task type produces the same canvas
    // branches in both nodes. Compare against the inline node's
    // ACTUAL descriptor (not just `configuredOutputs.toString()`) so
    // that any drift in the inline-side expression — wrapping syntax,
    // arg list, alpha-21 mode-aware logic — fails this test loudly.
    // Reading the value from the live descriptor closes the gap
    // CodeRabbit flagged: previously this only proved Continue
    // embedded `configuredOutputs.toString()`, not that Continue's
    // expression matched the inline node's actual string.
    expect(continueDescriptor.outputs).toBe(inlineDescriptor.outputs);
    // Sanity: both expressions reference the function body (canary
    // against a future refactor that hard-codes a string).
    expect(continueDescriptor.outputs as string).toContain(
      configuredOutputs.name,
    );
  });

  it("preserves outcome order across more than three branches", () => {
    const outcomes = [
      { id: "ship", label: "Ship it" },
      { id: "block", label: "Block" },
      { id: "escalate", label: "Escalate" },
      { id: "delegate", label: "Delegate" },
    ];
    const branches = configuredOutputs({
      taskType: encodeTaskTypeValue(TASK_TYPE_ID, outcomes),
    });
    expect(branches.map((b) => b.displayName)).toEqual([
      "Ship it",
      "Block",
      "Escalate",
      "Delegate",
      "Dismissed",
      "Timed Out",
    ]);
  });
});
