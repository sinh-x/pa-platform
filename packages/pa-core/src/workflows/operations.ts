import type { Effect, PackagePermission, StepKind } from "./contracts.js";

/** Vocabulary only. These declarations never register an executable owner or grant a capability. */
export interface OperationContract {
  readonly id: string; readonly version: "v1"; readonly kind: StepKind; readonly owner: string;
  readonly capability: string; readonly effects: readonly Effect[]; readonly permissions: readonly PackagePermission[];
  readonly inputSchemas: readonly string[]; readonly outputSchema: string; readonly verifier: string;
}
export const OPERATIONS: readonly OperationContract[] = Object.freeze([
  { id: "decision.package", version: "v1", kind: "decision", owner: "operator", capability: "operator.foreground", effects: ["operator.capture"], permissions: [], inputSchemas: ["pa-review-bundle/v1"], outputSchema: "pa-decision/v1", verifier: "decision.issued" },
  { id: "publication.pair", version: "v1", kind: "publication", owner: "tickets", capability: "artifact.paired-publication", effects: ["artifact.write-pair"], permissions: ["artifact.publish-pair"], inputSchemas: ["pa-review-bundle/v1", "pa-decision/v1"], outputSchema: "pa-publication-pair/v1", verifier: "publication.exact-pair" },
  { id: "ticket.queue", version: "v1", kind: "action", owner: "tickets", capability: "ticket.queue", effects: ["ticket.queue"], permissions: ["ticket.queue.advance"], inputSchemas: ["pa-publication-pair/v1", "pa-decision/v1"], outputSchema: "pa-ticket-queue-result/v1", verifier: "ticket.queue-observed" },
  { id: "source.local", version: "v1", kind: "action", owner: "execution", capability: "execution.scoped-local", effects: ["source.scoped", "git.local"], permissions: ["source.edit-scoped", "repair.same-scope", "git.commit-local"], inputSchemas: ["pa-review-bundle/v1", "pa-decision/v1"], outputSchema: "pa-execution-result/v1", verifier: "execution.native" },
  { id: "check.matrix", version: "v1", kind: "check", owner: "validation", capability: "validation.matrix", effects: ["check.scoped"], permissions: ["check.execute-scoped"], inputSchemas: ["pa-review-bundle/v1", "pa-decision/v1"], outputSchema: "pa-validation-result/v1", verifier: "validation.native" },
]);
export function operationContract(id: string, version: string): OperationContract | undefined {
  return OPERATIONS.find(operation => operation.id === id && operation.version === version);
}
/** Supported context is closed, with exact schemas; no JSONPath, scripts or arbitrary caller fields. */
export const CONTEXT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  "repository.key": "pa-string/v1", ticket: "pa-string/v1", "route.team": "pa-string/v1", "route.mode": "pa-string/v1",
  "handoff.type": "pa-string/v1", runtime: "pa-string/v1", bundle: "pa-review-bundle/v1",
});
export const PREDICATE_FIELDS = Object.freeze(Object.keys(CONTEXT_FIELDS).filter(field => field !== "bundle"));
