// Humangent Continue — trigger node that receives detached-mode
// decisions for a request created by a Humangent action node in
// `Create` mode.
//
// Lifecycle (canonical n8n trigger pattern, mirrors GitHubTrigger /
// StripeTrigger): on workflow activation, `webhookMethods.create`
// POSTs `api_register_subscription` and stores the resulting
// `subscription_id` in workflow static data. On deactivation,
// `webhookMethods.delete` POSTs `api_unregister_subscription`. The
// destination Humangent action node's `Create` mode passes the
// `(workflow_id, node_id, n8n_instance_id)` tuple through
// `decision_callback`; the backend resolves it back to this
// subscription at delivery time.
//
// The webhook descriptor diverges intentionally from the inline
// node's `restartWebhook: true` + `path: '={{$nodeId}}'` pattern:
// Continue uses `isFullPath: true` + `path: '={{$webhookId}}'` so
// the registered URL is stable across node renames (n8n's
// `webhookId` is documented-stable; node names aren't).
//
// Outputs reuse `configuredOutputs` from the inline node verbatim,
// so the canvas branches render identically (per-outcome lanes +
// Dismissed + Timed Out). U4 wires the actual webhook handler.

import {
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from "n8n-workflow";

import { listTaskTypes } from "../Humangent/listSearch";
import { configuredOutputs } from "../Humangent/outputs";
import {
  activationCheckExists,
  activationCreate,
  activationDelete,
} from "./continueRegistration";
import { continueWebhookHandler } from "./continueWebhook";

const description: INodeTypeDescription = {
  displayName: "Humangent Continue",
  name: "humangentContinue",
  icon: "file:humangent.svg",
  group: ["trigger"],
  version: 1,
  // Subtitle keeps the inline node's truthy-check pattern. We tag
  // the suffix `· Continue` so a canvas with both Humangent action
  // and Humangent Continue nodes side-by-side is unambiguous at a
  // glance.
  subtitle:
    '={{$parameter["taskType"] ? "Continue" : "Pick a task type"}} · Continue',
  description:
    "Receive a Humangent decision in a separate workflow when the source Humangent node uses Create mode. Routes onto the matching outcome branch.",
  defaults: { name: "Humangent Continue" },
  inputs: [],
  outputs: `={{(${configuredOutputs.toString()})($parameter)}}`,
  credentials: [{ name: "humangentApi", required: true }],
  webhooks: [
    {
      name: "default",
      httpMethod: "POST",
      responseMode: "onReceived",
      responseData: "",
      // `isFullPath: true` + `path: '={{$webhookId}}'` mounts the
      // webhook at n8n's stable `webhookId` (not the volatile node
      // id). `restartWebhook` is intentionally omitted — Continue
      // is a real trigger, not a resume webhook.
      isFullPath: true,
      path: "={{$webhookId}}",
    },
  ],
  properties: [
    // Task Type picker — symmetric to the inline node's, so
    // configuredOutputs renders the same per-outcome lanes. The
    // backend's `api_register_subscription` validates that the
    // task type belongs to the calling org before binding the
    // subscription.
    {
      displayName: "Task Type",
      name: "taskType",
      type: "resourceLocator",
      required: true,
      default: { mode: "list", value: "" },
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
      description:
        "Which task type's decisions this Continue node should receive. Must match the source Humangent node's task type.",
    },
  ],
};

export class HumangentContinue implements INodeType {
  description = description;

  methods = {
    listSearch: {
      listTaskTypes,
    },
  };

  webhookMethods = {
    default: {
      checkExists: activationCheckExists,
      create: activationCreate,
      delete: activationDelete,
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return continueWebhookHandler.call(this);
  }
}
