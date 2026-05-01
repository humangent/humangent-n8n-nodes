// Lock-in tests for the Humangent node's descriptor. These are not
// behavior tests — they assert the shape of the INodeTypeDescription
// so regressions that would break the n8n builder surface (missing
// credential, wrong webhook shape, outputs expression mangled) fail
// CI rather than showing up as a broken installed node.
//
// execute() + webhook() runtime behavior lands in Units 4 + 5; those
// units carry their own tests.

import { describe, expect, it } from "vitest";

import { Humangent } from "./Humangent.node";

const node = new Humangent();
const descriptor = node.description;

describe("Humangent.node descriptor", () => {
  it("declares the canonical n8n identity", () => {
    expect(descriptor.name).toBe("humangent");
    expect(descriptor.displayName).toBe("Humangent");
    expect(descriptor.version).toBe(1);
    expect(descriptor.group).toEqual(["transform"]);
  });

  it("points to the bundled SVG icon", () => {
    expect(descriptor.icon).toBe("file:humangent.svg");
  });

  it("requires the humangentApi credential", () => {
    expect(descriptor.credentials).toEqual([
      { name: "humangentApi", required: true },
    ]);
  });

  it("declares the canonical sendAndWait webhook pair (GET + POST, restartWebhook, isFullPath)", () => {
    // Mirrors n8n's `sendAndWaitWebhooksDescription` from
    // packages/nodes-base/utils/sendAndWait/descriptions.ts. Both
    // entries share name + path + restartWebhook + isFullPath; the
    // only difference is httpMethod.
    expect(descriptor.webhooks).toHaveLength(2);
    for (const hook of descriptor.webhooks!) {
      expect(hook.name).toBe("default");
      expect(hook.responseMode).toBe("onReceived");
      expect(hook.restartWebhook).toBe(true);
      expect(hook.isFullPath).toBe(true);
      expect(hook.path).toBe("={{ $nodeId }}");
    }
    const methods = descriptor.webhooks!.map((h) => h.httpMethod).sort();
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("declares the hidden operation: sendAndWait marker for n8n's HMAC waiting-webhook validator branch", () => {
    // Empirical: without this marker, n8n core's WaitingWebhooks
    // validator falls into the validateToken branch that compares
    // the URL signature against `data.resumeToken` (opaque) and
    // 401s every signed delivery on a hosted n8n instance. alpha.14
    // wrongly removed it; alpha.17 brings it back. Editor-ui
    // references to SEND_AND_WAIT_OPERATION are benign (tooltip +
    // wait-state label) — see node-descriptor comment block.
    const op = descriptor.properties.find((p) => p.name === "operation");
    expect(op).toBeDefined();
    expect(op?.type).toBe("hidden");
    expect(op?.default).toBe("sendAndWait");
  });

  it("declares the user-facing `mode` dropdown alongside the hidden operation marker", () => {
    // alpha.21: detached-mode plan adds a user-facing toggle between
    // the inline `Create and Wait` path (existing v1 behavior) and
    // the new `Create` path that hands decisions off to a Humangent
    // Continue node in another workflow. The hidden `operation`
    // property above stays pinned to SEND_AND_WAIT_OPERATION in
    // BOTH modes — n8n core reads `operation` for its HMAC validator
    // branch, not `mode`. Default is `createAndWait` so saved alpha.20
    // workflows without the field continue to take the inline path.
    const mode = descriptor.properties.find((p) => p.name === "mode");
    expect(mode).toBeDefined();
    expect(mode?.type).toBe("options");
    expect(mode?.default).toBe("createAndWait");
    const values = (
      mode as { options?: Array<{ value: string }> } | undefined
    )?.options?.map((o) => o.value);
    expect(values).toEqual(["createAndWait", "create"]);
  });

  it("subtitle expression flips on mode without introducing cachedResultName", () => {
    // n8n's WorkflowDataProxy auto-unwraps resourceLocator parameters
    // so `cachedResultName` is unreachable from canvas expressions.
    // Subtitle keeps the truthy-check pattern and adds a mode-aware
    // suffix.
    expect(descriptor.subtitle).toContain('$parameter["taskType"]');
    expect(descriptor.subtitle).toContain('$parameter["mode"]');
    expect(descriptor.subtitle).toContain('"Create"');
    expect(descriptor.subtitle).toContain('"Wait for human decision"');
    expect(descriptor.subtitle).toContain('"Pick a task type"');
    expect(descriptor.subtitle as string).not.toContain("cachedResultName");
  });

  it("renders existing properties in both modes via displayOptions", () => {
    // Smoke check: the properties that existed pre-alpha.21 (taskType,
    // fields, limitWaitTime, limitWaitTimeUnit, parentRequestId) all
    // declare `displayOptions.show.mode` covering BOTH modes, so the
    // saved-workflow path with the default `mode === createAndWait`
    // continues to render every property unchanged.
    const sharedNames = [
      "taskType",
      "fields",
      "limitWaitTime",
      "limitWaitTimeUnit",
      "parentRequestId",
    ];
    for (const name of sharedNames) {
      const prop = descriptor.properties.find((p) => p.name === name);
      expect(prop, `expected property ${name}`).toBeDefined();
      const show = (
        prop as { displayOptions?: { show?: { mode?: string[] } } } | undefined
      )?.displayOptions?.show?.mode;
      expect(show, `expected displayOptions.show.mode on ${name}`).toEqual([
        "createAndWait",
        "create",
      ]);
    }
  });

  it("embeds the configuredOutputs function as a live expression", () => {
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
    // alpha.10: By-ID and expression modes are dropped — workflow
    // authors must pick a static task type so configuredOutputs has a
    // deterministic snapshot to render branches from.
    expect(modes).toEqual(["list"]);
  });

  it("does NOT declare an outcomes multiOptions parameter", () => {
    // alpha.10 dropped the user-facing `outcomes` field — outcomes
    // come from the task type's snapshot on cachedResultUrl, not from
    // user selection.
    const outcomes = descriptor.properties.find((p) => p.name === "outcomes");
    expect(outcomes).toBeUndefined();
  });

  it("declares fields as a resourceMapper bound to getTaskTypeSchema", () => {
    const fields = descriptor.properties.find((p) => p.name === "fields");
    expect(fields?.type).toBe("resourceMapper");
    const opts = fields?.typeOptions as
      | { resourceMapper?: { resourceMapperMethod?: string } }
      | undefined;
    expect(opts?.resourceMapper?.resourceMapperMethod).toBe(
      "getTaskTypeSchema",
    );
  });

  it("has a Limit Wait Time number + unit pair", () => {
    const limit = descriptor.properties.find((p) => p.name === "limitWaitTime");
    const unit = descriptor.properties.find(
      (p) => p.name === "limitWaitTimeUnit",
    );
    expect(limit?.type).toBe("number");
    expect(limit?.default).toBe(24);
    expect(unit?.type).toBe("options");
    const unitValues = (
      unit as { options?: Array<{ value: string }> } | undefined
    )?.options?.map((o) => o.value);
    expect(unitValues).toEqual(["minutes", "hours", "days"]);
  });

  it("registers listSearch + resourceMapping methods on the class", () => {
    expect(node.methods.listSearch.listTaskTypes).toBeTypeOf("function");
    expect(node.methods.resourceMapping.getTaskTypeSchema).toBeTypeOf(
      "function",
    );
    // alpha.10: methods.loadOptions is gone (was only used by the
    // dropped `outcomes` multiOptions field).
    expect(
      (node.methods as { loadOptions?: unknown }).loadOptions,
    ).toBeUndefined();
  });

  it("wires execute and webhook onto runtime implementations", () => {
    // Behavior for each path lives in execute.test.ts and
    // webhook.test.ts; this descriptor test just asserts that the
    // class's runtime methods are present + function-typed (not the
    // Unit-3-era stubs that threw).
    expect(node.execute).toBeTypeOf("function");
    expect(node.webhook).toBeTypeOf("function");
  });
});
