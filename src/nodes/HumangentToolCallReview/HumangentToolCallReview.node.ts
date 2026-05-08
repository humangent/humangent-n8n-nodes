// Humangent Tool Call Review — second public n8n node.
//
// Purpose: act as the human-review channel for n8n's AI Agent
// tool-call HITL surface. n8n's HITL generator (hitl-tools.ts in the
// cli package) auto-wraps any node whose name does NOT end with
// "Tool" and that exposes a `webhooks` config plus an `operation`
// property containing the SEND_AND_WAIT_OPERATION value. The wrapper
// reshapes inputs/outputs to AiTool, hides the operation, and the
// agent processes the resume with the `{approved: bool, chatInput?:
// string}` contract from packages/@n8n/nodes-langchain/utils/
// agent-execution/processHitlResponses.ts.
//
// This descriptor only declares the eligibility contract + builder-
// facing options. The execute / webhook handlers are sibling files
// (execute.ts / webhook.ts) so the contract surface stays small and
// the existing approval node (../Humangent/Humangent.node.ts) is
// untouched.
//
// Outcome contract: this node always uses the system task type
// returned by `api_ensure_tool_call_review_task_type`. That task
// type's outcomes are pinned to `approve` (default-positive) +
// `deny` (secondary) and locked from editor mutation by the
// Humangent backend trigger (migration 20260507000004). The node
// maps `outcome_id === "approve" && !is_dismiss` to
// `{approved: true}` and everything else (deny / dismiss / drift /
// malformed) to `{approved: false}` with an optional `chatInput`
// carrying the reviewer's note.
//
// Plan: humangent app repo —
// docs/plans/2026-05-07-002-feat-humangent-tool-call-review-plan.md U4.

import {
  SEND_AND_WAIT_OPERATION,
  type IExecuteFunctions,
  type INodeType,
  type INodeTypeDescription,
  type INodeExecutionData,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from "n8n-workflow";

import { executeToolCallReview } from "./execute";
import { webhookToolCallReviewResume } from "./webhook";

const description: INodeTypeDescription = {
  displayName: "Humangent Tool Call Review",
  // MUST NOT end with "Tool" — n8n's hitl-tools.ts:hasSendAndWaitOperation
  // skips any node whose name suffixes "Tool" (preventing infinite
  // wrapping of an already-wrapped HitlTool variant). The wrapped
  // variant n8n generates is named `humangentToolCallReviewHitlTool`.
  name: "humangentToolCallReview",
  icon: "file:humangent.svg",
  group: ["transform"],
  version: 1,
  subtitle: '={{$parameter["message"] || "Wait for tool-call review"}}',
  description:
    "Pause the AI Agent on a proposed tool call until a Humangent reviewer approves or denies",
  defaults: { name: "Humangent Tool Call Review" },
  inputs: ["main"],
  outputs: ["main"],
  credentials: [{ name: "humangentApi", required: true }],
  // Resume webhooks. Same shape as the existing Humangent approval
  // node — two descriptors (GET + POST) on the same restart-webhook
  // path so both the API delivery POST and any approval-link GET
  // hit this node's webhook handler. The HITL wrapper does not
  // override these.
  webhooks: [
    {
      name: "default",
      httpMethod: "GET",
      responseMode: "onReceived",
      responseData: "",
      path: "={{ $nodeId }}",
      restartWebhook: true,
      isFullPath: true,
    },
    {
      name: "default",
      httpMethod: "POST",
      responseMode: "onReceived",
      responseData: "",
      path: "={{ $nodeId }}",
      restartWebhook: true,
      isFullPath: true,
    },
  ],
  properties: [
    // `operation` MUST be a `type: "options"` with at least one
    // option whose `value === SEND_AND_WAIT_OPERATION` for n8n's
    // hitl-tools.ts:hasSendAndWaitOperation to detect this node as
    // HITL-eligible. The hidden default works for n8n core's
    // WaitingWebhooks HMAC validator (the existing approval node),
    // but the HITL generator iterates `operationProp.options` and
    // a hidden property has no options array — it skips. Concretely:
    // expose options shape, set the default, and let the HITL
    // wrapper hide it via filterHitlToolProperties at convert time.
    {
      displayName: "Operation",
      name: "operation",
      type: "options",
      noDataExpression: true,
      options: [
        {
          name: "Send and Wait for Approval",
          value: SEND_AND_WAIT_OPERATION,
          description: "Pause until a reviewer approves or denies the tool call",
          action: "Send and wait for approval",
        },
      ],
      default: SEND_AND_WAIT_OPERATION,
    },
    // Reviewer message. The HITL generator populates this with a
    // default expression (`={{ "The agent wants to call " + $tool.name }}`)
    // when the node is auto-wrapped, but exposing our own default
    // keeps the node usable outside the agent context too (e.g. a
    // builder dropping it into a non-agent flow as a generic gated
    // approval).
    {
      displayName: "Message",
      name: "message",
      type: "string",
      default: "=The agent wants to call {{ $tool?.name || \"a tool\" }}",
      typeOptions: { rows: 3 },
      description:
        "Message to show the reviewer. Use n8n expressions to reference {{ $tool.name }} and {{ $tool.parameters }} from the gated tool input.",
    },
    {
      displayName: "Limit Wait Time",
      name: "limitWaitTime",
      type: "number",
      default: 24,
      description:
        "How long to wait for a reviewer decision before treating the call as denied",
      typeOptions: { minValue: 1 },
    },
    {
      displayName: "Wait Time Unit",
      name: "limitWaitTimeUnit",
      type: "options",
      default: "hours",
      description:
        "Unit applied to Limit Wait Time. n8n's EXECUTIONS_TIMEOUT_MAX still caps the wait; configure the env to extend.",
      options: [
        { name: "Minutes", value: "minutes" },
        { name: "Hours", value: "hours" },
        { name: "Days", value: "days" },
      ],
    },
    {
      displayName: "Redact Parameter Keys",
      name: "redactedParameterKeys",
      type: "string",
      default: "",
      placeholder: "body, authorization, password",
      description:
        "Comma-separated list of parameter keys whose values must be redacted in the reviewer-visible preview. Values become \"[REDACTED]\". Recommended for any free-form text the agent generated.",
    },
  ],
};

export class HumangentToolCallReview implements INodeType {
  description = description;

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return executeToolCallReview.call(this);
  }

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return webhookToolCallReviewResume.call(this);
  }
}
