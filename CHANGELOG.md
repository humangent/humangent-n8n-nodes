# Changelog

All notable changes to `@humangent/n8n-nodes-humangent`. The format
loosely follows [Keep a Changelog](https://keepachangelog.com).

## 0.1.0 — 2026-05-03

First non-alpha release. The package has been stable across the
alpha.10–alpha.28 series of canvas + webhook + resume fixes; this
release graduates the version line.

### Fixed

- **Resource-mapper field schema now refreshes when the user picks a
  different task type.** The `fields` resourceMapper had no declared
  dependency on the `taskType` resourceLocator, so n8n only refetched
  the schema when the user clicked the refresh icon next to the field
  list — switching task types silently left the prior task type's
  fields on the canvas. Adds `loadOptionsDependsOn: ["taskType.value"]`
  to the field's typeOptions, matching the Postgres v2 node's pattern.
  The `.value` sub-path is required because the watcher does not
  auto-unwrap resourceLocator values the way `WorkflowDataProxy` does
  in runtime expressions.

## 0.0.1-alpha.27 — 2026-05-01

### Changed

- Republished README/docs so npm no longer documents the removed
  `NPM_PUBLISH_TAG` variable. The release workflow always publishes to
  npm's `latest` dist-tag.

## 0.0.1-alpha.26 — 2026-05-01

### Changed

- Split the node into its standalone public repository.
- Removed all runtime external dependencies from the published package.
- Replaced schema-library validation with local runtime validators.
- Removed runtime environment-variable reads from node code.
- Added GitHub Actions CI and provenance-based npm publishing workflow.
- Documented release configuration and n8n verification steps.

## 0.0.1-alpha.25 — 2026-05-01

### Changed

- Same verification-ready package contents as alpha.26, published under the
  `alpha` dist-tag only. Superseded by alpha.26 so npm's default `latest`
  tag also points at the verification-ready package.

## 0.0.1-alpha.23 — 2026-04-29

### Fixed

- **Detached-mode credential `instanceId` now actually persists.** alpha.21
  declared the auto-minted `instanceId` UUID as `type: "hidden"` on the
  Humangent credential. n8n's credential schema generator strips
  hidden-typed properties before serializing the public JSON Schema; the
  schema's `additionalProperties: false` then filters them out on save.
  Net effect: the `preAuthentication` hook minted the UUID and used it
  for the in-flight credential test (which passed cleanly) — but the
  value never landed on disk, so every Continue-node activation tripped
  the `Humangent credential is missing its auto-minted instance ID`
  guard in `continueRegistration.ts`.
  - Promote the field to `type: "string"` with `typeOptions.password: true`
    masking. The schema now includes `instanceId` as a known property,
    so the persistence round-trip survives. Compare: n8n core's OAuth2
    credentials use `type: "json"` for `oauthTokenData` for the same
    structural reason — auto-managed credential fields need a non-hidden
    schema-visible type to round-trip.
  - The field appears in the credential dialog with an "Auto-managed.
    Do not edit." hint. The masked-password rendering keeps the dialog
    visually clean.
  - Verified empirically against a hosted n8n credential schema endpoint
    and against `slackOAuth2Api`'s schema (which exposes its
    auto-managed `oauthTokenData` field as `type: "json"`).

### Notes

- Existing alpha.21 credentials carry no `instanceId` value. After
  upgrading to alpha.23, click **Test** on the credential once — the
  preAuthentication hook will mint the UUID and (now) actually persist
  it. Subsequent Continue-node activations succeed.

## 0.0.1-alpha.21 — 2026-04-29

### Added

- **Detached mode end-to-end.** Two new things ship together so
  long-running reviews (overnight, multi-day) can survive n8n's
  `EXECUTIONS_TIMEOUT_MAX` cap:
  - **`Create` mode on the existing Humangent action node.** A
    user-facing **Mode** dropdown. The default `Create and Wait`
    preserves alpha.20 behaviour verbatim. The new `Create` returns
    immediately on a single Main output of `{ requestId, requestUrl,
expectedTimeoutAt }` and hands the decision off to a Humangent
    Continue node in another workflow. The hidden `operation` marker
    stays pinned to `SEND_AND_WAIT_OPERATION` in both modes — n8n
    core's WaitingWebhooks validator branch (alpha.17 fix) keeps
    working.
  - **Humangent Continue trigger node.** A second node in the package
    (`@humangent/n8n-nodes-humangent.humangentContinue`). Registers
    a subscription with Humangent on workflow activation
    (`webhookMethods.create` posts `api_register_subscription`),
    fires the matching outcome / Dismissed / Timed Out branch when
    the deliverer POSTs an HMAC-signed decision, and unregisters on
    deactivation.
