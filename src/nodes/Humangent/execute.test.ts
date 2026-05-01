import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeApiError, NodeOperationError } from "n8n-workflow";

import { executeCreateRequest } from "./execute";
import { encodeTaskTypeValue } from "./listSearch";

/**
 * Build a resourceLocator object matching what n8n persists after
 * the user picks a task type from the From-List dropdown. alpha.14+
 * embeds the outcomes snapshot directly in `value` as
 * `<task-type-id>#o=<encoded>` (see listSearch.ts:encodeTaskTypeValue
 * and the comment block in outputs.ts for why the snapshot can't
 * live on cachedResultUrl).
 */
function buildTaskTypeRL(
  taskTypeId: string,
  outcomes: Array<{ id: string; label: string }>,
): {
  __rl: true;
  mode: "list";
  value: string;
  cachedResultName: string;
} {
  return {
    __rl: true,
    mode: "list",
    value: encodeTaskTypeValue(taskTypeId, outcomes),
    cachedResultName: "Default approval",
  };
}

const VALID_REQUEST_RESPONSE = {
  id: "00000000-0000-0000-0000-000000000010",
  org_id: "00000000-0000-0000-0000-000000000002",
  task_type_id: "00000000-0000-0000-0000-000000000001",
  fields: { customer: "Acme" },
  outcomes_snapshot: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  status: "open",
  is_test: false,
  metadata: { n8n_execution_id: "exec_123" },
  expected_timeout_at: null,
  assignee_id: null,
  created_by_api_key_id: "00000000-0000-0000-0000-000000000099",
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
};

const VALID_TASK_TYPE_RESPONSE = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: null,
  scope_label: "org-wide",
  field_schema_json: [],
  outcomes_json: [
    { id: "approve", label: "Approve", role: "default-positive" as const },
    { id: "reject", label: "Reject" },
  ],
  is_system: false,
  archived_at: null,
  version: 1,
  created_at: "2026-04-22T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

/**
 * Build an httpRequest mock that dispatches by RPC URL. Covers the two
 * endpoints execute() now hits: api_get_task_type (for the canonical
 * outcomes list) and api_create_request (the actual write).
 */
type HttpRequestArgs = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

/** Find the call args for a specific RPC, asserting it was made. */
function callFor(
  mock: ReturnType<typeof makeHttpMock>,
  rpcName: string,
): HttpRequestArgs {
  const call = mock.mock.calls.find((c) =>
    c[0].url.endsWith(`/rpc/${rpcName}`),
  );
  if (!call)
    throw new Error(`expected an HTTP call to ${rpcName} but found none`);
  return call[0];
}

function makeHttpMock(
  taskTypeResponse: unknown = VALID_TASK_TYPE_RESPONSE,
  createResponse: unknown = VALID_REQUEST_RESPONSE,
) {
  return vi.fn(async (opts: HttpRequestArgs) => {
    if (opts.url.endsWith("/rpc/api_get_task_type")) return taskTypeResponse;
    if (opts.url.endsWith("/rpc/api_create_request")) return createResponse;
    throw new Error(`unexpected RPC: ${opts.url}`);
  });
}

type Overrides = {
  taskTypeId?: string;
  /**
   * The outcomes to encode onto the RL `value`, simulating what the
   * builder picked from the resourceLocator dropdown. Defaults match
   * VALID_TASK_TYPE_RESPONSE.outcomes_json so the snapshot and the
   * live API agree (no drift) by default. Tests that exercise drift
   * supply a divergent value here OR a divergent live response via
   * `httpRequest`.
   */
  snapshotOutcomes?: Array<{ id: string; label: string }>;
  /**
   * Pass `null` to simulate an old workflow where the RL `value`
   * has no `#o=` snapshot suffix (the workflow was saved before
   * alpha.14, so the value is just the bare task-type-id).
   * Pass `undefined` to use the default snapshot.
   */
  snapshotOverride?: null;
  fields?: Record<string, unknown> | null;
  limitWaitTime?: number;
  limitWaitTimeUnit?: string;
  /**
   * Optional revision-continuation pointer the builder typed into the
   * `parentRequestId` parameter. Default is "" (chain-root path).
   */
  parentRequestId?: string;
  /**
   * alpha.21 detached-mode picker pair. Default mode is `createAndWait`
   * (preserves the inline-path tests verbatim). Tests that exercise
   * the detached path supply `mode: 'create'` plus the picker values.
   */
  mode?: "createAndWait" | "create";
  continueWorkflow?: string | { value: string };
  continueNodeName?: string;
  /** Credential override — defaults to a key + a valid instanceId UUID. */
  credentials?: Record<string, unknown>;
  /** n8n execution mode — `manual` triggers the test-step short-circuit. */
  executionMode?: "manual" | "trigger";
  httpRequest?: ReturnType<typeof vi.fn>;
  signedResumeUrl?: ReturnType<typeof vi.fn>;
  putExecutionToWait?: ReturnType<typeof vi.fn>;
  addExecutionHints?: ReturnType<typeof vi.fn>;
  inputItems?: unknown[];
};

