import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getTicketsDir, readReviewEvidenceFile, parseReviewEvidenceJson, observeReadonlyRepositoryTicketSlot, LOCAL_GIT_CONTROL_FLAGS, JsonWorkflowError, type WorkflowState, type ReviewBundle } from "@pa-platform/pa-core";

/** Existing protected owner, observation only. Stale/malformed custody stays
 * unknown; no slot is acquired, released, repaired or implicitly reclaimed. */
function assertNoRegisteredWriter(state: WorkflowState): void {
  try { observeReadonlyRepositoryTicketSlot(state.subject.repository.root, state.subject.ticket); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "document-custody-unknown", "custody-owner");
  }
  throw new JsonWorkflowError("WORKFLOW_CONFLICT", "document-live-writer", "custody-owner");
}
/** A materialized but inert branch is not execution custody. Only fresh-to-fresh
 * additionally needs the exact planned/absent ticket tuple AND an absent ref. */
export function assertPiDocumentContinuation(state: WorkflowState, subject: ReviewBundle, requireUnmaterialized: boolean): void {
  assertNoRegisteredWriter(state);
  if (!requireUnmaterialized) return;
  try {
    const ticket = parseReviewEvidenceJson(readReviewEvidenceFile(join(getTicketsDir(), `${subject.ticket}.json`), 1_048_576, "workflow.ticket"), "workflow.ticket") as Record<string, unknown>;
    if (ticket.id !== subject.ticket || ticket.project !== subject.repository.key || !Array.isArray(ticket.linkedBranches)) throw Error("unproven tuple");
    if (ticket.linkedBranches.some((link: { repo?: string; branch?: string; state?: string; baseSha?: string; headSha?: string; sha?: string }) => !link || link.repo !== subject.repository.key || link.branch !== subject.handoff.branch || link.state !== "planned" || link.baseSha || link.headSha || link.sha)
      || ticket.linkedBranches.length > 1) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "document-branch-materialized-or-uncertain", "tickets");
  } catch (error) {
    if (error instanceof JsonWorkflowError) throw error;
    throw new JsonWorkflowError("WORKFLOW_SOURCE", "document-ticket-tuple", "tickets");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["--no-optional-locks", ...LOCAL_GIT_CONTROL_FLAGS, "show-ref", "--verify", "--quiet", `refs/heads/${subject.handoff.branch}`], {
    cwd: subject.repository.root, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeout: 15_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "document-branch-inspection", "repository-owner");
  if (result.status === 0) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "document-branch-materialized-or-uncertain", "tickets");
}
export function piDocumentContinuationView(state: WorkflowState): Record<string, unknown> {
  try {
    assertPiDocumentContinuation(state, state.subject, false);
    let freshToFresh: Record<string, unknown> = { status: "not-applicable" };
    if (state.subject.handoff.type === "fresh") {
      try { assertPiDocumentContinuation(state, state.subject, true); freshToFresh = { status: "unmaterialized-observed" }; }
      catch (error) { const e = error instanceof JsonWorkflowError ? error : new JsonWorkflowError("WORKFLOW_SOURCE", "document-ticket-tuple", "tickets"); freshToFresh = { status: "blocked", code: e.code, gateId: e.gateId, correctionOwner: e.correctionOwner }; }
    }
    return { status: "no-registered-writer-observed", freshToFresh, effectsAdmitted: false, nextAction: "Observation only; the native owner rechecks custody and tuple at revision CAS. An inert materialized branch requires amendment/reuse, not fresh creation. No custody is acquired." };
  } catch (error) {
    const e = error instanceof JsonWorkflowError ? error : new JsonWorkflowError("WORKFLOW_UNCERTAIN", "document-custody-unknown", "custody-owner");
    return { status: "blocked", code: e.code, gateId: e.gateId, correctionOwner: e.correctionOwner, effectsAdmitted: false, nextAction: "Existing custody owner must reconcile live/unknown writer evidence; unrelated reads remain available. Do not steal or release resources." };
  }
}