- **Continuation Workflow + Continue Node Name pickers** on the
  action node, visible only in Create mode.
- **Auto-minted instance ID on the Humangent credential.** A hidden
  UUID populated by the credential's `preAuthentication` hook,
  stamped onto subscription rows so dev / prod n8n instances sharing
  the same workflow JSON register as distinct subscriptions.
- **Decision-delivery payload audience claim.** The signed body now
  carries `target_kind: 'inline' | 'subscription'` and `target_id`;
  the Continue node rejects anything other than `'subscription'`
  after HMAC verifies, blocking cross-audience replay within ±5min
  skew.
- **Replay protection on the Continue node** via
  `getWorkflowStaticData`. Eviction at 100 entries OR 24h TTL,
  whichever fires first. A second post with the same `delivery_id`
  returns `{deduped: true}` without firing the workflow.
  Defense-in-depth on top of the backend's pgmq dedup.
- **Migration deprecation hint** when `Create and Wait` is configured
  with `limitWaitTime > 1h`. Surfaces the README migration recipe
  inside the canvas.
- **README sections:** detached-mode walk-through, bootstrap sequence,
  migration recipe, replay semantics, signing-secret rotation vs
  revocation, allowlist update behavior, deactivation while in-flight,
  workflow-JSON export warning.

### Notes

- Continue's webhook descriptor diverges intentionally from the
  inline node's `restartWebhook + path:$nodeId` pair. Continue uses
  `isFullPath: true` + `path: '={{$webhookId}}'` so the registered
  URL is stable across node renames.
- Outputs reuse `configuredOutputs` verbatim from the inline node, so
  branches render identically when both nodes pick the same task type.
- Saved alpha.20 workflows without a `mode` field default to
  `createAndWait` and run identically.

## 0.0.1-alpha.20 — 2026-04-28

### Added

- **`decisionNote` on every named-branch resume payload.** When the
  reviewer attaches guidance to a decision, the Humangent Edge Function
  now emits it in the signed delivery body and the node forwards it as
  `decisionNote` on the matching outcome branch (and on Dismissed +
  Timed Out for shape parity). Closes the R22 gap where reviewer
  guidance was visible in the inbox but never reached the workflow.
  The field is always present — empty string when the reviewer didn't
  add a note, populated when they did — so downstream nodes can read
  one key without conditional access.
- **`Parent Request ID (Continuation)` input parameter.** Optional
  string field below `Wait Time Unit`. When set to the upstream
  Humangent node's `requestId`, links the new request as a
  revision-iteration child via `p_parent_request_id`. Empty (default)
  → starts a fresh chain. Trimmed + UUID-validated client-side; bad
  input throws a clear `NodeOperationError` rather than a leaky
  PostgREST 22P02.
- **`revision-request` outcome role accepted.** `OutcomeSchema.role`
  now includes `"revision-request"` alongside the existing
  `default-positive` / `secondary` / `destructive` set, matching the
  task-types CHECK constraint the gateway migration adds. Task-type
  fetches whose `outcomes_json` includes a revision-request outcome no
  longer fail schema validation (alpha.10–alpha.19 silently rejected
  them, blocking the dropdown).

### Notes

- **Forward-compat with alpha.10–alpha.19 Edge Function payloads.** The
  new `decision_note` field on `DecisionDeliverySchema` uses
  `z.string().default("")`, so alpha.20 nodes parse both pre-revision
  Edge Function payloads (no `decision_note` key — fills `""`) AND
  the new payload (which emits `decision_note` explicitly). No HMAC
  401s during the deploy ordering window. The HMAC envelope is
  unchanged: the signing contract still operates over the raw body
  bytes whatever the body shape, so adding a field is transparent to
  signature verification.
- The hidden `operation: SEND_AND_WAIT_OPERATION` parameter
  (alpha.12 + alpha.17) and the canonical GET + POST `sendAndWait`
  webhook descriptor pair (alpha.13) are unchanged.
