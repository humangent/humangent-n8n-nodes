// Tests for HumangentToolCallReview's execute() handler.
//
// Covers:
//   * happy path — calls api_ensure_tool_call_review_task_type +
//     api_create_request, registers signed resume URLs for approve /
//     deny / dismiss, puts execution to wait, returns synthetic
//     timeout payload.
//   * sanitization — redactedParameterKeys replaces matching values
//     with [REDACTED] in metadata.tool_call_review.parameters_preview.
//   * outcome contract guard — fails fast if the backend ever returns
//     a task type whose outcomes diverge from the pinned approve+deny
//     pair (out-of-band backend change shipping ahead of the node).
//   * multi-item rejection — N>1 input items raises NodeOperationError.

import { describe, expect, it, vi } from "vitest";
import { NodeApiError, NodeOperationError } from "n8n-workflow";

import { executeToolCallReview } from "./execute";

const SYSTEM_TASK_TYPE = {
  id: "00000000-0000-0000-0000-0000000007aa",
  org_id: "00000000-0000-0000-0000-000000000001",
  slug: "00000000-0000-0000-0000-0000000007aa",
  name: "Tool call review",
  description: "Reviewer approval for an AI Agent tool call proposed in n8n.",
  scope_label: "org-wide",
  field_schema_json: [
    { id: "tool_name", label: "Tool", type: "text" },
    { id: "parameters_preview", label: "Proposed parameters", type: "textarea" },
  ],
  outcomes_json: [
    { id: "approve", label: "Approve", role: "default-positive" as const },
    { id: "deny", label: "Deny", role: "secondary" },
  ],
  is_system: true,
  status: "published" as const,
  archived_at: null,
  version: 1,
  created_at: "2026-05-07T00:00:00Z",
  updated_at: "2026-05-07T00:00:00Z",
};

const VALID_REQUEST_RESPONSE = {
  id: "00000000-0000-0000-0000-000000000099",
  org_id: "00000000-0000-0000-0000-000000000001",
  task_type_id: SYSTEM_TASK_TYPE.id,
  fields: {},
  outcomes_snapshot: SYSTEM_TASK_TYPE.outcomes_json,
  status: "open",
  is_test: false,
  metadata: {},
  expected_timeout_at: null,
  assignee_id: null,
  created_by_api_key_id: null,
  created_at: "2026-05-08T00:00:00Z",
  updated_at: "2026-05-08T00:00:00Z",
};

