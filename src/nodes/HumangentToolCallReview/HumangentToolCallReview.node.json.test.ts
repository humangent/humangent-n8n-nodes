// Regression guard for the HumangentToolCallReview codex JSON. n8n
// reads this file to place the node under "Human in the Loop" in
// the picker; the runtime descriptor handles HITL eligibility.

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
  readFileSync(
    join(__dirname, "HumangentToolCallReview.node.json"),
    "utf8",
  ),
) as CodexFile;

describe("HumangentToolCallReview.node.json codex", () => {
  it("identifies the node by its fully-qualified name", () => {
    expect(codex.node).toBe(
      "@humangent/n8n-nodes-humangent.humangentToolCallReview",
    );
  });

  it("declares the HITL category + Human in the Loop subcategory", () => {
    expect(codex.categories).toContain("HITL");
    expect(codex.subcategories.HITL).toEqual(["Human in the Loop"]);
  });

  it("includes the AI-Agent-relevant aliases for picker search", () => {
    for (const alias of ["tool", "tool-call", "agent", "ai-agent"]) {
      expect(codex.alias).toContain(alias);
    }
  });

  it("points primaryDocumentation at a Humangent URL", () => {
    const url = codex.resources?.primaryDocumentation?.[0]?.url;
    expect(url).toBeTypeOf("string");
    expect(url).toMatch(/^https:\/\/([a-z0-9-]+\.)*humangent\.io\//);
  });
});
