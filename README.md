# @humangent/n8n-nodes-humangent

Official n8n community node for [Humangent](https://humangent.io), a
human-in-the-loop inbox for n8n workflows.

## Install

Minimum supported n8n version: **1.70**.

### n8n Cloud

After n8n verifies the node, an instance owner or admin can install it
from the workflow canvas:

1. Open the nodes panel with **+** or **N**.
2. Search for **Humangent**.
3. Select the Humangent community node from the community results.
4. Select **Install**.

If verified community nodes are not visible, the instance owner can
enable them in the Cloud Admin Panel.

### Self-hosted n8n

Install from the n8n community nodes settings:

```text
Settings -> Community Nodes -> Install -> @humangent/n8n-nodes-humangent
```

## Credentials

Create a **Humangent API** credential in n8n.

| Field | Value |
| --- | --- |
| Humangent API Key | `hmk_live_...` or `hmk_test_...` |

Create API keys in Humangent from `/admin/api-keys`. The key is shown
once when you create it, so copy it before closing the modal.

Use an `hmk_test_*` key while testing workflows and an `hmk_live_*` key
for production workflows. Click **Test** in the credential dialog to
verify the key.

## Humangent Node

Use the **Humangent** node when a workflow should create a Humangent
request.

### Mode

| Mode | Use when |
| --- | --- |
| Create and Wait | The same workflow should pause until the reviewer decides. |
| Create | The source workflow should continue immediately and a separate workflow should receive the decision with a **Humangent Continue** node. |

### Task Type

Pick the Humangent task type from the searchable list. The selected task
type controls the fields shown in **Fields** and the output branches
available on the canvas.

If the task type changes in Humangent, re-open the dropdown and pick the
task type again to refresh the node configuration.

### Fields

Map n8n data into the fields required by the selected task type. Matching
incoming field names can be auto-mapped, and each value can also use an
n8n expression.

### Continuation Workflow

Visible in **Create** mode.

Pick the workflow that starts with the **Humangent Continue** node that
should receive the decision. Activate the destination workflow before
running the source workflow.

### Continue Node Name

Visible in **Create** mode.

Enter the name of the destination **Humangent Continue** node exactly as
it appears on the destination workflow canvas.

### Limit Wait Time

Set how long the request may stay open before it routes to the **Timed
Out** branch. Choose the number in **Limit Wait Time** and the unit in
**Wait Time Unit**.

For long-running reviews, use **Create** mode with a **Humangent
Continue** node.

### Parent Request ID (Continuation)

Optional. Use this when one Humangent request is a continuation of an
earlier request. Pass the previous Humangent node's `requestId`, usually
with an expression.

## Humangent Continue Node

Use **Humangent Continue** as the first node in a destination workflow
when the source **Humangent** node uses **Create** mode.

### Task Type

Pick the same task type used by the source **Humangent** node. The
Continue node uses this task type to show the same decision branches on
the canvas.

Save and activate the destination workflow after selecting the task type.

## Output Branches

The node creates one branch for each outcome on the selected task type,
plus:

| Branch | When it runs |
| --- | --- |
| Dismissed | The reviewer dismissed the request or the decision no longer matches the configured outcomes. |
| Timed Out | The configured wait time expired before a decision arrived. |

Use each branch to connect the next workflow step for that decision.

## Example Configuration

Short review in one workflow:

1. Add the **Humangent** node after your trigger.
2. Set **Mode** to **Create and Wait**.
3. Pick a **Task Type**.
4. Map the required **Fields**.
5. Connect each outcome branch to the next workflow step.

Long review with a separate destination workflow:

1. Create and activate a destination workflow starting with
   **Humangent Continue**.
2. Pick the same **Task Type** on the Continue node.
3. In the source workflow, set the **Humangent** node **Mode** to
   **Create**.
4. Pick the **Continuation Workflow**.
5. Enter the destination **Continue Node Name**.
6. Map the required **Fields** and run the source workflow.

## Humangent Tool Call Review (AI Agent HITL)

> Tested with **n8n 2.18.5**. Requires an n8n version that ships the
> AI Agent HITL feature.

Use **Humangent Tool Call Review** when you want a reviewer to
approve or deny each downstream tool call an AI Agent proposes,
such as Gmail, CRM writes, or HTTP requests, instead of
gating the whole workflow at the front. The node registers as an
n8n-native HITL tool for the AI Agent: the agent sees the original
downstream tool's schema, the reviewer sees what's about to happen,
and only approval permits the gated tool to run.

### Builder setup

Canonical wiring on the canvas:

```text
AI Agent -- Tool --> Humangent Tool Call Review -- Tool --> Gmail / CRM / HTTP
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
   and create on demand the system task type for the org. There is
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

Connect each sensitive tool **only** through Humangent Tool Call
Review. A direct AI-Agent to Gmail link bypasses Humangent.

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
sensitive tool only on the approve branch.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Credential test fails | Confirm the API key was copied correctly and has not been revoked. |
| Task type does not appear | Confirm the API key belongs to the Humangent workspace that owns the task type. |
| Required field error | Check the **Fields** mapping for missing values. |
| Decision routes to Dismissed unexpectedly | Re-pick the task type to refresh the configured outcomes. |
| Create mode cannot find the Continue node | Activate the destination workflow and confirm **Continue Node Name** matches the node name on the canvas. |
| Continue workflow activation fails with an origin error | Add the n8n instance origin in Humangent under **Workspace Settings -> n8n Allowed Origins**. |

## Support

Docs and contact: [humangent.io](https://humangent.io).
