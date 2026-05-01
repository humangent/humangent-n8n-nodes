// Humangent node — execute() logic.
//
// Flow:
//   1. Read node parameters (taskType resourceLocator, fields, wait time).
//   2. Validate task-type selection + wait-time shape.
//   3. Mint a per-execute UUIDv4 idempotency key.
//   4. Fetch live task-type outcomes; decode the snapshot from the
//      resourceLocator's `value` (alpha.14+ encodes the snapshot as
//      `<task-type-id>#o=<encoded>` on the value string — see
//      listSearch.ts and outputs.ts for why we can't put it on
//      `cachedResultUrl`). If snapshot is empty but live has outcomes
//      (= old workflow that hasn't been re-picked since alpha.14),
//      throw `task_type_snapshot_missing` so the author refreshes
//      before the request lands.
//   5. Compute drift summary (id-set drift + label drift) for
//      `metadata.n8n_drift`. Drift is non-blocking — workflow
//      proceeds; backend audit retains the divergence record.
//   6. Build per-outcome signed resume URLs against ALL live
//      outcomes (gateway's _validate_resume_urls rejects subsets),
//      plus one for `dismiss`.
//   7. Call api_create_request with fields + resume_urls + metadata.
//   8. On 2xx: putExecutionToWait(waitTill) and return a sparse
//      branch array indexed by the SNAPSHOT (canvas-truth source).
//      Synthetic Timed Out payload at index `snapshot.length + 1`.
//      If a webhook hits first, webhook.ts's handler overrides the
//      routing.
//   9. On error: raise NodeApiError with builder-readable copy via
//      errors.ts's humangentApiError factory.
//
// v1 limitations worth flagging:
//   * Single-item execute. A single putExecutionToWait can only
//     route on one decision, so receiving N > 1 input items is a
//     foot-gun; we fail fast with a pointer to the Loop / Split In
//     Batches pattern rather than silently using item 0.
//   * Test-step mode (getMode() === 'manual') uses whichever tier
//     the builder configured in the credential (hmk_live_* or
//     hmk_test_*). No separate in-node branch; the test tier is a
//     credential property per R38.
//   * No request_url surfacing on the canvas — api_create_request
//     returns the request row, not a deep link. Follow-up when the
//     API exposes it.

import { randomUUID } from "node:crypto";

import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type JsonObject,
} from "n8n-workflow";

import {
  createRequest,
  getTaskType,
  type DecisionCallback,
  type HumangentCredentials,
} from "../../lib/api";
import type { Outcome } from "../../lib/schemas";
import {
  buildEmptyBranches,
  decodeSnapshot,
  humangentApiError,
  syntheticTimedOutPayload,
} from "./errors";
import { requesterFor } from "./n8nBridge";

type WaitUnit = "minutes" | "hours" | "days";

const UNIT_SECONDS: Record<WaitUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

const ONE_HOUR_SECONDS = 3600;

/**
 * Build the canvas-after-execution hint that confirms what the
 * backend resolved on the detached path. The hint name + task type
 * come from `decision_callback_resolved` on the api_create_request
 * response (Phase A backend) so a fallback-C typo on the Continue
 * Node Name picker shows the actually-targeted node here, not the
 * one the builder thought they typed.
 */
function buildDetachedExecutionHint(args: {
  resolvedContinueName?: string;
  resolvedTaskTypeName?: string;
  requestUrl?: string | null;
}): string {
  const continueLabel = args.resolvedContinueName ?? "(unresolved)";
  const taskTypeLabel = args.resolvedTaskTypeName ?? "(unresolved)";
  const url = args.requestUrl ?? "(no URL)";
  return `Review request created. Decision will be delivered to Continue node \`${continueLabel}\` (Task Type: \`${taskTypeLabel}\`) when the reviewer decides — view request: ${url}.`;
}