function makeExecuteCtx(overrides: Overrides = {}) {
  const {
    taskTypeId = "00000000-0000-0000-0000-000000000001",
    snapshotOutcomes = [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
    snapshotOverride,
    fields = { customer: "Acme" },
    limitWaitTime = 1,
    limitWaitTimeUnit = "hours",
    parentRequestId = "",
    mode = "createAndWait",
    continueWorkflow = "",
    continueNodeName = "",
    credentials = {
      apiKey: "hmk_live_abc",
      instanceId: "00000000-0000-0000-0000-0000000000aa",
    },
    executionMode = "trigger",
    httpRequest = makeHttpMock(),
    signedResumeUrl = vi.fn(
      ({ outcome }: { outcome: string }) =>
        `https://n8n.example/resume/${outcome}?token=sig`,
    ),
    putExecutionToWait = vi.fn().mockResolvedValue(undefined),
    addExecutionHints = vi.fn(),
    inputItems = [{ json: { customer: "Acme" } }],
  } = overrides;

  const taskTypeRL = buildTaskTypeRL(taskTypeId, snapshotOutcomes);
  if (snapshotOverride === null) {
    // Strip the `#o=` suffix so the value is just the bare id —
    // simulates an old workflow saved before alpha.14.
    taskTypeRL.value = taskTypeId;
  }
  // Empty taskTypeId is a "no task type picked" fixture — make value
  // an empty string so execute()'s empty-id guard fires.
  if (taskTypeId === "") {
    taskTypeRL.value = "";
  }

  const paramMap: Record<string, unknown> = {
    taskType: taskTypeRL,
    fields: { mappingMode: "defineBelow", value: fields },
    limitWaitTime,
    limitWaitTimeUnit,
    parentRequestId,
    mode,
    continueWorkflow,
    continueNodeName,
  };

  return {
    helpers: { httpRequest },
    getCredentials: vi.fn().mockResolvedValue(credentials),
    getNodeParameter: vi.fn(
      (name: string, _itemIndex?: number, fallback?: unknown) => {
        const value = paramMap[name];
        return value !== undefined ? value : fallback;
      },
    ),
    getSignedResumeUrl: signedResumeUrl,
    getExecutionId: vi.fn().mockReturnValue("exec_123"),
    getWorkflow: vi.fn().mockReturnValue({ id: "wf_456" }),
    getNode: vi.fn().mockReturnValue({
      id: "node_789",
      name: "Humangent",
      type: "@humangent/n8n-nodes-humangent.humangent",
      typeVersion: 1,
    }),
    getInputData: vi.fn().mockReturnValue(inputItems),
    putExecutionToWait,
    // alpha.21: execute() now calls addExecutionHints from both the
    // detached-mode happy path AND the inline `Create and Wait`
    // path when `limitWaitTime > 1h` (migration deprecation hint).
    // Default this to a no-op spy so existing tests keep passing
    // unchanged; tests that care about hint emission override.
    addExecutionHints,
    getMode: vi.fn().mockReturnValue(executionMode),
  } as unknown as never;
}

describe("executeCreateRequest — happy path", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a request, waits, and returns a sparse Timed-Out-only placeholder", async () => {
    const httpRequest = makeHttpMock();
    const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
    const ctx = makeExecuteCtx({ httpRequest, putExecutionToWait });

    const result = await executeCreateRequest.call(ctx);

    // Two HTTP calls: api_get_task_type (for outcomes) + api_create_request.
    expect(httpRequest).toHaveBeenCalledTimes(2);
    const req = callFor(httpRequest, "api_create_request");
    expect(req.url).toContain("/rest/v1/rpc/api_create_request");
    expect(req.headers["X-Humangent-API-Key"]).toBe("hmk_live_abc");
    expect(req.headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // putExecutionToWait called with a future Date.
    expect(putExecutionToWait).toHaveBeenCalledTimes(1);
    const waitTill = putExecutionToWait.mock.calls[0][0];
    expect(waitTill).toBeInstanceOf(Date);
    expect((waitTill as Date).getTime()).toBeGreaterThan(Date.now());

    // Return: sparse N+2-branch array (outcomes=[approve,reject] →
    // 4 branches). Timed Out (index 3) holds the synthetic payload;
    // all other branches are empty. Webhook handler's return
    // overrides if a decision arrives before waitTill.
    expect(result).toHaveLength(4);
    expect(result[0]).toHaveLength(0); // approve
    expect(result[1]).toHaveLength(0); // reject
    expect(result[2]).toHaveLength(0); // Dismissed
    expect(result[3]).toHaveLength(1); // Timed Out
    expect(result[3][0].json).toMatchObject({
      request_id: VALID_REQUEST_RESPONSE.id,
      outcome_id: "timed_out",
      is_dismiss: false,
      is_test: false,
    });
  });

  it("registers signed resume URLs for every live task-type outcome plus dismiss, even when the snapshot is a subset (mid-wait drift)", async () => {
    // Task type lives [approve, reject, escalate] — but the snapshot
    // captured when the builder picked the task type only had
    // [approve, reject]. Mid-wait drift: the task-type author added
    // `escalate` after the workflow saved its snapshot. The gateway's
    // `_validate_resume_urls` still requires URLs for ALL live
    // outcomes ∪ {dismiss}, so the node must register the full live
    // set regardless of what the snapshot knows.
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      outcomes_json: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
        { id: "escalate", label: "Escalate" },
      ],
    };
    const signedResumeUrl = vi.fn(
      ({ outcome }: { outcome: string }) =>
        `https://n8n.example/resume/${outcome}`,
    );
    const httpRequest = makeHttpMock(taskType);
    const ctx = makeExecuteCtx({
      // Snapshot only captured [approve, reject] — escalate added live
      // after workflow save.
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      signedResumeUrl,
      httpRequest,
    });
    await executeCreateRequest.call(ctx);

    // 3 live task-type outcomes + dismiss = 4 URL generations.
    expect(signedResumeUrl).toHaveBeenCalledTimes(4);
    const calledWith = signedResumeUrl.mock.calls
      .map((c) => c[0].outcome)
      .sort();
    expect(calledWith).toEqual(["approve", "dismiss", "escalate", "reject"]);

    const body = callFor(httpRequest, "api_create_request").body;
    expect(
      Object.keys(body.p_resume_urls as Record<string, unknown>).sort(),
    ).toEqual(["approve", "dismiss", "escalate", "reject"]);
  });

  it("fetches the task type via api_get_task_type before creating the request", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({ httpRequest });
    await executeCreateRequest.call(ctx);

    const getCall = callFor(httpRequest, "api_get_task_type");
    expect(getCall.body).toEqual({
      p_task_type_id: VALID_TASK_TYPE_RESPONSE.id,
    });
    expect(getCall.headers["X-Humangent-API-Key"]).toBe("hmk_live_abc");
  });

  it("forwards fields + n8n metadata + limit_wait_time_seconds", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      fields: { customer: "Acme", amount: 1000 },
      limitWaitTime: 2,
      limitWaitTimeUnit: "hours",
    });
    await executeCreateRequest.call(ctx);
    const body = callFor(httpRequest, "api_create_request").body;
    expect(body.p_fields).toEqual({ customer: "Acme", amount: 1000 });
    // toMatchObject because metadata also carries `n8n_drift` (covered
    // in the dedicated drift tests below).
    expect(body.p_metadata).toMatchObject({
      n8n_execution_id: "exec_123",
      n8n_workflow_id: "wf_456",
      n8n_node_id: "node_789",
      limit_wait_time_seconds: 7200,
    });
  });

  it("splits multi-select fields on commas before sending to api_create_request", async () => {
    // n8n's resourceMapper has no multi-select widget so workflow
    // authors type comma-separated values into a plain text input.
    // execute() splits on commas and trims each element so the
    // gateway receives the array shape it expects.
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      field_schema_json: [
        {
          id: "tags",
          label: "Tags",
          type: "multi-select",
          required: false,
          options: [
            { label: "Alpha", value: "alpha" },
            { label: "Beta", value: "beta" },
          ],
        },
        {
          id: "single_tag",
          label: "Single",
          type: "select",
          required: false,
          options: [{ label: "X", value: "x" }],
        },
      ],
    };
    const httpRequest = makeHttpMock(taskType);
    const ctx = makeExecuteCtx({
      httpRequest,
      fields: {
        tags: "  alpha , beta ,gamma,",
        single_tag: "x",
      },
    });
    await executeCreateRequest.call(ctx);
    const body = callFor(httpRequest, "api_create_request").body;
    expect(body.p_fields).toEqual({
      tags: ["alpha", "beta", "gamma"],
      single_tag: "x",
    });
  });

  it("leaves multi-select alone when value is already an array", async () => {
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      field_schema_json: [
        {
          id: "tags",
          label: "Tags",
          type: "multi-select",
          required: false,
          options: [{ label: "Alpha", value: "alpha" }],
        },
      ],
    };
    const httpRequest = makeHttpMock(taskType);
    const ctx = makeExecuteCtx({
      httpRequest,
      fields: { tags: ["alpha", "beta"] },
    });
    await executeCreateRequest.call(ctx);
    const body = callFor(httpRequest, "api_create_request").body;
    expect(body.p_fields).toEqual({ tags: ["alpha", "beta"] });
  });

  it("converts limit wait time × unit into seconds", async () => {
    const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      putExecutionToWait,
      limitWaitTime: 15,
      limitWaitTimeUnit: "minutes",
    });
    const before = Date.now();
    await executeCreateRequest.call(ctx);
    const waitTill = putExecutionToWait.mock.calls[0][0] as Date;
    const deltaSeconds = (waitTill.getTime() - before) / 1000;
    expect(deltaSeconds).toBeGreaterThanOrEqual(15 * 60 - 1);
    expect(deltaSeconds).toBeLessThanOrEqual(15 * 60 + 2);
  });

  it("handles a null resourceMapper value without throwing", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      fields: null,
    });
    await executeCreateRequest.call(ctx);
    expect(callFor(httpRequest, "api_create_request").body.p_fields).toEqual(
      {},
    );
  });
});

