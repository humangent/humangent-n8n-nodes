// Decoders for the encoded task-type resourceLocator value
// `<task-type-id>#o=<encoded-snapshot>`. The marker is `#o=` and we
// always split on the LAST occurrence so any earlier `#o=` substrings
// in malformed / hand-edited values still resolve the id prefix
// correctly. See listSearch.ts's `encodeTaskTypeValue` for the
// producer side and the comment block in outputs.ts for why the
// snapshot lives in `value` rather than on `cachedResultUrl`.

export function extractTaskTypeId(encodedValue: string): string {
  const idx = encodedValue.lastIndexOf("#o=");
  return idx < 0 ? encodedValue : encodedValue.slice(0, idx);
}