export async function executeCreateRequest(
  this: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();

  // A single execute() call puts the whole execution into wait; n8n's
  // resume machinery can only route on one decision. Processing
  // multiple items silently with item-0's parameters would be a
  // surprising foot-gun (workflow receives N items, only 1 decision
  // fires). Fail fast with a pointer to the split/loop pattern.
  if (items.length > 1) {
    throw new NodeOperationError(
      this.getNode(),
      `Humangent expects a single input item per execute; received ${items.length}. Use a Loop / Split In Batches node upstream so each item creates its own review request.`,
    );
  }

  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;

  // Mode toggle (alpha.21): default `createAndWait` preserves
  // the inline path verbatim for saved workflows that predate the
  // field. `create` dispatches to the detached-mode path further
  // down — backend hands the decision off to a Humangent Continue
  // node in another workflow rather than holding this execution
  // open via putExecutionToWait.
  const mode = (this.getNodeParameter("mode", 0, "createAndWait") ??
    "createAndWait") as string;

  // Read the resourceLocator object. `value` carries the encoded
  // task-type-id + outcomes snapshot (`<task-type-id>#o=<encoded>`).
  // We split on the marker to recover the real task-type UUID for
  // server calls, and decode the suffix for the canvas-aligned
  // snapshot. See listSearch.ts's `encodeTaskTypeValue` for the
  // producer side and the comment block in outputs.ts for why the
  // snapshot lives in `value` rather than on `cachedResultUrl`.
  const taskTypeParam = this.getNodeParameter("taskType", 0) as {
    __rl?: boolean;
    mode?: string;
    value?: unknown;
    cachedResultName?: string;
    cachedResultUrl?: string;
  };
  const rawValue =
    typeof taskTypeParam?.value === "string" ? taskTypeParam.value.trim() : "";
  // `lastIndexOf` for parity with the decoders — the snapshot
  // marker is always the LAST `#o=` so any earlier substrings in
  // a malformed/hand-edited value don't truncate the id prefix.
  const markerIdx = rawValue.lastIndexOf("#o=");
  const taskTypeId = markerIdx < 0 ? rawValue : rawValue.slice(0, markerIdx);
  // Resource-mapper output shape. n8n's editor produces
  // `{ mappingMode, value: {…} | null, ...}` but a saved workflow
  // could in theory carry something else; only accept a plain object
  // for `value`, otherwise treat as no fields supplied.
  const fieldsParamRaw = this.getNodeParameter("fields", 0, {});
  const fieldsValue = (fieldsParamRaw as { value?: unknown } | null | undefined)
    ?.value;
  const fieldsParam = {
    value:
      fieldsValue !== null &&
      typeof fieldsValue === "object" &&
      !Array.isArray(fieldsValue)
        ? (fieldsValue as Record<string, unknown>)
        : null,
  };
  // Coerce explicitly: n8n's editor descriptor declares this as a
  // number with default 24, but a saved workflow could in theory
  // carry a string (e.g. an unresolved expression that didn't pass
  // a number through). `Math.floor(NaN * x)` is NaN; `Math.max(1,
  // NaN)` is NaN; `new Date(now + NaN * 1000)` is Invalid Date —
  // which n8n's putExecutionToWait would silently mishandle. Coerce
  // to a finite number, fall back to the default if not.
  const rawLimit = this.getNodeParameter("limitWaitTime", 0, 24);
  const limitWaitTime =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? rawLimit
      : 24;
  const limitWaitTimeUnit = this.getNodeParameter(
    "limitWaitTimeUnit",
    0,
    "hours",
  ) as WaitUnit;
  // Optional revision-continuation pointer. Trim before validation so
  // copy-paste with stray whitespace from an n8n expression doesn't
  // trigger the regex reject. Empty string (after trim) → chain-root
  // path; a non-empty value MUST be a canonical UUID before we
  // forward it. Surfacing bad input as a NodeOperationError beats
  // letting PostgREST raise 22P02 with a leaky parser message — the
  // workflow author sees a clean error pointing at their expression,
  // not a database internal.
  // Mirror the typeof guard pattern used for `taskTypeParam.value` at
  // line ~112 — an unresolved expression or a saved workflow with a
  // type-mismatched value can hand us a non-string here, and calling
  // .trim() directly would throw a raw TypeError before our
  // NodeOperationError path. Treat any non-string as an empty
  // (chain-root) parent.
  const parentRequestIdParam = this.getNodeParameter("parentRequestId", 0, "");
  const parentRequestIdRaw =
    typeof parentRequestIdParam === "string" ? parentRequestIdParam.trim() : "";
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (parentRequestIdRaw !== "" && !UUID_RE.test(parentRequestIdRaw)) {
    throw new NodeOperationError(
      this.getNode(),
      `parentRequestId must be a UUID, got: "${parentRequestIdRaw.slice(0, 80)}"`,
    );
  }

  if (taskTypeId.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Pick a task type before running this node.",
    );
  }

  // Detached test-step short-circuit: in `Create` mode + manual
  // execution we return mocked output without fetching the task type
  // OR calling the backend. The plan deliberately decouples test
  // steps in source workflows from real-request creation — the
  // destination Continue node has its own listen-for-event test step.
  if (mode === "create" && this.getMode() === "manual") {
    const fallbackWaitSeconds = (() => {
      const u = this.getNodeParameter(
        "limitWaitTimeUnit",
        0,
        "hours",
      ) as string;
      const t = this.getNodeParameter("limitWaitTime", 0, 24);
      const num = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 24;
      const unit = Object.hasOwn(UNIT_SECONDS, u as WaitUnit)
        ? UNIT_SECONDS[u as WaitUnit]
        : UNIT_SECONDS.hours;
      return Math.max(1, Math.floor(num * unit));
    })();
    const expectedTimeoutAt = new Date(
      Date.now() + fallbackWaitSeconds * 1000,
    ).toISOString();
    this.addExecutionHints({
      message:
        "Test step does not create a real request — test the destination Continue from its own workflow.",
      type: "info",
      location: "outputPane",
    });
    return [
      [
        {
          json: {
            requestId: `mock-${randomUUID()}`,
            requestUrl: "(test step — no backend call)",
            expectedTimeoutAt,
          },
        },
      ],
    ];
  }

  // The `as WaitUnit` cast is compile-time only — a saved workflow or
  // upstream expression could still hand us "toString" / "constructor",
  // which would resolve to a prototype member rather than `undefined`
  // and silently produce NaN. Guard with Object.hasOwn so unrecognized
  // values fall back to "hours" (the default).
  const unitSeconds = Object.hasOwn(UNIT_SECONDS, limitWaitTimeUnit)
    ? UNIT_SECONDS[limitWaitTimeUnit as keyof typeof UNIT_SECONDS]
    : UNIT_SECONDS.hours;
  const waitSeconds = Math.max(1, Math.floor(limitWaitTime * unitSeconds));
  // n8n's EXECUTIONS_TIMEOUT_MAX still caps inline `Create and Wait`, but
  // verified community nodes may not read environment variables directly.
  // Let n8n enforce the cap for inline waits and document the caveat in the
  // README. Detached `Create` returns immediately and Humangent enforces the
  // timeout server-side (max 90 days).

  // Resume URLs must cover EVERY task-type outcome ∪ {'dismiss'} —
  // the API's _validate_resume_urls rejects with `missing:<id>` if
  // any outcome is absent. The snapshot embedded in the RL `value`
  // is canvas-only metadata; the live API list drives URL
  // registration.
  //
  // Fetch the canonical outcome list at execute time. If it diverges
  // from the saved snapshot, attach the divergence to
  // `metadata.n8n_drift` (non-blocking) so the backend audit trail
  // captures it. webhook.ts routes any decision whose outcome_id
  // isn't in the snapshot to Dismissed with `drift_detected: true`
  // — the workflow doesn't lose the decision, but the author can
  // see (in the JSON) that they're getting an outcome the canvas
  // doesn't know about.
  const taskTypeResult = await getTaskType(
    requesterFor(this),
    creds,
    taskTypeId,
  );
  if (!taskTypeResult.ok) {
    throw humangentApiError(this.getNode(), taskTypeResult);
  }
  const liveOutcomes: Outcome[] = taskTypeResult.data.outcomes_json;
  const snapshot = decodeSnapshot(rawValue);

  // Branch A: snapshot empty + live has outcomes
  // = old workflow that has not been re-picked since alpha.10.
  // Block before creating the request so the author can fix the
  // workflow rather than discover the issue mid-decision.
  if (snapshot.length === 0 && liveOutcomes.length > 0) {
    throw humangentApiError(this.getNode(), {
      ok: false,
      status: 412,
      code: `task_type_snapshot_missing:${taskTypeId}`,
      message:
        "This workflow has not captured the task type's outcomes. Open the node and re-pick the task type from the dropdown.",
    });
  }

  // Branch B: snapshot present. Compute drift summary and proceed.
  const snapshotIds = snapshot.map((o) => o.id);
  const liveIds = liveOutcomes.map((o) => o.id);
  const liveById = new Map(liveOutcomes.map((o) => [o.id, o]));
  const snapshotById = new Map(snapshot.map((o) => [o.id, o]));
  const idDrifted =
    snapshotIds.length !== liveIds.length ||
    snapshotIds.some((id) => !liveById.has(id)) ||
    liveIds.some((id) => !snapshotById.has(id));
  const labelDrift: Record<
    string,
    { snapshot_label: string; live_label: string }
  > = {};
  for (const o of snapshot) {
    const live = liveById.get(o.id);
    if (live && live.label !== o.label) {
      labelDrift[o.id] = {
        snapshot_label: o.label,
        live_label: live.label,
      };
    }
  }
  const driftSummary = {
    snapshot_outcome_ids: snapshotIds,
    live_outcome_ids: liveIds,
    drifted: idDrifted,
    label_drift: labelDrift,
    observed_at: new Date().toISOString(),
  };

  // Multi-select fields degrade to a text input in n8n's
  // resourceMapper (no native multi-select widget). The author
  // types comma-separated values; we split here before the API call
  // so the gateway receives the array shape it expects. See
  // `resourceMapper.ts:FIELD_TYPE_MAP` for the documented
  // degradation. Per-element `.trim()` lets " alpha , gamma "
  // round-trip to `["alpha", "gamma"]`. Empty after trim is
  // dropped so a stray trailing comma doesn't produce an empty
  // string element.
  //
  // (Block hoisted ahead of the inline / detached split so both
  // paths see the same field-value normalization.)
  const multiSelectIds = new Set(
    liveOutcomes.length > 0
      ? taskTypeResult.data.field_schema_json
          .filter((f) => f.type === "multi-select")
          .map((f) => f.id)
      : [],
  );
  const fieldsRaw = fieldsParam?.value ?? {};
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fieldsRaw)) {
    if (multiSelectIds.has(k) && typeof v === "string") {
      fields[k] = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      fields[k] = v;
    }
  }

  // Detached path branch (alpha.21). On `Create` mode we hand off
  // delivery to a Humangent Continue node in another workflow via
  // a backend-resolved subscription instead of holding the inline
  // execution open via putExecutionToWait. Returns immediately on
  // a single Main output with `{ requestId, requestUrl,
  // expectedTimeoutAt }` plus an executionHint that echoes what
  // the backend resolved.
  if (mode === "create") {
    return executeDetachedCreate.call(this, {
      creds,
      taskTypeId,
      fields,
      driftSummary,
      waitSeconds,
      parentRequestIdRaw,
    });
  }

  // Inline path migration deprecation hint: when `Create and Wait`
  // is configured for waits longer than 1 hour, surface a builder
  // hint pointing at the detached-mode migration recipe in U7's
  // README. The backend cap on detached is 90 days — anyone holding
  // an inline execution open for >1h is the audience this hint
  // targets. Skipping when waitSeconds is exactly 3600 keeps the
  // default 1-hour configuration silent.
  if (waitSeconds > ONE_HOUR_SECONDS) {
    this.addExecutionHints({
      message:
        "For waits beyond 1 hour, switch this node to the `Create` mode + a Humangent Continue node in another workflow. See the n8n-node README for the migration recipe.",
      type: "info",
      location: "outputPane",
    });
  }

  const resumeUrls: Record<string, string> = {
    dismiss: this.getSignedResumeUrl({ outcome: "dismiss" }),
  };
  for (const id of liveIds) {
    resumeUrls[id] = this.getSignedResumeUrl({ outcome: id });
  }

  const metadata = {
    n8n_execution_id: this.getExecutionId(),
    n8n_workflow_id: this.getWorkflow().id,
    n8n_node_id: this.getNode().id,
    limit_wait_time_seconds: waitSeconds,
    n8n_drift: driftSummary as unknown as JsonObject,
  };

  const idempotencyKey = randomUUID();

  const result = await createRequest(requesterFor(this), creds, {
    taskTypeId,
    fields,
    resumeUrls,
    metadata,
    idempotencyKey,
    parentRequestId: parentRequestIdRaw,
  });

  if (!result.ok) {
    throw humangentApiError(this.getNode(), result);
  }

  const waitTill = new Date(Date.now() + waitSeconds * 1000);
  await this.putExecutionToWait(waitTill);

  // Return a sparse (snapshot.length + 2)-branch array with the
  // synthetic Timed Out payload on the last branch. If the webhook
  // handler fires first, its return value replaces this routing.
  // If waitTill expires without a webhook hit, n8n emits this
  // return — routing the execution onto the Timed Out lane with
  // the request snapshot so downstream nodes can still react.
  //
  // Branch indexing is snapshot-driven (canvas truth source);
  // configuredOutputs in outputs.ts produces matching positions.
  const totalBranches = snapshot.length + 2;
  const timedOutIndex = snapshot.length + 1;
  const branches = buildEmptyBranches(totalBranches);
  branches[timedOutIndex] = [syntheticTimedOutPayload(result.data)];
  return branches;
}

