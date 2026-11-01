import { JsonWorkflowError, type EvidenceRef, type ReviewBundle } from "./contracts.js";
import { operationContract } from "./operations.js";
import { readWorkflowEvidence } from "./evidence.js";
import { gate, type WorkflowGateResult } from "./presentation.js";
import { selectNewWorkflow, type SelectedWorkflow, type WorkflowSelection } from "./selected.js";

export interface WorkflowPreflight {
  schemaVersion: "pa-workflow-preflight/v1"; status: "static-compatible" | "blocked";
  executionAdmitted: false; gates: WorkflowGateResult[];
  projectProfile: WorkflowObservations["projectProfile"];
  /** Later execution blockers: these do not prevent discovery, drafting, admission or queueing. */
  executionPrerequisites: WorkflowGateResult[];
  selected: { workflowId: string; version: string; sha256: string; configRevision: string } | null;
}
/** Read-only owner observations, not execution ports. No probes, allocation, persistence or synthetic passed flags. */
export interface WorkflowObservations {
  readonly capabilities: ReadonlySet<string>;
  readonly projectProfile: "supported" | "missing" | "unsupported" | "uninspected";
  readonly producerContract: "supported" | "missing" | "unsupported";
  readonly producerFailure?: JsonWorkflowError;
  readonly readEvidence: (ref: EvidenceRef) => Uint8Array | null;
}
export function preflightWorkflow(selection: WorkflowSelection, team: string, mode: string, observations: WorkflowObservations, subject?: ReviewBundle): WorkflowPreflight {
  const gates: WorkflowGateResult[] = [];
  let selected: SelectedWorkflow | undefined;
  try { selected = selectNewWorkflow(selection, team, mode); }
  catch (error) { gates.push(gate(error instanceof JsonWorkflowError ? error.code : "WORKFLOW_SOURCE", "selected-binding", "blocked", "papc-owner")); }
  return inspectWorkflow(selected, observations, subject, gates);
}
/** Trusted retained-run path only: no current binding is enabled or migrated. */
export function preflightPinnedWorkflow(selected: Pick<SelectedWorkflow, "definition" | "sha256" | "configRevision">, observations: WorkflowObservations, subject: ReviewBundle): WorkflowPreflight {
  return inspectWorkflow(selected, observations, subject, []);
}
function inspectWorkflow(selected: Pick<SelectedWorkflow, "definition" | "sha256" | "configRevision"> | undefined, observations: WorkflowObservations, subject: ReviewBundle | undefined, gates: WorkflowGateResult[]): WorkflowPreflight {
  if (selected) {
    if (selected.definition.requiredCapabilities.some(c => !observations.capabilities.has(c))) gates.push(gate("WORKFLOW_CAPABILITY", "required-capabilities", "blocked", "runtime-owner"));
    for (const step of selected.definition.steps) {
      const contract = operationContract(step.operation.id, step.operation.version);
      if (!contract || !observations.capabilities.has(contract.capability)) gates.push(gate("WORKFLOW_CAPABILITY", "operation-owner", "blocked", "runtime-owner"));
    }
    if (subject && (subject.workflow.id !== selected.definition.workflowId || subject.workflow.version !== selected.definition.version || subject.workflow.sha256 !== selected.sha256)) gates.push(gate("WORKFLOW_AUTHORITY", "subject-binding", "blocked", "package-owner"));
  }
  // Independent prerequisites are reported even when the selected definition is incompatible.
  if (observations.producerContract !== "supported") {
    const cause = observations.producerFailure;
    gates.push(gate(cause?.code ?? "WORKFLOW_CAPABILITY", cause?.gateId ?? "shared-producer-contract-required", "blocked", cause?.correctionOwner ?? "producer-owner"));
  }
  if (subject) {
    try { readWorkflowEvidence(subject, observations.readEvidence); }
    catch { gates.push(gate("WORKFLOW_SOURCE", "subject-evidence", "blocked", "artifact-owner")); }
  }
  const status = gates.some(g => g.outcome === "blocked") ? "blocked" : "static-compatible";
  if (status === "static-compatible") gates.push(gate("WORKFLOW_STATIC_COMPATIBLE", "static-contract", "compatible", "workflow-owner"));
  gates.push(gate("WORKFLOW_LIVE_DEFERRED", "effect-boundary", "deferred", "existing-effect-owner"));
  return { schemaVersion: "pa-workflow-preflight/v1", status, executionAdmitted: false, gates,
    projectProfile: observations.projectProfile, executionPrerequisites: projectExecutionPrerequisites(observations),
    selected: selected ? { workflowId: selected.definition.workflowId, version: selected.definition.version, sha256: selected.sha256, configRevision: selected.configRevision } : null };
}
/** Observational only. Actual source/check owners must still resolve commands, authority and confinement. */
export function projectExecutionPrerequisites(observations: Pick<WorkflowObservations, "projectProfile">): WorkflowGateResult[] {
  const profile = observations.projectProfile;
  if (profile === "supported") return [];
  const id = profile === "missing" ? "project-command-contract-required" : `project-command-contract-${profile}`;
  return [{ ...gate("WORKFLOW_CAPABILITY", id, "blocked", profile === "uninspected" ? "runtime-owner" : "project-command-owner"),
    nextAction: "Discovery, drafting and approved queueing may continue. Before source/check execution, the owning service must validate the registered repository's supported command contract, task scope, authority and confinement; do not launch a builder on this observation." }];
}
/** Safe defaults until actual owner adapters provide observational evidence. Installation supplies no capability. */
export function unavailableWorkflowObservations(): WorkflowObservations {
  return { capabilities: new Set(), projectProfile: "uninspected", producerContract: "missing", readEvidence: () => null };
}
