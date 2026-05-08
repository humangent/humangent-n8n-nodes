# @humangent/n8n-nodes-humangent

Official n8n node for [Humangent](https://humangent.io) — a human-in-
the-loop inbox for n8n workflows. Drop the **Humangent** node onto a
canvas, pick a task type, map fields, and the workflow pauses on a
human decision and resumes along the branch that matches the
reviewer's outcome.

## Install

In your self-hosted n8n instance:

```text
Settings → Community Nodes → Install → @humangent/n8n-nodes-humangent
```

Restart n8n if prompted. Minimum supported n8n version: **1.70**.

## Credential setup

Create a **Humangent API** credential in n8n. One field, required,
issued from Humangent's admin console at `/admin/api-keys`:

| Field             | Value                        |
| ----------------- | ---------------------------- |
| Humangent API Key | `hmk_live_…` or `hmk_test_…` |

The key is shown **once** when you create it — copy it before closing
the modal. Use an `hmk_test_*` key for the **Test step** button so
test-run requests stay tagged separately from production audit trails.

Click **Test** on the credential dialog to verify.

## Test mode

Use an `hmk_test_*` API key in the credential when running n8n's
**Test step** flow. Test-mode requests are still sent to Humangent but
are marked separately from live audit trails. Use an `hmk_live_*` key
only for production workflows.

## Node walk-through

### Task Type

A resource-locator with a **From list** (searchable dropdown) only.
Pick the task type from the list — the node captures a snapshot of
the task type's outcomes at pick time and renders one canvas branch
per outcome (plus a Dismissed lane and a Timed Out lane).

The snapshot is the canvas truth source. If the task-type author later
adds, removes, or relabels outcomes upstream, the canvas keeps showing
what you picked. To refresh, **re-open the dropdown and re-pick** the
task type — that re-captures the snapshot. See
[Handling outcome drift](#handling-outcome-drift) for what happens at
runtime when the snapshot and the live task type diverge.

### Fields

A resource-mapper bound to the task type's field schema. Upstream
keys that match field names are auto-mapped; override or provide
expressions per field.

### Limit Wait Time + Wait Time Unit

How long n8n waits before routing to the **Timed Out** branch.
Default 24 hours.

**Important:** n8n's own `EXECUTIONS_TIMEOUT_MAX` env var caps the
workflow-wide wait. The default is **3600 s (1 hour)**. If your
Limit Wait Time exceeds that cap, n8n can end the execution before a
reviewer decides. Raise the env var on your n8n instance:

```bash
export EXECUTIONS_TIMEOUT_MAX=604800   # e.g., 7 days
# restart n8n
```

`EXECUTIONS_TIMEOUT_MAX=0` disables the cap entirely.

## Output branches

Output ordering on the canvas (`N` outcomes in the snapshot captured
when you picked the task type):

| Branch index | Lane                    | Fires when                                                                                                        |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0 … N-1`    | snapshot outcome labels | Humangent delivers a signed decision whose `outcome_id` matches this snapshot outcome.                            |
| `N`          | `Dismissed`             | Reviewer explicitly dismissed, OR the decision's `outcome_id` isn't in the snapshot (mid-wait drift — see below). |
| `N+1`        | `Timed Out`             | The wait expired before any decision arrived.                                                                     |

All non-timeout branches receive a JSON item of this shape:

```jsonc
{
  "delivery_id": "<opaque id>",
  "request_id": "<uuid>",
  "outcome_id": "<outcome or 'dismiss'>",
  "is_dismiss": false,
  "fields": {
    /* final field values */
  },
  "fields_before": {
    /* pre-edit values, only when reviewer edited */
  },
  "decided_by_profile_id": "<uuid>",
  "decided_at": "2026-04-23T12:34:56Z",
  "duration_ms": 12345,
  "is_test": false,
}
```

The `Timed Out` branch's item is narrower — no reviewer acted, so
`fields` carries the last saved state and
`fields_before`/`decided_by_profile_id`/`decided_at` are absent.

## Handling outcome drift

The node captures a snapshot of the task type's outcomes when you pick
it from the dropdown. Two things can drift between then and the moment
a reviewer decides:

**1. The task-type author added or renamed outcomes upstream.** The
canvas keeps rendering the snapshot you picked, so the Humangent admin
console may show outcomes the workflow doesn't have a branch for. The
node still registers signed resume URLs for **every live outcome**
plus `dismiss` — the API requires that — so reviewers can pick any
current outcome.

If a reviewer picks an outcome that's in the live list but **not** in
the snapshot, the node routes the decision onto **Dismissed** with two
extra fields on the JSON payload:

```jsonc
{
  "outcome_id": "needs_changes",
  "drift_detected": true,
  "unmatched_outcome_id": "needs_changes",
  // …rest of the decision payload as usual
}
```

You can branch on `drift_detected === true` downstream of Dismissed to
escalate, log, or re-route. Decisions are **never silently dropped**.

**2. The task type itself was archived or deleted.** The node hard-
fails at execute time with `Task type not found`. Re-pick the task
type from the dropdown to refresh.

To stay aligned: re-open the task-type dropdown periodically and
re-pick — that re-captures the snapshot from the current outcomes
list. Every execute also writes a non-blocking `n8n_drift` summary
into the request's metadata (snapshot vs live outcome ids + label
diffs) for backend audit.

### Old workflows from before the snapshot was introduced

Workflows saved with `0.0.1-alpha.9` or earlier don't carry an
outcomes snapshot on the node parameter. On the **first execute** of
such a workflow, the node throws:

> This workflow has not captured the task type's outcomes. Open the
> node and re-pick the task type from the dropdown.

Open the node, re-pick the task type, save the workflow, then run
again.

## Humangent Tool Call Review (AI Agent HITL)

> Tested with **n8n 2.18.5**. Requires an n8n version that ships the
> AI Agent HITL feature (`packages/cli/src/tool-generation/hitl-tools.ts`
> and `packages/@n8n/nodes-langchain/utils/agent-execution/processHitlResponses.ts`).

Use **Humangent Tool Call Review** when you want a reviewer to
approve or deny each downstream tool call an AI Agent proposes —
Gmail, CRM writes, HTTP requests, anything destructive — instead of
gating the whole workflow at the front. The node registers as an
n8n-native HITL tool for the AI Agent: the agent sees the original
downstream tool's schema, the reviewer sees what's about to happen,
and only approval permits the gated tool to run.

### Builder setup

Canonical wiring on the canvas:

```
AI Agent ── Tool ──▶ Humangent Tool Call Review ── Tool ──▶ Gmail / CRM / HTTP
```

1. Drop the **AI Agent** (langchain) node onto a workflow.
2. Connect **Humangent Tool Call Review** to one of the AI Agent's
   tool ports. n8n's HITL generator wraps it as an `*HitlTool` variant
   automatically when the agent runs.
3. Connect the actual downstream tool (Gmail, HTTP Request, anything
   ending in `Tool`) to Humangent Tool Call Review's tool input. The
   agent still sees the downstream tool's full schema — you do **not**
   re-declare parameters on the Humangent node.
4. Pick the **Humangent API** credential. The node calls
   `api_ensure_tool_call_review_task_type` on first run to resolve
   (and create on demand) the system task type for the org. There is
   **no** task-type picker — the system task type's outcomes
   (`approve`, `deny`) are pinned by the Humangent backend so the
   agent's `{approved: bool}` contract stays stable across editor
   edits.
5. Optionally fill **Message** with reviewer-facing copy (defaults to
   `The agent wants to call {{ $tool.name }}`), set **Limit Wait Time**,
   and list **Redact Parameter Keys** for any parameter values that
   must not appear in the reviewer's preview.

### Enforcement boundary

The Humangent gate **only applies to tool calls routed through this
node**. If you also connect a sensitive downstream tool directly to
the Agent's tool port, the agent can call it without review.

> 🚨 Connect each sensitive tool **only** through Humangent Tool Call
> Review. A direct AI-Agent → Gmail link bypasses Humangent.

### Reviewer experience

The request opens in the Humangent inbox with:

- A **Proposed tool call** card (proposed tool name, sanitized
  parameter preview, redaction notice, n8n workflow / execution /
  node origin pointers).
- The standard request fields card with the same data, populated for
  reviewers who prefer the form layout.
- Two action buttons: **Approve** and **Deny**. Reviewers can also
  use the inbox's **Dismiss** flow.

Routing applies the same way as any other Humangent task type —
admins can route the **Tool call review** task type to a specific
team or escalation chain in the task-type editor. Outcomes and
field schema are read-only on the system task type; routing,
cosmetics, and archive remain editable.

### Outcome → agent contract

The webhook handler maps the reviewer's decision into the
`{approved, chatInput?}` shape n8n's `processHitlResponses` reads:

| Reviewer outcome              | Returned to agent                                                |
| ----------------------------- | ---------------------------------------------------------------- |
| `approve`                     | `{ approved: true, chatInput: <reviewer note> }`                 |
| `deny`                        | `{ approved: false, chatInput: <reviewer note or default> }`     |
| **Dismiss** (inbox flow)      | `{ approved: false, dismissed: true, chatInput: … }`             |
| **Timeout** (no decision)     | `{ approved: false, timed_out: true, chatInput: … }`             |
| Delivery failure / bad sig    | No resume — n8n keeps the execution waiting; deliver-decision retries |

After a denial, the agent's HITL processor surfaces a
`STOP what you are doing and wait for the user to tell you how to proceed`
prompt to the model, with the reviewer's `chatInput` as guidance.

### System prompt guidance

Build agent system prompts that gracefully handle denials — the agent
will see denial messages from `processHitlResponses` and should
acknowledge them rather than retrying. A typical add-on:

> When a tool call is denied, do not retry. Summarize what was blocked
> and ask the user how to proceed. Reviewer notes (when present) are
> guidance from a human and take priority over your previous plan.

### Fallback for unsupported n8n versions

If your n8n is older than 2.x or runs without the AI Agent HITL
generator, the node still appears in the picker but n8n won't
auto-wrap it as an `*HitlTool`. As a fallback you can use a regular
**Humangent** node with a protected subworkflow that runs the
sensitive tool only on the approve branch — see [Detached mode
(Create + Continue)](#detached-mode-create--continue).

## Detached mode (Create + Continue)

Long-running reviews — anything that risks blowing past
`EXECUTIONS_TIMEOUT_MAX` (defaults to **1 hour** on n8n Cloud) — need
the **Create** mode plus a **Humangent Continue** trigger node in a
separate workflow. The original `Create and Wait` mode stays the
right choice for short reviews; detached mode exists for waits that
shouldn't be bounded by a single execution's wall time.

### When to use which

| Use…                                       | If your review is…                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create and Wait** (existing inline path) | Short and self-contained — minutes to under an hour. The workflow holds open and resumes on the matching branch.                                                                                    |
| **Create** + a Humangent Continue node     | Long, overnight, or multi-day. The source workflow returns immediately after creating the request; a separate workflow rooted at a Humangent Continue receives the decision when the reviewer acts. |

### Bootstrap sequence (admin → builder)

1. **Org admin** opens **Workspace Settings → n8n Allowed Origins**
   in the Humangent app and adds the origin (`scheme://host[:port]`)
   of every n8n instance that will register Continue nodes
   (e.g., `https://n8n.acme.com`). Empty allowlist rejects every
   `api_register_subscription` call with `n8n_allowed_origins_unset`.
2. **Builder** creates the **destination** workflow and drops a
   **Humangent Continue** node into it. Pick the Task Type that
   matches what the source workflow will create. Save and **activate**
   the workflow — activation registers the Continue with Humangent.
3. **Builder** returns to the **source** workflow. On the Humangent
   action node, set **Mode → Create**, fill in **Continuation
   Workflow** (the destination workflow you just activated) and
   **Continue Node Name** (the n8n-internal name of the Continue —
   visible in the destination canvas). Save.
4. Run a test step on the source workflow. The execution hint echoes
   the resolved Continue display name + Task Type — that's your
   confirmation the destination resolved correctly. Real review
   testing happens on the destination workflow's own listen-for-event
   test step.

### Migration recipe (alpha.10 → alpha.21)

Already on inline `Create and Wait` and want to lift a long-running
review out of the EXECUTIONS_TIMEOUT_MAX cap?

1. Copy every node downstream of the Humangent action into a **new**
   workflow.
2. At the top of the new workflow, drop a **Humangent Continue** node
   and pick the same Task Type the source uses. Connect it to the
   nodes you copied.
3. **Activate** the new workflow.
4. On the source workflow, change the Humangent action's **Mode** from
   **Create and Wait** to **Create**. Fill in the picker pair pointing
   at the new workflow + Continue node name.
5. Save the source workflow. Done — the next run hands off to the
   destination Continue.

The action node also surfaces an in-canvas migration hint when
`Create and Wait` is configured for waits longer than 1 hour, pointing
at this section.

### Detached-mode payload + replay semantics

- **Source emits a single Main output** of `{ requestId, requestUrl, expectedTimeoutAt }` and continues immediately.
- **Continue's per-outcome / Dismissed / Timed Out branches** fire the
  same payload shape inline `Create and Wait` emits today (per-outcome
  field values, `decided_by_profile_id`, `delivery_id`, `request_id`,
  etc.). See **Output branches** above for the full shape.
- **Replaying a Create execution mints a fresh idempotency key.** Both
  the original and the replay create independent requests; both
  eventually fire the destination Continue. `request_id` differs
  between original and replay, so downstream nodes **cannot** dedupe
  on `request_id` alone — if your downstream has external side
  effects, key downstream dedup on a business-context idempotency
  key (the customer id, the invoice number, etc.) rather than the
  fresh UUID.
- **No persistent canvas badge.** Once Create executes in detached
  mode, no canvas indicator shows a pending review. Use the Humangent
  inbox to monitor outstanding decisions; the `requestUrl` in the
  Create output is the deep link.

### Detached-mode limits + caps

- **`Limit Wait Time` is server-enforced** on Create (max 90 days).
  The n8n `EXECUTIONS_TIMEOUT_MAX` cap does **not** apply on this
  path.
- **Continue activation needs a Task Type pick + a workflow save.**
  If `webhookMethods.create` cannot resolve the webhook URL, the
  workflow refuses to activate. Save the workflow once, then activate.

### Workflow-JSON export warning

An exported workflow JSON containing an **active** Continue node
includes a live `subscription_id` in `staticData`. The ID alone does
not authenticate, but a member of the same Humangent workspace who
already has an API key can call `api_unregister_subscription` with
that ID to deactivate the listener (DoS), or — through the org_admin
path — silently overwrite its `webhook_url`. **Deactivate the
Continue's workflow before sharing its JSON publicly, or strip
`staticData` from the export.**

### Signing-secret rotation vs revocation

- **Rotation** (routine hygiene): re-issue your Humangent API key,
  update the n8n credential, revoke the old when nothing depends on
  it. **In-flight detached requests stay signed with the API key
  they were created with**, so rotation never breaks a review that's
  already open. Rotation only affects requests created after the
  rotation.
- **Revocation** (break-glass response to a known-compromised key):
  setting `revoked_at` on the API key tells the deliverer to refuse
  to sign with it. In-flight requests bound to a revoked key route
  to `delivery_failed` with a `decision.signing_key_revoked` event.
  Recover by issuing a new credential and using
  `admin_redrive_request_delivery` to re-deliver with a healthy
  signing key.

### Allowlist update behavior

Removing a previously-allowlisted n8n origin from Workspace Settings
**does not rescind existing subscriptions**. New deliveries to a
removed origin will fail at the deliverer's allowlist re-check, retry
exhausts, and the request enters `delivery_failed`. Re-allowlist the
origin or unregister the affected Continue nodes.

The allowlist also rejects loopback (`127.0.0.0/8`, `::1`),
link-local (`169.254.0.0/16` including AWS IMDS), RFC-1918 private
ranges, and bare `localhost` — even if an admin tries to add them.
This protects the Humangent platform from being used to probe its
own internal network on behalf of a tenant.

### Deactivating a Continue mid-wait

If you deactivate a workflow whose Continue node has open detached
requests:

- The requests stay alive on the Humangent backend until they're
  decided or their `limit_wait_time` expires.
- Deliveries to the deactivated webhook will fail at HTTP transport,
  retry per the backend retry budget, and after exhaustion enter
  `delivery_failed`.
- `api_unregister_subscription` refuses with `subscription_in_use:<count>`
  while open requests reference the subscription — wait for them to
  decide / time out / fail before deactivating, or use the admin
  re-drive path after re-activating.

### n8n Instance ID

The Humangent credential auto-mints a unique `instanceId` UUID on
first save (via the credential's `preAuthentication` hook). This ID
disambiguates dev / prod n8n instances that share the same exported
workflow JSON — each instance registers as a distinct subscription.
**Two different n8n instances must use different credentials**; copying
a credential record verbatim across instances would collide their
instance IDs.

### Continue Node Name picker

Today the Continue Node picker is a typed string (the n8n-internal
node name, NOT the display name — visible by hovering the destination
node in the source canvas). The execution hint after a successful
Create echoes the resolved Continue's display name + Task Type, so
verify it matches what you intended before relying on the workflow.
A typo'd name resolves to a different but valid Continue subscription
(if one exists with that name) — that's the case the executionHint
catches.

## Replaying workflows

n8n's **Re-run from node** creates a fresh execution, which opens a
**new** Humangent request. The original request (if still open)
becomes orphaned — it remains visible in the Humangent admin UI but
its resume URLs point at a cancelled execution and will never re-fire
the workflow. Close orphans manually from the admin UI.

This applies in **both** modes — Create and Wait and Create. In Create
mode, replays mint a fresh idempotency key; both the original and the
replay deliver to the destination Continue if both reviewers act.

## Security

Decision deliveries from Humangent are HMAC-SHA256 signed with your
**Humangent API Key**. The node verifies every delivery before routing
onto a branch; invalid signatures cause the execution to stay waiting
and Humangent's outbox to retry.

Rotate keys at any time from `/admin/api-keys` — issue a new one,
update the credential, revoke the old.

## Troubleshooting

| Symptom                                                             | Likely cause                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow stuck for exactly `EXECUTIONS_TIMEOUT_MAX` seconds         | Timeout cap lower than your Limit Wait Time. Raise the env var + restart n8n, or switch to **Create** mode + a Continue node.                                                 |
| "API key is missing, invalid, or revoked"                           | Credential field typo, or key revoked. Re-issue at `/admin/api-keys`.                                                                                                         |
| "Task type not found"                                               | Task type was archived or deleted. Re-pick from the dropdown.                                                                                                                 |
| "This workflow has not captured the task type's outcomes…"          | Workflow saved before `0.0.1-alpha.10`. Open the node, re-pick the task type.                                                                                                 |
| "Field validation failed: required field \`<id>\`"                  | Upstream data is missing a required field. Check the field mapping.                                                                                                           |
| Decision arrives on `Dismissed` with `drift_detected: true`         | Reviewer picked a live outcome the snapshot doesn't know. Re-pick to refresh.                                                                                                 |
| Continue workflow refuses to activate with `n8n_origin_not_allowed` | Org admin must add this n8n instance's origin to **Workspace Settings → n8n Allowed Origins**.                                                                                |
| Continue activation fails with `n8n_allowed_origins_unset`          | The org's allowlist is empty. Org admin bootstraps via Workspace Settings before any Continue can register.                                                                   |
| `subscription_not_found:<workflow>:<node>` from a Create node       | The destination Continue isn't registered. Activate the destination workflow first, then re-run the Create.                                                                   |
| `subscription_owner_mismatch` on Continue activation                | Another credential already registered a subscription with the same `(workflow_id, node_id, n8n_instance_id)` tuple. Use the original credential or have an org admin re-bind. |
| `subscription_in_use:<count>` when deactivating a Continue          | Open detached requests still reference this subscription. Wait for them to decide / time out / fail, or use the admin re-drive path.                                          |
| Detached delivery fails with `signing_key_revoked`                  | The API key bound to the request was revoked. Issue a new credential and use `admin_redrive_request_delivery` to re-deliver.                                                  |

## Long-running requests

Humangent makes no SLO commitment on how long a request stays open. Reviewer
chains can extend a request from minutes to weeks (especially when multi-
level approval kicks back to a prior level for revision).

**Always drive workflow resumption from the webhook callback, not from
a Wait node with a deadline timeout.** Set up your Humangent node to send
the request, then wait for the decision-delivery webhook to fire — the
webhook arrives whenever the decision is final, regardless of how many
hours/days/weeks elapsed.

If you need a hard time bound, configure auto-approve mode on the task
type (Humangent will finalize the request automatically after the
configured timeout) — don't try to enforce it via n8n's Wait node.

## Example workflow

Short review:

1. Trigger node receives the business event.
2. Humangent node uses **Create and Wait**.
3. Pick a Task Type and map fields from the trigger payload.
4. Connect each outcome branch to the matching downstream action.
5. Connect **Dismissed** and **Timed Out** to explicit handling paths.

Long review:

1. Destination workflow starts with **Humangent Continue** and is
   activated after selecting the same Task Type.
2. Source workflow uses Humangent **Create** mode.
3. Source **Continuation Workflow** points at the destination workflow.
4. Source **Continue Node Name** matches the destination Continue node.
5. Source workflow continues immediately; the destination workflow runs
   when Humangent delivers the decision.

## Chain audit (multi-level approval)

When a request goes through a multi-level approval chain, the decision-
delivery webhook payload includes:

- `decided_via`: `"human"` for reviewer decisions, `"auto_approve"` for
  timer-fired decisions on auto-approve task types.
- `chain`: array of one entry per chain action (approval at each level,
  any kick-back declines, escalation broadens, and the auto-approve fire
  when applicable). Entries are ordered by timestamp (oldest first).

Each `chain[]` entry has:

- `level`: integer (1 = entry-level reviewer, 2..N = subsequent approvers).
- `activation_index`: integer (1 = first time this level was activated;
  > 1 = re-activations after a kick-back).
- `decision`: one of `approve`, `decline`, `auto_approve`, `escalate`,
  `stall`.
- `comment`: optional string (set on `decline` entries).
- `at`: ISO-8601 timestamp of when the entry was added.
- `outcome_id`: optional string (set on level-1 `approve` and on
  `auto_approve` entries — identifies which configured outcome was
  selected).
- `target_active`: optional boolean (set on `escalate` entries —
  indicates whether the broadened target was an active org member at
  the time the timer fired).
- `reason`: optional string (set on `stall` entries — explains why
  the request stalled, e.g., `direct_assignee_disabled`).

**Note: actor identity is not exposed in the chain audit.** The reviewer
who approved/declined at each level is recorded internally (and visible
in the Humangent UI), but the webhook payload omits actor profile IDs to
keep the n8n contract free of internal identifiers. Use the Humangent web
UI to see who decided what.

Requires n8n-nodes-humangent v0.0.1-alpha.22 or later.

## Local development

```bash
npm install
npm run type-check
npm test
npm run build
npm run lint
npm run pack:smoke
```

The runtime package has no external dependencies. Dev dependencies are
used only for TypeScript, linting, tests, and packaging checks.

## Release process

Releases are published from GitHub Actions using npm Trusted Publisher
and provenance. Local-machine npm publishing is not verification-ready.

Required GitHub Actions secrets: none for npm when Trusted Publisher is
configured. Do not add production URLs, API keys, Supabase project refs,
callback URLs, or private preview URLs to committed workflows.

One-time npm setup:

1. Create the public GitHub repository.
2. In npm package settings, add a Trusted Publisher for this repository.
3. Use workflow filename `publish.yml`.
4. Push a tag that matches `package.json`, for example `v0.0.1-alpha.27`.

The release workflow runs lint, type-check, tests, build, pack smoke,
`npm publish --provenance --tag latest`, and then the n8n scanner against
the exact published version. Every publish updates npm's `latest` tag.

## n8n verification

Before submitting, publish the package from GitHub Actions with
provenance and confirm:

```bash
npx @n8n/scan-community-package @humangent/n8n-nodes-humangent
npm view @humangent/n8n-nodes-humangent repository license keywords --json
```

The scanner analyzes the package currently available from npm, not the
local checkout. For an unpublished change, rely on local gates first,
then run the scanner after the GitHub Actions publish completes.

Then submit the package in the n8n Creator Portal. Include this public
repository, the npm package, installation instructions, credential setup,
usage examples, and the release workflow provenance.

## Support

Docs and contact: [humangent.io](https://humangent.io).
