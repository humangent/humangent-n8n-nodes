// Lifecycle helpers for the Humangent Continue trigger node.
//
// n8n calls webhookMethods.default.{checkExists,create,delete} on
// workflow activation, deactivation, and pre-activation
// existence-check. These helpers wrap the public-API subscription
// RPCs (registered in `lib/api.ts`) and apply the small amount of
// node-context glue n8n's hook surface needs (resolve webhook URL,
// read params, mutate static data).
//
// Activation / deactivation flow:
//   * `activationCreate` → POST api_register_subscription → store
//     subscription_id in workflow static data → return true.
//   * `activationDelete` → POST api_unregister_subscription with the
//     stored subscription_id → clear static data → return true
//     (best-effort; backend's R18 retry path covers any cleanup
//     deliveries that fail).
//   * `activationCheckExists` → resolve current subscription via the
//     stored id (when present) → return true if its registered
//     webhook_url matches the current node's webhook URL; false
//     otherwise to force re-register via `create`.
//
// **Note on api_resolve_subscription posture.** The backend's
// `api_resolve_subscription` RPC is service-role only — see
// `apps/api/supabase/migrations/20260429100003_subscription_rpcs.sql`
// (~line 245). The Continue node cannot call it directly with the
// hmk_(live|test)_* key. `activationCheckExists` therefore relies on
// the static-data round-trip: if our static data has a
// `subscription_id` AND a stored `webhook_url`, and n8n's current
// node webhook URL still matches, treat the subscription as
// existing. Any mismatch returns false to force re-registration.
// On webhookId rebinding (n8n upgrade, workflow duplication) the
// register call's `ON CONFLICT DO UPDATE` refreshes the row's
// `webhook_url` so the new URL still resolves at delivery time.

import { NodeOperationError } from "n8n-workflow";
import type { IDataObject, IHookFunctions } from "n8n-workflow";

import {
  registerSubscription,
  unregisterSubscription,
  type HumangentCredentials,
} from "../../lib/api";
import { extractTaskTypeId } from "../../lib/taskTypeValue";
import { requesterFor } from "../Humangent/n8nBridge";

const STATIC_KEY = "humangentContinueSubscription";

interface SubscriptionStaticData {
  subscriptionId?: string;
  webhookUrl?: string;
  taskTypeId?: string;
}

function readSubscriptionData(ctx: IHookFunctions): {
  data: SubscriptionStaticData;
  staticData: IDataObject;
} {
  const staticData = ctx.getWorkflowStaticData("node") as IDataObject;
  const existing = (staticData[STATIC_KEY] ?? {}) as SubscriptionStaticData;
  return { data: existing, staticData };
}

function writeSubscriptionData(
  ctx: IHookFunctions,
  data: SubscriptionStaticData,
): void {
  const staticData = ctx.getWorkflowStaticData("node") as IDataObject;
  staticData[STATIC_KEY] = data as unknown as IDataObject;
}

function clearSubscriptionData(ctx: IHookFunctions): void {
  const staticData = ctx.getWorkflowStaticData("node") as IDataObject;
  delete staticData[STATIC_KEY];
}

// Decode the Task Type ID from the resourceLocator's `value`. The
// value carries `<task-type-id>#o=<encoded-snapshot>`; we strip the
// `#o=` suffix via the shared `extractTaskTypeId` helper.
function readTaskTypeId(ctx: IHookFunctions): string {
  const taskTypeParam = ctx.getNodeParameter("taskType", undefined) as
    | { value?: unknown }
    | string
    | null;
  let raw = "";
  if (typeof taskTypeParam === "string") {
    raw = taskTypeParam;
  } else if (
    taskTypeParam &&
    typeof (taskTypeParam as { value?: unknown }).value === "string"
  ) {
    raw = (taskTypeParam as { value: string }).value;
  }
  return extractTaskTypeId(raw.trim());
}

/**
 * Read the credential's auto-minted `instanceId`. Empty string after
 * trim is a hard error — the credential's `preAuthentication` hook
 * mints one on first auth round-trip, so reaching activation without
 * one means the credential never authenticated (e.g., the user
 * activated the workflow without saving credentials first).
 */