describe("executeCreateRequest — validation errors", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws NodeOperationError when no task type is picked", async () => {
    const ctx = makeExecuteCtx({ taskTypeId: "" });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /pick a task type/i,
    );
  });

  it("throws task_type_snapshot_missing when the snapshot is empty but the live task type has outcomes (old workflow not re-picked since alpha.14)", async () => {
    // Old workflow saved before alpha.14 has no `#o=` fragment on
    // the RL `value` — the value is just the bare task-type id.
    // configuredOutputs would render zero canvas branches; execute()
    // must hard-fail before opening a request so the author can
    // re-pick rather than discover the issue mid-decision.
    const ctx = makeExecuteCtx({ snapshotOverride: null });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeApiError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /re-pick the task type/i,
    );
  });

  it("throws NodeOperationError when input has more than one item", async () => {
    const ctx = makeExecuteCtx({
      inputItems: [{ json: { customer: "A" } }, { json: { customer: "B" } }],
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /single input item.*received 2/i,
    );
  });

  it("does not read EXECUTIONS_TIMEOUT_MAX directly in inline mode", async () => {
    // Verified community nodes must not inspect environment variables.
    // n8n owns enforcement of its global execution timeout.
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "off");
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      limitWaitTime: 48,
      limitWaitTimeUnit: "hours",
    });
    await expect(executeCreateRequest.call(ctx)).resolves.toBeTruthy();
  });

  it("lets n8n enforce global timeout caps for long inline waits", async () => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "3600");
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      limitWaitTime: 48, // 48h
      limitWaitTimeUnit: "hours",
    });
    await expect(executeCreateRequest.call(ctx)).resolves.toBeTruthy();
  });

  it("accepts any wait when EXECUTIONS_TIMEOUT_MAX=0 (disabled)", async () => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "0");
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      limitWaitTime: 30,
      limitWaitTimeUnit: "days",
    });
    await expect(executeCreateRequest.call(ctx)).resolves.toBeTruthy();
  });

  it("falls back to 24 when limitWaitTime is non-numeric / NaN / non-positive", async () => {
    // n8n's editor declares limitWaitTime as a number with default
    // 24, but a saved workflow could carry a string (e.g. an
    // unresolved expression) or 0/negative. Without the
    // Number.isFinite + > 0 guard, Math.floor(NaN * x) → NaN →
    // Date(now+NaN) → Invalid Date, which n8n's putExecutionToWait
    // mishandles silently. Verify the guard falls back to default 24.
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
    const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
    const ctx = makeExecuteCtx({
      putExecutionToWait,
      limitWaitTime: "garbage" as unknown as number,
      limitWaitTimeUnit: "hours",
    });
    const before = Date.now();
    await executeCreateRequest.call(ctx);
    const waitTill = putExecutionToWait.mock.calls[0][0] as Date;
    expect(waitTill).toBeInstanceOf(Date);
    expect(Number.isFinite(waitTill.getTime())).toBe(true);
    const deltaSeconds = (waitTill.getTime() - before) / 1000;
    // 24 hours default fallback.
    expect(deltaSeconds).toBeGreaterThanOrEqual(24 * 3600 - 2);
    expect(deltaSeconds).toBeLessThanOrEqual(24 * 3600 + 2);
  });

  it("falls back to hours when limitWaitTimeUnit is a prototype-pollution key", async () => {
    // The TS cast `as WaitUnit` is compile-time only. A saved
    // workflow could supply "toString" / "constructor" — without
    // Object.hasOwn, UNIT_SECONDS["toString"] would resolve to a
    // function, multiplied into limitWaitTime would yield NaN, and
    // the cap check would silently no-op. Verify the guard rejects
    // prototype keys and falls back to the hours unit (3600s).
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
    const httpRequest = makeHttpMock();
    const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
    const ctx = makeExecuteCtx({
      httpRequest,
      putExecutionToWait,
      limitWaitTime: 2,
      limitWaitTimeUnit: "toString",
    });
    const before = Date.now();
    await executeCreateRequest.call(ctx);
    const waitTill = putExecutionToWait.mock.calls[0][0] as Date;
    const deltaSeconds = (waitTill.getTime() - before) / 1000;
    // 2 × 3600s (hours fallback) — not NaN, not a prototype-derived
    // garbage value.
    expect(deltaSeconds).toBeGreaterThanOrEqual(2 * 3600 - 2);
    expect(deltaSeconds).toBeLessThanOrEqual(2 * 3600 + 2);
  });
});

