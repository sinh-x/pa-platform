import { join } from "node:path";
import { getAiUsageDir } from "../paths.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { digest, reject, type PackagePermission, type ReviewBundle } from "./contracts.js";
import { replayWorkflow, requireDecision, type WorkflowState } from "./service.js";
import { readWorkflowEvidence } from "./evidence.js";

export interface StructuredTaskBaseline {
  readonly schemaVersion: "structured-task-baseline/v1";
  readonly repoKey: string; readonly repoRoot: string; readonly ticket: string; readonly branch: string; readonly baseSha: string;
  readonly requirements: { readonly ref: string; readonly sha256: string };
  readonly handoff: Readonly<ReviewBundle["handoff"]>;
  readonly authority: { readonly runId: string; readonly decisionId: string; readonly subjectSha256: string };
}
export interface StructuredConsumerContext {
  readonly repoKey: string; readonly repoRoot: string; readonly ticket: string; readonly branch: string;
  readonly team: string; readonly mode: string; readonly primaryRequirementsRef: string;
}
/** Structured-route only. Missing/corrupt/revoked authority is a hard denial, never a call to a legacy prose reader. */
export function authorizeStructuredConsumer(journal: RegistryWorkflowJournal, runId: string, decisionId: string, context: StructuredConsumerContext, permissions: readonly PackagePermission[], read: (ref: string) => Uint8Array = readCanonicalWorkflowArtifact): WorkflowState {
  const state = replayWorkflow(journal, runId); const subject = state.subject;
  requireDecision(state, decisionId, permissions);
  if (subject.repository.key !== context.repoKey || subject.repository.root !== context.repoRoot || subject.ticket !== context.ticket
    || subject.handoff.branch !== context.branch || subject.route.team !== context.team || subject.route.mode !== context.mode
    || subject.requirements.ref !== context.primaryRequirementsRef) reject("WORKFLOW_AUTHORITY");
  readWorkflowEvidence(subject, ref => read(ref.ref));
  return state;
}
export function structuredTaskBaseline(journal: RegistryWorkflowJournal, runId: string, decisionId: string, context: StructuredConsumerContext, read?: (ref: string) => Uint8Array): StructuredTaskBaseline {
  const state = authorizeStructuredConsumer(journal, runId, decisionId, context, ["source.edit-scoped", "check.execute-scoped", "repair.same-scope", "git.commit-local"], read);

  return Object.freeze({ schemaVersion: "structured-task-baseline/v1", repoKey: context.repoKey, repoRoot: context.repoRoot, ticket: context.ticket, branch: context.branch,
    baseSha: state.subject.handoff.baseSha, handoff: Object.freeze({ ...state.subject.handoff }), requirements: Object.freeze({ ref: state.subject.requirements.ref, sha256: state.subject.requirements.sha256 }),
    authority: Object.freeze({ runId, decisionId, subjectSha256: state.subjectSha256 }) });
}
export function readCanonicalWorkflowArtifact(ref: string): Uint8Array {
  if (!/^(requirements|uat):agent-teams\/requirements\/artifacts\/[A-Za-z0-9_./-]+\.md$/.test(ref)) reject("WORKFLOW_SOURCE");
  const relative = ref.slice(ref.indexOf(":") + 1);
  if (relative.split("/").some(p => !p || p === "." || p === "..")) reject("WORKFLOW_SOURCE");
  return readReviewEvidenceFile(join(getAiUsageDir(), relative), 1_048_576, "workflow.canonical-artifact");
}
