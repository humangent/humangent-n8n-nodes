// Dynamic-outputs helper for the Humangent node.
//
// Stringified at build time and embedded in INodeTypeDescription.outputs
// as an expression: `={{(${configuredOutputs})($parameter)}}`. At
// canvas-render time n8n evaluates the expression in its sandbox with
// the node's live `$parameter` object. That means this function MUST
// be self-contained — no module-level imports, no enum references at
// runtime, only literals. The `NodeConnectionType.Main` enum in
// n8n-workflow's source resolves to the string `'main'`, so we use
// the literal.
//
// Sandbox-allowed globals (verified at
// node_modules/n8n-workflow/dist/cjs/expression.js:340-439):
//   JSON, String, Array, Object, Number, Math, Date, RegExp,
//   encodeURI, encodeURIComponent, decodeURI, decodeURIComponent.
// NOT in the sandbox (must NOT appear in the function string):
//   atob, btoa, URLSearchParams, URL, fetch, Buffer, require, import,
//   NodeConnectionType.
//
// CRITICAL: n8n's WorkflowDataProxy.nodeParameterGetter
// (packages/workflow/src/workflow-data-proxy.ts:331-343) auto-unwraps
// resourceLocator parameters to their `.value` field before reaching
// expressions. So `$parameter.taskType` is the VALUE STRING the
// listSearch returned — NOT the full RL object. Anything stored on
// `cachedResultUrl` / `cachedResultName` is unreachable from canvas
// expressions, even though it survives the workflow JSON round-trip.
// alpha.14+ embeds the outcomes snapshot inside that value string
// as `<task-type-id>#o=<encoded>` — see listSearch.ts's
// `encodeTaskTypeValue` for the producer side.
//
// Shape: one output per task-type outcome (decoded from the
// resourceLocator's value snapshot), plus a Dismissed lane and a
// Timed Out lane.
//
// When the snapshot is absent, malformed, or empty (no task type
// picked, or an old workflow that predates alpha.14), return an
// empty branch list. n8n renders a zero-output node — the builder
// sees "needs configuration" state rather than fabricated branches
// that can never actually fire.

type OutputConfig = {
  type: "main";
  displayName: string;
};

// configuredOutputs is `.toString()`-interpolated into an n8n
// expression in Humangent.node.ts (`outputs: ={{(${fn.toString()})(...)}}`)
// and runs in n8n's expression sandbox. It cannot import helpers from
// other modules — every helper it uses must be DECLARED INSIDE the
// function body so it travels with the stringified source. The nested
// functions below are an explicit restructuring to keep the top-level
// branching shallow without violating the sandbox constraint.
export function configuredOutputs(parameter: unknown): OutputConfig[] {
  function decodeSnapshotEntries(value: string): unknown {
    // Find the LAST `#o=` marker so any future suffix structure stays
    // appendable (currently only `#o=` is defined; the lastIndexOf
    // keeps us robust).
    const marker = "#o=";
    const idx = value.lastIndexOf(marker);
    if (idx < 0) return null;
    const encoded = value.slice(idx + marker.length);
    try {
      return JSON.parse(decodeURIComponent(encoded));
    } catch {
      return null;
    }
  }

  function readLabel(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const id = (item as { id?: unknown }).id;
    const label = (item as { label?: unknown }).label;
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof label !== "string" || label.length === 0) return null;
    return label;
  }

  if (!parameter || typeof parameter !== "object") return [];
  const p = parameter as { taskType?: unknown; mode?: unknown };

  // alpha.21 detached `Create` mode short-circuit. The source-side
  // Humangent node returns immediately on a single Main output of
  // {requestId, requestUrl, expectedTimeoutAt} — the per-outcome /
  // Dismissed / Timed Out branches live on the destination Continue
  // node, not here. The Humangent Continue node never sets `mode`
  // on its parameters, so $parameter.mode is undefined there and we
  // fall through to the snapshot-driven branches.
  if (p.mode === "create") {
    return [{ type: "main", displayName: "Created" }];
  }

  // n8n's WorkflowDataProxy unwraps resourceLocator parameters to
  // their `.value` string before reaching this function. STRINGS only
  // — older workflows that arrived as the full RL object
  // (alpha.10–alpha.13) return [] here, which renders a zero-output
  // node and hints the author to re-pick.
  const value = p.taskType;
  if (typeof value !== "string" || value.length === 0) return [];

  const decoded = decodeSnapshotEntries(value);
  if (!Array.isArray(decoded) || decoded.length === 0) return [];

  // Whole-array validation. Any malformed item rejects the entire
  // snapshot — a half-rendered canvas is worse than no canvas.
  const named: OutputConfig[] = [];
  for (const item of decoded) {
    const label = readLabel(item);
    if (label === null) return [];
    named.push({ type: "main", displayName: label });
  }

  return [
    ...named,
    { type: "main", displayName: "Dismissed" },
    { type: "main", displayName: "Timed Out" },
  ];
}
