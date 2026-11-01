import { join, resolve } from "node:path";
import { getTicketsDir } from "../paths.js";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { loadRepoEntry } from "../repos.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { adoptedWorkflow, withExistingWorkflowJournal } from "./catalog.js";
import { JsonWorkflowError, MAX_WORKFLOW_RECORD_BYTES, object, strictJson, parseWorkflowRequest, workflowTicket, text, ID, type ReviewBundle } from "./contracts.js";
import { queryWorkflow } from "./queries.js";
import { preflightWorkflow, preflightPinnedWorkflow, projectExecutionPrerequisites, unavailableWorkflowObservations } from "./preflight.js";
import type { WorkflowObservations, WorkflowPreflight } from "./preflight.js";
import { loadSelectedWorkflows, type WorkflowSelection } from "./selected.js";
import { eligibleSteps, projectWorkflowNext, type WorkflowState } from "./service.js";
import { readCanonicalWorkflowArtifact } from "./consumers.js";
import { readWorkflowEvidence } from "./evidence.js";
import { gate } from "./presentation.js";

export interface WorkflowPrimerView { runId: string; workflowId: string; version: string; sha256: string; configRevision: string; nextOwner: string; nextAction: string }
export function workflowPrimerView(state: WorkflowState): WorkflowPrimerView {
  const pending = state.pending[0], id = pending?.stepId ?? eligibleSteps(state)[0], step = state.definition.steps.find(s => s.id === id);
  const revoked = step && step.kind !== "decision" && !state.decisions.some(d => d.subjectSha256 === state.subjectSha256 && d.outcome === "approved" && !state.revoked.includes(d.decisionId) && step.authorization.every(p => d.permissions.includes(p)));
  return { runId: state.runId, workflowId: state.definition.workflowId, version: state.definition.version, sha256: state.subject.workflow.sha256, configRevision: state.configRevision,
    nextOwner: !state.resources && !pending ? "config-runtime-owner" : revoked && !pending ? "operator" : step?.owner ?? "workflow-owner", nextAction: pending ? `reconcile retained intent ${pending.intentId}; do not repeat effects` : !state.resources ? "blocked: original resource closure is missing; preserve history and do not adopt current instructions/templates or reuse approvals for changed bytes" : revoked ? "blocked by absent/revoked authority; preserve state and inspect the exact decision" : step ? `request structurally eligible step ${step.id} through its owner; live availability/admission remains unproven` : "inspect retained terminal/blocked state; no completion or approval is inferred" };
}
export interface WorkflowRepository { key: string; root: string }
export interface WorkflowReadContext { repository?: WorkflowRepository; state: WorkflowState | null }
export interface WorkflowReadHost {
  selection?(): WorkflowSelection;
  context?(ticket: string): WorkflowReadContext;
  /** Trusted fixture/owner seam; without a repository context inspection remains uninspected. */
  state?(ticket: string): WorkflowState | null;
  observations?(subject?: ReviewBundle, repository?: WorkflowRepository, state?: WorkflowState): WorkflowObservations;
  team?: string; mode?: string;
  operations?: ReadonlySet<string>;
}
export const workflowFailure = (error: unknown) => {
  const e = error instanceof JsonWorkflowError ? error : new JsonWorkflowError("WORKFLOW_SOURCE");
  return { schemaVersion: "pa-workflow-result/v1", ok: false, code: e.code, gateId: e.gateId, correctionOwner: e.correctionOwner, diagnostic: e.message, nextAction: gate(e.code, e.gateId, "blocked", e.correctionOwner).nextAction, executionAdmitted: false };
};
/** No TicketStore constructor, database migration, process probe, authority import or writes. */
export function readTicketWorkflowContext(ticket: string): WorkflowReadContext {
  workflowTicket(ticket);
  const row = strictJson(readReviewEvidenceFile(join(getTicketsDir(), `${ticket}.json`), 1_048_576, "workflow.ticket")) as Record<string, unknown>;
  if (row.id !== ticket) throw new JsonWorkflowError("WORKFLOW_SOURCE");
  const repoKey = text(row.project, ID), repo = loadRepoEntry(repoKey);
  if (!repo) throw new JsonWorkflowError("WORKFLOW_SOURCE");
  const repository = { key: repoKey, root: repo.path };
  const state = withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticket) : null;
    if (state && (state.subject.repository.key !== repoKey || state.subject.repository.root !== repo.path)) throw new JsonWorkflowError("WORKFLOW_AUTHORITY");
    if (!state && Array.isArray(row.doc_refs) && row.doc_refs.some((r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).type === "workflow")) throw new JsonWorkflowError("WORKFLOW_UNCERTAIN");
    return state;
  });
  return { repository, state };
}
export function readTicketWorkflow(ticket: string): WorkflowState | null { return readTicketWorkflowContext(ticket).state; }
/** CLI/native read semantics. JSON projections are never writable authority. */
export function workflowReadService(input: Uint8Array | string, host: WorkflowReadHost = {}): Record<string, unknown> {
  try {
    const r = object(parseWorkflowRequest(input), ["action"], ["id", "ticket", "definitionFile"]);
    const action = text(r.action); let result: unknown;
    const contextFor = () => {
      const ticket = workflowTicket(r.ticket);
      return host.context ? host.context(ticket) : host.state ? { state: host.state(ticket) } : readTicketWorkflowContext(ticket);
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
      const context: WorkflowReadContext = contextFor(), { state, repository } = context;
      if (state && repository && (state.subject.repository.key !== repository.key || state.subject.repository.root !== repository.root)) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "ticket-repository", "repository-owner");
      const observe = () => host.observations?.(state?.subject, repository, state ?? undefined) ?? unavailableWorkflowObservations();
      const preflight = (): WorkflowPreflight => {
        const report = state ? preflightPinnedWorkflow({ definition: state.definition, sha256: state.subject.workflow.sha256, configRevision: state.configRevision }, observe(), state.subject)
          : preflightWorkflow((host.selection ?? loadSelectedWorkflows)(), host.team ?? "requirements", host.mode ?? "analyze", observe());
        if (state && !state.resources) { report.status = "blocked"; report.gates = report.gates.filter(g => g.code !== "WORKFLOW_STATIC_COMPATIBLE"); report.gates.push(gate("WORKFLOW_SOURCE", "retained-resource-closure", "blocked", "config-runtime-owner")); }
        return report;
      };
      if (action === "preflight") result = preflight();
      else if (!state && (action === "status" || action === "next")) {
        const report = preflight();
        result = { runState: report.selected ? "selected-without-run" : "selection-blocked-without-run", runId: null, preflight: report, effectsAdmitted: false,
          nextAction: "No run has been admitted. Resolve any selected-contract blockers through their named owners, then draft the exact canonical pair; admission requires authenticated foreground context. Retrying status/next or repeating prior human decisions does not repair infrastructure." };
      } else {
        if (!state) throw new JsonWorkflowError("WORKFLOW_SOURCE", "admitted-run", "workflow-owner");
        if (action === "status") {
          const observations = observe();
          result = { ...state, runState: "admitted", resourceState: state.resources ? "retained" : "legacy-missing", projectProfile: observations.projectProfile, executionPrerequisites: projectExecutionPrerequisites(observations) };
        } else if (action === "next") {
          const observations = observe();
          result = { ...projectWorkflowNext(state, host.operations ?? new Set(), observations), runState: "admitted", resourceState: state.resources ? "retained" : "legacy-missing", projectProfile: observations.projectProfile, executionPrerequisites: projectExecutionPrerequisites(observations), effectsAdmitted: false };
        } else {
          const id = text(r.id, ID), decision = state.decisions.find(d => d.decisionId === id);
          if (!decision) throw new JsonWorkflowError("WORKFLOW_AUTHORITY");
          const currentSubject = decision.subjectSha256 === state.subjectSha256;
          if (action === "decision-verify" && currentSubject) readWorkflowEvidence(state.subject, ref => readCanonicalWorkflowArtifact(ref.ref));
          result = { decision, issued: true, revoked: state.revoked.includes(id), currentSubject, approved: currentSubject && decision.outcome === "approved" && !state.revoked.includes(id) };
        }
      }
    } else throw new JsonWorkflowError("WORKFLOW_CONTRACT");
    const envelope = { schemaVersion: "pa-workflow-result/v1", ok: true, action, result, executionAdmitted: false };
    if (findSensitiveMatch("content", JSON.stringify(envelope))) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "sensitive-public-output", "workflow-owner");
    if (Buffer.byteLength(JSON.stringify(envelope)) > 50 * 1024) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "public-response-size", "workflow-owner");
    return JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  } catch (error) { return workflowFailure(error); }
}
