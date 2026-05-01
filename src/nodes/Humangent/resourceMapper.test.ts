import type { ResourceMapperField } from "n8n-workflow";
import { describe, expect, it, vi } from "vitest";

import { FIELD_TYPES, type FieldType } from "../../lib/fieldTypes";
import {
  FIELD_TYPE_MAP,
  getTaskTypeSchema,
  mapFieldType,
} from "./resourceMapper";

// Compile-time exhaustiveness fence — both directions. If `FieldTypeSchema`
// gains a new member without a matching key in FIELD_TYPE_MAP, the first
// `satisfies` fails type-check with a clear "Property 'X' is missing" error.
// If FIELD_TYPE_MAP gains a typo'd or extra key (e.g., `radioo`), the
// `_KeysAreFieldTypes` helper fails because the map's keyof is no longer a
// subset of `FieldType`. Pairs with the runtime iteration below — the runtime
// fence catches drift if someone bypasses tsc.
//
// Lives in the test file because production-side code in this workspace can't
// import `FieldType` from apps/web (tsconfig.build.json's `rootDir: ./src`
// rejects it). Test files are excluded from the production build.
FIELD_TYPE_MAP satisfies Record<
  FieldType,
  NonNullable<ResourceMapperField["type"]>
>;
type _KeysAreFieldTypes = keyof typeof FIELD_TYPE_MAP extends FieldType
  ? true
  : never;
const _keysCheck: _KeysAreFieldTypes = true;
void _keysCheck;

function makeContext(
  httpRequest: ReturnType<typeof vi.fn>,
  taskTypeId: string | undefined,
) {
  return {
    helpers: { httpRequest },
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: "hmk_live_abc",
    }),
    getNodeParameter: vi.fn().mockReturnValue(taskTypeId ?? ""),
  } as unknown as never;
}

const TASK_TYPE_WITH_FIELDS_AND_OUTCOMES = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: null,
  scope_label: "org-wide",
  field_schema_json: [
    {
      id: "customer",
      label: "Customer name",
      type: "text",
      required: true,
    },
    {
      id: "amount",
      type: "number",
      required: false,
    },
    {
      id: "decision_tier",
      label: "Decision tier",
      type: "radio-images",
      required: true,
      options: [
        { label: "Gold", value: "gold" },
        { label: "Silver", value: "silver" },
      ],
    },
  ],
  outcomes_json: [
    { id: "approve", label: "Approve", role: "default-positive" as const },
    { id: "reject", label: "Reject", role: "destructive" as const },
  ],
  is_system: true,
  archived_at: null,
  version: 1,
  created_at: "2026-04-22T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

describe("mapFieldType — copied FieldType contract", () => {
  // Iterates the copied FieldType list at test runtime. Every
  // member must have an own-property entry in FIELD_TYPE_MAP and
  // mapFieldType must return that entry's value (i.e., not the
  // unknown-input fallback). Adding a new value to FIELD_TYPES
  // without updating FIELD_TYPE_MAP fails this iteration and also
  // fails the compile-time fence above.
  it.each(FIELD_TYPES.map((value) => [value] as const))(
    "%s has an explicit FIELD_TYPE_MAP entry that mapFieldType returns",
    (value) => {
      expect(FIELD_TYPE_MAP).toHaveProperty(value);
      expect(mapFieldType(value)).toBe(
        FIELD_TYPE_MAP[value as keyof typeof FIELD_TYPE_MAP],
      );
    },
  );

  it("returns 'string' for genuinely unknown inputs", () => {
    // The DB publish-gate (apps/api/supabase/migrations/...) restricts
    // persisted field-type strings to (most of) the FieldTypeSchema
    // allowlist, so unknown inputs shouldn't reach mapFieldType in
    // production. The default exists for true unknowns (e.g., a v0 row
    // predating the validator) — degraded UX, not a crash.
    expect(mapFieldType("unknown-type-from-future")).toBe("string");
  });

  it("returns 'string' for prototype-chain names instead of resolving to a Function", () => {
    // Regression guard: a direct `FIELD_TYPE_MAP[type]` index walks the
    // prototype chain, so `mapFieldType('toString')` would resolve to
    // `Object.prototype.toString` (a function) and short-circuit a `??`
    // fallback because functions are truthy. `Object.hasOwn` blocks this.
    expect(mapFieldType("toString")).toBe("string");
    expect(mapFieldType("constructor")).toBe("string");
    expect(mapFieldType("hasOwnProperty")).toBe("string");
    expect(mapFieldType("valueOf")).toBe("string");
  });
});

