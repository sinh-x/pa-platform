import type { EvidenceRef, WorkflowErrorCode } from "./contracts.js";
export interface WorkflowGateResult {
  schemaVersion: "pa-workflow-gate-result/v1";
  code: WorkflowErrorCode | "WORKFLOW_STATIC_COMPATIBLE" | "WORKFLOW_LIVE_DEFERRED";
  gateId: string; outcome: "compatible" | "blocked" | "deferred";
  evidence: EvidenceRef[]; correctionOwner: string; nextAction: string;
}
/** Only runtime-owned constants are passed here. Unknown keys/values and underlying exceptions are never public diagnostics. */
export function gate(code: WorkflowGateResult["code"], gateId: string, outcome: WorkflowGateResult["outcome"], correctionOwner: string): WorkflowGateResult {
  return { schemaVersion: "pa-workflow-gate-result/v1", code, gateId, outcome, evidence: [], correctionOwner,
    nextAction: code === "TEMPLATE_PAIR" ? "The config/runtime owner must reconcile the physical selected root/team, config revision, registry and resource pins through supported source/selection processes. Preserve decisions; status/next retries or repeated human approval cannot repair a pair mismatch."
      : outcome === "blocked" ? "Preserve state; ask the named owner to supply matching supported evidence, then repeat preflight."
      : outcome === "deferred" ? "Recheck live identity, capacity, custody, execution profile and review claims through their owners at the effect boundary."
      : "Static compatibility only; request the next action through its authenticated owning service." };
}
export function renderWorkflowGate(result: WorkflowGateResult): string {
  return `Condition: JSON workflow ${result.outcome}\nSource: ${result.gateId}\nReason: ${result.code}\nCorrection: ${result.correctionOwner}\nResume Action: ${result.nextAction}`;
}
