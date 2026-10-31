import { parseReviewMatrixPlan, type ReviewMatrixArtifact } from "../validation/review-contract.js";
import { adoptedWorkflow, withExistingWorkflowJournal } from "./catalog.js";
import { readCanonicalWorkflowArtifact } from "./consumers.js";
import { readWorkflowEvidence } from "./evidence.js";
import { reject } from "./contracts.js";
import { requireDecision, type WorkflowState } from "./service.js";

export function workflowDecisionReference(state: WorkflowState, decisionId: string): string {
  requireDecision(state, decisionId, []);
  return `workflow-decision:${state.runId}:${decisionId}:${state.subjectSha256}`;
}
/** New-route review authority. A missing/revoked/foreign locator never falls back to Markdown or comment text.
 * The review/candidate/one-use/readiness owners still perform all their normal independent checks. */
export function structuredReviewArtifact(repoKey: string, ticket: string, source: string, approval: string): ReviewMatrixArtifact | null {
  return withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticket) : null;
    if (!state) { if (approval.startsWith("workflow-decision:")) reject("WORKFLOW_AUTHORITY"); return null; }
    const match = /^workflow-decision:([a-z][a-z0-9.-]{0,127}):([a-z][a-z0-9.-]{0,127}):([a-f0-9]{64})$/.exec(approval);
    if (!match || match[1] !== state.runId || match[3] !== state.subjectSha256 || source !== state.subject.requirements.ref) reject("WORKFLOW_AUTHORITY");
    requireDecision(state, match[2]!, ["check.execute-scoped"]);
    readWorkflowEvidence(state.subject, ref => readCanonicalWorkflowArtifact(ref.ref));
    const plan = parseReviewMatrixPlan(readCanonicalWorkflowArtifact(source), source), s = state.subject;
    return { source, authorityBytes: plan.authorityBytes, digest: plan.digest, matrix: plan.matrix,
      header: { ticket, repositoryKey: s.repository.key, repositoryRoot: s.repository.root, approvedBaseSha: s.handoff.baseSha,
        featureBranch: s.handoff.branch, matrixAuthoritySha256: plan.digest, matrixApprovalEvidence: approval } };
  });
}
