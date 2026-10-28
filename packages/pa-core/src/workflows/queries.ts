import { parseWorkflowDefinition } from "./definition.js";
import { preflightWorkflow, unavailableWorkflowObservations, type WorkflowObservations } from "./preflight.js";
import { JsonWorkflowError, type ReviewBundle } from "./contracts.js";
import type { WorkflowSelection } from "./selected.js";
export type WorkflowReadRequest = { action: "list" } | { action: "show"; id: string } | { action: "validate"; raw: Uint8Array }
  | { action: "preflight"; team: string; mode: string; subject?: ReviewBundle };
/** One read semantics owner for CLI/native tools. No public operation takes a result, principal or permission grant. */
export function queryWorkflow(selection: WorkflowSelection, request: WorkflowReadRequest, observations: WorkflowObservations = unavailableWorkflowObservations()): unknown {
  switch (request.action) {
    case "list": return { schemaVersion: "pa-workflow-list/v1", configRevision: selection.configRevision,
      definitions: selection.definitions.map(d => ({ workflowId: d.definition.workflowId, version: d.definition.version, sha256: d.sha256 })), bindings: selection.bindings };
    case "show": {
      const selected = selection.definitions.filter(d => d.definition.workflowId === request.id);
      if (!selected.length) throw new JsonWorkflowError("WORKFLOW_SOURCE", "definition-selection", "papc-owner");
      return { schemaVersion: "pa-workflow-show/v1", definitions: selected.map(d => ({ definition: d.definition, sha256: d.sha256, configRevision: d.configRevision })) };
    }
    case "validate": return { schemaVersion: "pa-workflow-validation/v1", definition: parseWorkflowDefinition(request.raw), staticOnly: true, executionAdmitted: false };
    case "preflight": return preflightWorkflow(selection, request.team, request.mode, observations, request.subject);
  }
}
