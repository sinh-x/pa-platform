import { join, resolve } from "node:path";
import { getTicketsDir } from "../paths.js";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { loadRepoEntry } from "../repos.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { adoptedWorkflow, withExistingWorkflowJournal } from "./catalog.js";
import { JsonWorkflowError, MAX_WORKFLOW_RECORD_BYTES, object, strictJson, parseWorkflowRequest, text, ID, type ReviewBundle } from "./contracts.js";
import { queryWorkflow } from "./queries.js";
import { unavailableWorkflowObservations, type WorkflowObservations } from "./preflight.js";
import { loadSelectedWorkflows, type WorkflowSelection } from "./selected.js";
import { eligibleSteps, projectWorkflowNext, type WorkflowState } from "./service.js";
import { readCanonicalWorkflowArtifact } from "./consumers.js";
import { readWorkflowEvidence } from "./evidence.js";

export interface WorkflowPrimerView { runId: string; workflowId: string; version: string; sha256: string; configRevision: string; nextOwner: string; nextAction: string }
export function workflowPrimerView(state: WorkflowState): WorkflowPrimerView {
  const pending = state.pending[0], id = pending?.stepId ?? eligibleSteps(state)[0], step = state.definition.steps.find(s => s.id === id);
  const revoked = step && step.kind !== "decision" && !state.decisions.some(d => d.outcome === "approved" && !state.revoked.includes(d.decisionId) && step.authorization.every(p => d.permissions.includes(p)));
  return { runId: state.runId, workflowId: state.definition.workflowId, version: state.definition.version, sha256: state.subject.workflow.sha256, configRevision: state.configRevision,
    nextOwner: revoked && !pending ? "operator" : step?.owner ?? "workflow-owner", nextAction: pending ? `reconcile retained intent ${pending.intentId}; do not repeat effects` : revoked ? "blocked by absent/revoked authority; preserve state and inspect the exact decision" : step ? `request structurally eligible step ${step.id} through its owner; live availability/admission remains unproven` : "inspect retained terminal/blocked state; no completion or approval is inferred" };
}
export interface WorkflowReadHost {
  selection?(): WorkflowSelection;
  state?(ticket: string): WorkflowState | null;
  observations?(subject?: ReviewBundle): WorkflowObservations;
  team?: string; mode?: string;
  operations?: ReadonlySet<string>;
}
export const workflowFailure = (error: unknown) => {
  const e = error instanceof JsonWorkflowError ? error : new JsonWorkflowError("WORKFLOW_SOURCE");
  return { schemaVersion: "pa-workflow-result/v1", ok: false, code: e.code, gateId: e.gateId, correctionOwner: e.correctionOwner, diagnostic: e.message, nextAction: "Correct the named evidence and repeat observational preflight; never retry uncertain effects blindly.", executionAdmitted: false };
};
/** No TicketStore constructor, database migration, process probe, authority import or writes. */
export function readTicketWorkflow(ticket: string): WorkflowState | null {
  text(ticket, /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
  const row = strictJson(readReviewEvidenceFile(join(getTicketsDir(), `${ticket}.json`), 1_048_576, "workflow.ticket")) as Record<string, unknown>;
  if (row.id !== ticket) throw new JsonWorkflowError("WORKFLOW_SOURCE");
  const repoKey = text(row.project, ID), repo = loadRepoEntry(repoKey);
  if (!repo) throw new JsonWorkflowError("WORKFLOW_SOURCE");
  return withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticket) : null;
    if (state && state.subject.repository.root !== repo.path) throw new JsonWorkflowError("WORKFLOW_AUTHORITY");
    if (!state && Array.isArray(row.doc_refs) && row.doc_refs.some((r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).type === "workflow")) throw new JsonWorkflowError("WORKFLOW_UNCERTAIN");
    return state;
  });
}
/** CLI/native read semantics. JSON projections are never writable authority. */
export function workflowReadService(input: Uint8Array | string, host: WorkflowReadHost = {}): Record<string, unknown> {
  try {
    const r = object(parseWorkflowRequest(input), ["action"], ["id", "ticket", "definitionFile"]);
    const action = text(r.action); let result: unknown;
    const stateFor = () => {
      const ticket = text(r.ticket, /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
      return (host.state ?? readTicketWorkflow)(ticket);
    };
    if (action === "validate") {
      object(r, ["action", "definitionFile"]);
      const file = text(r.definitionFile);
      if (findSensitiveMatch("path", file)) throw new JsonWorkflowError("WORKFLOW_CONTRACT");
      const path = resolve(file);
      result = queryWorkflow({} as WorkflowSelection, { action: "validate", raw: readReviewEvidenceFile(path, 1_048_576, "workflow.definition-inspection") });
    } else if (action === "list" || action === "show") {
      object(r, action === "list" ? ["action"] : ["action", "id"]);
      result = queryWorkflow((host.selection ?? loadSelectedWorkflows)(), action === "list" ? { action } : { action, id: text(r.id, ID) });
    } else if (["preflight", "status", "next", "decision-show", "decision-verify"].includes(action)) {
      object(r, action.startsWith("decision-") ? ["action", "ticket", "id"] : ["action", "ticket"]);
      const state = stateFor();
      if (action === "preflight") result = queryWorkflow((host.selection ?? loadSelectedWorkflows)(), { action: "preflight", team: host.team ?? "requirements", mode: host.mode ?? "analyze", ...(state ? { subject: state.subject } : {}) }, host.observations?.(state?.subject) ?? unavailableWorkflowObservations());
      else {
        if (!state) throw new JsonWorkflowError("WORKFLOW_SOURCE", "admitted-run", "workflow-owner");
        if (action === "status") result = state;
        else if (action === "next") {
          result = { ...projectWorkflowNext(state, host.operations ?? new Set()), effectsAdmitted: false };
        } else {
          const id = text(r.id, ID), decision = state.decisions.find(d => d.decisionId === id);
          if (!decision) throw new JsonWorkflowError("WORKFLOW_AUTHORITY");
          if (action === "decision-verify") readWorkflowEvidence(state.subject, ref => readCanonicalWorkflowArtifact(ref.ref));
          result = { decision, issued: true, revoked: state.revoked.includes(id), approved: decision.outcome === "approved" && !state.revoked.includes(id) };
        }
      }
    } else throw new JsonWorkflowError("WORKFLOW_CONTRACT");
    const envelope = { schemaVersion: "pa-workflow-result/v1", ok: true, action, result, executionAdmitted: false };
    if (findSensitiveMatch("content", JSON.stringify(envelope))) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "sensitive-public-output", "workflow-owner");
    if (Buffer.byteLength(JSON.stringify(envelope)) > 50 * 1024) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "public-response-size", "workflow-owner");
    return JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  } catch (error) { return workflowFailure(error); }
}
