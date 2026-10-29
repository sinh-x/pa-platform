import {
  adoptedWorkflow, packageDecision, withExistingWorkflowJournal, assertWorkflowMarkerAvailable, structuredTaskBaseline, requireDecision,
  authorizeStructuredConsumer, readWorkflowEvidence, readCanonicalWorkflowArtifact, parseReviewMatrixPlan, TicketStore, requireTicketLinkedBranch,
  JsonWorkflowError, type StructuredTaskBaseline, type WorkflowState, type PackagePermission,
} from "@pa-platform/pa-core";
import { ProjectCommandContract } from "./project-command-contract.js";

const deny = () => { throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "structured-consumer", "workflow-owner"); };
export function structuredLaunchNote(base: string, authority: StructuredTaskBaseline["authority"]): string {
  return `${base}:workflow:${authority.runId}:${authority.decisionId}:${authority.subjectSha256}`;
}
export function parseStructuredLaunchNote(note: string | undefined): StructuredTaskBaseline["authority"] | null {
  if (!note?.includes(":workflow:")) return null;
  const match = /^ordinary-native-execution\/v1:workflow:([a-z][a-z0-9.-]{0,127}):([a-z][a-z0-9.-]{0,127}):([a-f0-9]{64})$/.exec(note);
  if (!match) return deny();
  return { runId: match[1]!, decisionId: match[2]!, subjectSha256: match[3]! };
}
/** Automatic adoption is sticky in registry + ticket; malformed/revoked v1 never enters legacy prose readers. */
export function resolvePiStructuredBaseline(repoKey: string, repoRoot: string, ticketId: string): StructuredTaskBaseline | null {
  return withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticketId) : null;
    const store = new TicketStore(); assertWorkflowMarkerAvailable(repoKey, ticketId, state !== null, store);
    if (!state || !journal) return null;
    // Actual files/status alone cannot skip PAPC dependencies or an unsettled owner intent.
    for (const operation of ["publication.pair", "ticket.queue"]) {
      const steps = state.definition.steps.filter(step => step.operation.id === operation);
      if (steps.length !== 1 || state.outcomes[steps[0]!.id] !== "completed" || state.pending.some(intent => intent.owner === "tickets")) return deny();
    }
    const ticket = store.get(ticketId)!; const link = requireTicketLinkedBranch(ticket, repoKey);
    const primary = ticket.doc_refs.filter(r => r.type === "requirements" && r.primary);
    if (primary.length !== 1 || !["pending-implementation", "implementing"].includes(ticket.status)) return deny();
    const context = { repoKey, repoRoot, ticket: ticketId, branch: link.branch, team: "builder", mode: "orchestrator", primaryRequirementsRef: `requirements:${primary[0]!.path}` };
    const baseline = structuredTaskBaseline(journal, state.runId, packageDecision(state), context);
    // Static inspection only. Live namespace/tool/custody checks stay with their owners.
    const profile = ProjectCommandContract.inspect(repoKey, repoRoot);
    if (!profile) throw new JsonWorkflowError("WORKFLOW_CAPABILITY", "project-command-contract-required", "project-command-owner");
    const matrix = parseReviewMatrixPlan(readCanonicalWorkflowArtifact(state.subject.requirements.ref), state.subject.matrix.ref).matrix;
    for (const reference of state.subject.scope.checks) {
      const command = matrix.commands.find(c => c.id === reference.commandId);
      if (!command || !profile.checks.some(c => c.command === command.command)) throw new JsonWorkflowError("WORKFLOW_CAPABILITY", "project-command-definition", "project-command-owner");
    }
    return baseline;
  });
}
/** Fresh authority at every source/check/phase boundary. Native custody remains a separate necessary gate. */
export function authorizePiStructuredWork(repoKey: string, repoRoot: string, ticket: string, branch: string, permission: PackagePermission, plan?: { paths: readonly string[]; checks: readonly string[] }, authority?: StructuredTaskBaseline["authority"]): WorkflowState | null {
  return withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticket) : null;
    assertWorkflowMarkerAvailable(repoKey, ticket, state !== null);
    if (!state || !journal) { if (authority) return deny(); return null; }
    if (!authority) return deny(); // an already-running legacy lineage cannot inherit a later v1 grant
    if (authority.runId !== state.runId || authority.subjectSha256 !== state.subjectSha256 || authority.decisionId !== packageDecision(state)) return deny();
    const source = new TicketStore().get(ticket)!.doc_refs.filter(r => r.type === "requirements" && r.primary);
    if (source.length !== 1) return deny();
    authorizeStructuredConsumer(journal, state.runId, packageDecision(state), { repoKey, repoRoot, ticket, branch, team: "builder", mode: "orchestrator", primaryRequirementsRef: `requirements:${source[0]!.path}` }, [permission]);
    if (plan) {
      const scope = state.subject.scope;
      if (plan.paths.some(path => !scope.files.includes(path) && !scope.newPaths.includes(path) && !scope.directories.some(dir => path.startsWith(`${dir}/`)))) return deny();
      const matrix = parseReviewMatrixPlan(readCanonicalWorkflowArtifact(state.subject.requirements.ref), state.subject.matrix.ref).matrix;
      const profile = ProjectCommandContract.inspect(repoKey, repoRoot);
      if (!profile) return deny();
      const allowed = scope.checks.map(ref => matrix.commands.find(c => c.id === ref.commandId)!);
      if (plan.checks.some(name => !allowed.some(c => c && profile.checks.some(p => (p.id === name || p.command === name) && p.command === c.command)))) return deny();
    }
    return state;
  });
}
