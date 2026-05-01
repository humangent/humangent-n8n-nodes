// Test the canvas-render decoder. Pairs the inputs configuredOutputs
// will see in n8n's expression sandbox at canvas render time:
//
//   $parameter.taskType =
//     "<task-type-id>#o=<encodeURIComponent(JSON.stringify([{id, label}, ...]))>"
//
// n8n's WorkflowDataProxy auto-unwraps a resourceLocator parameter to
// its `.value` string before reaching expressions. configuredOutputs
// receives that string as `parameter.taskType` and decodes the `#o=`
// fragment off the end. When the snapshot is missing, malformed, or
// partially malformed, configuredOutputs returns `[]` (whole-array
// validation — partial render is worse than no render).

import { describe, expect, it } from "vitest";

import { configuredOutputs } from "./outputs";

/** Build a `value` string the decoder will round-trip. */
function snapshotValue(
  taskTypeId: string,
  outcomes: Array<{ id: string; label: string }>,
): string {
  return `${taskTypeId}#o=${encodeURIComponent(JSON.stringify(outcomes))}`;
}

describe("configuredOutputs (canvas render — sandbox decoder)", () => {
  it("returns zero branches when $parameter is missing", () => {
    expect(configuredOutputs(undefined)).toEqual([]);
  });

  it("returns zero branches for a non-object parameter", () => {
    expect(configuredOutputs("anything")).toEqual([]);
    expect(configuredOutputs(42)).toEqual([]);
  });

  it("returns zero branches when taskType is missing", () => {
    expect(configuredOutputs({})).toEqual([]);
  });

  it("returns zero branches when taskType is an empty string", () => {
    expect(configuredOutputs({ taskType: "" })).toEqual([]);
  });

  it("returns zero branches when taskType is the unwrapped object (alpha.10–alpha.13 fixture)", () => {
    // Defensive: if a workflow is somehow re-introducing the old RL
    // object shape into expressions, treat it as missing rather than
    // half-render. Workflows saved on alpha.10–alpha.13 will hit this
    // branch — re-pick the task type to refresh.
    expect(
      configuredOutputs({
        taskType: { __rl: true, mode: "list", value: "abc" },
      }),
    ).toEqual([]);
  });

  it("returns zero branches when taskType has no #o= fragment (only the id)", () => {
    expect(configuredOutputs({ taskType: "abc" })).toEqual([]);
  });

  it("returns zero branches when the #o= fragment is corrupt JSON", () => {
    expect(configuredOutputs({ taskType: "abc#o=not-json" })).toEqual([]);
  });

  it("returns zero branches when the snapshot decodes to a non-array", () => {
    const value = `abc#o=${encodeURIComponent("{}")}`;
    expect(configuredOutputs({ taskType: value })).toEqual([]);
  });

  it("returns zero branches when the snapshot is an empty array", () => {
    const value = `abc#o=${encodeURIComponent("[]")}`;
    expect(configuredOutputs({ taskType: value })).toEqual([]);
  });

  it("rejects the WHOLE snapshot if any item is missing id or label", () => {
    // alpha.14 design: half-rendered canvas is worse than no canvas.
    const value = snapshotValue("abc", [
      { id: "approve", label: "Approve" },
      { id: "", label: "Empty id" } as { id: string; label: string },
    ]);
    expect(configuredOutputs({ taskType: value })).toEqual([]);
  });

  it("rejects the WHOLE snapshot if any item has non-string id/label", () => {
    const malformed = `abc#o=${encodeURIComponent(
      JSON.stringify([
        { id: "approve", label: "Approve" },
        { id: 1, label: "Number id" },
      ]),
    )}`;
    expect(configuredOutputs({ taskType: malformed })).toEqual([]);
  });

  it("emits one branch per outcome + Dismissed + Timed Out", () => {
    const value = snapshotValue("abc", [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]);
    expect(configuredOutputs({ taskType: value })).toEqual([
      { type: "main", displayName: "Approve" },
      { type: "main", displayName: "Reject" },
      { type: "main", displayName: "Dismissed" },
      { type: "main", displayName: "Timed Out" },
    ]);
  });

  it("preserves outcome order from the snapshot", () => {
    const value = snapshotValue("abc", [
      { id: "reject", label: "Reject" },
      { id: "approve", label: "Approve" },
    ]);
    const named = configuredOutputs({ taskType: value })
      .map((o) => o.displayName)
      .slice(0, -2);
    expect(named).toEqual(["Reject", "Approve"]);
  });

  it("does NOT emit category:error on the Timed Out output", () => {
    const value = snapshotValue("abc", [{ id: "approve", label: "Approve" }]);
    const result = configuredOutputs({ taskType: value });
    for (const out of result) {
      expect(out).not.toHaveProperty("category");
    }
  });

  it("snapshot length parity — encoded value decodes back to exactly N outcomes", () => {
    // Defends against subset-encoding bugs where the encoder
    // accidentally slices the source array. Round-trip JSON would
    // still parse, but length would not match. This test fails fast
    // when an implementation bug silently drops outcomes — the
    // gateway's `_validate_resume_urls` requires the FULL outcomes
    // set.
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `o${i}`,
      label: `Outcome ${i}`,
    }));
    const value = snapshotValue("abc", seven);
    const result = configuredOutputs({ taskType: value });
    // 7 outcomes + Dismissed + Timed Out = 9 branches
    expect(result.length).toBe(9);
  });

  it("decodes Unicode + URL-reserved characters in labels", () => {
    const value = snapshotValue("abc", [
      { id: "approve", label: "Approve & notify — accounting" },
      { id: "reject", label: "Reject 🚫 with reason: foo=bar" },
    ]);
    const named = configuredOutputs({ taskType: value })
      .map((o) => o.displayName)
      .slice(0, -2);
    expect(named).toEqual([
      "Approve & notify — accounting",
      "Reject 🚫 with reason: foo=bar",
    ]);
  });

  it("uses lastIndexOf so any earlier `#o=` substrings in the id are tolerated", () => {
    // Defensive: if a future task-type id ever contains the marker
    // (it shouldn't — UUIDs only have hex), the LAST occurrence wins.
    const fragment = encodeURIComponent(
      JSON.stringify([{ id: "approve", label: "Approve" }]),
    );
    // Unlikely but exercising the lastIndexOf safety path.
    const value = `weird#o=earlier#o=${fragment}`;
    const named = configuredOutputs({ taskType: value })
      .map((o) => o.displayName)
      .slice(0, -2);
    expect(named).toEqual(["Approve"]);
  });

  // alpha.21 detached-mode short-circuit. When the action node is in
  // `Create` mode, execute() returns a single Main output and the
  // canvas needs to declare a single `Created` branch — otherwise the
  // detached payload lands on the canvas position labeled with the
  // first task-type outcome ("Approve" et al.).

  it("returns a single `Created` branch when mode is `create`, regardless of taskType snapshot", () => {
    const value = snapshotValue("00000000-0000-0000-0000-000000000001", [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]);
    expect(configuredOutputs({ mode: "create", taskType: value })).toEqual([
      { type: "main", displayName: "Created" },
    ]);
  });

  it("returns a single `Created` branch when mode is `create` and taskType is empty (fresh-place state)", () => {
    expect(configuredOutputs({ mode: "create", taskType: "" })).toEqual([
      { type: "main", displayName: "Created" },
    ]);
  });

  it("renders the snapshot-driven branches when mode is `createAndWait` (default path preserved)", () => {
    const value = snapshotValue("00000000-0000-0000-0000-000000000001", [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ]);
    expect(
      configuredOutputs({ mode: "createAndWait", taskType: value }),
    ).toEqual([
      { type: "main", displayName: "Approve" },
      { type: "main", displayName: "Reject" },
      { type: "main", displayName: "Dismissed" },
      { type: "main", displayName: "Timed Out" },
    ]);
  });

  it("renders the snapshot-driven branches when mode is unset (alpha.20 backwards-compat)", () => {
    // Saved alpha.20 workflows that predate the `mode` property carry
    // no `mode` value at all. n8n's parameter resolution falls back
    // to the descriptor's default (`createAndWait`); even if it didn't,
    // a missing `mode` should never accidentally route into the
    // detached single-branch path.
    const value = snapshotValue("00000000-0000-0000-0000-000000000001", [
      { id: "approve", label: "Approve" },
    ]);
    expect(configuredOutputs({ taskType: value })).toEqual([
      { type: "main", displayName: "Approve" },
      { type: "main", displayName: "Dismissed" },
      { type: "main", displayName: "Timed Out" },
    ]);
  });

  it("self-containment: the function string references no forbidden globals", () => {
    // configuredOutputs runs in n8n's expression sandbox. The sandbox
    // exposes JSON, String, Array, Object, encodeURIComponent,
    // decodeURIComponent — but NOT atob / btoa / URLSearchParams /
    // URL / fetch / Buffer / require / import. A regression that
    // pulls one of those in via a casual refactor will silently break
    // the canvas render.
    const src = configuredOutputs.toString();
    const forbidden = [
      /\batob\b/,
      /\bbtoa\b/,
      /\bURLSearchParams\b/,
      /\bURL\b/,
      /\bfetch\b/,
      /\bBuffer\b/,
      /\brequire\b/,
      /\bimport\b/,
      /\bNodeConnectionType\b/,
    ];
    for (const pattern of forbidden) {
      expect(src).not.toMatch(pattern);
    }
  });
});
