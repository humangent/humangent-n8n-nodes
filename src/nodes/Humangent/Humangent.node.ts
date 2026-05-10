// The Humangent action node — the first-party n8n wrapper over
// Humangent's public API v2. Drops onto a workflow canvas, opens a
// request via api_create_request with per-outcome signed resume URLs,
// calls putExecutionToWait, and resumes on the matching output
// branch when the Humangent outbox worker (public API v2 Unit 4 —
// not yet shipped on develop) POSTs an HMAC-signed decision.
//
// Unit 3 of docs/plans/2026-04-23-001-feat-n8n-node-v1-plan.md lands
// the descriptor + listSearch + resourceMapper. Unit 4 fills in
// execute; Unit 5 fills in webhook. Until then the runtime methods
// raise ApplicationError so anyone wiring this node prematurely
// knows the state (and the lint rule that forbids plain `throw new
// Error()` inside an execute block is satisfied).
//
// The descriptor lives in this file — not a sibling description.ts —
// because eslint-plugin-n8n-nodes-base's node-filename-against-convention
// rule expects the INodeTypeDescription object's `name` to match the
// enclosing filename.

import {
  SEND_AND_WAIT_OPERATION,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from "n8n-workflow";

import { RESTART_WEBHOOK_DESCRIPTIONS } from "../../lib/nodeDescriptions";
import { executeCreateRequest } from "./execute";
import { listTaskTypes } from "./listSearch";
import { configuredOutputs } from "./outputs";
import { getTaskTypeSchema } from "./resourceMapper";
import { webhookResume } from "./webhook";

const description: INodeTypeDescription = {
  displayName: "Humangent",
  name: "humangent",
  icon: "file:humangent.svg",
  group: ["transform"],
  version: 1,
  // n8n's WorkflowDataProxy auto-unwraps a resourceLocator parameter
  // to its `.value` string before reaching expressions, so
  // `$parameter["taskType"]["cachedResultName"]` is unreachable. The
  // value string carries `<task-type-id>#o=<encoded-snapshot>` —
  // showing the encoded blob is ugly and showing just the id is
  // unhelpful. Use a static label that flips on whether anything is
  // picked at all, with a mode-aware suffix once the user-facing
  // `mode` property is set.
  subtitle:
    '={{$parameter["taskType"] ? ($parameter["mode"] === "create" ? "Create" : "Wait for human decision") : "Pick a task type"}}',
  description:
    "Pause the workflow on a human decision and resume on the matching outcome branch",
  defaults: { name: "Humangent" },
  inputs: ["main"],
  outputs: `={{(${configuredOutputs.toString()})($parameter)}}`,
  credentials: [{ name: "humangentApi", required: true }],
  // Resume-on-decision webhooks. Mirrors n8n's canonical
  // `sendAndWaitWebhooksDescription` from
  // packages/nodes-base/utils/sendAndWait/descriptions.ts in n8n core
  // — same shape Slack / Email / Microsoft Teams / Telegram all
  // declare for their `sendAndWait` operations. Two descriptors
  // (GET + POST) registered on the same restart-webhook path so the
  // approval-button click (GET) and the API delivery (POST) both
  // reach this node.
  webhooks: RESTART_WEBHOOK_DESCRIPTIONS,
  properties: [
    // Hidden marker that opts the node into n8n core's send-and-wait
    // waiting-webhook validator branch.
    //
    // n8n's `WaitingWebhooks.executeWebhook` (cli) inspects the
    // resumed execution's last-node parameters. When `operation ===
    // SEND_AND_WAIT_OPERATION`, it runs the HMAC validator that
    // matches the `?signature=` query param `getSignedResumeUrl`
    // mints. Without this flag the validator falls back to
    // comparing the query param against the opaque
    // `execution.data.resumeToken` and every signed delivery 401s
    // with `{"error":"Invalid token"}` — empirically reproduced on
    // a hosted n8n instance.
    //
    // alpha.14 wrongly removed this marker after blaming it for the
    // canvas regressions reported on alpha.12. The actual canvas
    // root cause was the alpha.11 webhook-descriptor truncation
    // (single POST, no `isFullPath`) which was fixed independently
    // in alpha.13. The editor-ui only references this constant in
    // benign hint code (a tooltip + a wait-state label) — verified
    // in `packages/frontend/editor-ui/src/app/utils/nodeViewUtils.ts`
    // and `packages/frontend/editor-ui/src/features/workflows/canvas/
    // composables/useCanvasMapping.ts`.
    //
    // Hidden because workflow authors have no decision to make:
    // every Humangent execution is a send-and-wait flow by
    // definition. The value is read by n8n core, not by our
    // execute logic.
    {
      displayName: "Operation",
      name: "operation",
      type: "hidden",
      default: SEND_AND_WAIT_OPERATION,
    },
    // User-facing Mode toggle. Defaults to `createAndWait` so saved
    // alpha.20 workflows that predate this property load on the
    // existing inline path with no behavior change. The hidden
    // `operation` marker above stays pinned to SEND_AND_WAIT_OPERATION
    // in BOTH modes — n8n core's `WaitingWebhooks.executeWebhook`
    // reads `operation` (not `mode`) to pick the HMAC validator
    // branch, and the inline `Create and Wait` path still depends on
    // that wire. The user-facing dropdown is a pure descriptor add.
    {
      displayName: "Mode",
      name: "mode",
      type: "options",
      default: "createAndWait",
      options: [
        {
          name: "Create and Wait",
          value: "createAndWait",
          description: "Pause this workflow until the reviewer decides",
        },
        {
          name: "Create",
          value: "create",
          description:
            "Create the request and continue immediately. Use a Humangent Continue node in another workflow to receive the decision.",
        },
      ],
    },
    {
      displayName: "Task Type",
      name: "taskType",
      type: "resourceLocator",
      required: true,
      default: { mode: "list", value: "" },
      displayOptions: { show: { mode: ["createAndWait", "create"] } },
      modes: [
        {
          displayName: "From List",
          name: "list",
          type: "list",
          placeholder: "Select a task type…",
          typeOptions: {
            searchListMethod: "listTaskTypes",
            searchable: true,
          },
        },
      ],
      description: "Which task type to create a request against",
    },
    {
      displayName: "Fields",
      name: "fields",
      type: "resourceMapper",
      noDataExpression: true,
      default: { mappingMode: "defineBelow", value: null },
      required: true,
      displayOptions: { show: { mode: ["createAndWait", "create"] } },
      typeOptions: {
        // taskType is a resourceLocator. The watcher does NOT
        // auto-unwrap to `.value` the way WorkflowDataProxy does in
        // runtime expressions — point at the `.value` sub-path so the
        // schema reloads when the user picks a different task type
        // (matches the Postgres node's pattern, packages/nodes-base/
        // nodes/Postgres/v2/actions/database/insert.operation.ts).
        loadOptionsDependsOn: ["taskType.value"],
        resourceMapper: {
          resourceMapperMethod: "getTaskTypeSchema",
          mode: "add",
          valuesLabel: "Field",
          fieldWords: { singular: "field", plural: "fields" },
          supportAutoMap: true,
        },
      },
    },
    // Continuation Workflow + Continue Node pickers — visible only
    // in `Create` mode. The pair tells the backend which n8n workflow
    // + node to deliver the decision back to. Backend resolves the
    // (workflow_id, node_id, n8n_instance_id) tuple to a registered
    // Continue subscription at create time. U0 spike has not yet
    // committed to a picker primitive (A/B/C); we ship fallback C
    // (typed-string node name) as the safe default. The backend's
    // resolution is independent of how the picker stored the values
    // — promoting to A or B later does not break the wire.
    {
      displayName: "Continuation Workflow",
      name: "continueWorkflow",
      type: "workflowSelector",
      required: true,
      default: "",
      displayOptions: { show: { mode: ["create"] } },
      description:
        "Pick the workflow that contains the Humangent Continue node that should receive the decision",
    },
    {
      displayName: "Continue Node Name",
      name: "continueNodeName",
      type: "string",
      required: true,
      default: "",
      displayOptions: { show: { mode: ["create"] } },
      placeholder: "e.g., Humangent Continue",
      description:
        "Enter the destination Humangent Continue node name exactly as it appears in the selected workflow",
    },
    {
      displayName: "Limit Wait Time",
      name: "limitWaitTime",
      type: "number",
      default: 24,
      displayOptions: { show: { mode: ["createAndWait", "create"] } },
      description:
        "How long to wait for a decision before routing to the Timed Out branch",
      typeOptions: { minValue: 1 },
    },
    {
      displayName: "Wait Time Unit",
      name: "limitWaitTimeUnit",
      type: "options",
      default: "hours",
      displayOptions: { show: { mode: ["createAndWait", "create"] } },
      description:
        "Unit applied to Limit Wait Time. For long reviews, use Create mode with a Humangent Continue node in another workflow.",
      options: [
        { name: "Minutes", value: "minutes" },
        { name: "Hours", value: "hours" },
        { name: "Days", value: "days" },
      ],
    },
    // Optional revision-continuation pointer. When the upstream
    // workflow node was a Humangent that resumed on a
    // `revision-request` outcome, the builder pipes its `requestId`
    // into this parameter to link the new request as the next
    // iteration of the chain. Empty (default) → this request starts a
    // fresh chain. The value is trimmed + UUID-validated in execute()
    // before forwarding to `p_parent_request_id`; non-UUID input
    // throws a NodeOperationError with the offending string truncated
    // (so the workflow author sees a clean error rather than a leaky
    // PostgREST 22P02).
    {
      displayName: "Parent Request ID (Continuation)",
      name: "parentRequestId",
      type: "string",
      default: "",
      displayOptions: { show: { mode: ["createAndWait", "create"] } },
      placeholder: "{{ $('Humangent Previous').item.json.requestId }}",
      description:
        "Optional. Pass the previous Humangent node's requestId to link this request to an earlier review. Leave empty for the first review in a chain.",
    },
  ],
};

export class Humangent implements INodeType {
  description = description;

  methods = {
    listSearch: {
      listTaskTypes,
    },
    resourceMapping: {
      getTaskTypeSchema,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return executeCreateRequest.call(this);
  }

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return webhookResume.call(this);
  }
}
