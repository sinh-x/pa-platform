import { JsonWorkflowError, reject, type ReviewBundle, type StepOutcome } from "./contracts.js";
import type { WorkflowState } from "./service.js";

/** Derived exclusively from immutable run events, never a writable attempt ledger. */
export interface WorkflowAttempt {
  attemptId: string; predecessor: string | null; subjectRef: string; subjectSha256: string;
  revision: number; reason: "initial" | "changes-requested" | "material-amendment" | "document-revision";
  outcomes: Record<string, StepOutcome>;
}
/** Structural only: native custody/materialization proof remains a separate owner boundary. */
export function documentRevisionEligibility(state: WorkflowState) {
  const latest = state.decisions.filter(d => d.subjectSha256 === state.subjectSha256).at(-1);
  const execution = state.definition.steps.some(step => step.effects.some(effect => ["source.scoped", "check.scoped", "git.local"].includes(effect)) && state.outcomes[step.id] !== undefined);
  const gateId = !state.resources ? "retained-resource-closure" : state.pending.length ? "pending-effect-reconciliation" : state.coordinatorQueueOnly ? "adopted-queue-intent-only"
    : state.attempts.length >= 256 ? "subject-attempt-bound" : !latest || !["approved", "changes-requested"].includes(latest.outcome) ? "revision-decision-required" : null;
  return { structurallyAvailable: gateId === null, gateId, correctionOwner: state.pending[0]?.owner ?? (gateId === "revision-decision-required" ? "operator" : "workflow-owner"),
    freshToFresh: gateId === null && state.subject.handoff.type === "fresh" && !execution && (latest?.outcome === "changes-requested" || !state.revoked.includes(latest!.decisionId)), freshToFreshRequiresUnmaterializedProof: true,
    nextAction: state.pending.length ? "Reconcile the SAME retained intent through its existing owner; do not delete, replay or abandon it to revise documents."
      : "Use an authenticated coordinator or explicit document adoption; submit a consecutive immutable producer revision. Fresh-to-fresh additionally requires native proof of no materialization. New exact approval is required before publication; this projection admits no effect." };
}
/** A revision changes the review subject, never lineage, pins or execution counters.
 * New subjects need their own decisions. Existing revision event semantics remain replayable. */
export function subjectRevisionReason(state: WorkflowState, next: ReviewBundle): "changes-requested" | "material-amendment" | "document-revision" {
  const old = state.subject;
  if (state.pending.length) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "pending-effect-reconciliation", state.pending[0]!.owner);
  if (state.attempts.length >= 256) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "subject-attempt-bound", "workflow-owner");
  if (next.revision !== old.revision + 1 || state.attempts.some(a => a.subjectRef === next.subjectId)
    || next.repository.key !== old.repository.key || next.repository.root !== old.repository.root || next.ticket !== old.ticket
    || next.route.team !== old.route.team || next.route.mode !== old.route.mode || next.handoff.baseSha !== old.handoff.baseSha || next.handoff.branch !== old.handoff.branch
    || next.workflow.id !== old.workflow.id || next.workflow.version !== old.workflow.version || next.workflow.sha256 !== old.workflow.sha256) reject("WORKFLOW_AUTHORITY");
  const decisions = state.decisions.filter(d => d.subjectSha256 === state.subjectSha256);
  if (decisions.at(-1)?.outcome === "changes-requested") {
    // An amendment can never become fresh creation; an unapproved fresh plan
    // may remain fresh or explicitly become an amendment of materialized work.
    if (old.handoff.type === "amendment" && next.handoff.type !== "amendment") reject("WORKFLOW_AUTHORITY");
    return "changes-requested";
  }
  if (decisions.at(-1)?.outcome === "approved") {
    if (next.handoff.type === "amendment") return "material-amendment";
    if (old.handoff.type === "fresh" && documentRevisionEligibility(state).freshToFresh) return "document-revision";
  }
  return reject("WORKFLOW_AUTHORITY");
}
