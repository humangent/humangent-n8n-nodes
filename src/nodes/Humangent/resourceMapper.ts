// Resource-mapping method for the Humangent node.
//
// One public method, registered on INodeType.methods.resourceMapping:
//   * getTaskTypeSchema — resourceMapperMethod for the `fields`
//     property. Reads the currently-selected task type and returns
//     a ResourceMapperFields list n8n renders as per-field inputs.
//
// (The previous `getTaskTypeOutcomes` loadOptions method was deleted
// in alpha.10 along with the user-facing `outcomes` multiOptions
// parameter — outcomes are now derived from the task-type snapshot
// the listSearch encodes onto cachedResultUrl.)
//
// Radio-with-images on the Humangent side degrades to n8n's `options`
// field type — n8n has no native radio-with-images widget. The
// images render in Humangent's reviewer UI; the node only needs to
// carry the chosen value.

import type {
  ILoadOptionsFunctions,
  ResourceMapperField,
  ResourceMapperFields,
} from "n8n-workflow";

import { getTaskType } from "../../lib/api";
import type { HumangentCredentials } from "../../lib/api";
import type { FieldType } from "../../lib/fieldTypes";
import { extractTaskTypeId } from "../../lib/taskTypeValue";
import { requesterFor } from "./n8nBridge";

type ResourceMapperFieldType = NonNullable<ResourceMapperField["type"]>;

/**
 * Canonical mapping from every copied Humangent `FieldType` member to its
 * n8n `ResourceMapperFieldType` counterpart. Exported for the contract test
 * harness in resourceMapper.test.ts; production callers should go through
 * `mapFieldType()` rather than indexing this object directly.
 *
 * Keep keys ordered the same as `FIELD_TYPES` so a side-by-side diff
 * makes drift obvious.
 *
 * Mapping rules for new field types:
 * - If the new Humangent type has a direct n8n `ResourceMapperFieldType`
 *   counterpart, map to that.
 * - If not, map to `"string"` (n8n renders a plain text input; server-side
 *   validation is the enforcement boundary).
 *
 * Documented degradations:
 * - `radio*` → `options` (n8n has no native radio widget; the full radio +
 *   image experience renders in Humangent's reviewer UI).
 * - `textarea` → `string` (no native multi-line input on the canvas;
 *   reviewers can paste multi-line content anyway).
 * - `url` → `string` (n8n's `FieldType` union includes `url` but the
 *   resourceMapper UI does NOT render an input for that type — verified
 *   empirically against a hosted n8n instance. The reviewer-side editor in
 *   apps/web validates URL shape at decide time, so the server stays the
 *   enforcement boundary.).
 * - `email` → `string` (n8n has no native email widget; same pattern as
 *   url).
 * - `multi-select` → `string` (n8n's resourceMapper has no multi-select
 *   widget — `type: "options"` is single-select only and `multiOptions`
 *   isn't a valid resourceMapper FieldType. We degrade to a plain text
 *   input with a `(comma-separated)` hint in the description, and
 *   `execute.ts` splits the value on commas before sending the array to
 *   the API. Single-value entry still works — both `"alpha"` and
 *   `"alpha, gamma"` round-trip correctly server-side.).
 *
 * Synonym fall-through deliberately removed (2026-04-27): the old switch
 * accepted `integer`, `float`, `boolean`, `dateTime`, `time`, `options`,
 * `single-select`, `multiOptions`, `array`, `object`, `string`, `long-text`.
 * The DB publish-gate has always restricted `field_schema_json[].type` to
 * the `FieldTypeSchema` allowlist, so those synonyms aren't reachable in
 * production; preserving them was speculative complexity. Genuinely-unknown
 * inputs still fall through to `"string"` via `mapFieldType`.
 *
 * @internal — exported only for the test harness.
 */
export const FIELD_TYPE_MAP = {
  text: "string",
  textarea: "string",
  number: "number",
  currency: "number",
  email: "string",
  url: "string",
  date: "dateTime",
  datetime: "dateTime",
  checkbox: "boolean",
  radio: "options",
  "radio-images": "options",
  select: "options",
  "multi-select": "string",
} as const satisfies Record<FieldType, ResourceMapperFieldType>;