function readInstanceId(creds: HumangentCredentials): string {
  const trimmed =
    typeof creds.instanceId === "string" ? creds.instanceId.trim() : "";
  return trimmed;
}

export async function activationCreate(this: IHookFunctions): Promise<boolean> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const instanceId = readInstanceId(creds);
  if (instanceId.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Humangent credential is missing its n8n Instance ID. Open the Humangent credential, save it once, then re-activate the workflow.",
    );
  }

  const webhookUrl = this.getNodeWebhookUrl("default");
  if (typeof webhookUrl !== "string" || webhookUrl.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Could not resolve webhook URL for this Continue node. Save the workflow first, then re-activate.",
    );
  }

  const taskTypeId = readTaskTypeId(this);
  if (taskTypeId.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Pick a task type on this Continue node before activating the workflow.",
    );
  }

  const workflowId = String(this.getWorkflow().id ?? "");
  const nodeId = this.getNode().id;

  const result = await registerSubscription(requesterFor(this), creds, {
    workflowId,
    nodeId,
    n8nInstanceId: instanceId,
    webhookUrl,
    taskTypeId,
  });

  if (!result.ok) {
    // Surface the backend hint (e.g., n8n_origin_not_allowed,
    // task_type_org_mismatch, n8n_allowed_origins_unset) as a
    // builder-readable error so n8n refuses to activate. The hint
    // suffix-stripping convention (see
    // `docs/solutions/conventions/rpc-error-code-suffix-stripping-2026-04-25.md`)
    // means the prefix before `:` is the stable error class.
    const baseCode = result.code.split(":")[0];
    throw new NodeOperationError(
      this.getNode(),
      `Could not register Continue with Humangent: ${result.message} (${baseCode}).`,
      { description: result.message },
    );
  }

  writeSubscriptionData(this, {
    subscriptionId: result.data.id,
    webhookUrl,
    taskTypeId,
  });
  return true;
}

export async function activationDelete(this: IHookFunctions): Promise<boolean> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const { data } = readSubscriptionData(this);
  const subscriptionId = data.subscriptionId;

  // Static data may legitimately be empty on the first deactivation
  // after a partial activation failure. Treat as a no-op.
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
    return true;
  }

  // Best-effort: log + swallow on failure. The backend's
  // `api_unregister_subscription` is itself idempotent on missing /
  // already-deleted rows, and R18 retry covers any in-flight
  // deliveries that hit a stale URL after we've torn down here.
  const result = await unregisterSubscription(
    requesterFor(this),
    creds,
    subscriptionId,
  );
  if (!result.ok) {
    this.logger?.warn?.("humangent.continue.unregister_failed", {
      subscription_id: subscriptionId,
      code: result.code,
      message: result.message,
    } as IDataObject);
  }

  clearSubscriptionData(this);
  return true;
}

export async function activationCheckExists(
  this: IHookFunctions,
): Promise<boolean> {
  // Service-role-gated `api_resolve_subscription` is unreachable from
  // the public-API key context (see file header). We use the static
  // data we wrote during the last successful activationCreate as the
  // source of truth, falling back to false to force a fresh
  // registration whenever:
  //   * static data is empty (first activation, or a previously
  //     partial-failed activation),
  //   * the stored webhook URL no longer matches the current node
  //     webhook URL (e.g., n8n upgrade rebound the webhookId,
  //     workflow duplication, or any other URL volatility).
  // The register RPC's `ON CONFLICT DO UPDATE` makes re-registration
  // safe — it refreshes `webhook_url` and returns the same
  // subscription_id, so no orphan rows accumulate.
  const { data } = readSubscriptionData(this);
  const subscriptionId = data.subscriptionId;
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
    return false;
  }
  const currentUrl = this.getNodeWebhookUrl("default");
  if (typeof currentUrl !== "string" || currentUrl.length === 0) {
    return false;
  }
  return data.webhookUrl === currentUrl;
}
