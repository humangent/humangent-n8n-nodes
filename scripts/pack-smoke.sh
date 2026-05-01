#!/usr/bin/env bash
# Packaging smoke test for n8n-nodes-humangent.
#
# Scope:
#   1. Packaging shape — n8n-verification-relevant fields in
#      package.json (name, MIT license, n8nNodesApiVersion as the
#      literal number 1, non-empty n8n.nodes, community-package
#      keyword).
#   2. Loadability — every path in n8n.nodes + n8n.credentials
#      resolves via require() in a fresh npm install of the packed
#      tarball. This catches two classes of mistake:
#        * n8n.nodes pointing at a file that didn't get built/copied.
#        * A compile-time error in the node's module graph that
#          surfaces only at require time (e.g., dynamic outputs
#          expression referencing a symbol that doesn't exist).
#   3. Node asset presence — the codex (*.node.json) + icon (*.svg)
#      for each node module exist in dist/ alongside the .node.js.
#
# Does NOT run n8n itself — no officially-supported "does this load
# into n8n" CLI exists. @n8n/scan-community-package is the closest
# official checker; we skip it here for local speed but it's wired
# into the CI gate separately.

set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PACKAGE_ROOT"

TARBALL_DIR="$(mktemp -d)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$TARBALL_DIR" "$SCRATCH"' EXIT

TARBALL="$TARBALL_DIR/n8n-nodes-humangent.tgz"

echo "→ npm pack → $TARBALL"
npm pack --pack-destination "$TARBALL_DIR" --silent >/dev/null
PACKED_TARBALL="$(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
mv "$PACKED_TARBALL" "$TARBALL"

echo "→ npm install tarball into scratch dir"
cd "$SCRATCH"
cat >package.json <<'EOF'
{ "name": "smoke", "version": "0.0.0", "private": true }
EOF
npm install --silent --no-audit --no-fund "$TARBALL"

echo "→ package-shape checks"
node -e "
  const p = require('@humangent/n8n-nodes-humangent/package.json');
  const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
  if (p.name !== '@humangent/n8n-nodes-humangent') fail('package.json.name must be @humangent/n8n-nodes-humangent');
  if (p.license !== 'MIT') fail('license must be MIT (n8n verification rule)');
  if (p.n8n?.n8nNodesApiVersion !== 1) fail('n8n.n8nNodesApiVersion must be the number 1');
  if (!Array.isArray(p.n8n?.nodes) || p.n8n.nodes.length === 0) fail('n8n.nodes must be a non-empty array');
  if (!(p.keywords || []).includes('n8n-community-node-package')) fail('keywords must include n8n-community-node-package');
  console.log('OK: package shape');
"

echo "→ require() each n8n.nodes + n8n.credentials entry"
node -e "
  const path = require('path');
  const fs = require('fs');
  const pkg = require('@humangent/n8n-nodes-humangent/package.json');
  const pkgDir = path.dirname(require.resolve('@humangent/n8n-nodes-humangent/package.json'));
  const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
  for (const nodePath of pkg.n8n?.nodes ?? []) {
    const full = path.join(pkgDir, nodePath);
    if (!fs.existsSync(full)) fail('missing node file: ' + nodePath);
    const mod = require(full);
    // n8n loads a class from the module's default or first named export.
    const exported = Object.values(mod).find((v) => typeof v === 'function');
    if (!exported) fail('no class exported from ' + nodePath);
    console.log('OK: node ' + nodePath + ' (' + exported.name + ')');
  }
  for (const credPath of pkg.n8n?.credentials ?? []) {
    const full = path.join(pkgDir, credPath);
    if (!fs.existsSync(full)) fail('missing credential file: ' + credPath);
    const mod = require(full);
    const exported = Object.values(mod).find((v) => typeof v === 'function');
    if (!exported) fail('no class exported from ' + credPath);
    console.log('OK: credential ' + credPath + ' (' + exported.name + ')');
  }
"

echo "→ codex + icon presence (per-node)"
node -e "
  const path = require('path');
  const fs = require('fs');
  const pkg = require('@humangent/n8n-nodes-humangent/package.json');
  const pkgDir = path.dirname(require.resolve('@humangent/n8n-nodes-humangent/package.json'));
  const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
  for (const nodePath of pkg.n8n?.nodes ?? []) {
    const nodeDir = path.dirname(path.join(pkgDir, nodePath));
    // Codex: <NodeName>.node.json in the same directory.
    const codexEntries = fs.readdirSync(nodeDir).filter((f) => f.endsWith('.node.json'));
    if (codexEntries.length === 0) fail('no .node.json codex next to ' + nodePath);
    // Icon: at least one .svg file referenced via the node's description.
    // We don't parse the descriptor here; existence-check is the floor.
    const svgs = fs.readdirSync(nodeDir).filter((f) => f.endsWith('.svg'));
    if (svgs.length === 0) fail('no .svg icon next to ' + nodePath);
    console.log('OK: codex + icon present for ' + nodePath);
  }
"

echo "→ smoke test passed"
