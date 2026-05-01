// Copied public task-field type contract for the standalone n8n node.
//
// Source of truth in the Humangent product repo:
// apps/web/src/lib/types.ts `FieldTypeSchema`.
//
// When app/API field types change, update this file and the mapping in
// `src/nodes/Humangent/resourceMapper.ts` in the same release.

export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "currency",
  "email",
  "url",
  "date",
  "datetime",
  "checkbox",
  "radio",
  "radio-images",
  "select",
  "multi-select",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
