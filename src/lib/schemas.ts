// Runtime validators for Humangent public API v2 response bodies.
//
// n8n verified community nodes must not ship external runtime dependencies,
// so this file intentionally avoids schema libraries. The shape checks remain
// strict at the API trust boundary and expose a small `safeParse` interface
// matching the subset the rest of the node needs.

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { message: string } };

interface RuntimeSchema<T> {
  safeParse(value: unknown): SafeParseResult<T>;
}

class ValidationError extends Error {}

function schema<T>(parse: (value: unknown, path: string) => T): RuntimeSchema<T> {
  return {
    safeParse(value: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parse(value, "$") };
      } catch (error) {
        return {
          success: false,
          error: {
            message:
              error instanceof Error ? error.message : "Invalid response shape",
          },
        };
      }
    },
  };
}

function invalid(path: string, expected: string): never {
  throw new ValidationError(`${path}: expected ${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "object");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "string");
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (parsed.length === 0) invalid(path, "non-empty string");
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "boolean");
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(path, "finite number");
  }
  return value;
}

function integer(value: unknown, path: string): number {
  const parsed = number(value, path);
  if (!Number.isInteger(parsed)) invalid(path, "integer");
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = integer(value, path);
  if (parsed <= 0) invalid(path, "positive integer");
  return parsed;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = integer(value, path);
  if (parsed < 0) invalid(path, "non-negative integer");
  return parsed;
}

function nullable<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | null {
  return value === null ? null : parse(value, path);
}

function optional<T>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | undefined {
  return Object.hasOwn(source, key) ? parse(source[key], `${path}.${key}`) : undefined;
}

function optionalNullable<T>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | null | undefined {
  return Object.hasOwn(source, key)
    ? nullable(source[key], `${path}.${key}`, parse)
    : undefined;
}

function arrayOf<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) invalid(path, "array");
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function nonEmptyArrayOf<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T[] {
  const parsed = arrayOf(value, path, parse);
  if (parsed.length === 0) invalid(path, "non-empty array");
  return parsed;
}

function recordUnknown(value: unknown, path: string): Record<string, unknown> {
  return object(value, path);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): T[number] {
  const parsed = string(value, path);
  if (!allowed.includes(parsed)) {
    invalid(path, `one of ${allowed.join(", ")}`);
  }
  return parsed;
}

function stringOrNumberOrBoolean(
  value: unknown,
  path: string,
): string | number | boolean {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  invalid(path, "string, number, or boolean");
}

const OUTCOME_ROLES = [
  "default-positive",
  "secondary",
  "destructive",
  "revision-request",
] as const;

export interface Outcome {
  id: string;
  label: string;
  role?: (typeof OUTCOME_ROLES)[number];
}

function parseOutcome(value: unknown, path: string): Outcome {
  const source = object(value, path);
  return {
    id: nonEmptyString(source.id, `${path}.id`),
    label: nonEmptyString(source.label, `${path}.label`),
    role: optional(source, "role", path, (v, p) => oneOf(v, p, OUTCOME_ROLES)),
  };
}

export const OutcomeSchema = schema(parseOutcome);

export interface FieldDef {
  id: string;
  label?: string;
  type: string;
  required?: boolean;
  options?: Array<{ label: string; value: string | number | boolean }>;
  description?: string;
  defaultValue?: unknown;
  flags?: { shown?: boolean; editable?: boolean };
}

function parseFieldOption(
  value: unknown,
  path: string,
): { label: string; value: string | number | boolean } {
  const source = object(value, path);
  return {
    label: string(source.label, `${path}.label`),
    value: stringOrNumberOrBoolean(source.value, `${path}.value`),
  };
}

function parseFlags(value: unknown, path: string): FieldDef["flags"] {
  const source = object(value, path);
  return {
    shown: optional(source, "shown", path, boolean),
    editable: optional(source, "editable", path, boolean),
  };
}

function parseFieldDef(value: unknown, path: string): FieldDef {
  const source = object(value, path);
  return {
    id: nonEmptyString(source.id, `${path}.id`),
    label: optional(source, "label", path, string),
    type: string(source.type, `${path}.type`),
    required: optional(source, "required", path, boolean),
    options: optional(source, "options", path, (v, p) =>
      arrayOf(v, p, parseFieldOption),
    ),
    description: optional(source, "description", path, string),
    defaultValue: Object.hasOwn(source, "defaultValue")
      ? source.defaultValue
      : undefined,
    flags: optional(source, "flags", path, parseFlags),
  };
}

export const FieldDefSchema = schema(parseFieldDef);

export interface TaskTypeRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string | null;
  scope_label: string;
  field_schema_json: FieldDef[];
  outcomes_json: Outcome[];
  is_system: boolean;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function parseTaskTypeRow(value: unknown, path: string): TaskTypeRow {
  const source = object(value, path);
  return {
    id: nonEmptyString(source.id, `${path}.id`),
    org_id: nonEmptyString(source.org_id, `${path}.org_id`),
    slug: nonEmptyString(source.slug, `${path}.slug`),
    name: nonEmptyString(source.name, `${path}.name`),
    description: nullable(source.description, `${path}.description`, string),
    scope_label: string(source.scope_label, `${path}.scope_label`),
    field_schema_json: arrayOf(
      source.field_schema_json,
      `${path}.field_schema_json`,
      parseFieldDef,
    ),
    outcomes_json: nonEmptyArrayOf(
      source.outcomes_json,
      `${path}.outcomes_json`,
      parseOutcome,
    ),
    is_system: boolean(source.is_system, `${path}.is_system`),
    archived_at: nullable(source.archived_at, `${path}.archived_at`, string),
    version: positiveInteger(source.version, `${path}.version`),
    created_at: string(source.created_at, `${path}.created_at`),
    updated_at: string(source.updated_at, `${path}.updated_at`),
  };
}

export const TaskTypeRowSchema = schema(parseTaskTypeRow);

export interface TaskTypeList {
  items: TaskTypeRow[];
  next_cursor: string | null;
}

function parseTaskTypeList(value: unknown, path: string): TaskTypeList {
  const source = object(value, path);
  return {
    items: arrayOf(source.items, `${path}.items`, parseTaskTypeRow),
    next_cursor: nullable(source.next_cursor, `${path}.next_cursor`, string),
  };
}

export const TaskTypeListSchema = schema(parseTaskTypeList);

const REQUEST_STATUSES = [
  "open",
  "assigned",
  "decided",
  "dismissed",
  "timed_out",
  "cancelled",
] as const;

export interface DecisionCallbackResolved {
  continue_node_name: string;
  task_type_name: string;
  subscription_id: string;
}

function parseDecisionCallbackResolved(
  value: unknown,
  path: string,
): DecisionCallbackResolved {
  const source = object(value, path);
  return {
    continue_node_name: string(
      source.continue_node_name,
      `${path}.continue_node_name`,
    ),
    task_type_name: string(source.task_type_name, `${path}.task_type_name`),
    subscription_id: string(source.subscription_id, `${path}.subscription_id`),
  };
}

export interface TaskTypeDriftWarning {
  live_outcome_ids: string[];
  drifted_outcome_ids: string[];
  [key: string]: unknown;
}

function parseTaskTypeDriftWarning(
  value: unknown,
  path: string,
): TaskTypeDriftWarning {
  const source = object(value, path);
  return {
    ...source,
    live_outcome_ids: arrayOf(
      source.live_outcome_ids,
      `${path}.live_outcome_ids`,
      string,
    ),
    drifted_outcome_ids: arrayOf(
      source.drifted_outcome_ids,
      `${path}.drifted_outcome_ids`,
      string,
    ),
  };
}

export interface RequestRow {
  id: string;
  org_id: string;
  task_type_id: string;
  fields: Record<string, unknown>;
  outcomes_snapshot: Outcome[];
  status: (typeof REQUEST_STATUSES)[number];
  is_test: boolean;
  metadata: Record<string, unknown>;
  expected_timeout_at: string | null;
  assignee_id: string | null;
  created_by_api_key_id: string | null;
  created_at: string;
  updated_at: string;
  request_url?: string | null;
  subscription_id?: string | null;
  signing_api_key_id?: string | null;
  delivery_failed_at?: string | null;
  webhook_url_snapshot?: string | null;
  decision_callback_resolved?: DecisionCallbackResolved;
  task_type_drift_warning?: TaskTypeDriftWarning;
}

function parseRequestRow(value: unknown, path: string): RequestRow {
  const source = object(value, path);
  return {
    id: nonEmptyString(source.id, `${path}.id`),
    org_id: nonEmptyString(source.org_id, `${path}.org_id`),
    task_type_id: nonEmptyString(source.task_type_id, `${path}.task_type_id`),
    fields: recordUnknown(source.fields, `${path}.fields`),
    outcomes_snapshot: arrayOf(
      source.outcomes_snapshot,
      `${path}.outcomes_snapshot`,
      parseOutcome,
    ),
    status: oneOf(source.status, `${path}.status`, REQUEST_STATUSES),
    is_test: boolean(source.is_test, `${path}.is_test`),
    metadata: recordUnknown(source.metadata, `${path}.metadata`),
    expected_timeout_at: nullable(
      source.expected_timeout_at,
      `${path}.expected_timeout_at`,
      string,
    ),
    assignee_id: nullable(source.assignee_id, `${path}.assignee_id`, string),
    created_by_api_key_id: nullable(
      source.created_by_api_key_id,
      `${path}.created_by_api_key_id`,
      string,
    ),
    created_at: string(source.created_at, `${path}.created_at`),
    updated_at: string(source.updated_at, `${path}.updated_at`),
    request_url: optionalNullable(source, "request_url", path, string),
    subscription_id: optionalNullable(source, "subscription_id", path, string),
    signing_api_key_id: optionalNullable(
      source,
      "signing_api_key_id",
      path,
      string,
    ),
    delivery_failed_at: optionalNullable(
      source,
      "delivery_failed_at",
      path,
      string,
    ),
    webhook_url_snapshot: optionalNullable(
      source,
      "webhook_url_snapshot",
      path,
      string,
    ),
    decision_callback_resolved: optional(
      source,
      "decision_callback_resolved",
      path,
      parseDecisionCallbackResolved,
    ),
    task_type_drift_warning: optional(
      source,
      "task_type_drift_warning",
      path,
      parseTaskTypeDriftWarning,
    ),
  };
}

export const RequestRowSchema = schema(parseRequestRow);

const CHAIN_DECISIONS = [
  "approve",
  "decline",
  "auto_approve",
  "escalate",
  "stall",
] as const;

export interface ChainEntry {
  level: number;
  activation_index: number;
  decision: (typeof CHAIN_DECISIONS)[number];
  comment?: string | null;
  at: string;
  outcome_id?: string | null;
  target_active?: boolean | null;
  reason?: string | null;
  [key: string]: unknown;
}

function parseChainEntry(value: unknown, path: string): ChainEntry {
  const source = object(value, path);
  return {
    ...source,
    level: positiveInteger(source.level, `${path}.level`),
    activation_index: positiveInteger(
      source.activation_index,
      `${path}.activation_index`,
    ),
    decision: oneOf(source.decision, `${path}.decision`, CHAIN_DECISIONS),
    comment: optionalNullable(source, "comment", path, string),
    at: string(source.at, `${path}.at`),
    outcome_id: optionalNullable(source, "outcome_id", path, string),
    target_active: optionalNullable(source, "target_active", path, boolean),
    reason: optionalNullable(source, "reason", path, string),
  };
}

const TARGET_KINDS = ["inline", "subscription"] as const;
const DECIDED_VIA = ["human", "auto_approve"] as const;

export interface DecisionDelivery {
  delivery_id: string;
  request_id: string;
  outcome_id: string;
  is_dismiss: boolean;
  fields: Record<string, unknown>;
  fields_before: Record<string, unknown> | null;
  decided_by_profile_id: string | null;
  decided_at: string;
  duration_ms: number;
  is_test: boolean;
  decision_note: string;
  target_kind?: (typeof TARGET_KINDS)[number];
  target_id?: string | null;
  decided_via?: (typeof DECIDED_VIA)[number];
  chain?: ChainEntry[];
}

function parseDecisionDelivery(value: unknown, path: string): DecisionDelivery {
  const source = object(value, path);
  return {
    delivery_id: nonEmptyString(source.delivery_id, `${path}.delivery_id`),
    request_id: nonEmptyString(source.request_id, `${path}.request_id`),
    outcome_id: nonEmptyString(source.outcome_id, `${path}.outcome_id`),
    is_dismiss: boolean(source.is_dismiss, `${path}.is_dismiss`),
    fields: recordUnknown(source.fields, `${path}.fields`),
    fields_before: nullable(
      source.fields_before,
      `${path}.fields_before`,
      recordUnknown,
    ),
    decided_by_profile_id: nullable(
      source.decided_by_profile_id,
      `${path}.decided_by_profile_id`,
      string,
    ),
    decided_at: string(source.decided_at, `${path}.decided_at`),
    duration_ms: nonNegativeInteger(source.duration_ms, `${path}.duration_ms`),
    is_test: boolean(source.is_test, `${path}.is_test`),
    decision_note: Object.hasOwn(source, "decision_note")
      ? string(source.decision_note, `${path}.decision_note`)
      : "",
    target_kind: optional(source, "target_kind", path, (v, p) =>
      oneOf(v, p, TARGET_KINDS),
    ),
    target_id: optionalNullable(source, "target_id", path, string),
    decided_via: optional(source, "decided_via", path, (v, p) =>
      oneOf(v, p, DECIDED_VIA),
    ),
    chain: optional(source, "chain", path, (v, p) =>
      arrayOf(v, p, parseChainEntry),
    ),
  };
}

export const DecisionDeliverySchema = schema(parseDecisionDelivery);

export interface RegisterSubscriptionResponse {
  id: string;
}

export const RegisterSubscriptionResponseSchema = schema(
  (value, path): RegisterSubscriptionResponse => {
    const source = object(value, path);
    return { id: nonEmptyString(source.id, `${path}.id`) };
  },
);

export interface UnregisterSubscriptionResponse {
  id: string;
  deleted: boolean;
}

export const UnregisterSubscriptionResponseSchema = schema(
  (value, path): UnregisterSubscriptionResponse => {
    const source = object(value, path);
    return {
      id: nonEmptyString(source.id, `${path}.id`),
      deleted: boolean(source.deleted, `${path}.deleted`),
    };
  },
);