- The outcomes-snapshot encoding (`<task-type-id>#o=<encoded>` on the
  resourceLocator's `value` per alpha.14) is unchanged. Revision
  outcomes ride the same encoding as default-positive / secondary /
  destructive.
- The alpha.19 `multi-select`-as-comma-separated-string degradation is
  unchanged — revision-request outcomes don't interact with field
  rendering.

## 0.0.1-alpha.19 — 2026-04-28

### Fixed

- **`multi-select` task-type fields can now hold multiple values
  again.** alpha.16 mapped `multi-select` to n8n's `options` resource-
  mapper type (single-select), which let workflow authors pick at
  most one value even though the gateway expects an array. n8n's
  resourceMapper has no native multi-select widget — the
  `multiOptions` parameter type isn't a valid `ResourceMapperField`
  type. We now degrade to a `string` text input with a
  `(comma-separated)` hint appended to the field's display name, and
  `execute.ts` splits the value on commas (trims each, drops empty
  elements) before sending the array to the API. Single-value entry
  still works — both `"alpha"` and `"alpha, gamma"` round-trip
  correctly server-side.

## 0.0.1-alpha.18 — 2026-04-28

### Fixed

- **`url`-typed task-type fields now render a text input on the
  resourceMapper.** The previous map sent them through as n8n's `url`
  resource-mapper field type, which has no UI input on
  n8n-workflow ^2.16 — verified empirically. Other workflow nodes
  that accept URL strings just use plain `string` fields. Aligned
  with the existing pattern (`textarea`, `radio*` already degrade to
  the closest renderable type). Documented as a deliberate
  degradation.
- **Optional `radio` / `select` / `multi-select` / `radio-images`
  fields now render with a `(none)` entry at the top of the options
  list.** n8n's resourceMapper auto-picks the first option when a
  field of `type: "options"` first renders, which made it impossible
  to leave an optional options-bearing field unset (the user would
  have to remove the row entirely via the X icon — non-obvious UX).
  The `(none)` entry surfaces an explicit "no selection" choice with
  `value: ""` for optional fields. Required fields skip the prepend
  — the author still has to pick a real value.

## 0.0.1-alpha.17 — 2026-04-28

### Fixed

- **Resume webhook now resolves end-to-end again.** alpha.14 wrongly
  removed the hidden `operation: SEND_AND_WAIT_OPERATION` marker
  added in alpha.12, after blaming it for canvas regressions
  reported on alpha.12. Empirical re-test on a hosted n8n instance after
  alpha.16 confirmed the canvas is fine without the marker but the
  resume webhook 401s with `{"error":"Invalid token"}` from n8n
  core's `WaitingWebhooks` validator. The actual canvas root cause
  was the alpha.11 webhook-descriptor truncation (single POST, no
  `isFullPath`) — fixed independently in alpha.13. The editor-ui
  only references the marker in benign hint code (tooltip +
  wait-state label) — verified in
  `packages/frontend/editor-ui/src/app/utils/nodeViewUtils.ts` and
  `useCanvasMapping.ts`. alpha.17 brings the marker back.

## 0.0.1-alpha.16 — 2026-04-28

### Fixed

- **Field row headers in the resourceMapper now show the user-
  friendly label** (e.g. "Summary") instead of the lowercase
  identifier ("summary"). The n8n-node's `FieldDefSchema` was using
  the n8n-flavored property name `displayName` while the editor's
  source-of-truth `FieldSnapshotSchema`
  (`apps/web/src/lib/types.ts`) writes the label into a `label`
  property; the mismatch made the resourceMapper fall through to
  `f.id`. Aligned the schema + the row-mapping.
- **Task-type dropdown unblocks when an org has any task type with
  options-bearing fields.** The previous `FieldDefSchema` expected
  `{name, value}` for options but the editor writes `{label, value}`,
  so Zod's strict parse rejected the entire `listTaskTypes` response
  whenever any row's `field_schema_json` contained a select / radio /
  multi-select / radio-images field. Symptom in canvas: dropdown
  loaded zero items with a Zod parse error on path
  `field_schema_json[N].options[M].name` (`expected string, received
undefined`). Aligned the schema. Options now render as proper
  dropdowns/radios in the resourceMapper.

### Notes

- Field-removability in the resourceMapper UI is the standard n8n
  behavior: optional fields can be removed (X icon), required
  fields are pinned. If the workflow author removes an optional
  field, the request is created without it — which is fine because
  the gateway only enforces required fields. There's no node-side
  override for this; if you want to force every field through, mark
  it required in the task type.

## 0.0.1-alpha.15 — 2026-04-28

### Fixed

- **Strip the alpha.14 `#o=` snapshot suffix in `getTaskTypeSchema`**
  before calling `api_get_task_type`. alpha.14 moved the outcomes
  snapshot inline into the resourceLocator's `value` string, but the
  resourceMapper's task-type-id reader still passed the full encoded
  value through to PostgREST, which rejected with HTTP 400 because
  `p_task_type_id` requires a bare UUID. Visible in the canvas as
  "Humangent: Request failed with status code 400" or "No fields
  found in Humangent" when opening the resourceMapper. Now uses
  `lastIndexOf("#o=")` to recover the bare id, matching the strip
  in `execute.ts` and `extractTaskTypeId`.

## 0.0.1-alpha.14 — 2026-04-28

### Fixed

- **Canvas now actually renders subtitle + dropdown + resourceMapper +
  dynamic outputs.** alpha.10–alpha.13 stored the outcomes snapshot on
  the resourceLocator's `cachedResultUrl`, but n8n's
  `WorkflowDataProxy.nodeParameterGetter`
  ([workflow-data-proxy.ts:331-343](https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/workflow-data-proxy.ts#L331-L343))
  unconditionally unwraps `$parameter[<resourceLocator>]` to its
  `.value` string before any expression sees it — so anything stored
  on `cachedResultUrl` / `cachedResultName` is unreachable from
  canvas expressions, even though the data survives the workflow JSON
  round-trip. The `subtitle` expression and the `outputs` expression
  both depended on those fields and silently failed.

  alpha.14 moves the snapshot into the RL `value` itself as
  `<task-type-id>#o=<encoded>`. The sandbox decoder
  (`configuredOutputs`) and the Node decoder (`decodeSnapshot`) both
  now parse a string instead of an object. `execute()` and
  `webhook()` split on `#o=` to recover the bare task-type id for
  server calls. The subtitle is now a static label
  (`'Wait for human decision'` / `'Pick a task type'`) since
  `cachedResultName` is unreachable.

### Removed

- **Hidden `operation: SEND_AND_WAIT_OPERATION` marker** added in
  alpha.12. Empirical re-test against the running n8n
  ("v2.47.14" — most likely a 1.107.x branch) showed the marker
  isn't required for the resume webhook to resolve, and it
  coincided with the canvas regressions reported on alpha.12+. If a
  future n8n upgrade requires the marker again, re-add behind
  whatever displayOptions guard avoids the canvas issue.

### Migration

- Workflows saved on `0.0.1-alpha.10` through `0.0.1-alpha.13` carry
  the snapshot on `cachedResultUrl`, which alpha.14 ignores. On the
  first execute, the node throws `task_type_snapshot_missing` with
  copy pointing the author back to the dropdown — re-pick the task
  type and the new value-encoded snapshot lands automatically.

## 0.0.1-alpha.13 — 2026-04-28

### Fixed

- **Restore n8n's canonical `sendAndWait` webhook descriptor pair.**
  alpha.11 collapsed the two-webhook (GET + POST, both `isFullPath:
true`) descriptor pair to a single POST without `isFullPath`,
  attempting to fix what the first investigator misidentified as the
  cause of `{"error":"Invalid token"}` 401s. The actual canonical
  shape — verified against n8n core's
  `packages/nodes-base/utils/sendAndWait/descriptions.ts`
  (`sendAndWaitWebhooksDescription`) — is the GET + POST pair with
  `isFullPath: true` that alpha.10 originally had. alpha.13 restores
  that shape AND keeps the alpha.12
  `operation: SEND_AND_WAIT_OPERATION` hidden parameter; the two
  together match n8n's exact pattern (Slack / Email / Microsoft
  Teams / Telegram all use the same).
- **Fixes the canvas regression visible after upgrading to alpha.12.**
  With alpha.11's truncated webhook descriptor in place, picking a
  task type, opening the resourceMapper, and rendering dynamic
  outputs all became unstable on n8n's canvas (subtitle fell back to
  "No task type selected", dropdown failed to render, resourceMapper
  threw "invalid parsing json", outputs disappeared leaving only
  connection lines). Restoring the canonical webhook descriptor pair
  resolves all four symptoms.

## 0.0.1-alpha.12 — 2026-04-28

### Fixed

- **Resume webhook now opts into n8n's HMAC validator branch.** Adds a
  hidden `operation: SEND_AND_WAIT_OPERATION` parameter on the node so
  n8n core's `WaitingWebhooks.executeWebhook` (master / 2.x) routes
  signed deliveries through `generateUrlSignature` HMAC verification
  against the URL `getSignedResumeUrl` mints. Without the flag, the
  validator falls back to comparing the `?signature=` query against
  the unrelated `execution.data.resumeToken`, which always 401s with
  `{"error":"Invalid token"}`. alpha.11 fixed the descriptor lookup;
  alpha.12 fixes the validator branch selection — both are required
  for the end-to-end resume to succeed against n8n 2.x.

## 0.0.1-alpha.11 — 2026-04-28

### Fixed

- **Decision deliveries can now actually resume the execution.** The
  webhook descriptor on the Humangent node was registered with
  `isFullPath: true` and a duplicate GET + POST pair, which routed
  through n8n's regular trigger-webhook table. n8n's
  `getSignedResumeUrl` mints `/webhook-waiting/<execId>/<nodeId>`
  resume URLs that the core router only matches to descriptors
  registered without `isFullPath`. The mismatch surfaced as an
  `{"error":"Invalid token"}` 401 from n8n core _before_ the node's
  HMAC verifier ever ran — every decision delivery against a
  self-hosted n8n bounced silently and the workflow only resumed on
  waitTill expiry. Consolidates to a single POST descriptor with
  `restartWebhook: true` and `path: '={{$nodeId}}'`, no `isFullPath`.
  Verified end-to-end against a hosted n8n v2.47.14 instance.

## 0.0.1-alpha.10 — 2026-04-28

### Breaking

- **Removed the `outcomes` (Outcome Names or IDs) parameter from the
  node.** The set of canvas branches now derives from a snapshot of
  the task type's outcomes captured when you pick the task type from
  the From-list dropdown. There's no longer a separate field for the
  builder to manually re-select outcome ids.
- **The Task Type resourceLocator no longer exposes the "By ID" mode.**
  Pick from the list — the dropdown is the only entry point so the
  outcomes snapshot is always captured alongside the id.
- **Workflows saved on `0.0.1-alpha.9` or earlier must be re-opened
  and re-saved** before they will execute on alpha.10. On first
  execute, the node throws `task_type_snapshot_missing` with copy
  pointing the author back to the dropdown. No silent failure mode.

### Added

- **Outcomes snapshot on the node.** Pick a task type → the node
  captures `[{id, label}, ...]` onto the resourceLocator's
  `cachedResultUrl` fragment. The canvas decoder reads that fragment
  to render branches without re-fetching the API at canvas-render
  time. Empirical preservation across n8n save/load cycles confirmed
  byte-identical (see
  `docs/solutions/best-practices/n8n-resourceLocator-cachedResultUrl-preservation-2026-04-27.md`).
- **`n8n_drift` metadata on every request.** Each execute writes a
  non-blocking summary to `metadata.n8n_drift` with the snapshot vs
  live outcome ids and a label-drift map for any id whose label
  changed upstream. Available for backend audit; never blocks the
  workflow.
- **Drift-detected payloads.** When a decision arrives carrying an
  `outcome_id` the snapshot doesn't know about (mid-wait drift —
  outcome added live after the workflow saved its snapshot), the
  node routes onto **Dismissed** with `drift_detected: true` and
  `unmatched_outcome_id: "<id>"` on the JSON. Workflows can branch
  on the flag downstream of Dismissed; decisions are never silently
  dropped.
- **README "Handling outcome drift" section** documenting the
  behaviour above + the re-pick refresh story.

### Fixed

- Resume URL registration now covers **every live task-type outcome
  plus `dismiss`**, not just the snapshot subset. The gateway's
  `_validate_resume_urls` requires the full set; previously this
  was true by accident because the dropped `outcomes` parameter
  didn't gate URL registration. Now it's enforced by construction.

### Notes

- The signing contract for decision deliveries is unchanged.
- The HMAC secret is still the API key plaintext.
- `EXECUTIONS_TIMEOUT_MAX` cap behaviour is unchanged.

## 0.0.1-alpha.9 — 2026-04-27

### Added

- Removed runtime environment-variable overrides from the verified package
  preparation branch. Preview and local-stack addresses now belong in CI
  variables or unreleased test harnesses, not in node runtime code.

## 0.0.1-alpha.8 and earlier

See git history.
