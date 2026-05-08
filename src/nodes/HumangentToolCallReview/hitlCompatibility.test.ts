// U1 — pin n8n's HITL eligibility contract for the new node.
//
// n8n auto-wraps any installed node whose descriptor satisfies
// `hasSendAndWaitOperation` from `n8n/dist/tool-generation/hitl-tools.js`:
//
//   1. `name` does NOT end with the string "Tool" (otherwise the
//      generator skips, treating it as an already-wrapped variant).
//   2. `webhooks` is non-empty.
//   3. `properties` contains at least one element with `name ===
//      "operation"` whose `options` array contains `{ value:
//      SEND_AND_WAIT_OPERATION }`.
//
// These tests reimplement the predicate verbatim so a future
// inadvertent regression in our descriptor (hidden the operation,
// dropped the webhook, suffixed the name with "Tool") fails here
// with a clear message instead of silently de-listing the node from
// n8n's HITL surface.
//
// Tested against n8n 2.18.5 (the version installed in the workspace's
// docker container at the time of writing). The contract has been
// stable since the HITL feature shipped; if a future n8n release
// adds new prerequisites, surface the change here first.

import { describe, expect, it } from "vitest";
import { SEND_AND_WAIT_OPERATION } from "n8n-workflow";

import { HumangentToolCallReview } from "./HumangentToolCallReview.node";

// Reimplementation of n8n's hasSendAndWaitOperation predicate.
// Mirrors `cli/src/tool-generation/hitl-tools.ts` — keep the logic
// byte-for-byte aligned. If n8n ships a behavioural change, fix it
// here AND surface a comment pointing at the upstream version.
function hasSendAndWaitOperation(nodeType: {
  name: string;
  webhooks?: unknown[];
  properties: Array<{
    name: string;
    options?: unknown;
  }>;
}): boolean {
  if (nodeType.name.endsWith("Tool")) return false;
  if (!nodeType.webhooks || nodeType.webhooks.length === 0) return false;
  const operationProps = nodeType.properties.filter(
    (p) => p.name === "operation",
  );
  if (operationProps.length === 0) return false;
  for (const operationProp of operationProps) {
    if (!Array.isArray(operationProp.options)) continue;
    const hasSendAndWait = operationProp.options.some(
      (opt) =>
        typeof opt === "object" &&
        opt !== null &&
        "value" in opt &&
        (opt as { value: unknown }).value === SEND_AND_WAIT_OPERATION,
    );
    if (hasSendAndWait) return true;
  }
  return false;
}

describe("HumangentToolCallReview — n8n HITL eligibility", () => {
  const node = new HumangentToolCallReview();
  const description = node.description;

  it("name does NOT end with 'Tool' — required by hasSendAndWaitOperation", () => {
    expect(description.name.endsWith("Tool")).toBe(false);
  });

  it("declares at least one webhook descriptor", () => {
    expect(Array.isArray(description.webhooks)).toBe(true);
    expect((description.webhooks ?? []).length).toBeGreaterThan(0);
  });

  it("exposes the SEND_AND_WAIT_OPERATION value via an options-typed `operation` property (not hidden)", () => {
    // `type: hidden` properties have no `options` array; n8n's HITL
    // detector iterates `operationProp.options` and short-circuits.
    // The wrapped HitlTool variant hides the property automatically
    // via filterHitlToolProperties at convert time, so exposing
    // options here doesn't bleed into the agent UI.
    const operationProp = description.properties.find(
      (p) => p.name === "operation",
    );
    expect(operationProp).toBeDefined();
    expect(operationProp?.type).toBe("options");
    expect(Array.isArray((operationProp as { options?: unknown }).options)).toBe(
      true,
    );
    const options = (operationProp as { options: Array<{ value: unknown }> })
      .options;
    expect(options.some((opt) => opt.value === SEND_AND_WAIT_OPERATION)).toBe(
      true,
    );
  });

  it("passes hasSendAndWaitOperation — n8n WILL register the auto-generated HitlTool variant", () => {
    expect(
      hasSendAndWaitOperation({
        name: description.name,
        webhooks: description.webhooks as unknown[] | undefined,
        properties: description.properties as Array<{
          name: string;
          options?: unknown;
        }>,
      }),
    ).toBe(true);
  });

  it("rejects a malformed clone whose operation is hidden — guards against accidentally hiding the property", () => {
    // Sanity check that the predicate would correctly reject a
    // descriptor with a hidden `operation` (mirroring the existing
    // approval node in this repo, which intentionally is NOT
    // HITL-eligible). If this assertion changes, n8n's predicate
    // changed too — sync with upstream.
    expect(
      hasSendAndWaitOperation({
        name: "humangentToolCallReview",
        webhooks: [{ name: "default" }],
        properties: [
          {
            name: "operation",
            // No `options` — a `type: "hidden"` property looks like this.
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a clone whose name suffixes 'Tool' — guards against the convention slip", () => {
    expect(
      hasSendAndWaitOperation({
        name: "humangentToolCallReviewTool",
        webhooks: [{ name: "default" }],
        properties: [
          {
            name: "operation",
            options: [{ value: SEND_AND_WAIT_OPERATION }],
          },
        ],
      }),
    ).toBe(false);
  });
});
