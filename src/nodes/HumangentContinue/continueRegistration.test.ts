// Tests for the Humangent Continue node's webhookMethods lifecycle.
// These exercise the activation / deactivation / pre-activation
// paths against mocked HTTP + n8n hook contexts.

import { describe, expect, it, vi } from "vitest";

import { NodeOperationError } from "n8n-workflow";

import { encodeTaskTypeValue } from "../Humangent/listSearch";
import {
  activationCheckExists,
  activationCreate,
  activationDelete,
} from "./continueRegistration";

const TASK_TYPE_ID = "00000000-0000-0000-0000-000000000001";
const INSTANCE_ID = "00000000-0000-0000-0000-0000000000aa";
const WORKFLOW_ID = "wf_456";
const NODE_ID = "node_humangent_continue_1";
const WEBHOOK_URL = "https://n8n.example.com/webhook/abc123";
const SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111";

interface HookOverrides {
  taskTypeRLValue?: string | null;
  webhookUrl?: string | null;
  instanceId?: string;
  staticData?: Record<string, unknown>;
  httpRequest?: ReturnType<typeof vi.fn>;
}

type HttpRequestArgs = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function defaultRegisterMock() {
  return vi.fn(async (opts: HttpRequestArgs) => {
    if (opts.url.endsWith("/rpc/api_register_subscription")) {
      return { id: SUBSCRIPTION_ID };
    }
    if (opts.url.endsWith("/rpc/api_unregister_subscription")) {
      return { id: SUBSCRIPTION_ID, deleted: true };
    }
    throw new Error(`unexpected RPC: ${opts.url}`);
  });
}

function makeHookCtx(overrides: HookOverrides = {}) {
  const {
    taskTypeRLValue,
    webhookUrl = WEBHOOK_URL,
    instanceId = INSTANCE_ID,
    staticData = {},
    httpRequest = defaultRegisterMock(),
  } = overrides;

  const taskTypeParam = {
    __rl: true,
    mode: "list",
    value:
      taskTypeRLValue !== undefined
        ? (taskTypeRLValue ?? "")
        : encodeTaskTypeValue(TASK_TYPE_ID, [
            { id: "approve", label: "Approve" },
            { id: "reject", label: "Reject" },
          ]),
  };

  return {
    helpers: { httpRequest },
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: "hmk_live_abc",
      instanceId,
    }),
    getNodeParameter: vi.fn().mockReturnValue(taskTypeParam),
    getNodeWebhookUrl: vi.fn().mockReturnValue(webhookUrl ?? undefined),
    getWorkflow: vi.fn().mockReturnValue({ id: WORKFLOW_ID }),
    getNode: vi.fn().mockReturnValue({
      id: NODE_ID,
      name: "Humangent Continue",
      type: "@humangent/n8n-nodes-humangent.humangentContinue",
      typeVersion: 1,
    }),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as never;
}

