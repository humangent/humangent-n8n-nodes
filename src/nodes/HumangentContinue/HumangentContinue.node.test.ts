// Lock-in tests for the Humangent Continue node's descriptor. These
// pin the n8n-builder-surface shape so a regression that would
// silently break the trigger registration (missing credential, wrong
// webhook shape, mis-grouped node) fails CI rather than showing up
// as a broken installed node.
//
// webhookMethods runtime behavior lives in continueRegistration.test.ts.
// webhook() runtime handler lives in continueWebhook.test.ts (U4).

import { describe, expect, it } from "vitest";

import { HumangentContinue } from "./HumangentContinue.node";

const node = new HumangentContinue();
const descriptor = node.description;

describe("HumangentContinue.node descriptor", () => {
  it("declares the canonical n8n identity for a trigger node", () => {
    expect(descriptor.name).toBe("humangentContinue");
    expect(descriptor.displayName).toBe("Humangent Continue");
    expect(descriptor.version).toBe(1);
    expect(descriptor.group).toEqual(["trigger"]);
  });

  it("declares zero inputs (trigger nodes don't take an input main lane)", () => {
    expect(descriptor.inputs).toEqual([]);
  });

  it("requires the humangentApi credential", () => {
    expect(descriptor.credentials).toEqual([
      { name: "humangentApi", required: true },
    ]);
  });

  it("points to the bundled SVG icon", () => {
    expect(descriptor.icon).toBe("file:humangent.svg");
  });

  it("declares one POST webhook keyed on $webhookId with isFullPath", () => {
    // Continue intentionally diverges from the inline Humangent
    // node's restartWebhook + path:$nodeId pair. Trigger registration
    // mounts on n8n's stable webhookId so the registered URL
    // survives node renames; restartWebhook is OFF because Continue
    // is a real trigger, not a resume webhook.
    expect(descriptor.webhooks).toHaveLength(1);
    const hook = descriptor.webhooks![0];
    expect(hook.name).toBe("default");
    expect(hook.httpMethod).toBe("POST");
    expect(hook.responseMode).toBe("onReceived");
    expect(hook.isFullPath).toBe(true);
    expect(hook.path).toBe("={{$webhookId}}");
    expect(
      (hook as { restartWebhook?: boolean }).restartWebhook,
    ).toBeUndefined();
  });

  it("subtitle keeps the truthy-check pattern with a `· Continue` suffix", () => {
    // Mirrors inline node's pattern (do NOT reach for cachedResultName,
    // which n8n's WorkflowDataProxy auto-unwraps out of view) and
    // adds a static suffix so canvases with both nodes are
    // unambiguous at a glance.
    expect(descriptor.subtitle).toContain('$parameter["taskType"]');
    expect(descriptor.subtitle).toContain('"Continue"');
    expect(descriptor.subtitle).toContain('"Pick a task type"');
    expect(descriptor.subtitle).toContain("· Continue");
    expect(descriptor.subtitle as string).not.toContain("cachedResultName");
  });

  it("embeds configuredOutputs as a live expression so branches render from the snapshot", () => {
    // R7: Continue's outputs reuse the inline node's
    // `configuredOutputs` verbatim so the per-outcome / Dismissed /
    // Timed Out branches render identically across both nodes.
    expect(typeof descriptor.outputs).toBe("string");
    const expr = descriptor.outputs as string;
    expect(expr.startsWith("={{")).toBe(true);
    expect(expr).toContain("$parameter");
  });

  it("declares taskType as a resourceLocator restricted to From-List mode", () => {
    const taskType = descriptor.properties.find((p) => p.name === "taskType");
    expect(taskType?.type).toBe("resourceLocator");
    const modes =
      (taskType as { modes?: Array<{ name: string }> } | undefined)?.modes?.map(
        (m) => m.name,
      ) ?? [];
    expect(modes).toEqual(["list"]);
  });

  it("registers the listSearch.listTaskTypes method on the class", () => {
    expect(node.methods.listSearch.listTaskTypes).toBeTypeOf("function");
  });

  it("wires webhookMethods.default lifecycle (checkExists, create, delete)", () => {
    const def = node.webhookMethods.default;
    expect(def.checkExists).toBeTypeOf("function");
    expect(def.create).toBeTypeOf("function");
    expect(def.delete).toBeTypeOf("function");
  });

  it("exposes the runtime webhook() method (handler wired in U4)", () => {
    expect(node.webhook).toBeTypeOf("function");
  });
});
