// Task-type picker backend — registered as the node's
// methods.listSearch.listTaskTypes. Called by n8n's resourceLocator
// when the builder opens the task-type dropdown or types to filter.
//
// The filter + paginationToken pass straight through to
// api_list_task_types; the server-side cursor is opaque to us.
//
// Outcomes snapshot (alpha.14+): each search result item embeds the
// snapshot directly inside its `value` field as
// `<task-type-id>#o=<encoded>`. The fragment encoding mirrors what
// alpha.10–alpha.13 stored on `cachedResultUrl`, but n8n's expression
// proxy auto-unwraps `$parameter[<resourceLocator>]` to just `.value`
// before the canvas-render expressions run — so anything stored on
// `cachedResultUrl` is unreachable from `subtitle` / `outputs` /
// dynamic resolvers, even though it survives the workflow JSON
// round-trip. Putting the snapshot in `value` is the only place
// canvas expressions can read it.
//
// Encoding format: `<task-type-id>#o=<encoded>` where `<encoded>` is
// `encodeURIComponent(JSON.stringify([{id, label}, ...]))`. The
// `<id>` portion stays a real UUID so server calls that need it
// (api_get_task_type, api_create_request) split on `#o=` and use
// the prefix.

import type {
  ILoadOptionsFunctions,
  INodeListSearchItems,
  INodeListSearchResult,
} from "n8n-workflow";

import { listTaskTypes as listTaskTypesApi } from "../../lib/api";
import type { HumangentCredentials } from "../../lib/api";
import type { Outcome } from "../../lib/schemas";
import { requesterFor } from "./n8nBridge";

/**
 * Build the resourceLocator `value` string for a task type. Embeds
 * the outcomes snapshot in the same string the editor surfaces to
 * canvas expressions via `$parameter[<rl>]`.
 *
 * The snapshot includes both `id` and `label` per outcome — `role` is
 * server-side metadata not needed for the canvas. Including the FULL
 * outcomes array (never a subset) is load-bearing: the gateway's
 * `_validate_resume_urls` rejects requests whose registered resume
 * URLs miss any task-type outcome ∪ {dismiss}.
 */
export function encodeTaskTypeValue(
  taskTypeId: string,
  outcomes: readonly Outcome[],
): string {
  const minimal = outcomes.map((o) => ({ id: o.id, label: o.label }));
  const fragment = encodeURIComponent(JSON.stringify(minimal));
  return `${taskTypeId}#o=${fragment}`;
}

/**
 * Recover the bare task type id from an encoded value string. Tests
 * + execute() / webhook() share this so behavior stays consistent.
 *
 * Uses `lastIndexOf` to match the decoders (`configuredOutputs` and
 * `decodeSnapshot`); the marker is always the LAST `#o=` so any
 * malformed or hand-edited values with earlier `#o=` substrings
 * still split on the snapshot boundary, not the prefix.
 */
export function extractTaskTypeId(encodedValue: string): string {
  const idx = encodedValue.lastIndexOf("#o=");
  return idx < 0 ? encodedValue : encodedValue.slice(0, idx);
}

export async function listTaskTypes(
  this: ILoadOptionsFunctions,
  filter?: string,
  paginationToken?: string,
): Promise<INodeListSearchResult> {
  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;

  const trimmedFilter = filter?.trim();
  const trimmedCursor = paginationToken?.trim();

  const result = await listTaskTypesApi(requesterFor(this), creds, {
    p_search:
      trimmedFilter && trimmedFilter.length > 0 ? trimmedFilter : undefined,
    p_cursor:
      trimmedCursor && trimmedCursor.length > 0 ? trimmedCursor : undefined,
    p_limit: 25,
  });

  if (!result.ok) {
    // Surface the server's message to the builder. The n8n modal
    // that renders listSearch errors displays Error.message verbatim.
    throw new Error(`Humangent: ${result.message}`);
  }

  const items: INodeListSearchItems[] = result.data.items.map((t) => ({
    name: t.name,
    value: encodeTaskTypeValue(t.id, t.outcomes_json),
    description: t.description ?? t.scope_label,
  }));

  return {
    results: items,
    paginationToken: result.data.next_cursor ?? undefined,
  };
}
