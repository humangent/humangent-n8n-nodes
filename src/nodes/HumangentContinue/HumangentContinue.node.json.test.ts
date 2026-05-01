// Regression guard for the Continue node codex file. Mirrors the
// inline node's `Humangent.node.json.test.ts` to keep the two
// codexes shaped consistently.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface CodexFile {
  node: string;
  nodeVersion: string;
  codexVersion: string;
  categories: string[];
  subcategories: Record<string, string[]>;
  alias: string[];
  resources?: {
    primaryDocumentation?: Array<{ url: string }>;
  };
}

const codex = JSON.parse(
  readFileSync(join(__dirname, "HumangentContinue.node.json"), "utf8"),
) as CodexFile;

describe("HumangentContinue.node.json codex", () => {
  it("identifies the Continue node by its fully-qualified name", () => {
    expect(codex.node).toBe("@humangent/n8n-nodes-humangent.humangentContinue");
  });

  it("declares the HITL category + Human in the Loop subcategory", () => {
    expect(codex.categories).toContain("HITL");
    expect(codex.subcategories.HITL).toEqual(["Human in the Loop"]);
  });

  it("includes Continue-specific aliases so picker search finds the trigger", () => {
    const required = [
      "humangent",
      "continue",
      "humangent decision trigger",
      "on-decision",
      "trigger",
    ];
    for (const alias of required) {
      expect(codex.alias).toContain(alias);
    }
  });

  it("declares codexVersion + nodeVersion in the expected 1.0 shape", () => {
    expect(codex.codexVersion).toBe("1.0");
    expect(codex.nodeVersion).toBe("1.0");
  });

  it("points primaryDocumentation at a Humangent URL", () => {
    const url = codex.resources?.primaryDocumentation?.[0]?.url;
    expect(url).toBeTypeOf("string");
    expect(url).toMatch(/^https:\/\/([a-z0-9-]+\.)*humangent\.io\//);
  });
});
