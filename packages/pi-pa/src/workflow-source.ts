import { isDeepStrictEqual as equal } from "node:util";
import {
  JsonWorkflowError, replayWorkflow, requireDecision, readExecutionState, readExecutionOperations, parseExecutionBinding, parseSourceVersion,
  queryReadonlyDeploymentEvents, queryReadonlyDeploymentStatus, workflowDigest, workflowObject, loadRepoEntry, parseReviewMatrixPlan, withPreparedTicketCapacity, withExecutionWorktreeAdmission,
  type RegistryWorkflowJournal, type WorkflowCaller, type WorkflowHost, type WorkflowEffectOwner, type EffectIntent, type EffectObservation,
  type ExecutionCommand, type ExecutionBinding, type ExecutionState, type ExecutionOperationRecord, type SourceVersion, type ProtectedWorkflowStore,
} from "@pa-platform/pa-core";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { NativeExecutionEvidence, type NativeProcessResult } from "./native-execution-evidence.js";
import { ProjectCommandContract } from "./project-command-contract.js";
import { structuredLaunchNote } from "./workflow-consumers.js";
import type { NativeToolResult, NativeIntent, NativeScopeSnapshot } from "./execution-native.js";

function blocked(): never { throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "source-native-result", "execution-owner"); }
const readonlyLocks = { repository: (): never => blocked(), worktree: (): never => blocked() };
interface PhaseResult {
  executionId: string; sequence: number; phaseId: string; candidateSha: string; commit: SourceVersion;
  snapshot: NativeScopeSnapshot["git"]; workflow: EffectIntent;
  projectCommands: { registrationSha256: string; sha256: string; checks: { id: string; command: string; inputsSha256: string }[] };
}
function processProof(evidence: NativeExecutionEvidence, intent: SourceVersion, process: NativeProcessResult | null): void {
  if (!process || process.exitCode !== 0 || process.signal !== null || !process.groupSettled || process.timedOut || process.aborted || process.outputLimitExceeded) blocked();
  const frame = evidence.read(process.frame, "process-frame") as { intent: SourceVersion };
  if (!equal(frame.intent, intent)) blocked();
  evidence.blob(process.stdout); evidence.blob(process.stderr);
}
function operationResult(evidence: NativeExecutionEvidence, binding: ExecutionBinding, operations: readonly ExecutionOperationRecord[], source: SourceVersion, sequence?: number): { result: NativeToolResult; intent: NativeIntent } {
  const records = operations.filter(operation => operation.finish && equal(operation.finish.evidence, source));
  if (records.length !== 1) blocked();
  const record = records[0]!, result = evidence.read(source, "tool-result") as NativeToolResult;
  const intent = evidence.read(result.intent, "tool-intent") as NativeIntent;
  if (!record.operation.intent || !equal(record.operation.intent, result.intent) || record.operation.id !== intent.operationId
    || !equal(record.actor, intent.actor) || (sequence !== undefined && record.finish!.sequence !== sequence)
    || intent.executionId !== workflowDigest(JSON.stringify(["execution/v1", binding.operationId, binding.lineageId]))) blocked();
  return { result, intent };
}
/** Internal native proof reader; never a public result/actor import. Historical
 * operation identities come from the actual validated execution replay, even
 * after a later holder replacement. Unfinished/unissued/reused results reject. */
export function readPiSourceOperation(store: ProtectedWorkflowStore, evidence: NativeExecutionEvidence, binding: ExecutionBinding, source: SourceVersion): { result: NativeToolResult; intent: NativeIntent } {
  return operationResult(evidence, binding, readExecutionOperations(store, binding), source);
}
/** Concrete interactive execution-owner bridge. An acknowledged intent does not
 * spawn/edit/commit or allocate resources. The existing authenticated native
 * caller drives that exact phase; only its protected current result settles it.
 * No path, process, outcome, candidate or passed flag comes from public JSON. */
