// Post-build asset copier for the n8n-nodes-humangent package.
//
// tsc only emits .js / .d.ts — it does not copy the codex files
// (*.node.json) or node icons (*.svg) that n8n's loader needs from
// the same directory as the compiled .node.js. This script walks
// src/ and mirrors those non-TS assets into dist/ preserving
// relative paths.
//
// Kept in plain ESM Node so it runs without a TS transform and
// has no external dependencies — matches the rest of the repo's
// scripts/ convention.

import { readdir, mkdir, copyFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const SRC = join(PACKAGE_ROOT, "src");
const DIST = join(PACKAGE_ROOT, "dist");

const ASSET_EXTS = [".node.json", ".svg"];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (ASSET_EXTS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  try {
    await stat(SRC);
  } catch {
    console.error(`copy-assets: ${SRC} does not exist; aborting`);
    process.exit(1);
  }
  const assets = await walk(SRC);
  for (const src of assets) {
    const rel = relative(SRC, src);
    const dest = join(DIST, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    console.log(`copy-assets: ${rel}`);
  }
  if (assets.length === 0) {
    console.log("copy-assets: no assets found");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
