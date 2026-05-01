import { describe, expect, it } from "vitest";

import { HumangentApi } from "./HumangentApi.credentials";

describe("HumangentApi credential", () => {
  const credential = new HumangentApi();

  it("uses the canonical n8n identity", () => {
    expect(credential.name).toBe("humangentApi");
    expect(credential.displayName).toBe("Humangent API");
    expect(credential.documentationUrl).toMatch(/^https:\/\//);
  });

  it("exposes apiKey (user-typed) + instanceId (auto-managed string) — and nothing else", () => {
    // Lock-in: the API key is the single secret the user supplies.
    // Humangent + Supabase URLs/anon-key are baked in; the API key
    // doubles as the HMAC secret for decision-delivery verification.
    //
    // alpha.21 added the `instanceId` UUID as `type: "hidden"`. n8n's
    // credential schema generator strips hidden-typed properties from
    // the JSON Schema (verified against the live /api/v1/credentials/schema
    // endpoint), and the schema's `additionalProperties: false` then
    // filters them out on persistence. Result: the preAuthentication
    // mint never landed on disk and every activation tripped the
    // safety guard in continueRegistration.ts. alpha.23 promotes the
    // field to `type: "string"` with `password: true` masking so it
    // appears in the schema (= survives persistence) without adding
    // visual noise to the credential dialog.
    //
    // A regression that re-exposes supabaseUrl / supabaseAnonKey /
    // signingSecret — or re-introduces type: "hidden" on instanceId —
    // fails this test before it ships.
    const names = credential.properties.map((p) => p.name).sort();
    expect(names).toEqual(["apiKey", "instanceId"]);

    const instanceId = credential.properties.find(
      (p) => p.name === "instanceId",
    );
    expect(instanceId?.type).toBe("string");
    expect(instanceId?.default).toBe("");
    expect(
      (instanceId?.typeOptions as { password?: boolean } | undefined)?.password,
    ).toBe(true);
  });

  it("preAuthentication mints a UUID when instanceId is missing", async () => {
    const partial = await credential.preAuthentication.call(
      undefined as unknown as never,
      { apiKey: "hmk_live_abc" },
    );
    expect(partial.instanceId).toBeTypeOf("string");
    expect(partial.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("preAuthentication preserves a valid existing instanceId", async () => {
    const existing = "12345678-1234-1234-1234-123456789abc";
    const partial = await credential.preAuthentication.call(
      undefined as unknown as never,
      { apiKey: "hmk_live_abc", instanceId: existing },
    );
    // Empty partial = no update — n8n leaves the persisted value alone.
    expect(partial).toEqual({});
  });

  it("preAuthentication regenerates when instanceId is shape-invalid", async () => {
    // A hand-edited credential JSON could carry a non-UUID string
    // (e.g., copy-pasted "default" or an empty quoted value). Treat
    // those as missing and re-mint so the detached-mode subscription
    // tuple stays stable.
    const partial = await credential.preAuthentication.call(
      undefined as unknown as never,
      { apiKey: "hmk_live_abc", instanceId: "not-a-uuid" },
    );
    expect(partial.instanceId).toBeTypeOf("string");
    expect(partial.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("marks apiKey as a password-typed secret + required", () => {
    const apiKey = credential.properties.find((p) => p.name === "apiKey");
    expect(apiKey?.required).toBe(true);
    expect(
      (apiKey?.typeOptions as { password?: boolean } | undefined)?.password,
    ).toBe(true);
  });

  it("composes auth via the user's apiKey", () => {
    const headers = credential.authenticate.properties.headers!;
    expect(headers["apikey"]).toBeUndefined();
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["X-Humangent-API-Key"]).toBe("={{$credentials.apiKey}}");
  });

  it("test hits api_list_task_types with p_limit:1 against the baked base URL", () => {
    expect(credential.test.request.method).toBe("POST");
    expect(credential.test.request.baseURL).not.toMatch(/\$credentials/);
    expect(String(credential.test.request.baseURL)).toMatch(/\/rest\/v1$/);
    expect(credential.test.request.url).toBe("/rpc/api_list_task_types");
    expect(credential.test.request.body).toEqual({ p_limit: 1 });
  });
});
