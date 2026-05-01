// Public surface of the n8n-nodes-humangent package.
//
// n8n's loader reads the compiled node + credential paths from the
// package.json `n8n` block, not from this module — but we still ship
// a stable `main` so programmatic consumers can `require()` the
// package's Zod schemas and HMAC helper for integration testing.

export { HumangentApi } from "./credentials/HumangentApi.credentials";

// Re-export the Continue node so n8n's loader (which reads
// `package.json#n8n.nodes`) and any programmatic consumer share a
// single import surface.
export { HumangentContinue } from "./nodes/HumangentContinue/HumangentContinue.node";

export {
  DecisionDeliverySchema,
  FieldDefSchema,
  OutcomeSchema,
  RequestRowSchema,
  TaskTypeListSchema,
  TaskTypeRowSchema,
  type DecisionDelivery,
  type FieldDef,
  type Outcome,
  type RequestRow,
  type TaskTypeList,
  type TaskTypeRow,
} from "./lib/schemas";

export {
  verifySignature,
  type VerifyFailureReason,
  type VerifyResult,
  type VerifySignatureOptions,
} from "./lib/hmac";
