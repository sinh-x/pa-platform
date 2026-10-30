import { getDeployPaths } from "./paths.js";
import { queryReadonlyDeploymentEvents, queryReadonlyDeploymentStatus } from "../registry/index.js";
import { loadRepoEntry } from "../repos.js";
import { parseExecutionBinding, readExecutionState, type ExecutionBinding, type ExecutionHolder } from "./execution-custody.js";
import { processIsWithinFingerprintLineage, readProcessFingerprint, type ProcessFingerprint } from "./repository-admission.js";
import { type ProtectedWorkflowStore, workflowDigest, workflowError } from "./prepared-workflow.js";

/** Internal existing-owner input, never a CLI/tool token or exported status import. */
export interface NativeExecutionRestartSource {
  readonly store: ProtectedWorkflowStore;
  readonly binding: ExecutionBinding;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** An unreadable /proc record alone is NOT process-death proof. A different
 * observed fingerprint proves PID reuse; otherwise the kernel must say ESRCH. */
export function assertNativeRestartProcessDead(previous: ProcessFingerprint): void {
  const current = readProcessFingerprint(previous.pid);
  if (current) { if (same(current, previous)) throw workflowError(); return; }
  try { process.kill(previous.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  throw workflowError();
}
/** Read native facts under the caller's EXISTING capacity/worktree locks.
 * Does not allocate, transfer, authorize source work, initialize a journal or
 * accept a caller-authored process/result/approval flag. Initial support is
 * deliberately quiescent ordinary structured direct custody only. */
export function authenticateNativeExecutionRestart(source: NativeExecutionRestartSource): Readonly<{
  previous: ExecutionHolder; actor: ExecutionHolder; deploymentDirectory: string; candidateSha: string; custody: "idle" | "active";
}> {
  const binding = parseExecutionBinding(source.binding), state = readExecutionState(source.store, binding), pending = state.pendingRestart;
  if (binding.operationId !== workflowDigest(JSON.stringify(["ordinary-native-execution/v1", binding.lineageId]))
    || !pending || pending.sequence !== state.sequence || !same(pending.previousOwner, state.activeOwner)
    || !same(binding.owner, state.retiredOwners[0] ?? state.activeOwner)
    || state.operation || state.custody.inFlightOperation
    || !["idle", "orchestrator-direct"].includes(state.custody.state)
    || (state.custody.holder !== null && !same(state.custody.holder, state.activeOwner))
    || loadRepoEntry(binding.repoKey)?.path !== binding.repoRoot) throw workflowError();
  const previous = state.activeOwner, actor = pending.actor;
  if (previous.deploymentId === actor.deploymentId || !same(readProcessFingerprint(actor.process.pid), actor.process)
    || !processIsWithinFingerprintLineage(process.pid, actor.process)) throw workflowError();
  assertNativeRestartProcessDead(previous.process);
  const ids = [binding.lineageId, previous.deploymentId, actor.deploymentId];
  const rows = ids.map(id => {
    const events = queryReadonlyDeploymentEvents(id), starts = events.filter(e => e.event === "started");
    const start = starts[0], status = queryReadonlyDeploymentStatus(id);
    if (starts.length !== 1 || !start || !status || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== "builder" || start.mode !== "orchestrator"
      || start.builder_authority !== "orchestrator" || start.rogue_one || start.parent_deployment_id || start.repo !== binding.worktreeRoot
      || start.repo_root !== binding.repoRoot || start.worktree_root !== binding.worktreeRoot || start.ticket_id !== binding.ticket
      || start.branch_state !== "materialized" || !start.branch_base_sha || !start.treehouse_lease_id || !start.treehouse_lease_holder
      || status.runtime !== "pi" || status.team !== "builder" || status.mode !== "orchestrator" || status.rogue_one
      || status.repo_root !== binding.repoRoot || status.worktree_root !== binding.worktreeRoot || status.ticket_id !== binding.ticket) throw workflowError();
    return { start, status, terminals: events.filter(e => e.event === "completed" || e.event === "crashed") };
  });
  const [origin, prior, current] = rows;
  if (!origin || !prior || !current || binding.owner.deploymentId !== binding.lineageId
    || origin.start.branch_head_sha !== binding.initialHeadSha || origin.start.resumed_from_deployment_id
    || origin.start.timestamp !== binding.bounds.startedAt || origin.start.effective_timeout_seconds !== binding.bounds.runtimeMinutes * 60
    || prior.status.pid !== previous.process.pid || origin.start.ticket_slot_id !== `pa:${binding.repoKey}:${binding.ticket}`
    || ![1, 2, 3, 4].includes(origin.start.repository_permit ?? 0)
    || !/^ordinary-native-execution\/v1:workflow:[a-z][a-z0-9.-]{0,127}:[a-z][a-z0-9.-]{0,127}:[a-f0-9]{64}$/.test(origin.start.note ?? "")
    || prior.start.note !== origin.start.note || current.start.note !== origin.start.note
    || !["success", "partial", "failed", "crashed"].includes(prior.status.status) || prior.terminals.length !== 1
    || current.status.status !== "running" || current.terminals.length !== 0 || current.status.pid !== actor.process.pid
    || current.start.resumed_from_deployment_id !== previous.deploymentId || current.start.branch_head_sha !== state.candidateSha
    || !Number.isSafeInteger(current.start.effective_timeout_seconds) || current.start.effective_timeout_seconds! <= 0
    || Date.parse(current.start.timestamp) + current.start.effective_timeout_seconds! * 1000 > Date.parse(binding.bounds.deadlineAt)) throw workflowError();
  // Every immutable resume edge, not a mutable latest-status approximation.
  const chain = [...state.retiredOwners, state.activeOwner];
  for (let index = 0; index < chain.length; index++) {
    const holder = chain[index]!, events = queryReadonlyDeploymentEvents(holder.deploymentId), starts = events.filter(e => e.event === "started");
    const start = starts[0], status = queryReadonlyDeploymentStatus(holder.deploymentId);
    assertNativeRestartProcessDead(holder.process);
    if (starts.length !== 1 || !start || !status || start.note !== origin.start.note
      || start.resumed_from_deployment_id !== (index === 0 ? undefined : chain[index - 1]!.deploymentId)
      || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== "builder" || start.mode !== "orchestrator" || start.builder_authority !== "orchestrator"
      || start.rogue_one || start.parent_deployment_id || start.repo_root !== binding.repoRoot || start.worktree_root !== binding.worktreeRoot || start.ticket_id !== binding.ticket
      || start.branch_base_sha !== origin.start.branch_base_sha || start.treehouse_lease_id !== origin.start.treehouse_lease_id
      || start.treehouse_lease_holder !== origin.start.treehouse_lease_holder || start.ticket_slot_id !== origin.start.ticket_slot_id || start.repository_permit !== origin.start.repository_permit
      || status.pid !== holder.process.pid || !["success", "partial", "failed", "crashed"].includes(status.status)
      || events.filter(e => e.event === "completed" || e.event === "crashed").length !== 1) throw workflowError();
  }
  for (const { start } of rows) if (start.branch_base_sha !== origin.start.branch_base_sha || start.treehouse_lease_id !== origin.start.treehouse_lease_id
    || start.treehouse_lease_holder !== origin.start.treehouse_lease_holder || start.ticket_slot_id !== origin.start.ticket_slot_id
    || start.repository_permit !== origin.start.repository_permit) throw workflowError();
  return Object.freeze({ previous, actor, deploymentDirectory: getDeployPaths(actor.deploymentId).deployDir, candidateSha: state.candidateSha, custody: state.custody.state === "idle" ? "idle" : "active" });
}
