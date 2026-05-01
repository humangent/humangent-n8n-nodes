import { describe, expect, it, vi } from "vitest";

import {
  callRpc,
  createRequest,
  getTaskType,
  listTaskTypes,
  registerSubscription,
  unregisterSubscription,
  type HttpRequester,
  type HumangentCredentials,
} from "./api";
import { HUMANGENT_API_URL } from "./constants";

const CREDS: HumangentCredentials = {
  apiKey: "hmk_live_TESTKEY12345",
};

/** Build a requester whose `request` returns a canned value. */
function requesterReturning(data: unknown): {
  requester: HttpRequester;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(data);
  return { requester: { request: spy }, spy };
}

/** Build a requester whose `request` throws a canned error. */
function requesterThrowing(err: unknown): {
  requester: HttpRequester;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockRejectedValue(err);
  return { requester: { request: spy }, spy };
}

const VALID_TASK_TYPE_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: null,
  scope_label: "org-wide",
  field_schema_json: [],
  outcomes_json: [{ id: "approve", label: "Approve" }],
  is_system: true,
  archived_at: null,
  version: 1,
  created_at: "2026-04-22T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

describe("callRpc (header composition + URL build)", () => {
  it("composes auth headers + content-type + URL from public constants + user apiKey", async () => {
    const { requester, spy } = requesterReturning({});
    await callRpc(requester, CREDS, {
      rpcName: "api_list_task_types",
      body: { p_limit: 5 },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0][0];
    expect(options.method).toBe("POST");
    expect(options.url).toBe(
      `${HUMANGENT_API_URL}/rest/v1/rpc/api_list_task_types`,
    );
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Humangent-API-Key": "hmk_live_TESTKEY12345",
    });
    expect(options.headers.apikey).toBeUndefined();
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers["Idempotency-Key"]).toBeUndefined();
    expect(options.body).toEqual({ p_limit: 5 });
    expect(options.json).toBe(true);
  });

  it("adds the Idempotency-Key header when provided", async () => {
    const { requester, spy } = requesterReturning({});
    await callRpc(requester, CREDS, {
      rpcName: "api_create_request",
      body: {},
      idempotencyKey: "uuid-v4-here",
    });
    expect(spy.mock.calls[0][0].headers["Idempotency-Key"]).toBe(
      "uuid-v4-here",
    );
  });
});