/**
 * Map a Humangent task-type field-type string to n8n's FieldType
 * union. Anything outside `FIELD_TYPE_MAP` degrades to `string` — the
 * safest default since n8n will render a plain text input and the
 * server's field-validation layer still catches malformed values.
 *
 * The DB publish-gate (apps/api/supabase/migrations/
 * 20260424000004_task_type_editor_rpcs.sql) restricts persisted
 * `field_schema_json[].type` to a near-superset of `FieldTypeSchema`
 * (currently 12 of the 13 values — `currency` is a known editor↔DB gap
 * acknowledged at apps/api/supabase/seed.sql:92), so unknown inputs
 * shouldn't reach this function in production. The default exists for
 * true unknowns (e.g., a v0 row predating the validator) — degraded UX,
 * not a crash.
 *
 * Use `Object.hasOwn` rather than direct index access so prototype-chain
 * names (`toString`, `constructor`, `valueOf`, `hasOwnProperty`) fall
 * through to the `"string"` default instead of resolving to a Function
 * via `Object.prototype` and short-circuiting the `??` (functions are
 * truthy).
 */
export function mapFieldType(humangentType: string): ResourceMapperFieldType {
  if (Object.hasOwn(FIELD_TYPE_MAP, humangentType)) {
    return FIELD_TYPE_MAP[humangentType as keyof typeof FIELD_TYPE_MAP];
  }
  return "string";
}

function readTaskTypeId(ctx: ILoadOptionsFunctions): string | undefined {
  // taskType is a resourceLocator. ILoadOptionsFunctions.getNodeParameter
  // takes (name, fallbackValue?, options?) — no itemIndex. `extractValue`
  // tells n8n to return just the `value` of the RL.
  //
  // alpha.14+ encodes the outcomes snapshot inline as
  // `<task-type-id>#o=<encoded>` — the gateway expects a bare UUID for
  // `p_task_type_id`, so strip everything after the `#o=` marker
  // before the API call.
  const raw = ctx.getNodeParameter("taskType", undefined, {
    extractValue: true,
  });
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return extractTaskTypeId(raw.trim());
}

export async function getTaskTypeSchema(
  this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
  const taskTypeId = readTaskTypeId(this);
  if (!taskTypeId) {
    return {
      fields: [],
      emptyFieldsNotice: "Pick a task type to load its fields.",
    };
  }

  const creds = (await this.getCredentials(
    "humangentApi",
  )) as unknown as HumangentCredentials;
  const result = await getTaskType(requesterFor(this), creds, taskTypeId);
  if (!result.ok) {
    return {
      fields: [],
      emptyFieldsNotice: `Humangent: ${result.message}`,
    };
  }

  // Number-field constraints (integer / decimals / min / max — added
  // to the editor schema in PR #57) are intentionally NOT propagated
  // here. n8n-workflow ^2.16's ResourceMapperField shape exposes no
  // slot for them: no min, max, numberPrecision, validationRules, or
  // typeOptions on the resource-mapper field. Reviewer-side
  // validateEditableFields (apps/web/src/features/inbox/
  // RequestDetailPage.tsx) is the enforcement boundary; n8n builders
  // get a plain number input as best-effort UX. Re-evaluate when
  // n8n-workflow ships a major version exposing these slots.
  const fields: ResourceMapperField[] = result.data.field_schema_json.map(
    (f) => ({
      id: f.id,
      // n8n's resourceMapper UI uses `displayName` for the row
      // header. The editor writes the user-friendly text into
      // `label` (matching apps/web/src/lib/types.ts'
      // `FieldSnapshotSchema`). Fall back to id when label is
      // missing OR empty / whitespace-only — treat blank as
      // missing so we don't render a header-less row. For
      // multi-select fields, append a `(comma-separated)` hint —
      // n8n's resourceMapper has no multi-select widget so we
      // degrade to a text input and split on commas in execute().
      displayName: (() => {
        const trimmed = f.label?.trim();
        const base = trimmed && trimmed.length > 0 ? trimmed : f.id;
        return f.type === "multi-select" ? `${base} (comma-separated)` : base;
      })(),
      type: mapFieldType(f.type),
      required: f.required ?? false,
      display: true,
      defaultMatch: false,
      canBeUsedToMatch: false,
      // Option entries use {label, value} on the editor side; n8n's
      // resourceMapper field shape uses {name, value}. Map across.
      // Optional options-bearing fields prepend an empty entry so the
      // workflow author can explicitly leave the field unset — n8n's
      // resourceMapper would otherwise auto-pick the first option for
      // a `type: "options"` field on initial render. Required fields
      // skip the empty entry; the author must pick a real value.
      options: f.options
        ? [
            ...((f.required ?? false) ? [] : [{ name: "(none)", value: "" }]),
            ...f.options.map((o) => ({
              name: o.label,
              value: o.value as string | number | boolean,
            })),
          ]
        : undefined,
    }),
  );

  return { fields };
}
