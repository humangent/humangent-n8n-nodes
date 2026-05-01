# Release and Verification

This repository publishes `@humangent/n8n-nodes-humangent` from GitHub
Actions only. Do not publish from a local machine.

No npm token is required when npm Trusted Publisher is configured. If a
token fallback is ever added, store it in `secrets.NPM_TOKEN` and keep
the workflow failing clearly when it is missing.

Do not commit real production URLs, API keys, Supabase project refs,
private callback URLs, n8n test instance URLs, or preview URLs. Put any
automation-only endpoint in GitHub Actions `vars.*` if public and
non-sensitive, or `secrets.*` if sensitive.

## npm Trusted Publisher Setup

1. Create the public GitHub repository.
2. Open the npm package settings for `@humangent/n8n-nodes-humangent`.
3. Add a Trusted Publisher:
   - Provider: GitHub Actions
   - Repository owner: the GitHub owner
   - Repository name: the public repository name
   - Workflow filename: `publish.yml`

## Release

1. Update `package.json` version.
2. Commit the change.
3. Tag the same version with a `v` prefix, for example:

   ```bash
   git tag v0.0.1-alpha.27
   git push origin v0.0.1-alpha.27
   ```

4. Wait for the `publish` workflow to pass.
5. Confirm npm shows provenance for the published version and that npm's
   `latest` dist-tag points at it.

## Verification Checks

Run locally before tagging:

```bash
npm install
npm run type-check
npm test
npm run build
npm run lint
npm run pack:smoke
```

The scanner command checks the package currently available from npm.
After publishing a new alpha or beta, the release workflow runs it
against the exact published version. You can rerun it manually before
submitting to the n8n Creator Portal:

```bash
npx @n8n/scan-community-package @humangent/n8n-nodes-humangent
```

## Creator Portal Submission

Submit the npm package and public GitHub repository. The package should
show:

- MIT license.
- `n8n-community-node-package` keyword.
- `n8n.nodes` and `n8n.credentials` in `package.json`.
- No external runtime dependencies.
- GitHub Actions provenance.
- English-only UI and documentation.
