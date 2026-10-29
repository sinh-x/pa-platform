import { JsonWorkflowError, type EvidenceRef, type ReviewBundle } from "./contracts.js";
import { operationContract } from "./operations.js";
import { readWorkflowEvidence } from "./evidence.js";
import { gate, type WorkflowGateResult } from "./presentation.js";
import { selectNewWorkflow, type SelectedWorkflow, type WorkflowSelection } from "./selected.js";

export interface WorkflowPreflight {
  schemaVersion: "pa-workflow-preflight/v1"; status: "static-compatible" | "blocked";
  executionAdmitted: false; gates: WorkflowGateResult[];
  selected: { workflowId: string; version: string; sha256: string; configRevision: string } | null;
}
/** Read-only owner observations, not execution ports. No probes, allocation, persistence or synthetic passed flags. */
export interface WorkflowObservations {
  readonly capabilities: ReadonlySet<string>;
  readonly projectProfile: "supported" | "missing" | "unsupported";
  readonly producerContract: "supported" | "missing";
  readonly readEvidence: (ref: EvidenceRef) => Uint8Array | null;
}
export function preflightWorkflow(selection: WorkflowSelection, team: string, mode: string, observations: WorkflowObservations, subject?: ReviewBundle): WorkflowPreflight {
  const gates: WorkflowGateResult[] = [];
  let selected: SelectedWorkflow | undefined;
  try { selected = selectNewWorkflow(selection, team, mode); }
  catch (error) { gates.push(gate(error instanceof JsonWorkflowError ? error.code : "WORKFLOW_SOURCE", "selected-binding", "blocked", "papc-owner")); }
  if (selected) {
    if (selected.definition.requiredCapabilities.some(c => !observations.capabilities.has(c))) gates.push(gate("WORKFLOW_CAPABILITY", "required-capabilities", "blocked", "runtime-owner"));
    for (const step of selected.definition.steps) {
      const contract = operationContract(step.operation.id, step.operation.version);
      if (!contract || !observations.capabilities.has(contract.capability)) gates.push(gate("WORKFLOW_CAPABILITY", "operation-owner", "blocked", "runtime-owner"));
    }
    if (subject && (subject.workflow.id !== selected.definition.workflowId || subject.workflow.version !== selected.definition.version || subject.workflow.sha256 !== selected.sha256)) gates.push(gate("WORKFLOW_AUTHORITY", "subject-binding", "blocked", "package-owner"));
  }
  // Independent prerequisites are reported even when the selected definition is incompatible.
  if (observations.projectProfile !== "supported") gates.push(gate("WORKFLOW_CAPABILITY", "project-command-contract-required", "blocked", "project-command-owner"));
  if (observations.producerContract !== "supported") gates.push(gate("WORKFLOW_CAPABILITY", "shared-producer-contract-required", "blocked", "pap-270-producer-owner"));
  if (subject) {
    try { readWorkflowEvidence(subject, observations.readEvidence); }
    catch { gates.push(gate("WORKFLOW_SOURCE", "subject-evidence", "blocked", "artifact-owner")); }
  }
  const status = gates.some(g => g.outcome === "blocked") ? "blocked" : "static-compatible";
  if (status === "static-compatible") gates.push(gate("WORKFLOW_STATIC_COMPATIBLE", "static-contract", "compatible", "workflow-owner"));
  gates.push(gate("WORKFLOW_LIVE_DEFERRED", "effect-boundary", "deferred", "existing-effect-owner"));
  return { schemaVersion: "pa-workflow-preflight/v1", status, executionAdmitted: false, gates,
    selected: selected ? { workflowId: selected.definition.workflowId, version: selected.definition.version, sha256: selected.sha256, configRevision: selected.configRevision } : null };
}
/** Safe defaults until actual owner adapters provide observational evidence. Installation supplies no capability. */
export function unavailableWorkflowObservations(): WorkflowObservations {
  return { capabilities: new Set(), projectProfile: "missing", producerContract: "missing", readEvidence: () => null };
}
