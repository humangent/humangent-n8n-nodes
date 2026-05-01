// Shim that binds n8n's request helpers into our api module's
// HttpRequester shape. Isolated in one file so the loose
// `as unknown` cast lives at exactly one boundary — every other
// consumer of HttpRequester (lib/api.ts, unit tests) speaks our
// narrower, n8n-independent type.

import type {
  IExecuteFunctions,
  IHookFunctions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
} from "n8n-workflow";

import type { HttpRequester } from "../../lib/api";

type N8nContext =
  | IExecuteFunctions
  | IHookFunctions
  | ILoadOptionsFunctions
  | IWebhookFunctions;

export function requesterFor(ctx: N8nContext): HttpRequester {
  return {
    async request(opts) {
      // n8n's IHttpRequestOptions is a superset of our narrower
      // HttpRequestOptions; the cast is localized to this one
      // boundary. We only depend on method/url/headers/body/json/
      // timeout, which every n8n minor version has carried.
      const helpers = ctx.helpers as unknown as {
        httpRequest: (o: unknown) => Promise<unknown>;
      };
      return helpers.httpRequest(opts);
    },
  };
}