describe("callRpc error mapping", () => {
  it("extracts PostgREST hint as code when body is parsed JSON", async () => {
    const err = {
      statusCode: 403,
      response: {
        statusCode: 403,
        body: {
          code: "28000",
          hint: "missing_or_invalid_api_key",
          message: "invalid api key",
        },
      },
    };
    const { requester } = requesterThrowing(err);
    const result = await callRpc(requester, CREDS, {
      rpcName: "api_list_task_types",
      body: {},
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: "missing_or_invalid_api_key",
      message: "invalid api key",
    });
  });

  it("falls back to code when hint is absent", async () => {
    const { requester } = requesterThrowing({
      statusCode: 500,
      response: { statusCode: 500, body: { code: "P0001", message: "boom" } },
    });
    const result = await callRpc(requester, CREDS, {
      rpcName: "api_list_task_types",
      body: {},
    });
    expect(result).toEqual({
      ok: false,
      status: 500,
      code: "P0001",
      message: "boom",
    });
  });

  it("parses a JSON-stringified body", async () => {
    const { requester } = requesterThrowing({
      statusCode: 422,
      response: {
        body: JSON.stringify({
          hint: "field_validation_failed:customer",
          message: "field validation failed",
        }),
      },
    });
    const result = await callRpc(requester, CREDS, {
      rpcName: "api_create_request",
      body: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("field_validation_failed:customer");
      expect(result.message).toBe("field validation failed");
    }
  });

  it("falls back to err.message when body is unparseable", async () => {
    const { requester } = requesterThrowing(new Error("network down"));
    const result = await callRpc(requester, CREDS, {
      rpcName: "api_list_task_types",
      body: {},
    });
    expect(result).toEqual({
      ok: false,
      status: undefined,
      code: "unknown",
      message: "network down",
    });
  });

  it("handles httpCode as a string (n8n's NodeApiError shape)", async () => {
    const { requester } = requesterThrowing({
      httpCode: "404",
      response: {
        body: { hint: "task_type_not_found", message: "task type not found" },
      },
    });
    const result = await callRpc(requester, CREDS, {
      rpcName: "api_get_task_type",
      body: {},
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      code: "task_type_not_found",
      message: "task type not found",
    });
  });
});

describe("listTaskTypes", () => {
  it("returns parsed data on a valid response", async () => {
    const { requester } = requesterReturning({
      items: [VALID_TASK_TYPE_ROW],
      next_cursor: null,
    });
    const result = await listTaskTypes(requester, CREDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toHaveLength(1);
      expect(result.data.next_cursor).toBeNull();
    }
  });

  it("returns malformed_response when the shape drifts", async () => {
    const { requester } = requesterReturning({
      items: "not an array",
      next_cursor: null,
    });
    const result = await listTaskTypes(requester, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });

  it("only includes explicitly-passed params in the RPC body", async () => {
    const { requester, spy } = requesterReturning({
      items: [],
      next_cursor: null,
    });
    await listTaskTypes(requester, CREDS, { p_limit: 25 });
    const body = spy.mock.calls[0][0].body;
    expect(body).toEqual({ p_limit: 25 });
  });

  it("bubbles auth errors up with the server's hint", async () => {
    const { requester } = requesterThrowing({
      statusCode: 403,
      response: {
        body: {
          hint: "missing_or_invalid_api_key",
          message: "invalid api key",
        },
      },
    });
    const result = await listTaskTypes(requester, CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_or_invalid_api_key");
  });
});

describe("getTaskType", () => {
  it("returns parsed data on a valid response", async () => {
    const { requester } = requesterReturning(VALID_TASK_TYPE_ROW);
    const result = await getTaskType(requester, CREDS, VALID_TASK_TYPE_ROW.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.slug).toBe("default_approval_v1");
      expect(result.data.outcomes_json).toHaveLength(1);
    }
  });

  it("passes p_task_type_id through", async () => {
    const { requester, spy } = requesterReturning(VALID_TASK_TYPE_ROW);
    await getTaskType(requester, CREDS, VALID_TASK_TYPE_ROW.id);
    expect(spy.mock.calls[0][0].body).toEqual({
      p_task_type_id: VALID_TASK_TYPE_ROW.id,
    });
  });

  it("surfaces 404 with task_type_not_found hint", async () => {
    const { requester } = requesterThrowing({
      statusCode: 404,
      response: {
        body: { hint: "task_type_not_found", message: "task type not found" },
      },
    });
    const result = await getTaskType(requester, CREDS, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("task_type_not_found");
      expect(result.status).toBe(404);
    }
  });
});

describe("createRequest", () => {
  const VALID_REQUEST_RESPONSE = {
    id: "00000000-0000-0000-0000-000000000010",
    org_id: VALID_TASK_TYPE_ROW.org_id,
    task_type_id: VALID_TASK_TYPE_ROW.id,
    fields: { customer: "Acme" },
    outcomes_snapshot: VALID_TASK_TYPE_ROW.outcomes_json,
    status: "open",
    is_test: false,
    metadata: {},
    expected_timeout_at: null,
    assignee_id: null,
    created_by_api_key_id: "00000000-0000-0000-0000-000000000099",
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
  };

  it("returns a parsed request row on success", async () => {
    const { requester } = requesterReturning(VALID_REQUEST_RESPONSE);
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: { customer: "Acme" },
      resumeUrls: {
        approve: "https://n8n.example.com/resume/approve?token=...",
        dismiss: "https://n8n.example.com/resume/dismiss?token=...",
      },
      idempotencyKey: "idem-abc-123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("open");
  });

  it("forwards metadata when provided", async () => {
    const { requester, spy } = requesterReturning(VALID_REQUEST_RESPONSE);
    await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: { approve: "u1", dismiss: "u2" },
      metadata: { limit_wait_time_seconds: 86400 },
      idempotencyKey: "key",
    });
    const body = spy.mock.calls[0][0].body;
    expect(body).toEqual({
      p_task_type_id: VALID_TASK_TYPE_ROW.id,
      p_fields: {},
      p_resume_urls: { approve: "u1", dismiss: "u2" },
      p_metadata: { limit_wait_time_seconds: 86400 },
    });
  });

  it("omits p_metadata when not provided", async () => {
    const { requester, spy } = requesterReturning(VALID_REQUEST_RESPONSE);
    await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: { approve: "u1", dismiss: "u2" },
    });
    const body = spy.mock.calls[0][0].body;
    expect(body).not.toHaveProperty("p_metadata");
  });

  it("surfaces field_validation_failed with the field id suffix", async () => {
    const { requester } = requesterThrowing({
      statusCode: 422,
      response: {
        body: {
          hint: "field_validation_failed:amount",
          message: "required field amount missing",
        },
      },
    });
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: { approve: "u1", dismiss: "u2" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("field_validation_failed:amount");
    }
  });

  it("surfaces idempotency_key_body_mismatch", async () => {
    const { requester } = requesterThrowing({
      statusCode: 409,
      response: {
        body: {
          hint: "idempotency_key_body_mismatch",
          message: "idempotency key reused with different body",
        },
      },
    });
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: { approve: "u1", dismiss: "u2" },
      idempotencyKey: "dup",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("idempotency_key_body_mismatch");
    }
  });

  it("rejects with invalid_input when neither decisionCallback nor resumeUrls is supplied", async () => {
    const { requester, spy } = requesterReturning({});
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    // Fail-fast — never round-trips the backend.
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects with invalid_input when an empty resumeUrls object is supplied without a decisionCallback", async () => {
    const { requester, spy } = requesterReturning({});
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects with invalid_input when both decisionCallback and a non-empty resumeUrls are supplied", async () => {
    const { requester, spy } = requesterReturning({});
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: {},
      resumeUrls: { approve: "u1", dismiss: "u2" },
      decisionCallback: {
        workflow_id: "wf",
        node_id: "node",
        n8n_instance_id: "00000000-0000-0000-0000-0000000000aa",
        limit_wait_time_seconds: 3600,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts p_decision_callback (without p_resume_urls) on the detached happy path", async () => {
    // Pins the detached wire shape. Earlier shape sent
    // `p_resume_urls: {}` defensively when neither was supplied; the
    // mutual-exclusion guard now rejects that case at the client. The
    // remaining detached path MUST serialize `p_decision_callback` as
    // the only delivery target — a regression that drops the key, or
    // re-introduces an empty `p_resume_urls`, fails this test before
    // the backend gets a chance to reject `decision_callback_conflict`.
    const { requester, spy } = requesterReturning(VALID_REQUEST_RESPONSE);
    const decisionCallback = {
      workflow_id: "wf_destination_42",
      node_id: "Humangent Continue",
      n8n_instance_id: "00000000-0000-0000-0000-0000000000aa",
      limit_wait_time_seconds: 3600,
    };
    const result = await createRequest(requester, CREDS, {
      taskTypeId: VALID_TASK_TYPE_ROW.id,
      fields: { customer: "Acme" },
      decisionCallback,
      idempotencyKey: "key",
    });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = spy.mock.calls[0][0].body;
    expect(body).toEqual({
      p_task_type_id: VALID_TASK_TYPE_ROW.id,
      p_fields: { customer: "Acme" },
      p_decision_callback: decisionCallback,
    });
    expect(body).not.toHaveProperty("p_resume_urls");
  });
});