describe("executeCreateRequest — outcome drift (non-blocking)", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches an empty drift summary to metadata.n8n_drift when snapshot and live agree", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({ httpRequest });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    const drift = (body.p_metadata as Record<string, unknown>)
      .n8n_drift as Record<string, unknown>;
    expect(drift.drifted).toBe(false);
    expect(drift.snapshot_outcome_ids).toEqual(["approve", "reject"]);
    expect(drift.live_outcome_ids).toEqual(["approve", "reject"]);
    expect(drift.label_drift).toEqual({});
    expect(typeof drift.observed_at).toBe("string");
  });

  it("flags drifted=true when live outcomes diverge from the snapshot id set", async () => {
    // Snapshot has [approve, reject]; live adds escalate.
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      outcomes_json: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
        { id: "escalate", label: "Escalate" },
      ],
    };
    const httpRequest = makeHttpMock(taskType);
    const ctx = makeExecuteCtx({
      httpRequest,
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    const drift = (body.p_metadata as Record<string, unknown>)
      .n8n_drift as Record<string, unknown>;
    expect(drift.drifted).toBe(true);
    expect(drift.snapshot_outcome_ids).toEqual(["approve", "reject"]);
    expect(drift.live_outcome_ids).toEqual(["approve", "reject", "escalate"]);
  });

  it("captures label_drift when an id is shared but the label changed live", async () => {
    // Same id [approve], different label live (was "Approve" in
    // snapshot, now "Approve & ship" live).
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      outcomes_json: [
        { id: "approve", label: "Approve & ship" },
        { id: "reject", label: "Reject" },
      ],
    };
    const httpRequest = makeHttpMock(taskType);
    const ctx = makeExecuteCtx({
      httpRequest,
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    const drift = (body.p_metadata as Record<string, unknown>)
      .n8n_drift as Record<string, unknown>;
    expect(drift.drifted).toBe(false); // ids match
    expect(drift.label_drift).toEqual({
      approve: { snapshot_label: "Approve", live_label: "Approve & ship" },
    });
  });

  it("returns snapshot.length + 2 branches with Timed Out on the last branch", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      // Snapshot of 3 outcomes → 5 branches: 3 named + Dismissed + Timed Out
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
        { id: "escalate", label: "Escalate" },
      ],
    });
    // Live needs to also have these 3 (no missing-id 412 path), so
    // override the live response.
    const taskType = {
      ...VALID_TASK_TYPE_RESPONSE,
      outcomes_json: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
        { id: "escalate", label: "Escalate" },
      ],
    };
    const ctx2 = makeExecuteCtx({
      httpRequest: makeHttpMock(taskType),
      snapshotOutcomes: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
        { id: "escalate", label: "Escalate" },
      ],
    });
    const result = await executeCreateRequest.call(ctx2);
    void httpRequest; // used by ctx but ctx2 has its own mock
    void ctx;
    expect(result).toHaveLength(5);
    expect(result[0]).toHaveLength(0); // approve
    expect(result[1]).toHaveLength(0); // reject
    expect(result[2]).toHaveLength(0); // escalate
    expect(result[3]).toHaveLength(0); // Dismissed
    expect(result[4]).toHaveLength(1); // Timed Out
    expect(result[4][0].json).toMatchObject({ outcome_id: "timed_out" });
  });
});