export function createPiSourceWorkflowOwner(journal: RegistryWorkflowJournal, authenticate: () => WorkflowCaller,
  continues?: WorkflowHost["continues"], authority = new PiPreparedNativeAuthority()): WorkflowEffectOwner {
  const stateFor = (intent: EffectIntent) => {
    const state = replayWorkflow(journal, intent.runId), step = state.definition.steps.find(s => s.id === intent.stepId);
    if (intent.subjectSha256 !== state.subjectSha256 || intent.owner !== "execution" || !step || step.owner !== "execution" || step.operation.id !== "source.local") blocked();
    return { state, step: step! };
  };
  let nativeReader: typeof import("./execution-native.js") | null = null;
  let verified: { intent: EffectIntent; result: EffectObservation; phase: PhaseResult; binding: ExecutionBinding; snapshot: NativeScopeSnapshot } | null = null;
  const observe = async (intent: EffectIntent): Promise<EffectObservation> => {
    verified = null;
    try {
      const { state } = stateFor(intent), store = authority.execution();
      if (!store) return { state: "pending" }; // owner has not started; no inferred allocation/dispatch
      const evidence = new NativeExecutionEvidence(store, authority.evidenceRoot(), readonlyLocks);
      const phases: { source: SourceVersion; phase: PhaseResult }[] = [];
      for (const name of store.records().filter(n => n.endsWith(".intent.json"))) {
        const row = store.read(name) as { schemaVersion?: string; kind?: string; payload?: PhaseResult };
        if (row.schemaVersion !== "native-execution-evidence/v1" || row.kind !== "phase" || row.payload?.workflow?.intentId !== intent.intentId) continue;
        const source = parseSourceVersion({ ref: `native-execution-evidence:${name.slice(0, 64)}`, version: "native-execution-evidence/v1", sha256: name.slice(0, 64) });
        const phase = evidence.read(source, "phase") as PhaseResult;
        workflowObject(phase, ["executionId", "sequence", "phaseId", "candidateSha", "commit", "snapshot", "workflow", "projectCommands"]);
        workflowObject(phase.projectCommands, ["registrationSha256", "sha256", "checks"]);
        if (!equal(phase.workflow, intent) || phase.phaseId !== intent.stepId) blocked();
        phases.push({ source, phase });
      }
      if (!phases.length) {
        // A missing phase proof is not evidence that native work is absent.
        // Read only explicitly correlated ordinary descriptors; preserve their
        // started/uncertain barriers instead of retrying or adopting a holder.
        let matches = 0;
        for (const name of store.records().filter(n => n.endsWith(".intent.json"))) {
          const row = store.read(name) as { schemaVersion?: string; binding?: unknown };
          if (row.schemaVersion !== "native-ordinary-execution-descriptor/v1") continue;
          const binding = parseExecutionBinding(row.binding);
          if (binding.repoRoot !== state.subject.repository.root || binding.ticket !== state.subject.ticket || binding.branch !== state.subject.handoff.branch) continue;
          const starts = queryReadonlyDeploymentEvents(binding.lineageId).filter(e => e.event === "started");
          if (starts.length !== 1 || starts[0]!.note !== structuredLaunchNote("ordinary-native-execution/v1", { runId: intent.runId, decisionId: intent.decisionId, subjectSha256: intent.subjectSha256 })) continue;
          matches++;
          const native = readExecutionState(store, binding);
          if (native.pendingRestart || native.operation || ["settling", "uncertain-blocked"].includes(native.custody.state)) return { state: "unknown" };
        }
        return { state: matches > 1 ? "conflict" : "pending" }; // never quiet logs or agent completion messages
      }
      if (new Set(phases.map(p => p.phase.executionId)).size !== 1) return { state: "conflict" };
      const candidates: { source: SourceVersion; phase: PhaseResult; binding: ExecutionBinding; snapshot: NativeScopeSnapshot }[] = [];
      for (const { source, phase } of phases) {
        const descriptorId = workflowDigest(JSON.stringify(["native-execution-descriptor/v1", phase.executionId]));
        const descriptor = workflowObject(store.read(`${descriptorId}.intent.json`), ["schemaVersion", "binding", "launchSha256", "initial", "projectCommandsRegistrationSha256"]);
        if (descriptor.schemaVersion !== "native-ordinary-execution-descriptor/v1") blocked();
        const binding = parseExecutionBinding(descriptor.binding);
        if (phase.executionId !== workflowDigest(JSON.stringify(["execution/v1", binding.operationId, binding.lineageId]))) blocked();
        const starts = queryReadonlyDeploymentEvents(binding.lineageId).filter(e => e.event === "started"), start = starts[0], status = queryReadonlyDeploymentStatus(binding.lineageId);
        if (starts.length !== 1 || !start || !status || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== "builder" || start.mode !== "orchestrator" || start.builder_authority !== "orchestrator" || start.rogue_one || start.parent_deployment_id || start.resumed_from_deployment_id
          || start.note !== structuredLaunchNote("ordinary-native-execution/v1", { runId: intent.runId, decisionId: intent.decisionId, subjectSha256: intent.subjectSha256 })
          || start.repo_root !== binding.repoRoot || start.worktree_root !== binding.worktreeRoot || start.repo !== binding.worktreeRoot || start.ticket_id !== binding.ticket || start.branch_head_sha !== binding.initialHeadSha
          || binding.repoKey !== state.subject.repository.key || binding.repoRoot !== state.subject.repository.root || binding.ticket !== state.subject.ticket || binding.branch !== state.subject.handoff.branch
          || binding.owner.deploymentId !== binding.lineageId || status.repo_root !== binding.repoRoot || status.ticket_id !== binding.ticket || status.runtime !== "pi" || status.team !== "builder" || status.mode !== "orchestrator" || status.worktree_root !== binding.worktreeRoot || status.rogue_one) blocked();
        const native = readExecutionState(store, binding);
        // Exact native journal revision, not newest-file or largest-SHA selection.
        // Old proofs remain historical when further native work invalidates them.
        if (native.pendingRestart || native.operation || ["settling", "uncertain-blocked"].includes(native.custody.state)) blocked();
        if (phase.sequence !== native.sequence) continue;
        if (!native.plan || native.plan.phaseId !== intent.stepId || native.custody.state !== "idle" || native.operation || native.originalFailure || native.recoveryPending || native.candidateSha !== phase.candidateSha) blocked();
        const registration = loadRepoEntry(binding.repoKey)?.projectCommands;
        if (!registration || descriptor.projectCommandsRegistrationSha256 !== workflowDigest(JSON.stringify(registration)) || phase.projectCommands.registrationSha256 !== descriptor.projectCommandsRegistrationSha256) blocked();
        const commands = ProjectCommandContract.inspectWorktree(binding.repoKey, binding.repoRoot, binding.worktreeRoot);
        if (!commands || commands.sha256 !== phase.projectCommands.sha256) blocked();
        const checks = native.plan.checks.map(name => { const check = commands.checks.find(c => c.id === name || c.command === name); if (!check) return blocked(); return { id: check.id, command: check.command, inputsSha256: commands.inputIdentity(check) }; });
        if (!equal(checks, phase.projectCommands.checks) || !equal(checks.map(c => c.id), commands.checks.map(c => c.id))) blocked();
        const matrix = parseReviewMatrixPlan(journal.snapshot(state.subject.requirements.sha256), state.subject.matrix.ref);
        if (checks.some(c => !state.subject.scope.checks.some(ref => ref.matrixSource === matrix.source && ref.matrixSha256 === matrix.digest && matrix.matrix.commands.some(command => command.id === ref.commandId && command.command === c.command)))) blocked();
        const nativeOwner = await import("./execution-native.js"); nativeReader = nativeOwner;
        const current = nativeOwner.captureNativeScope(binding.worktreeRoot);
        if (current.git.dirty || current.git.head !== phase.candidateSha || !equal(current.git, phase.snapshot)) blocked();
        const { result: commit, intent: commitIntent } = readPiSourceOperation(store, evidence, binding, phase.commit);
        if (commit.exitCode !== 0 || !commit.scopeValid || !equal(commit.after, current) || commitIntent.executionId !== phase.executionId
          || !commitIntent.command.startsWith("git commit -m ") || commitIntent.before.git.head === commit.after.git.head || !commitIntent.commitIndexSha256
          || nativeOwner.readNativeCommitTree(binding.worktreeRoot, phase.candidateSha) !== commitIntent.commitIndexSha256) blocked();
        processProof(evidence, commit.intent, commit.process);
        verifyChecks(store, evidence, binding, native, phase, checks);
        // Re-read after all native input/output observations; never settle a
        // candidate or journal that moved during verification.
        if (readExecutionState(store, binding).sequence !== phase.sequence || !equal(nativeOwner.captureNativeScope(binding.worktreeRoot), current)) blocked();
        candidates.push({ source, phase, binding, snapshot: current });
      }
      if (!candidates.length) return { state: "pending" };
      if (candidates.length !== 1) return { state: "conflict" };
      const proof = candidates[0]!, result: EffectObservation = { state: "proven", outcome: "completed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ...proof.source }] };
      // Returned projections are not writable authority: retain private copies
      // so a modified observation cannot rewrite the evidence being verified.
      verified = { intent: structuredClone(intent), result: structuredClone(result), phase: proof.phase, binding: proof.binding, snapshot: proof.snapshot }; return result;
    } catch { return { state: "unknown" }; } // keep the original intent/resources; no retry or forged failure result
  };
  return {
    admit: (caller, subject, intent) => {
      const { state, step } = stateFor(intent), current = authenticate();
      if ((!equal(state.caller, current) && !continues?.(state.caller, current)) || !equal(current, caller) || !equal(subject, state.subject) || current.team !== "requirements" || current.mode !== "analyze") blocked();
      requireDecision(state, intent.decisionId, step.authorization);
    },
    observe,
    execute: async () => ({ state: "pending" }), // interactive native owner, never an auto-spawn/script port
    verify: (intent, result) => {
      try {
        if (!verified || !nativeReader || !equal(intent, verified.intent) || !equal(result, verified.result)) return false;
        stateFor(intent);
        const store = authority.execution(); if (!store) return false;
        const evidence = new NativeExecutionEvidence(store, authority.evidenceRoot(), readonlyLocks), proof = verified;
        const native = readExecutionState(store, proof.binding);
        if (native.sequence !== proof.phase.sequence || !equal(nativeReader.captureNativeScope(proof.binding.worktreeRoot), proof.snapshot)) return false;
        const commands = ProjectCommandContract.inspectWorktree(proof.binding.repoKey, proof.binding.repoRoot, proof.binding.worktreeRoot);
        const registration = loadRepoEntry(proof.binding.repoKey)?.projectCommands;
        if (!commands || !registration || workflowDigest(JSON.stringify(registration)) !== proof.phase.projectCommands.registrationSha256 || commands.sha256 !== proof.phase.projectCommands.sha256) return false;
        const checks = native.plan!.checks.map(name => { const check = commands.checks.find(c => c.id === name || c.command === name); if (!check) return blocked(); return { id: check.id, command: check.command, inputsSha256: commands.inputIdentity(check) }; });
        if (!equal(checks, proof.phase.projectCommands.checks)) return false;
        verifyChecks(store, evidence, proof.binding, native, proof.phase, checks);
        const { result: commit } = readPiSourceOperation(store, evidence, proof.binding, proof.phase.commit); processProof(evidence, commit.intent, commit.process);
        return readExecutionState(store, proof.binding).sequence === proof.phase.sequence && equal(nativeReader.captureNativeScope(proof.binding.worktreeRoot), proof.snapshot);
      } catch { return false; }
    },
    settle: (intent, action) => {
      if (!verified || !equal(verified.intent, intent)) blocked();
      const binding = verified.binding;
      return withPreparedTicketCapacity({ canonicalRepoKey: binding.repoKey, canonicalRepoRoot: binding.repoRoot }, capacity =>
        withExecutionWorktreeAdmission(binding.repoRoot, binding.worktreeRoot, capacity, () => action()));
    },
  };
}
function verifyChecks(store: ProtectedWorkflowStore, evidence: NativeExecutionEvidence, binding: ExecutionBinding, state: ExecutionState, phase: PhaseResult, expected: PhaseResult["projectCommands"]["checks"]): void {
  let passed = 0, commitSeen = false;
  const operations = readExecutionOperations(store, binding);
  for (let sequence = 1; sequence <= state.sequence; sequence++) {
    const row = store.read(`${phase.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
    const command = row.command;
    if (["plan", "advance", "candidate", "attempt"].includes(command.action)) passed = 0;
    if (command.action !== "finish") continue;
    const { result, intent } = operationResult(evidence, binding, operations, command.evidence, sequence);
    if (equal(command.evidence, phase.commit)) { commitSeen = true; break; }
    if (!result.scopeValid || result.exitCode !== 0 || intent.toolName !== "bash" || !equal(intent.before.files, result.after.files) || intent.before.git.head !== result.after.git.head) { passed = 0; continue; }
    const check = expected[passed];
    if (!check || check.command !== intent.command) continue;
    if (intent.executionId !== phase.executionId) blocked();
    // Historical checks are retained, not reclassified as corrupt merely
    // because later scoped work changed their inputs. Invalidate their pass;
    // only a subsequent exact current-input check can rebuild the sequence.
    if (intent.checkedInputsSha256 !== check.inputsSha256) { passed = 0; continue; }
    processProof(evidence, result.intent, result.process); passed++;
  }
  if (!commitSeen || passed !== expected.length || !expected.length) blocked();
}
