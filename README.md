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
task type — that re-captures the snapshot.

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
it from the dropdown. If the task-type author adds or renames outcomes
upstream, the canvas keeps rendering the snapshot — so a reviewer can
pick a live outcome the snapshot doesn't know about. When that
happens, the node routes the decision onto **Dismissed** with two
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

To refresh the canvas to match the live outcomes, re-open the
task-type dropdown and re-pick the task type.

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
   (e.g., `https://n8n.acme.com`).
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

The source emits a single Main output of
`{ requestId, requestUrl, expectedTimeoutAt }` and continues
immediately. The destination Continue's per-outcome / Dismissed /
Timed Out branches fire the same payload shape inline `Create and
Wait` emits — see **Output branches** above.

## Security

Decision deliveries from Humangent are HMAC-SHA256 signed with your
**Humangent API Key**. The node verifies every delivery before routing
onto a branch; invalid signatures cause the execution to stay waiting
and Humangent's outbox to retry.

Rotate keys at any time from `/admin/api-keys` — issue a new one,
update the credential, revoke the old.

## Long-running requests

Humangent makes no SLO commitment on how long a request stays open.
Reviewer chains can extend a request from minutes to weeks (especially
when multi-level approval kicks back to a prior level for revision).

**Always drive workflow resumption from the webhook callback, not from
a Wait node with a deadline timeout.** Set up your Humangent node to
send the request, then wait for the decision-delivery webhook to fire
— the webhook arrives whenever the decision is final, regardless of
how many hours/days/weeks elapsed.

If you need a hard time bound, configure auto-approve mode on the
task type (Humangent will finalize the request automatically after the
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

## Troubleshooting

| Symptom                                                             | Likely cause                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workflow stuck for exactly `EXECUTIONS_TIMEOUT_MAX` seconds         | Timeout cap lower than your Limit Wait Time. Raise the env var + restart n8n, or switch to **Create** mode + a Continue node. |
| "API key is missing, invalid, or revoked"                           | Credential field typo, or key revoked. Re-issue at `/admin/api-keys`.                                                         |
| "Task type not found"                                               | Task type was archived or deleted. Re-pick from the dropdown.                                                                 |
| "Field validation failed: required field \`<id>\`"                  | Upstream data is missing a required field. Check the field mapping.                                                           |
| Decision arrives on `Dismissed` with `drift_detected: true`         | Reviewer picked a live outcome the snapshot doesn't know. Re-pick to refresh.                                                 |
| Continue workflow refuses to activate with `n8n_origin_not_allowed` | Org admin must add this n8n instance's origin to **Workspace Settings → n8n Allowed Origins**.                                |
| `subscription_not_found:<workflow>:<node>` from a Create node       | The destination Continue isn't registered. Activate the destination workflow first, then re-run the Create.                   |

## Support

Docs and contact: [humangent.io](https://humangent.io).
