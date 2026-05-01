// Error factory + payload helpers for the Humangent node.
//
// Centralises:
//   * PostgREST-hint → builder-facing copy catalogue (the messages
//     surfaced in n8n's canvas error banner).
//   * NodeApiError constructors that dodge n8n-workflow's httpCode →
//     canned-message overwrite.
//   * The synthetic Timed Out payload for waitTill expiry (fires
//     when no webhook hit arrives before the timer — R22 per-status
//     presence rules).
//   * Empty-branch array builder shared by execute() and webhook().
//
// Pure module — no n8n runtime dependencies beyond the error classes
// + the INode / INodeExecutionData types — so these helpers are
// directly unit-testable.

import {
  NodeApiError,
  type IDataObject,
  type INode,
  type INodeExecutionData,
  type JsonObject,
} from "n8n-workflow";

import type { ApiResult } from "../../lib/api";
import type { RequestRow } from "../../lib/schemas";

/**
 * Hint catalogue. PostgREST hints from the API v2 RPCs map to
 * builder-facing copy. Anything unknown falls through to the
 * server's own `message` via `mapHint`.
 */
export const HINT_COPY: Record<string, string> = {
  missing_or_invalid_api_key:
    "Humangent API key is missing, invalid, or revoked. Update the credential.",
  task_type_not_found:
    "Task type not found. Re-pick the task type from the list.",
  task_type_snapshot_missing:
    "This workflow has not captured the task type's outcomes. Open the node and re-pick the task type from the dropdown.",
  idempotency_key_body_mismatch:
    "Idempotency key reused with a different body. Retry with a fresh execution.",
  malformed_response:
    "Humangent returned an unexpected response shape. Retry; contact support if it persists.",
  parent_request_not_found:
    "The parentRequestId does not reference a request you can see. Check the upstream Humangent node's requestId, or leave parentRequestId empty for a chain-root request.",
  parent_request_not_revision:
    "The parent request was not decided with a revision-request outcome. Only decisions on revision-request outcomes can spawn an iteration N+1.",
  parent_request_snapshot_invalid:
    "The parent request's outcomes snapshot is malformed. This is a platform inconsistency — contact support.",
  decision_note_required:
    "Reviewer guidance is required when picking a revision-request outcome. The reviewer needs to type something before submitting.",
};

export function mapHint(code: string, fallbackMessage: string): string {
  // Object.hasOwn (not `in`) so prototype-chain keys like `toString`
  // or `constructor` can't accidentally short-circuit the lookup.
  if (Object.hasOwn(HINT_COPY, code)) return HINT_COPY[code];
  if (code.startsWith("resume_urls_mismatch:")) {
    const detail = code.slice("resume_urls_mismatch:".length);
    return `Resume URL set doesn't match the task type's outcomes (${detail}). Re-pick the task type.`;
  }
  if (code.startsWith("field_validation_failed:")) {
    const fieldId = code.slice("field_validation_failed:".length);
    return `Field validation failed: required field \`${fieldId}\` is missing or empty.`;
  }
  return fallbackMessage;
}

/**
 * Build a NodeApiError with Humangent-specific copy that actually
 * surfaces to the user.
 *
 * Subtle n8n-workflow quirk we work around: when `httpCode` is set
 * in NodeApiError's options, the constructor overwrites the passed
 * `message` with a canned STATUS_CODE_MESSAGES entry ("Forbidden -
 * perhaps check your credentials" on 403, etc.). We therefore omit
 * httpCode from options and stash the status inside the errorResponse
 * object instead — still available for logs, no longer blocks the
 * user-facing copy.
 */
export function humangentApiError(
  node: INode,
  result: Exclude<ApiResult<unknown>, { ok: true }>,
): NodeApiError {
  const copy = mapHint(result.code, result.message);
  return new NodeApiError(
    node,
    {
      status: result.status ?? null,
      code: result.code,
      message: result.message,
    } as unknown as JsonObject,
    {
      message: copy,
      description: result.message,
    },
  );
}

/**
 * Build an N-sized array of empty branches. Used by execute() to
 * pre-populate the return before injecting the Timed Out synthetic
 * on the correct index, and by webhook() to assemble the routed
 * decision payload.
 */
export function buildEmptyBranches(total: number): INodeExecutionData[][] {
  const branches: INodeExecutionData[][] = [];
  for (let i = 0; i < total; i++) branches.push([]);
  return branches;
}

/**
 * Decode the outcomes snapshot from a resourceLocator's value
 * string. The value shape `<task-type-id>#o=<encoded>` is produced by
 * `listSearch.ts:encodeTaskTypeValue` — see the comment block in
 * `outputs.ts` for why the snapshot lives in `value` rather than on
 * `cachedResultUrl` (n8n's expression proxy auto-unwraps RL params
 * to `.value`, hiding the rest of the RL fields).
 *
 * Mirrors the sandbox-strict decoder in outputs.ts (`configuredOutputs`)
 * but runs in n8n's regular Node.js runtime. Both decoders MUST
 * produce byte-identical output for the same input. The cross-test
 * in `decoders.cross.test.ts` asserts equality on a shared fixture
 * set. Keep this helper minimal — only APIs the sandbox decoder also
 * has access to (JSON.parse, decodeURIComponent, string methods) —
 * so we don't accidentally diverge or break in restricted hosted-n8n
 * environments.
 *
 * Kept here (rather than re-imported from outputs.ts) because
 * outputs.ts's function is stringified into an n8n expression and
 * must stay self-contained — it can't export the helper.
 *
 * Returns `[]` on any decode failure — partial render is worse than
 * no render. Whole-array validation: any malformed item rejects the
 * entire snapshot.
 */
function decodeSnapshotPayload(value: string): unknown {
  const marker = "#o=";
  const idx = value.lastIndexOf(marker);
  if (idx < 0) return null;
  const encoded = value.slice(idx + marker.length);
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function parseSnapshotItem(
  item: unknown,
): { id: string; label: string } | null {
  if (!item || typeof item !== "object") return null;
  const id = (item as { id?: unknown }).id;
  const label = (item as { label?: unknown }).label;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof label !== "string" || label.length === 0) return null;
  return { id, label };
}

export function decodeSnapshot(
  value: string | undefined | null,
): Array<{ id: string; label: string }> {
  if (typeof value !== "string" || value.length === 0) return [];
  const decoded = decodeSnapshotPayload(value);
  if (!Array.isArray(decoded) || decoded.length === 0) return [];

  // Whole-array validation: any malformed item rejects the entire
  // snapshot — a half-rendered canvas is worse than no canvas.
  const out: Array<{ id: string; label: string }> = [];
  for (const item of decoded) {
    const parsed = parseSnapshotItem(item);
    if (parsed === null) return [];
    out.push(parsed);
  }
  return out;
}

/**
 * Synthetic Timed Out payload. Emitted on the Timed Out branch if
 * n8n's waitTill fires without a webhook hit. Per R22's presence
 * rules: no fields_before, no decided_by, no decided_at — the
 * reviewer never acted.
 *
 * `decisionNote: ""` is included for shape parity with `decisionItem`
 * on the named branches — downstream nodes can read the same key
 * across all six branches without conditional access.
 */
export function syntheticTimedOutPayload(
  request: RequestRow,
): INodeExecutionData {
  return {
    json: {
      request_id: request.id,
      outcome_id: "timed_out",
      is_dismiss: false,
      fields: request.fields as IDataObject,
      is_test: request.is_test,
      decisionNote: "",
    } satisfies IDataObject,
  };
}