describe("registerSubscription", () => {
  const SUB_RESPONSE = { id: "11111111-1111-1111-1111-111111111111" };

  it("posts the canonical wire shape to api_register_subscription", async () => {
    const { requester, spy } = requesterReturning(SUB_RESPONSE);
    const result = await registerSubscription(requester, CREDS, {
      workflowId: "wf_456",
      nodeId: "node_continue_1",
      n8nInstanceId: "00000000-0000-0000-0000-0000000000aa",
      webhookUrl: "https://n8n.example.com/webhook/abc",
      taskTypeId: VALID_TASK_TYPE_ROW.id,
    });
    expect(result.ok).toBe(true);
    const call = spy.mock.calls[0][0];
    expect(call.url).toContain("/rpc/api_register_subscription");
    expect(call.body).toEqual({
      p_workflow_id: "wf_456",
      p_node_id: "node_continue_1",
      p_n8n_instance_id: "00000000-0000-0000-0000-0000000000aa",
      p_webhook_url: "https://n8n.example.com/webhook/abc",
      p_task_type_id: VALID_TASK_TYPE_ROW.id,
    });
    if (result.ok) expect(result.data.id).toBe(SUB_RESPONSE.id);
  });

  it("surfaces n8n_origin_not_allowed via the hint suffix", async () => {
    const { requester } = requesterThrowing({
      statusCode: 403,
      response: {
        body: {
          hint: "n8n_origin_not_allowed:https://n8n.acme.com",
          message: "origin not allowed",
        },
      },
    });
    const result = await registerSubscription(requester, CREDS, {
      workflowId: "wf",
      nodeId: "node",
      n8nInstanceId: "00000000-0000-0000-0000-0000000000aa",
      webhookUrl: "https://n8n.acme.com/webhook/x",
      taskTypeId: VALID_TASK_TYPE_ROW.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("n8n_origin_not_allowed:https://n8n.acme.com");
    }
  });

  it("rejects malformed responses missing the id field", async () => {
    const { requester } = requesterReturning({});
    const result = await registerSubscription(requester, CREDS, {
      workflowId: "wf",
      nodeId: "node",
      n8nInstanceId: "00000000-0000-0000-0000-0000000000aa",
      webhookUrl: "https://n8n.acme.com/webhook/x",
      taskTypeId: VALID_TASK_TYPE_ROW.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });
});

describe("unregisterSubscription", () => {
  it("posts the subscription id to api_unregister_subscription", async () => {
    const { requester, spy } = requesterReturning({
      id: "sub-1",
      deleted: true,
    });
    const result = await unregisterSubscription(requester, CREDS, "sub-1");
    expect(result.ok).toBe(true);
    const call = spy.mock.calls[0][0];
    expect(call.url).toContain("/rpc/api_unregister_subscription");
    expect(call.body).toEqual({ p_subscription_id: "sub-1" });
    if (result.ok) {
      expect(result.data.deleted).toBe(true);
    }
  });

  it("returns deleted: false when the backend reports the row is missing", async () => {
    const { requester } = requesterReturning({
      id: "sub-1",
      deleted: false,
    });
    const result = await unregisterSubscription(requester, CREDS, "sub-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(false);
  });

  it("rejects malformed responses missing the deleted flag (parser parity with register)", async () => {
    // registerSubscription has the same guard above; locking
    // unregister into the same shape so a backend regression that
    // drops `deleted` from the row surfaces as malformed_response,
    // not as a silent `undefined`.
    const { requester } = requesterReturning({ id: "sub-1" });
    const result = await unregisterSubscription(requester, CREDS, "sub-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_response");
  });
});
