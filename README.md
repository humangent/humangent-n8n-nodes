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
