import {
  adoptedWorkflow, packageDecision, withExistingWorkflowJournal, assertWorkflowMarkerAvailable, structuredTaskBaseline, requireDecision,
  authorizeStructuredConsumer, replayWorkflow, readWorkflowEvidence, readCanonicalWorkflowArtifact, parseReviewMatrixPlan, TicketStore, requireTicketLinkedBranch,
  JsonWorkflowError, assertRetainedConfigIdentity, type StructuredTaskBaseline, type WorkflowState, type PackagePermission, type EffectIntent,
} from "@pa-platform/pa-core";
import { ProjectCommandContract } from "./project-command-contract.js";

const deny = () => { throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "structured-consumer", "workflow-owner"); };
/** Native work is tied to exactly one already persisted source intent; declaring
 * an operation or approving a package does not start an unrequested phase. */
export function requirePiSourceIntent(state: WorkflowState, authority: StructuredTaskBaseline["authority"], phaseId?: string): EffectIntent | null {
  const steps = state.definition.steps.filter(step => step.operation.id === "source.local");
  if (!steps.length) return null; // previously supported capture/publication-only definitions
  const intents = state.pending.filter(intent => steps.some(step => step.id === intent.stepId));
  if (authority.runId !== state.runId || authority.subjectSha256 !== state.subjectSha256 || authority.decisionId !== packageDecision(state) || intents.length !== 1) return deny();
  const intent = intents[0]!;
  if (intent.owner !== "execution" || intent.decisionId !== authority.decisionId || intent.subjectSha256 !== state.subjectSha256 || (phaseId !== undefined && phaseId !== intent.stepId)) return deny();
  return intent;
}
/** Read-only result/settlement binding, also after revocation. No source grant,
 * live holder adoption or latest-result selection can be inferred from this. */
export function retainedPiSourceIntent(authority: StructuredTaskBaseline["authority"], phaseId: string): EffectIntent | null {
  return withExistingWorkflowJournal(journal => {
    if (!journal) return deny();
    const state = requireSourceState(journal, authority);
    if (!state.definition.steps.some(step => step.operation.id === "source.local")) return null;
    const step = state.definition.steps.find(step => step.id === phaseId && step.operation.id === "source.local" && step.owner === "execution");
    const decision = state.decisions.find(d => d.decisionId === authority.decisionId && d.subjectSha256 === state.subjectSha256 && d.outcome === "approved");
    if (!step || !decision || step.authorization.some(permission => !decision.permissions.includes(permission))) return deny();
    const intents = journal.read(state.runId).filter(entry => entry.event.type === "intent").map(entry => entry.event.data.intent as unknown as EffectIntent)
      .filter(intent => intent.stepId === phaseId && intent.subjectSha256 === authority.subjectSha256 && intent.decisionId === authority.decisionId);
    if (intents.length !== 1 || (!state.pending.some(intent => intent.intentId === intents[0]!.intentId) && state.outcomes[phaseId] !== "completed")) return deny();
    return intents[0]!;
  });
}
function requireSourceState(journal: Parameters<typeof authorizeStructuredConsumer>[0], authority: StructuredTaskBaseline["authority"]): WorkflowState {
  // replay's owner validates all persisted intent/decision grammar; no exported
  // status JSON or public phase result is imported here.
  const state = replayWorkflow(journal, authority.runId);
  if (state.subjectSha256 !== authority.subjectSha256) return deny(); return state;
}
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
    assertRetainedConfigIdentity(state);
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
    requirePiSourceIntent(state, baseline.authority); // before checkout/capacity effects
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
export function authorizePiStructuredWork(repoKey: string, repoRoot: string, ticket: string, branch: string, permission: PackagePermission, plan?: { paths: readonly string[]; checks: readonly string[]; requirements?: readonly string[] }, authority?: StructuredTaskBaseline["authority"]): WorkflowState | null {
  return withExistingWorkflowJournal(journal => {
    const state = journal ? adoptedWorkflow(journal, repoKey, ticket) : null;
    assertWorkflowMarkerAvailable(repoKey, ticket, state !== null);
    if (!state || !journal) { if (authority) return deny(); return null; }
    if (!authority) return deny(); // an already-running legacy lineage cannot inherit a later v1 grant
    assertRetainedConfigIdentity(state);
    if (authority.runId !== state.runId || authority.subjectSha256 !== state.subjectSha256 || authority.decisionId !== packageDecision(state)) return deny();
    const source = new TicketStore().get(ticket)!.doc_refs.filter(r => r.type === "requirements" && r.primary);
    if (source.length !== 1) return deny();
    authorizeStructuredConsumer(journal, state.runId, packageDecision(state), { repoKey, repoRoot, ticket, branch, team: "builder", mode: "orchestrator", primaryRequirementsRef: `requirements:${source[0]!.path}` }, [permission]);
    if (plan) {
      const scope = state.subject.scope;
      if (plan.requirements?.some(id => !scope.requirements.includes(id) && !scope.acceptanceCriteria.includes(id))) return deny();
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