describe("executeCreateRequest — API error → NodeApiError", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps missing_or_invalid_api_key to the friendly credential copy", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 403,
      response: {
        body: {
          hint: "missing_or_invalid_api_key",
          message: "invalid api key",
        },
      },
    });
    const ctx = makeExecuteCtx({ httpRequest });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeApiError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /api key is missing, invalid, or revoked/i,
    );
  });

  it("maps task_type_not_found with a re-pick hint", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 404,
      response: {
        body: {
          hint: "task_type_not_found",
          message: "task type not found",
        },
      },
    });
    const ctx = makeExecuteCtx({ httpRequest });
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /re-pick the task type/i,
    );
  });

  it("maps field_validation_failed:<id> with the field name surfaced", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 422,
      response: {
        body: {
          hint: "field_validation_failed:amount",
          message: "required field amount missing",
        },
      },
    });
    const ctx = makeExecuteCtx({ httpRequest });
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /required field `amount`/,
    );
  });

  it("maps resume_urls_mismatch with the offending detail", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 422,
      response: {
        body: {
          hint: "resume_urls_mismatch:missing:dismiss",
          message: "resume_urls validation failed: missing:dismiss",
        },
      },
    });
    const ctx = makeExecuteCtx({ httpRequest });
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /resume url set doesn't match/i,
    );
  });

  it("falls back to the server message for unknown hints", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 500,
      response: {
        body: { hint: "unfamiliar_failure", message: "something went wrong" },
      },
    });
    const ctx = makeExecuteCtx({ httpRequest });
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /something went wrong/,
    );
  });

  it("does not call putExecutionToWait when the API call fails", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 403,
      response: {
        body: {
          hint: "missing_or_invalid_api_key",
          message: "invalid api key",
        },
      },
    });
    const putExecutionToWait = vi.fn();
    const ctx = makeExecuteCtx({ httpRequest, putExecutionToWait });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeApiError,
    );
    expect(putExecutionToWait).not.toHaveBeenCalled();
  });
});

