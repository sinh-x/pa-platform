import type { TemplateBinding } from "./schema.js";
const HANDOFF_BINDINGS: Record<string, TemplateBinding> = {
  ticket: { type: "ticket", required: true }, repositoryKey: { type: "repository", required: true }, repositoryRoot: { type: "root", required: true },
  handoffType: { type: "handoff", required: true }, branch: { type: "branch", required: true }, baseSha: { type: "sha", required: true },
};
/** Runtime-owned typed grammar, not template content. Config cannot downgrade a
 * source/hash/tuple field into free narrative or silently omit it. */
const AMENDMENT_BINDINGS: Record<string, TemplateBinding> = {
  featureSha: { type: "sha", required: true }, amendmentSource: { type: "matrix-source", required: true }, tupleApprovalEvidence: { type: "comment-ref", required: true },
  immediateRereadSha256: { type: "digest", required: true }, finalRereadSha256: { type: "digest", required: true },
};
export function workflowProducerBindings(id: string): Record<string, TemplateBinding> | undefined {
  if (!["pair-signoff", "handoff-fresh", "handoff-amendment"].includes(id)) return undefined;
  if (id !== "pair-signoff") return { ...HANDOFF_BINDINGS, ...(id === "handoff-amendment" ? AMENDMENT_BINDINGS : {}) };
  return { ...HANDOFF_BINDINGS, ...Object.fromEntries(Object.entries(AMENDMENT_BINDINGS).map(([key, value]) => [key, { ...value, required: false }])), reviewRevision: { type: "revision", required: true },
    requirementsSource: { type: "matrix-source", required: true }, requirementsPreviewPath: { type: "path", required: true }, requirementsPreviewSha256: { type: "digest", required: true },
    uatPreviewPath: { type: "path", required: true }, uatPreviewSha256: { type: "digest", required: true }, matrixSource: { type: "matrix-source", required: true }, matrixSha256: { type: "digest", required: true } };
}
