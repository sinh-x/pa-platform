import { reject, type ReviewBundle, type StepOutcome } from "./contracts.js";
import type { WorkflowState } from "./service.js";

/** Derived exclusively from immutable run events, never a writable attempt ledger. */
export interface WorkflowAttempt {
  attemptId: string; predecessor: string | null; subjectRef: string; subjectSha256: string;
  revision: number; reason: "initial" | "changes-requested" | "material-amendment";
  outcomes: Record<string, StepOutcome>;
}
/** A revision changes the review subject, never repository lineage, pinned
 * workflow semantics or execution-owner counters. Every new subject needs its
 * own native decision; old decisions/results remain visible but grant nothing. */
export function subjectRevisionReason(state: WorkflowState, next: ReviewBundle): "changes-requested" | "material-amendment" {
  const old = state.subject;
  if (state.pending.length || state.attempts.length >= 256) reject("WORKFLOW_CONFLICT");
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
  if (decisions.at(-1)?.outcome === "approved" && next.handoff.type === "amendment") return "material-amendment";
  return reject("WORKFLOW_AUTHORITY");
}