interface DetachedCreateInput {
  creds: HumangentCredentials;
  taskTypeId: string;
  fields: Record<string, unknown>;
  driftSummary: Record<string, unknown>;
  waitSeconds: number;
  parentRequestIdRaw: string;
}

/**
 * Detached-mode (Create) branch. Validates the picker pair, mints a
 * `decision_callback` block, and returns a single Main-output array
 * carrying `{ requestId, requestUrl, expectedTimeoutAt }`.
 *
 * Test-step short-circuit: when `getMode() === 'manual'` we return
 * a mocked output without calling the backend. Real Continue testing
 * lives in the destination workflow's own test-step.
 */
async function executeDetachedCreate(
  this: IExecuteFunctions,
  input: DetachedCreateInput,
): Promise<INodeExecutionData[][]> {
  const continueWorkflowParam = this.getNodeParameter(
    "continueWorkflow",
    0,
    "",
  );
  // n8n's `workflowSelector` persists either a string id or an
  // `{ value, mode, cachedResultName }` resourceLocator-shaped
  // object depending on n8n version + how the user picked it; the
  // wire only needs the workflow id.
  const continueWorkflowId =
    typeof continueWorkflowParam === "string"
      ? continueWorkflowParam.trim()
      : typeof (continueWorkflowParam as { value?: unknown })?.value ===
          "string"
        ? (continueWorkflowParam as { value: string }).value.trim()
        : "";
  const continueNodeNameRaw = this.getNodeParameter("continueNodeName", 0, "");
  const continueNodeName =
    typeof continueNodeNameRaw === "string" ? continueNodeNameRaw.trim() : "";

  if (continueWorkflowId.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Pick the destination Continuation Workflow before running this node in Create mode.",
    );
  }
  if (continueNodeName.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Type the destination Humangent Continue node's name before running this node in Create mode.",
    );
  }

  const instanceId =
    typeof input.creds.instanceId === "string"
      ? input.creds.instanceId.trim()
      : "";
  if (instanceId.length === 0) {
    throw new NodeOperationError(
      this.getNode(),
      "Humangent credential is missing its auto-minted instance ID. Save the Humangent credential once so the credential's preAuthentication hook can mint the value, then re-run this node.",
    );
  }

  const decisionCallback: DecisionCallback = {
    workflow_id: continueWorkflowId,
    node_id: continueNodeName,
    n8n_instance_id: instanceId,
    limit_wait_time_seconds: input.waitSeconds,
    n8n_drift: input.driftSummary,
  };
  // Detached path metadata is the same n8n exec/workflow/node trio
  // as inline (omit n8n_drift here — drift travels in
  // decision_callback so the backend can validate against the
  // resolved subscription's task type and surface
  // task_type_drift_warning advisories on the response).
  const metadata = {
    n8n_execution_id: this.getExecutionId(),
    n8n_workflow_id: this.getWorkflow().id,
    n8n_node_id: this.getNode().id,
  };

  const result = await createRequest(requesterFor(this), input.creds, {
    taskTypeId: input.taskTypeId,
    fields: input.fields,
    decisionCallback,
    metadata,
    idempotencyKey: randomUUID(),
    parentRequestId: input.parentRequestIdRaw,
  });

  if (!result.ok) {
    throw humangentApiError(this.getNode(), result);
  }

  const resolved = result.data.decision_callback_resolved;
  this.addExecutionHints({
    message: buildDetachedExecutionHint({
      resolvedContinueName: resolved?.continue_node_name,
      resolvedTaskTypeName: resolved?.task_type_name,
      requestUrl: result.data.request_url,
    }),
    type: "info",
    location: "outputPane",
  });
  if (result.data.task_type_drift_warning !== undefined) {
    this.addExecutionHints({
      message:
        "Task type drift detected: this workflow's saved outcomes don't match the task type's current outcomes. Re-pick the task type to refresh the snapshot.",
      type: "warning",
      location: "outputPane",
    });
  }

  return [
    [
      {
        json: {
          requestId: result.data.id,
          requestUrl: result.data.request_url ?? null,
          expectedTimeoutAt: result.data.expected_timeout_at,
        },
      },
    ],
  ];
}
