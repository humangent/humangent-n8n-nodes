// HTTP client for Humangent public API v2.
//
// All public-API RPCs are POST /rest/v1/rpc/<name> on Humangent's public
// API endpoint. Authentication uses the per-org `X-Humangent-API-Key`.
// Older alpha backends also used Supabase gateway headers; the client still
// knows how to add them if a future public constant is configured, but the
// verified package does not read environment variables at runtime.
//
// Callers pass an HttpRequester (a minimal subset of n8n's
// IExecuteFunctions['helpers']) so unit tests can inject mocks
// without pulling in the full n8n-workflow runtime. At execute /
// webhook time the node itself will bind `this.helpers.httpRequest`
// into this shape.
//
// Error-to-code mapping mirrors apps/web/src/features/admin/people/api.ts:
// we prefer PostgREST's stable `hint` over `code` over a fallback,
// so the node's downstream NodeApiError copy (Unit 6) can branch on
// one string and stay resilient to PostgREST renaming internal error
// codes.

import { HUMANGENT_ANON_KEY, HUMANGENT_API_URL } from "./constants";
import {
  RegisterSubscriptionResponseSchema,
  TaskTypeListSchema,
  TaskTypeRowSchema,
  UnregisterSubscriptionResponseSchema,
  RequestRowSchema,
  type RequestRow,
  type RegisterSubscriptionResponse,
  type TaskTypeList,
  type TaskTypeRow,
  type UnregisterSubscriptionResponse,
} from "./schemas";

export interface HumangentCredentials {
  /**
   * Humangent API key — `hmk_live_...` or `hmk_test_...`. Doubles as
   * the HMAC secret for inbound decision-delivery verification.
   * The user-typed field on the credential class.
   */
  apiKey: string;
  /**
   * Auto-minted UUID (n8n persists via `preAuthentication`). Stamped
   * onto Continue subscription rows as `n8n_instance_id` so the
   * (workflow_id, node_id, n8n_instance_id) tuple disambiguates dev
   * / prod n8n instances sharing the same workflow JSON. Empty string
   * before first auth round-trip; populated thereafter.
   */
  instanceId?: string;
}

export interface HttpRequestOptions {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  json?: boolean;
  timeout?: number;
}

export interface HttpRequester {
  /** Mirrors n8n's `this.helpers.httpRequest`. Throws on non-2xx. */
  request(options: HttpRequestOptions): Promise<unknown>;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; status?: number };

export interface RpcCallInput {
  rpcName: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}

