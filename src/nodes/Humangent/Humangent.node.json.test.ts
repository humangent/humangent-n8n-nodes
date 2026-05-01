// Regression guard for the codex file n8n reads to place the node
// under "Human in the Loop" in its picker. The descriptor test
// covers most runtime-behavior concerns; this one pins the
// JSON-on-disk shape so a future editor can't silently drop the
// subcategory, aliases, or the node identifier.

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
  readFileSync(join(__dirname, "Humangent.node.json"), "utf8"),
) as CodexFile;

describe("Humangent.node.json codex", () => {
  it("identifies the node by its fully-qualified name", () => {
    expect(codex.node).toBe("@humangent/n8n-nodes-humangent.humangent");
  });

  it("declares the HITL category + Human in the Loop subcategory", () => {
    expect(codex.categories).toContain("HITL");
    expect(codex.subcategories.HITL).toEqual(["Human in the Loop"]);
  });

  it("includes every R7 alias so search in the node picker finds us", () => {
    const required = [
      "human",
      "hitl",
      "approval",
      "review",
      "inbox",
      "decision",
      "wait",
      "humangent",
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
