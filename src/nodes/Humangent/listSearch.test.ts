import { describe, expect, it, vi } from "vitest";

import { listTaskTypes } from "./listSearch";

/**
 * Build a minimal ILoadOptionsFunctions stand-in whose httpRequest
 * spy resolves/rejects as configured. We cast to `unknown as never`
 * because the full n8n type has many methods we don't implement;
 * the module under test only touches the two we provide.
 */
function makeContext(
  httpRequest: ReturnType<typeof vi.fn>,
  credentials: Record<string, unknown> = {
    apiKey: "hmk_live_abc",
  },
) {
  return {
    helpers: { httpRequest },
    getCredentials: vi.fn().mockResolvedValue(credentials),
  } as unknown as never;
}

const SAMPLE_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  org_id: "00000000-0000-0000-0000-000000000002",
  slug: "default_approval_v1",
  name: "Default approval",
  description: "System-seeded approval task type",
  scope_label: "org-wide",
  field_schema_json: [],
  outcomes_json: [{ id: "approve", label: "Approve" }],
  is_system: true,
  archived_at: null,
  version: 1,
  created_at: "2026-04-22T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

describe("listTaskTypes (listSearch method)", () => {
  it("returns results + paginationToken on a valid response", async () => {
    const httpRequest = vi
      .fn()
      .mockResolvedValue({ items: [SAMPLE_ROW], next_cursor: "abc" });
    const ctx = makeContext(httpRequest);
    const out = await listTaskTypes.call(ctx, "default", undefined);
    expect(out.results).toHaveLength(1);
    const [item] = out.results;
    expect(item.name).toBe(SAMPLE_ROW.name);
    // alpha.14+: each result's `value` is `<task-type-id>#o=<encoded
    // snapshot>` because n8n's expression proxy unwraps RL params to
    // `.value` before reaching canvas expressions, so the snapshot
    // must live there to be reachable. The id prefix and the encoded
    // outcomes both round-trip back to the source data (full
    // outcomes set — never a subset).
    expect(item.value).toMatch(/^[0-9a-f-]+#o=/);
    expect((item.value as string).startsWith(`${SAMPLE_ROW.id}#o=`)).toBe(true);
    expect(item.description).toBe(SAMPLE_ROW.description);
    expect(item.url).toBeUndefined();
    const idx = (item.value as string).lastIndexOf("#o=");
    const decoded = JSON.parse(
      decodeURIComponent((item.value as string).slice(idx + 3)),
    );
    expect(decoded).toEqual(
      SAMPLE_ROW.outcomes_json.map((o) => ({ id: o.id, label: o.label })),
    );
    expect(decoded.length).toBe(SAMPLE_ROW.outcomes_json.length);
    expect(out.paginationToken).toBe("abc");
  });

  it("falls back to scope_label when description is null", async () => {
    const httpRequest = vi.fn().mockResolvedValue({
      items: [{ ...SAMPLE_ROW, description: null }],
      next_cursor: null,
    });
    const ctx = makeContext(httpRequest);
    const out = await listTaskTypes.call(ctx, undefined, undefined);
    expect(out.results[0].description).toBe(SAMPLE_ROW.scope_label);
    expect(out.paginationToken).toBeUndefined();
  });

  it("passes p_search when filter is provided (trimmed, non-empty)", async () => {
    const httpRequest = vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null });
    const ctx = makeContext(httpRequest);
    await listTaskTypes.call(ctx, "  approval  ", undefined);
    const body = httpRequest.mock.calls[0][0].body;
    expect(body.p_search).toBe("approval");
    expect(body.p_limit).toBe(25);
  });

  it("omits p_search when filter is empty/whitespace", async () => {
    const httpRequest = vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null });
    const ctx = makeContext(httpRequest);
    await listTaskTypes.call(ctx, "   ", undefined);
    const body = httpRequest.mock.calls[0][0].body;
    expect(body.p_search).toBeUndefined();
  });

  it("forwards the paginationToken as p_cursor", async () => {
    const httpRequest = vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null });
    const ctx = makeContext(httpRequest);
    await listTaskTypes.call(ctx, undefined, "cursor-xyz");
    const body = httpRequest.mock.calls[0][0].body;
    expect(body.p_cursor).toBe("cursor-xyz");
  });

  it("throws a descriptive error when the API returns a failure", async () => {
    const httpRequest = vi.fn().mockRejectedValue({
      statusCode: 403,
      response: {
        body: {
          hint: "missing_or_invalid_api_key",
          message: "invalid api key",
        },
      },
    });
    const ctx = makeContext(httpRequest);
    await expect(listTaskTypes.call(ctx, undefined, undefined)).rejects.toThrow(
      /Humangent: invalid api key/,
    );
  });
});
