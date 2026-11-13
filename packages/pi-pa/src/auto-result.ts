import {
  workflowDigest, parseExecutionBinding, readExecutionState, readExecutionOperations, NativeExecutionEvidence,
  resolveRepoExecutionPath, queryReadonlyDeploymentEvents, type AutoItem, type AutoStartIntent, type ExecutionCommand,
} from "@pa-platform/pa-core";
import { isDeepStrictEqual } from "node:util";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { captureNativeScope, readNativeCommitTree, type NativeToolResult, type NativeScopeSnapshot } from "./execution-native.js";
import { ProjectCommandContract } from "./project-command-contract.js";

interface NativeIntentView { executionId: string; actor: unknown; toolName: string; command: string | null; before: NativeScopeSnapshot; checkedInputsSha256: string | null; commitIndexSha256: string | null }
export interface AutoNativeResult {
  state: "proven" | "unproven"; candidateSha: string | null; commitRef: string | null;
  checks: Array<{ command: string; state: "passed" | "unproven"; originalCandidateSha: string | null; outputRef: string | null }>;
}
/** Read original protected native journal/results, not a caller report/passed
 * flag or terminal prose. Never grants work, reacquires custody or runs checks.
 * A complete original commit/current-input proof is required for review-ready. */
export function inspectAutoNativeResult(item: AutoItem, intent: AutoStartIntent, nativeAuthority?: PiPreparedNativeAuthority): AutoNativeResult {
  const result: AutoNativeResult = { state: "unproven", candidateSha: null, commitRef: null,
    checks: intent.validation.commands.map(command => ({ command, state: "unproven", originalCandidateSha: null, outputRef: null })) };
  try {
    if (!item.dispatch) return result;
    const id = item.dispatch.deploymentId, starts = queryReadonlyDeploymentEvents(id).filter(e => e.event === "started"), start = starts[0];
    if (starts.length !== 1 || !start || start.note !== "ordinary-native-execution/v1" || start.team !== "builder" || start.mode !== "orchestrator" || start.runtime !== "pi" || start.binary !== "ppa"
      || start.ticket_id !== item.ticket || start.repo_root !== item.repoRoot || !start.worktree_root) return result;
    const physical = resolveRepoExecutionPath(undefined, start.worktree_root, { allowLinkedWorktreeCwd: true });
    if (physical.repoKey !== item.project || physical.repoRoot !== item.repoRoot) return result;
    const authority = nativeAuthority ?? new PiPreparedNativeAuthority(), store = authority.execution(false); if (!store) return result;
    const operationId = workflowDigest(JSON.stringify(["ordinary-native-execution/v1", id]));
    const executionId = workflowDigest(JSON.stringify(["execution/v1", operationId, id]));
    const descriptorName = `${workflowDigest(JSON.stringify(["native-execution-descriptor/v1", executionId]))}.intent.json`;
    const descriptor = store.read(descriptorName) as Record<string, unknown>, binding = parseExecutionBinding(descriptor.binding);
    if (descriptor.schemaVersion !== "native-ordinary-execution-descriptor/v1" || binding.lineageId !== id || binding.ticket !== item.ticket || binding.repoRoot !== item.repoRoot
      || binding.repoKey !== item.project || binding.branch !== intent.branch.name || binding.worktreeRoot !== start.worktree_root) return result;
    const state = readExecutionState(store, binding), operations = readExecutionOperations(store, binding);
    const snapshot = captureNativeScope(start.worktree_root); result.candidateSha = snapshot.git.head;
    if (!state.plan || state.operation || state.pendingRestart || state.restartLaunch || state.recoveryPending || state.originalFailure || state.custody.state !== "idle"
      || snapshot.git.dirty || snapshot.git.branch !== intent.branch.name || state.candidateSha !== snapshot.git.head) return result;
    const profile = ProjectCommandContract.inspectWorktree(item.project, item.repoRoot, start.worktree_root, intent.validation.commands);
    if (!profile || profile.sha256 !== intent.validation.profileSha256) return result;
    const commands = state.plan.checks.map(name => profile.checks.find(c => c.id === name || c.command === name)?.command);
    if (JSON.stringify(commands) !== JSON.stringify(intent.validation.commands)) return result;
    const evidence = new NativeExecutionEvidence(store, authority.evidenceRoot(), { repository: () => { throw new Error("readonly"); }, worktree: () => { throw new Error("readonly"); } });
    for (const operation of operations) {
      if (!operation.finish) continue;
      const final = store.read(`${executionId}.transaction-${operation.finish.sequence}.json`) as { command: ExecutionCommand };
      if (final.command.action !== "finish" || final.command.failure !== null) continue;
      const row = evidence.read(operation.finish.evidence, "tool-result") as NativeToolResult, original = evidence.read(row.intent, "tool-intent") as NativeIntentView;
      if (original.executionId !== executionId || !isDeepStrictEqual(original.actor, operation.actor) || original.toolName !== "bash" || row.scopeValid !== true || row.exitCode !== 0
        || row.process?.groupSettled !== true || row.process.exitCode !== 0 || row.process.signal !== null || row.process.timedOut !== false || row.process.aborted !== false || row.process.outputLimitExceeded !== false) continue;
      const frame = evidence.read(row.process.frame, "process-frame") as { intent: unknown };
      if (!isDeepStrictEqual(frame.intent, row.intent)) continue;
      evidence.blob(row.process.stdout); evidence.blob(row.process.stderr);
      if (typeof original.command !== "string") continue;
      if (original.command.startsWith("git commit -m ") && original.commitIndexSha256 && row.after.git.head === snapshot.git.head && original.before.git.head !== snapshot.git.head
        && readNativeCommitTree(start.worktree_root, snapshot.git.head) === original.commitIndexSha256) result.commitRef = operation.finish.evidence.ref;
      const index = intent.validation.commands.indexOf(original.command);
      if (operation.operation.kind !== "check" || index < 0) continue;
      const check = profile.checks.find(c => c.command === original.command);
      if (!check || original.checkedInputsSha256 !== profile.inputIdentity(check)) continue;
      result.checks[index] = { command: original.command, state: "passed", originalCandidateSha: original.before.git.head, outputRef: operation.finish.evidence.ref };
    }
    if (result.commitRef && result.checks.every(c => c.state === "passed") && isDeepStrictEqual(captureNativeScope(start.worktree_root), snapshot) && readExecutionState(store, binding).sequence === state.sequence) result.state = "proven";
    return result;
  } catch { return result; }
}