describe("activationCreate (webhookMethods.default.create)", () => {
  it("registers the subscription and writes subscription_id + webhook_url to static data", async () => {
    const httpRequest = defaultRegisterMock();
    const staticData: Record<string, unknown> = {};
    const ctx = makeHookCtx({ httpRequest, staticData });

    const result = await activationCreate.call(ctx);
    expect(result).toBe(true);

    // Posted the canonical wire shape.
    expect(httpRequest).toHaveBeenCalledTimes(1);
    const call = httpRequest.mock.calls[0][0];
    expect(call.url).toContain("/rpc/api_register_subscription");
    expect(call.body).toEqual({
      p_workflow_id: WORKFLOW_ID,
      p_node_id: NODE_ID,
      p_n8n_instance_id: INSTANCE_ID,
      p_webhook_url: WEBHOOK_URL,
      p_task_type_id: TASK_TYPE_ID,
    });
    expect(call.headers["X-Humangent-API-Key"]).toBe("hmk_live_abc");

    // Static data captured.
    const stored = staticData["humangentContinueSubscription"] as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      subscriptionId: SUBSCRIPTION_ID,
      webhookUrl: WEBHOOK_URL,
      taskTypeId: TASK_TYPE_ID,
    });
  });

  it("throws NodeOperationError when getNodeWebhookUrl returns undefined", async () => {
    const httpRequest = defaultRegisterMock();
    const ctx = makeHookCtx({ httpRequest, webhookUrl: null });
    await expect(activationCreate.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("throws NodeOperationError when the credential's instanceId is missing", async () => {
    const httpRequest = defaultRegisterMock();
    const ctx = makeHookCtx({ httpRequest, instanceId: "" });
    await expect(activationCreate.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("throws NodeOperationError when the Task Type picker is empty", async () => {
    const httpRequest = defaultRegisterMock();
    const ctx = makeHookCtx({ httpRequest, taskTypeRLValue: null });
    await expect(activationCreate.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("surfaces backend allowlist errors as NodeOperationError so n8n refuses to activate", async () => {
    const httpRequest = vi.fn(async () => {
      const err: Record<string, unknown> = {
        statusCode: 403,
        response: {
          statusCode: 403,
          body: {
            code: "P0001",
            hint: "n8n_origin_not_allowed:https://n8n.acme.com",
            message: "origin not allowed: https://n8n.acme.com",
          },
        },
      };
      throw err;
    });
    const ctx = makeHookCtx({ httpRequest });
    await expect(activationCreate.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
  });

  it("surfaces n8n_allowed_origins_unset so admins know to bootstrap the allowlist", async () => {
    const httpRequest = vi.fn(async () => {
      const err: Record<string, unknown> = {
        statusCode: 403,
        response: {
          statusCode: 403,
          body: {
            code: "P0001",
            hint: "n8n_allowed_origins_unset",
            message: "n8n_allowed_origins not configured for org",
          },
        },
      };
      throw err;
    });
    const ctx = makeHookCtx({ httpRequest });
    await expect(activationCreate.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
  });

  it("decodes the task type id from a `<id>#o=<encoded>` resource locator value", async () => {
    const httpRequest = defaultRegisterMock();
    const ctx = makeHookCtx({ httpRequest });
    await activationCreate.call(ctx);
    const call = httpRequest.mock.calls[0][0];
    expect(call.body.p_task_type_id).toBe(TASK_TYPE_ID);
  });
});

describe("activationDelete (webhookMethods.default.delete)", () => {
  it("calls api_unregister_subscription with the stored subscription id and clears static data", async () => {
    const httpRequest = defaultRegisterMock();
    const staticData: Record<string, unknown> = {
      humangentContinueSubscription: {
        subscriptionId: SUBSCRIPTION_ID,
        webhookUrl: WEBHOOK_URL,
        taskTypeId: TASK_TYPE_ID,
      },
    };
    const ctx = makeHookCtx({ httpRequest, staticData });

    const result = await activationDelete.call(ctx);
    expect(result).toBe(true);

    expect(httpRequest).toHaveBeenCalledTimes(1);
    const call = httpRequest.mock.calls[0][0];
    expect(call.url).toContain("/rpc/api_unregister_subscription");
    expect(call.body).toEqual({ p_subscription_id: SUBSCRIPTION_ID });

    expect(staticData["humangentContinueSubscription"]).toBeUndefined();
  });

  it("returns true (no-op) when static data has no subscription id", async () => {
    const httpRequest = defaultRegisterMock();
    const ctx = makeHookCtx({ httpRequest, staticData: {} });
    const result = await activationDelete.call(ctx);
    expect(result).toBe(true);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("returns true and clears static data even when the unregister RPC fails (best-effort)", async () => {
    const httpRequest = vi.fn(async () => {
      const err: Record<string, unknown> = {
        statusCode: 500,
        response: { statusCode: 500, body: { message: "boom" } },
      };
      throw err;
    });
    const staticData: Record<string, unknown> = {
      humangentContinueSubscription: {
        subscriptionId: SUBSCRIPTION_ID,
        webhookUrl: WEBHOOK_URL,
        taskTypeId: TASK_TYPE_ID,
      },
    };
    const ctx = makeHookCtx({ httpRequest, staticData });
    const result = await activationDelete.call(ctx);
    expect(result).toBe(true);
    expect(staticData["humangentContinueSubscription"]).toBeUndefined();
  });
});

describe("activationCheckExists (webhookMethods.default.checkExists)", () => {
  it("returns true when stored URL matches the current node webhook URL", async () => {
    const ctx = makeHookCtx({
      staticData: {
        humangentContinueSubscription: {
          subscriptionId: SUBSCRIPTION_ID,
          webhookUrl: WEBHOOK_URL,
          taskTypeId: TASK_TYPE_ID,
        },
      },
    });
    const result = await activationCheckExists.call(ctx);
    expect(result).toBe(true);
  });

  it("returns false when stored URL differs (forces re-register on rebound webhookId)", async () => {
    // A different `webhookUrl` simulates an n8n upgrade or workflow
    // duplication that rebound the underlying webhookId.
    const ctx = makeHookCtx({
      webhookUrl: "https://n8n.example.com/webhook/REBOUND",
      staticData: {
        humangentContinueSubscription: {
          subscriptionId: SUBSCRIPTION_ID,
          webhookUrl: WEBHOOK_URL,
          taskTypeId: TASK_TYPE_ID,
        },
      },
    });
    const result = await activationCheckExists.call(ctx);
    expect(result).toBe(false);
  });

  it("returns false when no subscription has been stored yet (first activation)", async () => {
    const ctx = makeHookCtx({ staticData: {} });
    const result = await activationCheckExists.call(ctx);
    expect(result).toBe(false);
  });

  it("returns false when the current node webhook URL is undefined", async () => {
    const ctx = makeHookCtx({
      webhookUrl: null,
      staticData: {
        humangentContinueSubscription: {
          subscriptionId: SUBSCRIPTION_ID,
          webhookUrl: WEBHOOK_URL,
          taskTypeId: TASK_TYPE_ID,
        },
      },
    });
    const result = await activationCheckExists.call(ctx);
    expect(result).toBe(false);
  });
});