describe("getTaskTypeSchema", () => {
  it("returns an empty list + notice when no task type is picked", async () => {
    const ctx = makeContext(vi.fn(), undefined);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields).toEqual([]);
    expect(result.emptyFieldsNotice).toMatch(/pick a task type/i);
  });

  it("maps each field_schema_json entry to a ResourceMapperField", async () => {
    const httpRequest = vi
      .fn()
      .mockResolvedValue(TASK_TYPE_WITH_FIELDS_AND_OUTCOMES);
    const ctx = makeContext(httpRequest, TASK_TYPE_WITH_FIELDS_AND_OUTCOMES.id);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields).toHaveLength(3);

    const customer = result.fields[0];
    expect(customer.id).toBe("customer");
    expect(customer.displayName).toBe("Customer name");
    expect(customer.type).toBe("string");
    expect(customer.required).toBe(true);

    const amount = result.fields[1];
    expect(amount.id).toBe("amount");
    expect(amount.displayName).toBe("amount");
    expect(amount.type).toBe("number");
    expect(amount.required).toBe(false);

    const tier = result.fields[2];
    expect(tier.type).toBe("options"); // radio-images degrades to options
    expect(tier.options).toEqual([
      { name: "Gold", value: "gold" },
      { name: "Silver", value: "silver" },
    ]);
  });

  it("multi-select degrades to a string input with a (comma-separated) hint in displayName", async () => {
    // n8n's resourceMapper has no multi-select widget; we degrade
    // to a text input and split on commas in execute(). The
    // displayName carries the hint so authors know the convention.
    const taskType = {
      ...TASK_TYPE_WITH_FIELDS_AND_OUTCOMES,
      field_schema_json: [
        {
          id: "f_tags",
          label: "Tags",
          type: "multi-select",
          required: false,
          options: [
            { label: "Alpha", value: "alpha" },
            { label: "Beta", value: "beta" },
          ],
        },
      ],
    };
    const httpRequest = vi.fn().mockResolvedValue(taskType);
    const ctx = makeContext(httpRequest, taskType.id);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].type).toBe("string");
    expect(result.fields[0].displayName).toBe("Tags (comma-separated)");
  });

  it("prepends a (none) option to optional options-bearing fields, but not required ones", async () => {
    // Optional options-bearing fields (radio, select, multi-select,
    // radio-images): n8n's resourceMapper auto-picks the first option
    // on initial render, leaving no way to express "no value picked".
    // Prepend an explicit (none) entry so the workflow author can
    // leave optional options-bearing fields unset. Required fields
    // must have a real selection — no (none) prepended.
    const taskType = {
      ...TASK_TYPE_WITH_FIELDS_AND_OUTCOMES,
      field_schema_json: [
        {
          id: "f_optional_select",
          label: "Optional select",
          type: "select",
          required: false,
          options: [
            { label: "Red", value: "red" },
            { label: "Blue", value: "blue" },
          ],
        },
        {
          id: "f_required_radio",
          label: "Required radio",
          type: "radio",
          required: true,
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ],
        },
      ],
    };
    const httpRequest = vi.fn().mockResolvedValue(taskType);
    const ctx = makeContext(httpRequest, taskType.id);
    const result = await getTaskTypeSchema.call(ctx);

    expect(result.fields[0].id).toBe("f_optional_select");
    expect(result.fields[0].options).toEqual([
      { name: "(none)", value: "" },
      { name: "Red", value: "red" },
      { name: "Blue", value: "blue" },
    ]);

    expect(result.fields[1].id).toBe("f_required_radio");
    expect(result.fields[1].options).toEqual([
      { name: "Yes", value: "yes" },
      { name: "No", value: "no" },
    ]);
  });

  it("falls back to id when label is empty or whitespace-only", async () => {
    // `f.label ?? f.id` would let `""` or `"   "` pass through and
    // render a header-less row. Treat blank as missing.
    const taskType = {
      ...TASK_TYPE_WITH_FIELDS_AND_OUTCOMES,
      field_schema_json: [
        { id: "f_blank", label: "", type: "text", required: false },
        { id: "f_ws", label: "   ", type: "text", required: false },
        { id: "f_ok", label: "Real label", type: "text", required: false },
      ],
    };
    const httpRequest = vi.fn().mockResolvedValue(taskType);
    const ctx = makeContext(httpRequest, taskType.id);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields[0].displayName).toBe("f_blank");
    expect(result.fields[1].displayName).toBe("f_ws");
    expect(result.fields[2].displayName).toBe("Real label");
  });

  it("strips the alpha.14+ #o= snapshot suffix before calling api_get_task_type", async () => {
    // The RL value carries `<task-type-id>#o=<encoded-snapshot>` so
    // canvas expressions can decode the snapshot. The gateway's
    // `p_task_type_id` expects a bare UUID — sending the encoded
    // value through unchanged returns 400 from PostgREST.
    const httpRequest = vi
      .fn()
      .mockResolvedValue(TASK_TYPE_WITH_FIELDS_AND_OUTCOMES);
    const encodedValue = `${TASK_TYPE_WITH_FIELDS_AND_OUTCOMES.id}#o=${encodeURIComponent(
      JSON.stringify([{ id: "approve", label: "Approve" }]),
    )}`;
    const ctx = makeContext(httpRequest, encodedValue);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields).toHaveLength(3);
    // The HTTP call should have used the bare id, not the encoded
    // string. PostgREST RPC body shape: {p_task_type_id: <uuid>}.
    const body = httpRequest.mock.calls[0][0].body;
    expect(body.p_task_type_id).toBe(TASK_TYPE_WITH_FIELDS_AND_OUTCOMES.id);
    expect(body.p_task_type_id).not.toContain("#o=");
  });

  it("surfaces API errors as an empty-fields notice", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 404,
      response: {
        body: { hint: "task_type_not_found", message: "task type not found" },
      },
    });
    const ctx = makeContext(httpRequest, TASK_TYPE_WITH_FIELDS_AND_OUTCOMES.id);
    const result = await getTaskTypeSchema.call(ctx);
    expect(result.fields).toEqual([]);
    expect(result.emptyFieldsNotice).toMatch(/task type not found/);
  });
});

// (alpha.10: getTaskTypeOutcomes was removed alongside the user-facing
// `outcomes` multiOptions parameter. Outcomes now come from the task
// type's snapshot on cachedResultUrl — see listSearch.ts's
// `encodeOutcomesSnapshot` and outputs.ts's `configuredOutputs`.
// Coverage for the new path lives in listSearch.test.ts and
// outputs.test.ts.)