function buildHeaders(
  creds: HumangentCredentials,
  idempotencyKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Humangent-API-Key": creds.apiKey,
  };
  if (HUMANGENT_ANON_KEY.length > 0) {
    headers.apikey = HUMANGENT_ANON_KEY;
    headers.Authorization = `Bearer ${HUMANGENT_ANON_KEY}`;
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

function buildUrl(rpcName: string): string {
  return `${HUMANGENT_API_URL}/rest/v1/rpc/${rpcName}`;
}

type ErrorObject = Record<string, unknown> & {
  response?: Record<string, unknown>;
};

type ErrorBody = {
  bodyObj?: Record<string, unknown>;
  fallbackMessage?: string;
};

function asFiniteNumber(
  value: unknown,
  allowString: boolean,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (allowString && typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// n8n's error shapes use `httpCode` in older versions (string) and
// newer versions have started surfacing it as a number; handle both.
// `statusCode` and `response.statusCode` are number-only in every
// version we've seen — coercing strings there would mask real shape
// drift, so they stay strict.
function extractStatusCode(e: ErrorObject): number | undefined {
  return (
    asFiniteNumber(e.httpCode, true) ??
    asFiniteNumber(e.statusCode, false) ??
    asFiniteNumber(e.response?.statusCode, false)
  );
}

function pickRawBody(e: ErrorObject): unknown {
  const responseBody = (e.response as Record<string, unknown> | undefined)
    ?.body;
  if (responseBody !== undefined) return responseBody;
  if (e.body !== undefined) return e.body;
  return e.error;
}

function parseBodyString(s: string): ErrorBody {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) {
      return { bodyObj: parsed as Record<string, unknown> };
    }
  } catch {
    // Not JSON — surface as the human-facing message.
    return { fallbackMessage: s };
  }
  return {};
}

// Pulls the candidate body off the error and normalizes the three
// shapes mapRequestError handles:
//   1. parsed object → returned as `bodyObj`
//   2. JSON string   → parsed (some runtimes don't auto-parse)
//   3. plain string  → returned as `fallbackMessage` so the caller
//      can use it as the human-facing message
//   4. missing       → both undefined
function extractErrorBody(e: ErrorObject): ErrorBody {
  const rawBody = pickRawBody(e);
  if (typeof rawBody === "object" && rawBody !== null) {
    return { bodyObj: rawBody as Record<string, unknown> };
  }
  if (typeof rawBody === "string") return parseBodyString(rawBody);
  return {};
}

// Preference order: `hint` > `code` > `"unknown"`.
function pickCodeFromBody(bodyObj: Record<string, unknown>): string {
  const hint = bodyObj.hint;
  if (typeof hint === "string" && hint.length > 0) return hint;
  const code = bodyObj.code;
  if (typeof code === "string" && code.length > 0) return code;
  return "unknown";
}

// Preference order: `bodyObj.message` > plain-text body fallback >
// `e.message` > `"Request failed"`. `e.message` is consulted only
// when neither a structured body nor a plain-text body is available
// — matches n8n's older-runtime fallback where the only signal is
// the thrown Error's message.
function pickMessage(
  e: ErrorObject,
  bodyObj: Record<string, unknown> | undefined,
  fallbackMessage: string | undefined,
): string {
  if (bodyObj) {
    const m = bodyObj.message;
    if (typeof m === "string" && m.length > 0) return m;
    return fallbackMessage ?? "Request failed";
  }
  if (fallbackMessage !== undefined) return fallbackMessage;
  if (typeof e.message === "string") return e.message;
  return "Request failed";
}

function resolveCodeAndMessage(
  e: ErrorObject,
  bodyObj: Record<string, unknown> | undefined,
  fallbackMessage: string | undefined,
): { code: string; message: string } {
  return {
    code: bodyObj ? pickCodeFromBody(bodyObj) : "unknown",
    message: pickMessage(e, bodyObj, fallbackMessage),
  };
}

/**
 * Map the shape n8n's httpRequest throws on non-2xx into a stable
 * `{ code, message, status }`. Handles three body shapes defensively:
 *   1. JSON object already parsed: `{ hint, code, message }`
 *   2. JSON string (some runtimes don't auto-parse): `"{...}"`
 *   3. Plain string or missing body
 *
 * Preference order for `code`: `hint` > `code` > `"unknown"`.
 */
function mapRequestError(err: unknown): {
  ok: false;
  code: string;
  message: string;
  status?: number;
} {
  if (typeof err !== "object" || err === null) {
    return { ok: false, code: "unknown", message: "Request failed" };
  }

  const e = err as ErrorObject;
  const status = extractStatusCode(e);
  const { bodyObj, fallbackMessage } = extractErrorBody(e);
  const { code, message } = resolveCodeAndMessage(e, bodyObj, fallbackMessage);

  return { ok: false, status, code, message };
}

/** Call one RPC. Returns raw JSON body on success; mapped error on failure. */
export async function callRpc(
  requester: HttpRequester,
  creds: HumangentCredentials,
  input: RpcCallInput,
): Promise<ApiResult<unknown>> {
  try {
    const data = await requester.request({
      method: "POST",
      url: buildUrl(input.rpcName),
      headers: buildHeaders(creds, input.idempotencyKey),
      body: input.body,
      json: true,
      // Cap per-RPC HTTP time so a stalled deliver-decision / admin
      // endpoint can't hang an n8n execution indefinitely. 30s is
      // generous for PostgREST RPCs, which typically return in <1s.
      timeout: 30_000,
    });
    return { ok: true, data };
  } catch (err) {
    return mapRequestError(err);
  }
}

function malformedResponse(details: string): {
  ok: false;
  code: "malformed_response";
  message: string;
} {
  return {
    ok: false,
    code: "malformed_response",
    message: `Humangent returned an unexpected response shape: ${details}`,
  };
}

// Typed RPC wrappers — one per public RPC the v1 node uses.

export interface ListTaskTypesParams {
  p_search?: string;
  p_cursor?: string;
  p_limit?: number;
  p_include_archived?: boolean;
}

export async function listTaskTypesApi(
  requester: HttpRequester,
  creds: HumangentCredentials,
  params: ListTaskTypesParams = {},
): Promise<ApiResult<TaskTypeList>> {
  const body: Record<string, unknown> = {};
  if (params.p_search !== undefined) body.p_search = params.p_search;
  if (params.p_cursor !== undefined) body.p_cursor = params.p_cursor;
  if (params.p_limit !== undefined) body.p_limit = params.p_limit;
  if (params.p_include_archived !== undefined) {
    body.p_include_archived = params.p_include_archived;
  }
  const raw = await callRpc(requester, creds, {
    rpcName: "api_list_task_types",
    body,
  });
  if (!raw.ok) return raw;
  const parsed = TaskTypeListSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}

export async function getTaskType(
  requester: HttpRequester,
  creds: HumangentCredentials,
  taskTypeId: string,
): Promise<ApiResult<TaskTypeRow>> {
  const raw = await callRpc(requester, creds, {
    rpcName: "api_get_task_type",
    body: { p_task_type_id: taskTypeId },
  });
  if (!raw.ok) return raw;
  const parsed = TaskTypeRowSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}

/**
 * Resolve the caller-org's tool-call review system task type, creating
 * it on first call. Used by the HumangentToolCallReview node when an
 * AI Agent proposes a tool call. The Humangent backend pins the
 * row's outcomes to `approve` + `deny` and locks them from editor
 * mutation, so the node's outcome → `{approved: bool}` mapping is
 * stable across edits.
 *
 * Plan: humangent app —
 * docs/plans/2026-05-07-002-feat-humangent-tool-call-review-plan.md U2.
 */
export async function ensureToolCallReviewTaskType(
  requester: HttpRequester,
  creds: HumangentCredentials,
): Promise<ApiResult<TaskTypeRow>> {
  const raw = await callRpc(requester, creds, {
    rpcName: "api_ensure_tool_call_review_task_type",
    body: {},
  });
  if (!raw.ok) return raw;
  const parsed = TaskTypeRowSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}

/**
 * The decision-callback block sent by `Create` mode requests. Carries
 * the (workflow_id, node_id, n8n_instance_id) tuple the backend
 * resolves to a registered Continue subscription, plus the
 * builder-configured `limit_wait_time_seconds` (server-enforced —
 * the n8n EXECUTIONS_TIMEOUT_MAX cap does not apply on this path)
 * and an optional `n8n_drift` snapshot (validation-only, not
 * persisted on the row).
 */
export interface DecisionCallback {
  workflow_id: string;
  node_id: string;
  n8n_instance_id: string;
  limit_wait_time_seconds: number;
  n8n_drift?: Record<string, unknown>;
}

export interface CreateRequestInput {
  taskTypeId: string;
  fields: Record<string, unknown>;
  /**
   * Inline path: every-outcome ∪ {dismiss} signed resume URL map.
   * Mutually exclusive with `decisionCallback` — backend rejects
   * `decision_callback_conflict` when both are non-empty.
   */
  resumeUrls?: Record<string, string>;
  /**
   * Detached path: the `(workflow_id, node_id, n8n_instance_id)`
   * tuple the backend resolves to a Continue subscription at create
   * time. Mutually exclusive with `resumeUrls`.
   */
  decisionCallback?: DecisionCallback;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * Optional UUID of the upstream request this one continues from.
   * When set, `api_create_request` links the new request as a
   * revision-iteration child via `p_parent_request_id`. Empty string
   * or undefined → omitted from the body (chain-root path). Caller
   * (execute.ts) trims and UUID-validates before passing through.
   */
  parentRequestId?: string;
}

export async function createRequest(
  requester: HttpRequester,
  creds: HumangentCredentials,
  input: CreateRequestInput,
): Promise<ApiResult<RequestRow>> {
  // Mutual-exclusion contract — fail fast on the client so caller
  // bugs surface here, not as a `decision_callback_conflict` /
  // `delivery_target_required` round-trip the user sees as a
  // surprise NodeApiError. The backend re-validates either way; this
  // is belt-and-suspenders, not the authoritative gate.
  const hasDecisionCallback = input.decisionCallback !== undefined;
  const hasResumeUrls =
    input.resumeUrls !== undefined && Object.keys(input.resumeUrls).length > 0;
  if (hasDecisionCallback === hasResumeUrls) {
    return {
      ok: false,
      code: "invalid_input",
      message: hasDecisionCallback
        ? "createRequest received both decisionCallback and resumeUrls — the inline and detached paths are mutually exclusive."
        : "createRequest received neither decisionCallback nor a non-empty resumeUrls — supply exactly one delivery target.",
    };
  }

  const body: Record<string, unknown> = {
    p_task_type_id: input.taskTypeId,
    p_fields: input.fields,
  };
  if (hasDecisionCallback) {
    body.p_decision_callback = input.decisionCallback;
  } else {
    body.p_resume_urls = input.resumeUrls;
  }
  if (input.metadata !== undefined) body.p_metadata = input.metadata;
  if (input.parentRequestId !== undefined && input.parentRequestId !== "") {
    body.p_parent_request_id = input.parentRequestId;
  }
  const raw = await callRpc(requester, creds, {
    rpcName: "api_create_request",
    body,
    idempotencyKey: input.idempotencyKey,
  });
  if (!raw.ok) return raw;
  const parsed = RequestRowSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}

// Subscription RPCs — invoked by the Humangent Continue node's
// webhookMethods.create / .delete on workflow activation/deactivation.
// Backend: `apps/api/supabase/migrations/20260429100003_subscription_rpcs.sql`.
// Wire shape pinned to those SQL signatures. n8n never resolves the
// subscription itself — `api_resolve_subscription` is service-role
// only and called by the deliver-decision Edge Function.

export interface RegisterSubscriptionInput {
  workflowId: string;
  nodeId: string;
  n8nInstanceId: string;
  webhookUrl: string;
  taskTypeId: string;
}

export async function registerSubscription(
  requester: HttpRequester,
  creds: HumangentCredentials,
  input: RegisterSubscriptionInput,
): Promise<ApiResult<RegisterSubscriptionResponse>> {
  const raw = await callRpc(requester, creds, {
    rpcName: "api_register_subscription",
    body: {
      p_workflow_id: input.workflowId,
      p_node_id: input.nodeId,
      p_n8n_instance_id: input.n8nInstanceId,
      p_webhook_url: input.webhookUrl,
      p_task_type_id: input.taskTypeId,
    },
  });
  if (!raw.ok) return raw;
  const parsed = RegisterSubscriptionResponseSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}

export async function unregisterSubscription(
  requester: HttpRequester,
  creds: HumangentCredentials,
  subscriptionId: string,
): Promise<ApiResult<UnregisterSubscriptionResponse>> {
  const raw = await callRpc(requester, creds, {
    rpcName: "api_unregister_subscription",
    body: { p_subscription_id: subscriptionId },
  });
  if (!raw.ok) return raw;
  const parsed = UnregisterSubscriptionResponseSchema.safeParse(raw.data);
  if (!parsed.success) return malformedResponse(parsed.error.message);
  return { ok: true, data: parsed.data };
}
