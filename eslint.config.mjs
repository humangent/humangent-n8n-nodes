// Flat-config ESLint setup for the n8n-nodes-humangent package.
//
// Three rule sets compose here:
//   1. Base JS + typescript-eslint recommended — repo-standard TS hygiene.
//   2. plugin:n8n-nodes-base/nodes — applied only to src/nodes/**/*.ts.
//      Catches node-level authoring mistakes (subtitle expression shape,
//      displayOptions correctness, version discipline, icon path).
//   3. plugin:n8n-nodes-base/credentials — applied only to
//      src/credentials/**/*.ts. Enforces the credential-class conventions
//      n8n reviewers check against.
//
// The community preset (package.json-level rules) is not wired here —
// ESLint's flat config does not parse package.json by default, and the
// plugin's package.json rules are applied at pack time by the smoke
// script (Unit 1 packaging checks + eventual @n8n/scan-community-package).
//
// eslint-plugin-n8n-nodes-base is eslintrc-native; FlatCompat translates
// its legacy presets into the flat-config shape.

import path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

export default defineConfig([
  globalIgnores(["dist", "coverage", "node_modules"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Allow the standard discard-via-underscore convention in
      // destructuring + function args + catch clauses. Matches the
      // spirit of the web workspace's looser default (typescript-eslint
      // recommended out of the box doesn't enforce this rule as strictly
      // as our stricter `noUnusedLocals/Parameters` tsconfig pair does,
      // so mirroring the `^_` escape hatch keeps both gates aligned).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Scope the nodes preset to just the main `*.node.ts` files. The
  // preset's descriptor-shape rules (filename-vs-name, display-name
  // conventions, description final-period check) are intended for
  // the canonical node file — applying them to helper modules or
  // tests in the same directory misfires on plain strings that
  // happen to look like n8n field descriptors.
  ...compat
    .extends("plugin:n8n-nodes-base/nodes")
    .map((config) => ({ ...config, files: ["src/nodes/**/*.node.ts"] })),
  ...compat
    .extends("plugin:n8n-nodes-base/credentials")
    .map((config) => ({ ...config, files: ["src/credentials/**/*.ts"] })),
  {
    // The preset enables a rule that camelCase-checks documentationUrl's
    // VALUE (not the identifier) — the rule's own docstring says "Only
    // applicable to nodes in the main repository." Our package isn't
    // in n8n-io/n8n, so the rule misfires on every real HTTPS URL.
    // See node_modules/eslint-plugin-n8n-nodes-base/dist/lib/rules/cred-class-field-documentation-url-miscased.js
    files: ["src/credentials/**/*.ts"],
    rules: {
      "n8n-nodes-base/cred-class-field-documentation-url-miscased": "off",
    },
  },
  {
    // The preset's `node-class-description-inputs-wrong-regular-node`
    // rule decides regular-vs-trigger by checking whether the
    // filename ends in `Trigger.node.ts`. The Humangent Continue node
    // is a real trigger (group: ['trigger'], webhookMethods, inputs:
    // []), but its filename intentionally ends in `Continue.node.ts`
    // — the suffix matters for the matching `Continue` mode on the
    // inline node, and renaming to `…Trigger.node.ts` would force a
    // descriptor name change that breaks codex parity. The companion
    // `wrong-trigger-node` rule is keyed on the same filename suffix
    // so it doesn't fire here either; with both off, neither path
    // mis-evaluates the `inputs: []` declaration.
    //
    // See node_modules/eslint-plugin-n8n-nodes-base/dist/lib/ast/utils/filename.js:isRegularNodeFile.
    files: ["src/nodes/HumangentContinue/HumangentContinue.node.ts"],
    rules: {
      "n8n-nodes-base/node-class-description-inputs-wrong-regular-node": "off",
    },
  },
]);
