// Humangent Tool Call Review — execute() logic.
//
// Flow when n8n's AI Agent invokes the auto-wrapped HitlTool variant:
//   1. Read node parameters (message, wait time, redacted keys).
//   2. Resolve the system task type via api_ensure_tool_call_review_task_type
//      so a brand-new org can use the node without an admin pre-creating
//      anything.
//   3. Sanitize the proposed tool call. n8n's hitl-tools generator sets
//      $tool.name + $tool.parameters in the wrapped node's runtime
//      context; we read those off the input items and redact any keys
//      the builder listed in `redactedParameterKeys`. Final structured
//      envelope lands in metadata.tool_call_review and a fields copy
//      goes into the request fields for the standard inbox card.
//   4. Mint signed resume URLs for both outcomes (approve/deny) plus
//      the implicit dismiss outcome the gateway requires.
//   5. POST api_create_request with the system task type id, fields,
//      resume URLs, and the structured tool-call metadata.
//   6. putExecutionToWait(waitTill). On webhook hit (webhook.ts) the
//      execution resumes with `{approved: bool, chatInput?: string}`
//      n8n's processHitlResponses expects.
//   7. If wait expires without a webhook, n8n routes onto the synthetic
//      timeout payload returned here — `approved: false` with a
//      `timed_out` flag so the agent does not execute the gated tool.
//
// v1 limitations:
//   * Single-item execute. n8n's HITL generator runs the wrapped tool
//     once per agent action, but we still defensively reject N>1
//     items rather than silently using item[0].
//   * No drift handling on outcome ids — the system task type's
//     outcomes_json is locked at the backend.

import { randomUUID } from "node:crypto";

import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
} from "n8n-workflow";

import {
  createRequest,
  ensureToolCallReviewTaskType,
  type HumangentCredentials,
} from "../../lib/api";
import { humangentApiError } from "../Humangent/errors";
import { requesterFor } from "../Humangent/n8nBridge";

type WaitUnit = "minutes" | "hours" | "days";

const UNIT_SECONDS: Record<WaitUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Pull the proposed tool name + parameters off the input item the
 * AI Agent passes to the wrapped HitlTool. n8n's HITL generator
 * exposes them as `$tool.name` / `$tool.parameters`; the resolved
 * values arrive in the input item's `json` (most setups) or `pairedItem`
 * — we read both defensively so the node still works when the wrapper
 * surfaces them in either location.
 */
interface ProposedToolCall {
  toolName: string | null;
  parametersRaw: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const s = nonEmptyString(value);
    if (s) return s;
  }
  return null;
}

function readProposedToolCall(
  items: INodeExecutionData[],
): ProposedToolCall {
  const first = items[0];
  if (!first) return { toolName: null, parametersRaw: undefined };
  const json = (first.json ?? {}) as Record<string, unknown>;
  // The HITL wrapper resolves `$tool.name` / `$tool.parameters` into
  // either top-level keys on json or nested under `tool`. Read both
  // shapes; n8n versions vary.
  const nested = objectRecord(json["tool"]);
  const parametersRaw =
    json["toolParameters"] ?? json["tool_parameters"] ?? nested?.["parameters"];
  return {
    toolName: firstString(json["toolName"], json["tool_name"], nested?.["name"]),
    parametersRaw,
  };
}

/**
 * Recursively redact values whose key matches one of `redactedKeys`.
 * Replaces matching values with the constant placeholder string. Keys
 * are matched case-insensitively. Non-object inputs return verbatim
 * (numbers / booleans / strings stay as-is).
 */
function redactParameters(
  value: unknown,
  redactedKeys: ReadonlySet<string>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactParameters(entry, redactedKeys));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (redactedKeys.has(k.toLowerCase())) {
      out[k] = REDACTED_PLACEHOLDER;
    } else {
      out[k] = redactParameters(v, redactedKeys);
    }
  }
  return out;
}

/**
 * Pretty-print the parameters preview into a stable string the
 * inbox card and the request `fields.parameters_preview` text field
 * can both render. Returns "" for null/undefined so the request body
 * carries a string (the system task type's field schema declares
 * parameters_preview as `type: textarea`).
 */
function previewToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function parseRedactedKeys(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function assertSingleInput(
  ctx: IExecuteFunctions,
  items: INodeExecutionData[],
): void {
  if (items.length !== 1) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Humangent Tool Call Review expects exactly one input item per execute; received ${items.length}. The HITL wrapper invokes this once per agent tool call.`,
    );
  }
}

function assertOutcomeContract(
  ctx: IExecuteFunctions,
  liveOutcomes: ReadonlyArray<{ id: string }>,
): void {
  // Defense in depth: the system task type ships with `approve` and
  // `deny`. If a future backend version evolves the contract, fail
  // fast here so the node version becomes the explicit upgrade gate
  // rather than a silent runtime mismatch.
  const liveOutcomeIds = liveOutcomes.map((o) => o.id).sort();
  const expected = ["approve", "deny"];
  const matchesContract =
    liveOutcomeIds.length === expected.length &&
    liveOutcomeIds.every((id, i) => id === expected[i]);
  if (!matchesContract) {
    throw humangentApiError(ctx.getNode(), {
      ok: false,
      status: 412,
      code: "tool_call_review_outcome_contract_mismatch",
      message: `The Humangent backend returned a tool-call review task type with outcomes ${JSON.stringify(liveOutcomeIds)}; this node version expects ${JSON.stringify(expected)}. Upgrade the node package.`,
    });
  }
}

async function resolveSystemTaskTypeId(
  ctx: IExecuteFunctions,
  creds: HumangentCredentials,
): Promise<string> {
  // Resolve the system task type. The backend RPC is idempotent —
  // first call creates, repeats return the same row.
  const taskTypeResult = await ensureToolCallReviewTaskType(
    requesterFor(ctx),
    creds,
  );
  if (!taskTypeResult.ok) {
    throw humangentApiError(ctx.getNode(), taskTypeResult);
  }
  assertOutcomeContract(ctx, taskTypeResult.data.outcomes_json);
  return taskTypeResult.data.id;
}

function readWaitSeconds(ctx: IExecuteFunctions): number {
  const limitWaitTimeRaw = ctx.getNodeParameter("limitWaitTime", 0, 24);
  const limitWaitTime =
    typeof limitWaitTimeRaw === "number" &&
    Number.isFinite(limitWaitTimeRaw) &&
    limitWaitTimeRaw > 0
      ? limitWaitTimeRaw
      : 24;
  const limitWaitTimeUnitRaw = ctx.getNodeParameter(
    "limitWaitTimeUnit",
    0,
    "hours",
  ) as string;
  const unitSeconds = Object.hasOwn(UNIT_SECONDS, limitWaitTimeUnitRaw)
    ? UNIT_SECONDS[limitWaitTimeUnitRaw as WaitUnit]
    : UNIT_SECONDS.hours;
  return Math.max(1, Math.floor(limitWaitTime * unitSeconds));
}

function readReviewerMessage(ctx: IExecuteFunctions): string {
  // Reviewer message — n8n's HITL wrapper auto-fills this with the
  // generator's default if the builder didn't set one. We pass it
  // through as the canonical reviewer-facing copy.
  const messageRaw = ctx.getNodeParameter("message", 0, "");
  return typeof messageRaw === "string" ? messageRaw : String(messageRaw ?? "");
}

function readRedactedKeys(ctx: IExecuteFunctions): string[] {
  // Redacted keys set — case-insensitive lookup.
  return parseRedactedKeys(
    ctx.getNodeParameter("redactedParameterKeys", 0, ""),
  );
}

function buildRedactedKeysSet(redactedKeysList: string[]): Set<string> {
  return new Set(redactedKeysList.map((k) => k.toLowerCase()));
}

interface ToolCallPreview {
  proposed: ProposedToolCall;
  sanitizedParameters: unknown;
  previewText: string;
}

function buildToolCallPreview(
  items: INodeExecutionData[],
  redactedKeysSet: ReadonlySet<string>,
): ToolCallPreview {
  // Read what the AI Agent proposed and sanitize it.
  const proposed = readProposedToolCall(items);
  const sanitizedParameters = redactParameters(
    proposed.parametersRaw,
    redactedKeysSet,
  );
  return {
    proposed,
    sanitizedParameters,
    previewText: previewToString(sanitizedParameters),
  };
}

interface WorkflowOrigin {
  executionId: string | undefined;
  workflow: ReturnType<IExecuteFunctions["getWorkflow"]>;
  node: ReturnType<IExecuteFunctions["getNode"]>;
  workflowName: string | null;
}

function readWorkflowOrigin(ctx: IExecuteFunctions): WorkflowOrigin {
  // Workflow / execution / node identifiers — surfaced in the inbox
  // card via metadata.tool_call_review and visible to reviewers as
  // origin context.
  const executionId = ctx.getExecutionId();
  const workflow = ctx.getWorkflow();
  const node = ctx.getNode();
  const workflowName =
    typeof workflow.name === "string" && workflow.name.length > 0
      ? workflow.name
      : null;
  return { executionId, workflow, node, workflowName };
}

function buildFields(
  preview: ToolCallPreview,
  origin: WorkflowOrigin,
  reviewerMessage: string,
): Record<string, unknown> {
  // Standard inbox fields for the system task type. The schema
  // declares all fields as optional; we populate what we have so
  // the existing RequestFieldsCard renders the same content the
  // tool-call card surfaces (one card from metadata, one from
  // fields — both useful).
  return {
    tool_name: preview.proposed.toolName ?? "",
    parameters_preview: preview.previewText,
    workflow_name: origin.workflowName ?? "",
    execution_context: origin.executionId
      ? `n8n execution ${origin.executionId}`
      : "",
    reviewer_message: reviewerMessage,
  };
}

function buildResumeUrls(ctx: IExecuteFunctions): Record<string, string> {
  // Resume URLs cover every outcome ∪ {dismiss} — the gateway
  // validator rejects subsets. We register all three even though
  // only `approve` / `deny` round-trip through the HITL contract;
  // a reviewer hitting Dismiss in the inbox still resolves the
  // request, and the webhook handler maps it to {approved: false}.
  return {
    approve: ctx.getSignedResumeUrl({ outcome: "approve" }),
    deny: ctx.getSignedResumeUrl({ outcome: "deny" }),
    dismiss: ctx.getSignedResumeUrl({ outcome: "dismiss" }),
  };
}

function buildMetadata(
  preview: ToolCallPreview,
  origin: WorkflowOrigin,
  redactedKeysList: string[],
  waitSeconds: number,
) {
  // Structured tool-call envelope — the canonical shape consumed by
  // the reviewer-inbox `<ToolCallReviewCard />`. Documented in the
  // Humangent app repo at docs/api/public-requests-api.md §
  // "Tool-call review metadata".
  const toolCallReviewMeta = {
    source: "n8n.HumangentToolCallReview",
    version: 1,
    tool_name: preview.proposed.toolName,
    parameters_preview: preview.sanitizedParameters,
    redacted_keys: redactedKeysList,
    workflow_name: origin.workflowName,
    workflow_id:
      typeof origin.workflow.id === "string" && origin.workflow.id.length > 0
        ? origin.workflow.id
        : null,
    execution_id: origin.executionId ?? null,
    node_id: origin.node.id,
  };

  return {
    n8n_execution_id: origin.executionId,
    n8n_workflow_id: origin.workflow.id,
    n8n_node_id: origin.node.id,
    limit_wait_time_seconds: waitSeconds,
    tool_call_review: toolCallReviewMeta,
  };
}

interface CreateReviewInput {
  taskTypeId: string;
  fields: Record<string, unknown>;
  metadata: ReturnType<typeof buildMetadata>;
}

async function createToolCallReviewRequest(
  ctx: IExecuteFunctions,
  creds: HumangentCredentials,
  input: CreateReviewInput,
) {
  const result = await createRequest(requesterFor(ctx), creds, {
    taskTypeId: input.taskTypeId,
    fields: input.fields,
    resumeUrls: buildResumeUrls(ctx),
    metadata: input.metadata,
    idempotencyKey: randomUUID(),
  });
  if (!result.ok) {
    throw humangentApiError(ctx.getNode(), result);
  }
  return result;
}

function timeoutResponse(requestId: string): INodeExecutionData[][] {
  // Synthetic timeout payload. n8n routes this onto the only
  // configured Main output if waitTill fires before any webhook.
  // The agent's HITL processor reads `approved: false` and treats
  // the call as denied, with a `timed_out` flag the workflow can
  // branch on if the user wants custom timeout copy.
  return [
    [
      {
        json: {
          approved: false,
          timed_out: true,
          request_id: requestId,
          chatInput:
            "The reviewer did not respond within the configured wait time. The tool call was not executed.",
        },
      },
    ],
  ];
}

export async function executeToolCallReview(
  this: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  assertSingleInput(this, items);

  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const taskTypeId = await resolveSystemTaskTypeId(this, creds);
  const waitSeconds = readWaitSeconds(this);
  const reviewerMessage = readReviewerMessage(this);
  const redactedKeysList = readRedactedKeys(this);
  const preview = buildToolCallPreview(
    items,
    buildRedactedKeysSet(redactedKeysList),
  );
  const origin = readWorkflowOrigin(this);
  const fields = buildFields(preview, origin, reviewerMessage);
  const metadata = buildMetadata(
    preview,
    origin,
    redactedKeysList,
    waitSeconds,
  );

  const result = await createToolCallReviewRequest(this, creds, {
    taskTypeId,
    fields,
    metadata,
  });
  await this.putExecutionToWait(new Date(Date.now() + waitSeconds * 1000));

  return timeoutResponse(result.data.id);
}
