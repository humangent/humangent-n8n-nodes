import { describe, expect, it } from "vitest";

import { HUMANGENT_ANON_KEY, HUMANGENT_API_URL } from "./constants";

describe("constants", () => {
  it("uses the public production API endpoint", () => {
    expect(HUMANGENT_API_URL).toBe("https://api.humangent.io");
  });

  it("omits legacy gateway auth by default", () => {
    expect(HUMANGENT_ANON_KEY).toBe("");
  });
});
