// Humangent API credential class.
//
// User-facing field:
//   * apiKey — hmk_(live|test)_... per-org Humangent key. Authenticates
//              outbound calls AND doubles as the HMAC secret for
//              inbound decision deliveries. The Humangent backend
//              signs deliveries using the API key plaintext; this
//              node verifies using the same value.
//
// Auto-minted hidden field:
//   * instanceId — a per-credential UUID generated on first save via
//                  the `preAuthentication` hook. The detached-mode
//                  Continue node stamps this onto subscription rows
//                  as `n8n_instance_id` so a workflow shared across
//                  dev + prod n8n instances using the same workflow
//                  JSON registers as two distinct subscriptions.
//                  Auto-minted (not user-input) so builders can't
//                  accidentally collide instances. The same value
//                  flows into Create-mode requests' decision_callback
//                  block, so the backend resolves the destination
//                  Continue from the (workflow_id, node_id,
//                  n8n_instance_id) tuple consistently across both
//                  ends of the handoff.
//
// Humangent's public production API URL is baked into the credential source.
// Users configure only their per-workspace API key.
//
// The credential `test` hits api_list_task_types({p_limit:1}). Any
// 2xx is a valid credential — a fresh org with zero task types
// returns {items:[], next_cursor:null}.

import { randomUUID } from "node:crypto";

import type {
  IAuthenticateGeneric,
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IDataObject,
  IHttpRequestHelper,
  INodeProperties,
} from "n8n-workflow";

import { HUMANGENT_API_URL } from "../lib/constants";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HumangentApi implements ICredentialType {
  name = "humangentApi";

  displayName = "Humangent API";

  documentationUrl = "https://humangent.io/docs/n8n-node";

  properties: INodeProperties[] = [
    {
      displayName: "Humangent API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      placeholder: "hmk_live_... or hmk_test_...",
      description:
        "Issued at /admin/api-keys. Authenticates outbound calls and verifies inbound decision webhooks. Use an `hmk_test_*` key for Test step runs.",
    },
    // Auto-minted UUID. Persisted by n8n after the first
    // preAuthentication run. Treated as opaque by the Humangent
    // backend — the only requirement is stability per credential.
    //
    // **Why type: "string" and not type: "hidden"?** alpha.21 declared
    // this as `type: "hidden"`. n8n's credential schema generator
    // strips hidden-typed properties before serializing the JSON
    // Schema for the public REST API; that schema also has
    // `additionalProperties: false`, so any partial credential
    // update returning `{ instanceId }` was silently filtered out
    // before persistence. The mint ran in-flight (the credential
    // test succeeded, the request used the minted UUID for that
    // single call) but the UUID never landed on disk — every
    // subsequent activation re-loaded the credential without
    // `instanceId` and the safety guard in continueRegistration.ts
    // refused to register the subscription.
    //
    // Promoting to `type: "string"` puts the field in the schema and
    // closes the loop. `typeOptions.password: true` masks the value
    // in the credential dialog so it doesn't add visual noise.
    // Compare: n8n core's OAuth2 credentials store `oauthTokenData`
    // as `type: "json"` for the same reason — auto-managed fields
    // need a non-hidden schema-visible type to survive persistence.
    {
      displayName: "n8n Instance ID",
      name: "instanceId",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: false,
      description:
        "Auto-managed. Do not edit. Populated by the credential's preAuthentication hook on first authenticated request and used by the Humangent Continue node to disambiguate n8n instances that share the same workflow JSON across dev / prod.",
    },
  ];

  // n8n calls preAuthentication before each authenticated request and
  // persists any returned partial credential update. Mint a fresh
  // UUID once (when missing or shape-invalid) so every Continue
  // registration carries a stable instance identifier without forcing
  // the builder to type one. We deliberately do NOT regenerate on
  // every call — only when the field is empty or fails the UUID
  // shape check, which keeps the value stable across credential
  // edits and across dev / prod n8n instances using the same
  // credential record.
  async preAuthentication(
    this: IHttpRequestHelper,
    credentials: ICredentialDataDecryptedObject,
  ): Promise<IDataObject> {
    const current = credentials.instanceId;
    if (typeof current === "string" && UUID_RE.test(current)) {
      return {};
    }
    return { instanceId: randomUUID() };
  }

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        "X-Humangent-API-Key": "={{$credentials.apiKey}}",
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      method: "POST",
      baseURL: `${HUMANGENT_API_URL}/rest/v1`,
      url: "/rpc/api_list_task_types",
      body: { p_limit: 1 },
      headers: { "Content-Type": "application/json" },
    },
  };
}
