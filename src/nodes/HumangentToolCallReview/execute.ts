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

function readProposedToolCall(
  items: INodeExecutionData[],
): ProposedToolCall {
  const first = items[0];
  if (!first) return { toolName: null, parametersRaw: undefined };
  const json = (first.json ?? {}) as Record<string, unknown>;
  // The HITL wrapper resolves `$tool.name` / `$tool.parameters` into
  // either top-level keys on json or nested under `tool`. Read both
  // shapes; n8n versions vary.
  const toolField = json["tool"];
  const nested =
    toolField && typeof toolField === "object" && !Array.isArray(toolField)
      ? (toolField as Record<string, unknown>)
      : undefined;
  const toolNameRaw =
    (typeof json["toolName"] === "string" && json["toolName"]) ||
    (typeof json["tool_name"] === "string" && json["tool_name"]) ||
    (nested && typeof nested["name"] === "string" && nested["name"]) ||
    null;
  const parametersRaw =
    json["toolParameters"] ?? json["tool_parameters"] ?? nested?.["parameters"];
  return {
    toolName: typeof toolNameRaw === "string" ? toolNameRaw : null,
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

export async function executeToolCallReview(
  this: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  if (items.length > 1) {
    throw new NodeOperationError(
      this.getNode(),
      `Humangent Tool Call Review expects a single input item per execute; received ${items.length}. The HITL wrapper invokes this once per agent tool call — N>1 indicates an upstream Loop / Split In Batches the agent did not intend.`,
    );
  }

  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;

  // Resolve the system task type. The backend RPC is idempotent —
  // first call creates, repeats return the same row.
  const taskTypeResult = await ensureToolCallReviewTaskType(
    requesterFor(this),
    creds,
  );
  if (!taskTypeResult.ok) {
    throw humangentApiError(this.getNode(), taskTypeResult);
  }
  const taskTypeId = taskTypeResult.data.id;
  const liveOutcomes = taskTypeResult.data.outcomes_json;

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
    throw humangentApiError(this.getNode(), {
      ok: false,
      status: 412,
      code: "tool_call_review_outcome_contract_mismatch",
      message: `The Humangent backend returned a tool-call review task type with outcomes ${JSON.stringify(liveOutcomeIds)}; this node version expects ${JSON.stringify(expected)}. Upgrade the node package.`,
    });
  }

  // Wait-time configuration.
  const limitWaitTimeRaw = this.getNodeParameter("limitWaitTime", 0, 24);
  const limitWaitTime =
    typeof limitWaitTimeRaw === "number" &&
    Number.isFinite(limitWaitTimeRaw) &&
    limitWaitTimeRaw > 0
      ? limitWaitTimeRaw
      : 24;
  const limitWaitTimeUnitRaw = this.getNodeParameter(
    "limitWaitTimeUnit",
    0,
    "hours",
  ) as string;
  const unitSeconds = Object.hasOwn(UNIT_SECONDS, limitWaitTimeUnitRaw)
    ? UNIT_SECONDS[limitWaitTimeUnitRaw as WaitUnit]
    : UNIT_SECONDS.hours;
  const waitSeconds = Math.max(1, Math.floor(limitWaitTime * unitSeconds));

  // Reviewer message — n8n's HITL wrapper auto-fills this with the
  // generator's default if the builder didn't set one. We pass it
  // through as the canonical reviewer-facing copy.
  const messageRaw = this.getNodeParameter("message", 0, "");
  const reviewerMessage =
    typeof messageRaw === "string" ? messageRaw : String(messageRaw ?? "");

  // Redacted keys set — case-insensitive lookup.
  const redactedKeysParam = this.getNodeParameter(
    "redactedParameterKeys",
    0,
    "",
  );
  const redactedKeysList = parseRedactedKeys(redactedKeysParam);
  const redactedKeysSet = new Set(redactedKeysList.map((k) => k.toLowerCase()));

  // Read what the AI Agent proposed and sanitize it.
  const proposed = readProposedToolCall(items);
  const sanitizedParameters = redactParameters(
    proposed.parametersRaw,
    redactedKeysSet,
  );
  const previewText = previewToString(sanitizedParameters);

  // Workflow / execution / node identifiers — surfaced in the inbox
  // card via metadata.tool_call_review and visible to reviewers as
  // origin context.
  const executionId = this.getExecutionId();
  const workflow = this.getWorkflow();
  const node = this.getNode();
  const workflowName =
    typeof workflow.name === "string" && workflow.name.length > 0
      ? workflow.name
      : null;

  // Standard inbox fields for the system task type. The schema
  // declares all fields as optional; we populate what we have so
  // the existing RequestFieldsCard renders the same content the
  // tool-call card surfaces (one card from metadata, one from
  // fields — both useful).
  const fields: Record<string, unknown> = {
    tool_name: proposed.toolName ?? "",
    parameters_preview: previewText,
    workflow_name: workflowName ?? "",
    execution_context: executionId ? `n8n execution ${executionId}` : "",
    reviewer_message: reviewerMessage,
  };

  // Resume URLs cover every outcome ∪ {dismiss} — the gateway
  // validator rejects subsets. We register all three even though
  // only `approve` / `deny` round-trip through the HITL contract;
  // a reviewer hitting Dismiss in the inbox still resolves the
  // request, and the webhook handler maps it to {approved: false}.
  const resumeUrls: Record<string, string> = {
    approve: this.getSignedResumeUrl({ outcome: "approve" }),
    deny: this.getSignedResumeUrl({ outcome: "deny" }),
    dismiss: this.getSignedResumeUrl({ outcome: "dismiss" }),
  };

  // Structured tool-call envelope — the canonical shape consumed by
  // the reviewer-inbox `<ToolCallReviewCard />`. Documented in the
  // Humangent app repo at docs/api/public-requests-api.md §
  // "Tool-call review metadata".
  const toolCallReviewMeta = {
    source: "n8n.HumangentToolCallReview",
    version: 1,
    tool_name: proposed.toolName,
    parameters_preview: sanitizedParameters,
    redacted_keys: redactedKeysList,
    workflow_name: workflowName,
    workflow_id:
      typeof workflow.id === "string" && workflow.id.length > 0
        ? workflow.id
        : null,
    execution_id: executionId ?? null,
    node_id: node.id,
  };

  const metadata = {
    n8n_execution_id: executionId,
    n8n_workflow_id: workflow.id,
    n8n_node_id: node.id,
    limit_wait_time_seconds: waitSeconds,
    tool_call_review: toolCallReviewMeta,
  };

  const result = await createRequest(requesterFor(this), creds, {
    taskTypeId,
    fields,
    resumeUrls,
    metadata,
    idempotencyKey: randomUUID(),
  });
  if (!result.ok) {
    throw humangentApiError(this.getNode(), result);
  }

  const waitTill = new Date(Date.now() + waitSeconds * 1000);
  await this.putExecutionToWait(waitTill);

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
          request_id: result.data.id,
          chatInput:
            "The reviewer did not respond within the configured wait time. The tool call was not executed.",
        },
      },
    ],
  ];
}