describe("executeCreateRequest — parentRequestId (revision continuation)", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "86400");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards p_parent_request_id when a valid UUID is supplied", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      parentRequestId: "00000000-0000-0000-0000-0000000000ab",
    });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    expect(body.p_parent_request_id).toBe(
      "00000000-0000-0000-0000-0000000000ab",
    );
  });

  it("trims surrounding whitespace before validating + forwarding", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      // n8n expressions can leak trailing newlines; trim must absorb
      // them rather than tripping the UUID regex.
      parentRequestId: "  00000000-0000-0000-0000-0000000000ab\n",
    });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    expect(body.p_parent_request_id).toBe(
      "00000000-0000-0000-0000-0000000000ab",
    );
  });

  it("omits p_parent_request_id from the body when the parameter is empty (chain-root path)", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({ httpRequest, parentRequestId: "" });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    expect("p_parent_request_id" in body).toBe(false);
  });

  it("omits p_parent_request_id when the parameter is whitespace-only (treated as empty after trim)", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({ httpRequest, parentRequestId: "   " });
    await executeCreateRequest.call(ctx);

    const body = callFor(httpRequest, "api_create_request").body;
    expect("p_parent_request_id" in body).toBe(false);
  });

  it("throws NodeOperationError when parentRequestId is not a UUID; does not call createRequest", async () => {
    // n8n expression returning a literal `undefined` string is a
    // common foot-gun (`{{$node[...].json.requestId}}` against a
    // missing field). Surface as a clean error pointing at the
    // offending value rather than a leaky PostgREST 22P02.
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      parentRequestId: "undefined",
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /parentRequestId must be a UUID.*"undefined"/,
    );
    // Both calls above ran a fresh execute against the mock; verify
    // neither reached api_create_request. (api_get_task_type is also
    // not reached because the UUID guard runs before the fetch.)
    expect(
      httpRequest.mock.calls.some((c) =>
        c[0].url.endsWith("/rpc/api_create_request"),
      ),
    ).toBe(false);
  });

  it("throws NodeOperationError when parentRequestId is a stringified JSON object", async () => {
    const httpRequest = makeHttpMock();
    const ctx = makeExecuteCtx({
      httpRequest,
      parentRequestId: '{"requestId":"abc"}',
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    await expect(executeCreateRequest.call(ctx)).rejects.toThrow(
      /parentRequestId must be a UUID/,
    );
  });

  it("truncates a long invalid value to 80 chars in the error message", async () => {
    const longJunk = "x".repeat(500);
    const ctx = makeExecuteCtx({ parentRequestId: longJunk });
    let caught: unknown;
    try {
      await executeCreateRequest.call(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodeOperationError);
    const msg = (caught as Error).message;
    // Should contain 80 'x' chars from the slice, but NOT the full 500.
    expect(msg).toContain("x".repeat(80));
    expect(msg).not.toContain("x".repeat(81));
  });
});

// ─────────────────────────────────────────────────────────────────
// alpha.21 detached-mode (Create) path. Picker pair, decision_callback
// wire, executionHint, test-step short-circuit. The inline path
// stays untouched — see the suites above.
// ─────────────────────────────────────────────────────────────────

const VALID_DETACHED_RESPONSE = {
  ...VALID_REQUEST_RESPONSE,
  request_url: "https://app.humangent.io/inbox/" + VALID_REQUEST_RESPONSE.id,
  decision_callback_resolved: {
    continue_node_name: "Humangent Continue",
    task_type_name: "Default approval",
    subscription_id: "11111111-1111-1111-1111-111111111111",
  },
};

function makeDetachedHttpMock(
  taskType: unknown = VALID_TASK_TYPE_RESPONSE,
  createResponse: unknown = VALID_DETACHED_RESPONSE,
) {
  return vi.fn(async (opts: HttpRequestArgs) => {
    if (opts.url.endsWith("/rpc/api_get_task_type")) return taskType;
    if (opts.url.endsWith("/rpc/api_create_request")) return createResponse;
    throw new Error(`unexpected RPC: ${opts.url}`);
  });
}

describe("executeCreateRequest — detached mode (Create)", () => {
  beforeEach(() => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "3600");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts decision_callback (not resume_urls) and emits a single Main output with the Phase A response fields", async () => {
    const httpRequest = makeDetachedHttpMock();
    const addExecutionHints = vi.fn();
    const putExecutionToWait = vi.fn().mockResolvedValue(undefined);
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: { value: "wf_destination_42" },
      continueNodeName: "Humangent Continue",
      httpRequest,
      addExecutionHints,
      putExecutionToWait,
    });

    const result = await executeCreateRequest.call(ctx);

    // No putExecutionToWait — detached path returns immediately.
    expect(putExecutionToWait).not.toHaveBeenCalled();

    // Single Main output with the Phase A fields.
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toMatchObject({
      requestId: VALID_REQUEST_RESPONSE.id,
      requestUrl: VALID_DETACHED_RESPONSE.request_url,
      expectedTimeoutAt: null,
    });

    // RPC body shape: decision_callback present, resume_urls absent.
    const createCall = callFor(httpRequest, "api_create_request");
    expect(createCall.body).not.toHaveProperty("p_resume_urls");
    const dc = createCall.body.p_decision_callback as Record<string, unknown>;
    expect(dc).toMatchObject({
      workflow_id: "wf_destination_42",
      node_id: "Humangent Continue",
      n8n_instance_id: "00000000-0000-0000-0000-0000000000aa",
      limit_wait_time_seconds: 3600,
    });
    expect(dc.n8n_drift).toBeDefined();

    // executionHint echoed the resolved Continue + task type.
    expect(addExecutionHints).toHaveBeenCalled();
    const hint = addExecutionHints.mock.calls[0][0] as { message: string };
    expect(hint.message).toContain("Humangent Continue");
    expect(hint.message).toContain("Default approval");
  });

  it("never registers resume URLs in detached mode (no getSignedResumeUrl calls)", async () => {
    const httpRequest = makeDetachedHttpMock();
    const signedResumeUrl = vi.fn();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "Humangent Continue",
      httpRequest,
      signedResumeUrl,
    });
    await executeCreateRequest.call(ctx);
    expect(signedResumeUrl).not.toHaveBeenCalled();
  });

  it("test-step (manual mode) returns mocked output without an HTTP call", async () => {
    const httpRequest = vi.fn();
    const addExecutionHints = vi.fn();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "Humangent Continue",
      executionMode: "manual",
      httpRequest,
      addExecutionHints,
    });
    const result = await executeCreateRequest.call(ctx);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(result[0][0].json.requestId).toMatch(/^mock-/);
    const hint = addExecutionHints.mock.calls[0][0] as { message: string };
    expect(hint.message).toContain("Test step does not create a real request");
  });

  it("throws NodeOperationError when Continuation Workflow is empty", async () => {
    const httpRequest = makeDetachedHttpMock();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "",
      continueNodeName: "Humangent Continue",
      httpRequest,
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
    // Pre-validation rejection happens before any RPC.
    expect(httpRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("api_create_request"),
      }),
    );
  });

  it("throws NodeOperationError when Continue Node Name is empty", async () => {
    const httpRequest = makeDetachedHttpMock();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "",
      httpRequest,
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
  });

  it("throws NodeOperationError when the credential's instanceId is missing", async () => {
    const httpRequest = makeDetachedHttpMock();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "Humangent Continue",
      credentials: { apiKey: "hmk_live_abc" }, // no instanceId
      httpRequest,
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeOperationError,
    );
  });

  it("does NOT enforce EXECUTIONS_TIMEOUT_MAX in detached mode (backend caps at 90 days)", async () => {
    // The detached path returns immediately; Humangent enforces its
    // server-side cap independently of n8n's execution timeout.
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "3600");
    const httpRequest = makeDetachedHttpMock();
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "Humangent Continue",
      limitWaitTime: 7,
      limitWaitTimeUnit: "days",
      httpRequest,
    });
    await expect(executeCreateRequest.call(ctx)).resolves.toBeDefined();
  });

  it("surfaces backend errors (e.g., subscription_not_found) via NodeApiError", async () => {
    const httpRequest = vi.fn(async (opts: HttpRequestArgs) => {
      if (opts.url.endsWith("/rpc/api_get_task_type"))
        return VALID_TASK_TYPE_RESPONSE;
      if (opts.url.endsWith("/rpc/api_create_request")) {
        const err: Record<string, unknown> = {
          statusCode: 404,
          response: {
            statusCode: 404,
            body: {
              hint: "subscription_not_found:wf_dest:Humangent Continue",
              message: "no subscription registered for that workflow + node",
            },
          },
        };
        throw err;
      }
      throw new Error("unexpected");
    });
    const ctx = makeExecuteCtx({
      mode: "create",
      continueWorkflow: "wf_dest",
      continueNodeName: "Humangent Continue",
      httpRequest,
    });
    await expect(executeCreateRequest.call(ctx)).rejects.toBeInstanceOf(
      NodeApiError,
    );
  });

  it("inline `Create and Wait` mode emits a migration hint when limitWaitTime > 1 hour", async () => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "0");
    const httpRequest = makeHttpMock();
    const addExecutionHints = vi.fn();
    const ctx = makeExecuteCtx({
      mode: "createAndWait",
      limitWaitTime: 6,
      limitWaitTimeUnit: "hours",
      httpRequest,
      addExecutionHints,
    });
    await executeCreateRequest.call(ctx);
    expect(addExecutionHints).toHaveBeenCalled();
    const hint = addExecutionHints.mock.calls[0][0] as { message: string };
    expect(hint.message).toContain("Create");
    expect(hint.message).toContain("Continue");
  });

  it("inline `Create and Wait` mode does NOT emit a migration hint at the default 1-hour wait", async () => {
    vi.stubEnv("EXECUTIONS_TIMEOUT_MAX", "3600");
    const httpRequest = makeHttpMock();
    const addExecutionHints = vi.fn();
    const ctx = makeExecuteCtx({
      mode: "createAndWait",
      limitWaitTime: 1,
      limitWaitTimeUnit: "hours",
      httpRequest,
      addExecutionHints,
    });
    await executeCreateRequest.call(ctx);
    expect(addExecutionHints).not.toHaveBeenCalled();
  });
});