interface HttpRequestArgs {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function makeHttpMock(
  taskTypeResponse: unknown = SYSTEM_TASK_TYPE,
  createResponse: unknown = VALID_REQUEST_RESPONSE,
) {
  return vi.fn(async (opts: HttpRequestArgs) => {
    if (opts.url.endsWith("/rpc/api_ensure_tool_call_review_task_type")) {
      return taskTypeResponse;
    }
    if (opts.url.endsWith("/rpc/api_create_request")) return createResponse;
    throw new Error(`unexpected RPC: ${opts.url}`);
  });
}

interface CtxOverrides {
  message?: string;
  redactedParameterKeys?: string;
  limitWaitTime?: number;
  limitWaitTimeUnit?: string;
  inputItems?: unknown[];
  httpRequest?: ReturnType<typeof vi.fn>;
}

function makeExecuteCtx(overrides: CtxOverrides = {}) {
  const {
    message = "The agent wants to call tool",
    redactedParameterKeys = "",
    limitWaitTime = 1,
    limitWaitTimeUnit = "hours",
    inputItems = [
      {
        json: {
          tool: {
            name: "gmailTool",
            parameters: {
              to: "alice@example.com",
              subject: "Welcome",
              body: "Sensitive content",
            },
          },
        },
      },
    ],
    httpRequest = makeHttpMock(),
  } = overrides;

  const paramMap: Record<string, unknown> = {
    message,
    redactedParameterKeys,
    limitWaitTime,
    limitWaitTimeUnit,
  };

  const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
  const signedResumeUrl = vi.fn(
    ({ outcome }: { outcome: string }) =>
      `https://n8n.example/resume/${outcome}?token=sig`,
  );

  const ctx = {
    helpers: { httpRequest },
    getCredentials: vi.fn().mockResolvedValue({ apiKey: "hmk_live_dev" }),
    getNodeParameter: vi.fn(
      (name: string, _i?: number, fallback?: unknown) => {
        const value = paramMap[name];
        return value !== undefined ? value : fallback;
      },
    ),
    getSignedResumeUrl: signedResumeUrl,
    getExecutionId: vi.fn().mockReturnValue("exec_123"),
    getWorkflow: vi.fn().mockReturnValue({ id: "wf_456", name: "Onboarding" }),
    getNode: vi.fn().mockReturnValue({
      id: "node_789",
      name: "Humangent Tool Call Review",
      type: "@humangent/n8n-nodes-humangent.humangentToolCallReview",
      typeVersion: 1,
    }),
    getInputData: vi.fn().mockReturnValue(inputItems),
    putExecutionToWait,
  } as unknown as never;

  return { ctx, httpRequest, signedResumeUrl, putExecutionToWait };
}

describe("executeToolCallReview — happy path", () => {
  it("calls ensureToolCallReviewTaskType + createRequest with sanitized fields and metadata", async () => {
    const { ctx, httpRequest, signedResumeUrl, putExecutionToWait } =
      makeExecuteCtx({ redactedParameterKeys: "body" });

    const branches = await executeToolCallReview.call(ctx);

    // Two RPCs hit — ensure first (resolve task type), then create.
    expect(httpRequest).toHaveBeenCalledTimes(2);
    const ensureCall = httpRequest.mock.calls[0][0] as HttpRequestArgs;
    const createCall = httpRequest.mock.calls[1][0] as HttpRequestArgs;
    expect(ensureCall.url).toMatch(/api_ensure_tool_call_review_task_type$/);
    expect(createCall.url).toMatch(/api_create_request$/);
    expect(createCall.body.p_task_type_id).toBe(SYSTEM_TASK_TYPE.id);

    // metadata.tool_call_review carries the structured envelope the
    // inbox card consumes — sanitized parameters with `body` replaced.
    const metadata = createCall.body.p_metadata as Record<string, unknown>;
    const tcr = metadata.tool_call_review as {
      tool_name: string;
      parameters_preview: Record<string, unknown>;
      redacted_keys: string[];
    };
    expect(tcr.tool_name).toBe("gmailTool");
    expect(tcr.parameters_preview).toMatchObject({
      to: "alice@example.com",
      subject: "Welcome",
      body: "[REDACTED]",
    });
    expect(tcr.redacted_keys).toEqual(["body"]);

    // Resume URLs cover all three outcomes.
    expect(signedResumeUrl).toHaveBeenCalledWith({ outcome: "approve" });
    expect(signedResumeUrl).toHaveBeenCalledWith({ outcome: "deny" });
    expect(signedResumeUrl).toHaveBeenCalledWith({ outcome: "dismiss" });
    expect(createCall.body.p_resume_urls).toMatchObject({
      approve: "https://n8n.example/resume/approve?token=sig",
      deny: "https://n8n.example/resume/deny?token=sig",
      dismiss: "https://n8n.example/resume/dismiss?token=sig",
    });

    // putExecutionToWait fired, synthetic timeout payload returned.
    expect(putExecutionToWait).toHaveBeenCalledTimes(1);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toHaveLength(1);
    const json = branches[0][0]!.json as Record<string, unknown>;
    expect(json.approved).toBe(false);
    expect(json.timed_out).toBe(true);
    expect(json.request_id).toBe(VALID_REQUEST_RESPONSE.id);
  });
});

describe("executeToolCallReview — guards", () => {
  it("rejects N>1 input items with a NodeOperationError pointing at the loop pattern", async () => {
    const { ctx } = makeExecuteCtx({
      inputItems: [{ json: {} }, { json: {} }],
    });
    await expect(executeToolCallReview.call(ctx)).rejects.toThrow(
      NodeOperationError,
    );
  });

  it("fails fast when the backend returns a task type with unexpected outcomes (out-of-band contract change)", async () => {
    const driftedTaskType = {
      ...SYSTEM_TASK_TYPE,
      outcomes_json: [
        { id: "approve", label: "Approve", role: "default-positive" as const },
        { id: "needs_revision", label: "Needs revision", role: "secondary" },
      ],
    };
    const { ctx } = makeExecuteCtx({
      httpRequest: makeHttpMock(driftedTaskType),
    });
    await expect(executeToolCallReview.call(ctx)).rejects.toThrow(
      NodeApiError,
    );
  });

  it("propagates create_request RPC failures via NodeApiError", async () => {
    const httpRequest = vi.fn(async (opts: HttpRequestArgs) => {
      if (opts.url.endsWith("/rpc/api_ensure_tool_call_review_task_type")) {
        return SYSTEM_TASK_TYPE;
      }
      const err = new Error("fields validation failed") as Error & {
        httpCode: number;
        response: { body: Record<string, unknown> };
      };
      err.httpCode = 422;
      err.response = {
        body: { hint: "field_validation_failed:tool_name", message: "missing" },
      };
      throw err;
    });
    const { ctx } = makeExecuteCtx({ httpRequest });
    await expect(executeToolCallReview.call(ctx)).rejects.toThrow(NodeApiError);
  });
});
