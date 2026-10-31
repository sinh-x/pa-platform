import {
  assertNativeRestartProcessDead, authenticateNativeExecutionRestart, captureRepositoryGitSnapshot, ExecutionCustodyService, getDeployPaths,
  observeReadonlyRepositoryAuthority, observeRetainedRepositoryTicketSlot, parseExecutionBinding, processIsWithinFingerprintLineage,
  queryReadonlyDeploymentEvents, queryReadonlyDeploymentStatus, readExecutionState, readProcessFingerprint, requireTicketLinkedBranch,
  resolveRepoExecutionPath, TicketStore, withExecutionWorktreeAdmission, withPreparedTicketCapacity, workflowDigest, workflowError,
  type ExecutionHolder, type ExecutionHost, type ExecutionWorktreeTransaction, type PreparedTicketCapacityTransaction,
  type StructuredTaskBaseline, type TreehouseLaunchEvidence,
} from "@pa-platform/pa-core";
import { NativeExecutionEvidence } from "./native-execution-evidence.js";
import { ordinaryExecutionOrigin, readRetainedOrdinaryNativeLineage } from "./execution-native.js";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { TreehouseClient } from "./treehouse.js";
import { parseStructuredLaunchNote, resolvePiStructuredBaseline, structuredLaunchNote } from "./workflow-consumers.js";
import { readPiProcessIdentity } from "./process-identity.js";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Trusted launcher only. No path/process/token/authority comes from tool JSON.
 * Selection is observational; reserve() is the first execution-journal mutation. */
export function selectPiStructuredResume(input: {
  previousId: string; deploymentId: string; repoKey: string; repoRoot: string; ticket: string; baseline: StructuredTaskBaseline;
  timeoutSeconds: number; treehouse: TreehouseClient; authority?: PiPreparedNativeAuthority;
}) {
  const priorStarts = queryReadonlyDeploymentEvents(input.previousId).filter(e => e.event === "started"), prior = priorStarts[0];
  if (priorStarts.length !== 1 || !prior || !parseStructuredLaunchNote(prior.note)
    || prior.note !== structuredLaunchNote("ordinary-native-execution/v1", input.baseline.authority)) throw workflowError();
  const priorStatus = queryReadonlyDeploymentStatus(input.previousId);
  if (!priorStatus || !["success", "partial", "failed", "crashed"].includes(priorStatus.status)
    || queryReadonlyDeploymentEvents(input.previousId).filter(e => e.event === "completed" || e.event === "crashed").length !== 1) throw workflowError();
  const origin = ordinaryExecutionOrigin(prior).start, runtime = input.authority ?? new PiPreparedNativeAuthority(), store = runtime.execution();
  if (!store || !prior.worktree_root) throw workflowError();
  const physical = resolveRepoExecutionPath(undefined, prior.worktree_root, { allowLinkedWorktreeCwd: true });
  if (physical.repoKey !== input.repoKey || physical.repoRoot !== input.repoRoot || physical.worktreeKind !== "linked" || physical.worktreeRoot !== prior.worktree_root) throw workflowError();
  const executionId = workflowDigest(JSON.stringify(["execution/v1", workflowDigest(JSON.stringify(["ordinary-native-execution/v1", origin.deployment_id])), origin.deployment_id]));
  const descriptorId = workflowDigest(JSON.stringify(["native-execution-descriptor/v1", executionId]));
  const descriptor = store.read(`${descriptorId}.intent.json`) as { schemaVersion?: string; binding?: unknown; launchSha256?: string };
  if (descriptor.schemaVersion !== "native-ordinary-execution-descriptor/v1") throw workflowError();
  const binding = parseExecutionBinding(descriptor.binding), initial = readExecutionState(store, binding);
  if (binding.repoKey !== input.repoKey || binding.repoRoot !== input.repoRoot || binding.ticket !== input.ticket || binding.worktreeRoot !== physical.worktreeRoot
    || binding.branch !== input.baseline.handoff.branch || binding.lineageId !== origin.deployment_id || initial.activeOwner.deploymentId !== input.previousId
    || initial.restartLaunch || initial.pendingRestart || initial.operation || initial.custody.inFlightOperation
    || !["idle", "orchestrator-direct"].includes(initial.custody.state) || initial.bounds.consecutiveNoProgress >= 3 || initial.bounds.replacementsUsed >= 3
    || initial.sequence >= 254 || !same(readPiProcessIdentity(input.previousId, getDeployPaths(input.previousId).deployDir), initial.activeOwner.process)) throw workflowError();
  const authority = observeReadonlyRepositoryAuthority(physical.gitDir), owner = authority.owner;
  const slot = observeRetainedRepositoryTicketSlot(input.repoRoot, input.ticket);
  if (!owner || authority.borrower || authority.implement || authority.review || owner.deploymentId !== input.previousId || slot.deploymentId !== input.previousId
    || owner.deploymentDirectory !== getDeployPaths(input.previousId).deployDir || slot.deploymentDirectory !== owner.deploymentDirectory
    || owner.ticket !== input.ticket || slot.ticket !== input.ticket || !same(slot.processFingerprint, owner.processFingerprint)
    || owner.directExecutionCustody !== (initial.custody.state === "idle" ? "idle" : "active")) throw workflowError();
  assertNativeRestartProcessDead(initial.activeOwner.process); assertNativeRestartProcessDead(owner.processFingerprint);
  const launch = readRetainedOrdinaryNativeLineage(origin, { deploymentId: input.previousId, repoKey: input.repoKey, repoRoot: input.repoRoot,
    worktreeRoot: physical.worktreeRoot, gitDir: physical.gitDir, ticket: input.ticket }, prior);
  if (descriptor.launchSha256 !== workflowDigest(JSON.stringify(launch))) throw workflowError();
  const deadline = Date.parse(initial.bounds.deadlineAt), remaining = Math.floor((deadline - Date.now()) / 1000) - 2;
  const timeoutSeconds = Math.min(input.timeoutSeconds, remaining);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw workflowError();
  const expectedLease = input.treehouse.authenticatePrepared(input.repoRoot, input.repoKey, input.ticket, physical.worktreeRoot);
  if (expectedLease.leaseId !== prior.treehouse_lease_id || expectedLease.leaseHolder !== prior.treehouse_lease_holder) throw workflowError();
  const fingerprint = readProcessFingerprint(process.pid); if (!fingerprint) throw workflowError();
  const launcher: ExecutionHolder = Object.freeze({ deploymentId: input.deploymentId, process: fingerprint });
  let capacity: PreparedTicketCapacityTransaction | null = null, worktree: ExecutionWorktreeTransaction | null = null;
  let evidenceRef: ReturnType<NativeExecutionEvidence["publish"]> | null = null, reserved = false, completed = false;
  const source = { store, binding };
  const reread = (allowMoved = false) => {
    const oldStatus = queryReadonlyDeploymentStatus(input.previousId), oldEvents = queryReadonlyDeploymentEvents(input.previousId);
    if (!oldStatus || !["success", "partial", "failed", "crashed"].includes(oldStatus.status)
      || oldEvents.filter(e => e.event === "completed" || e.event === "crashed").length !== 1
      || !same(oldEvents.filter(e => e.event === "started"), [prior]) || !same(store.read(`${descriptorId}.intent.json`), descriptor)) throw workflowError();
    const current = resolveRepoExecutionPath(undefined, physical.worktreeRoot, { allowLinkedWorktreeCwd: true });
    if (current.repoRoot !== physical.repoRoot || current.gitDir !== physical.gitDir || current.gitCommonDir !== physical.gitCommonDir) throw workflowError();
    const baseline = resolvePiStructuredBaseline(input.repoKey, input.repoRoot, input.ticket);
    if (!baseline || !same(baseline, input.baseline)) throw workflowError();
    const ticket = new TicketStore().get(input.ticket); if (!ticket) throw workflowError();
    const link = requireTicketLinkedBranch(ticket, input.repoKey), snapshot = captureRepositoryGitSnapshot(physical.worktreeRoot);
    if (link.state !== "materialized" || link.branch !== binding.branch || link.baseSha !== prior.branch_base_sha || link.headSha !== initial.candidateSha
      || snapshot.dirty || snapshot.branch !== binding.branch || snapshot.head !== initial.candidateSha || !same(snapshot, owner.authorityGitSnapshot ?? owner.preLaunchGitSnapshot)) throw workflowError();
    const lease = input.treehouse.authenticatePrepared(input.repoRoot, input.repoKey, input.ticket, physical.worktreeRoot);
    if (lease.path !== expectedLease.path || lease.leaseId !== expectedLease.leaseId || lease.leaseHolder !== expectedLease.leaseHolder) throw workflowError();
    if (!allowMoved && (!same(observeReadonlyRepositoryAuthority(physical.gitDir).owner, owner) || !same(observeRetainedRepositoryTicketSlot(input.repoRoot, input.ticket), slot))) throw workflowError();
    assertNativeRestartProcessDead(initial.activeOwner.process); assertNativeRestartProcessDead(owner.processFingerprint);
  };
  const host: ExecutionHost = { locks: {
    repository: run => withPreparedTicketCapacity({ canonicalRepoKey: input.repoKey, canonicalRepoRoot: input.repoRoot }, tx => { capacity = tx; try { return run(); } finally { capacity = null; } }),
    worktree: run => withExecutionWorktreeAdmission(input.repoRoot, physical.worktreeRoot, capacity!, tx => { worktree = tx; try { return run(); } finally { worktree = null; } }),
  }, now: () => new Date().toISOString(),
    authorize(_binding, actor, command) {
      if (typeof command === "string" || !["restart-launch", "restart-intent", "restart"].includes(command.action)
        || actor.deploymentId !== input.deploymentId || !same(readProcessFingerprint(process.pid), launcher.process)) throw workflowError();
      const starts = queryReadonlyDeploymentEvents(input.deploymentId).filter(e => e.event === "started"), current = starts[0], status = queryReadonlyDeploymentStatus(input.deploymentId);
      if (starts.length !== 1 || !current || !status || status.status !== "running" || current.resumed_from_deployment_id !== input.previousId
        || current.note !== prior.note || current.runtime !== "pi" || current.binary !== "ppa" || current.team !== "builder" || current.mode !== "orchestrator"
        || current.builder_authority !== "orchestrator" || current.rogue_one || current.parent_deployment_id || current.repo_root !== input.repoRoot
        || current.worktree_root !== physical.worktreeRoot || current.ticket_id !== input.ticket || current.treehouse_lease_id !== expectedLease.leaseId
        || current.treehouse_lease_holder !== expectedLease.leaseHolder || current.branch_head_sha !== initial.candidateSha || current.branch_base_sha !== prior.branch_base_sha
        || !Number.isSafeInteger(current.effective_timeout_seconds) || Date.parse(current.timestamp) + current.effective_timeout_seconds! * 1000 > deadline) throw workflowError();
      reread(command.action === "restart");
    },
    assertLive(actor) { if (!same(readProcessFingerprint(actor.process.pid), actor.process) || !processIsWithinFingerprintLineage(actor.process.pid, launcher.process)) throw workflowError(); },
    verifyEvidence(ref) { if (!evidenceRef || !same(ref, evidenceRef)) throw workflowError(); const row = evidence.read(ref, "restart-launch") as { executionId?: string; launcher?: unknown }; if (row.executionId !== executionId || !same(row.launcher, launcher)) throw workflowError(); },
    assertRestart(state, actor) {
      if (!state.pendingRestart) {
        if (actor.deploymentId !== launcher.deploymentId || (state.restartLaunch ? !same(state.restartLaunch.actor, launcher) : !same(actor, launcher))) throw workflowError();
        if (state.restartLaunch && !same(readPiProcessIdentity(actor.deploymentId, getDeployPaths(actor.deploymentId).deployDir), actor.process)) throw workflowError();
      } else authenticateNativeExecutionRestart(source);
    },
    assertHandover() { throw workflowError(); },
    projectCustody(_state, command, stage) {
      if (command.action !== "restart" || stage !== "before") return;
      reread(true); worktree!.handoffDirectOwner(owner, source); capacity!.handoffExecution(slot, source, worktree!);
    },
  };
  const evidence = new NativeExecutionEvidence(store, runtime.evidenceRoot(), host.locks), service = new ExecutionCustodyService(store, binding, host);
  reread();
  const treehouse: TreehouseLaunchEvidence = Object.freeze({ authority: "orchestrator", ticket: input.ticket, path: physical.worktreeRoot,
    leaseId: expectedLease.leaseId, leaseHolder: expectedLease.leaseHolder, branch: binding.branch, branchState: "materialized",
    baseSha: prior.branch_base_sha, headSha: initial.candidateSha, ticketSlotId: slot.slotId, repositoryPermit: slot.repositoryPermit });
  return { worktreeRoot: physical.worktreeRoot, treehouse, timeoutSeconds, note: prior.note!, binding,
    reread: () => reread(),
    reserve() {
      if (reserved) throw workflowError(); reread();
      evidenceRef = evidence.publish("restart-launch", { executionId, launcher, previousId: input.previousId, initialSequence: initial.sequence,
        owner, slot, candidateSha: initial.candidateSha, leaseId: expectedLease.leaseId });
      service.reserveRestartLaunch(launcher, initial.sequence, evidenceRef); reserved = true;
    },
    bindChild(pid: number) {
      if (!reserved || completed || !evidenceRef) throw workflowError(); const process = readProcessFingerprint(pid); if (!process) throw workflowError();
      const actor = { deploymentId: input.deploymentId, process }, launch = readExecutionState(store, binding).restartLaunch;
      if (!launch || !same(launch.actor, launcher)) throw workflowError();
      const pending = service.prepareRestart(actor, launch.sequence, evidenceRef); service.restart(actor, pending.sequence, evidenceRef); completed = true;
      return { canonicalRepoRoot: input.repoRoot, worktreeRoot: physical.worktreeRoot, repositoryGitDir: physical.gitDir,
        repositoryGitCommonDir: physical.gitCommonDir, slot: "orchestrator" as const, ownershipToken: owner.ownershipToken,
        ticketSlot: { canonicalRepoKey: input.repoKey, canonicalRepoRoot: input.repoRoot, ticket: input.ticket, slotId: slot.slotId, slotToken: slot.slotToken, repositoryPermit: slot.repositoryPermit } };
    },
    assertCompleted() { if (!completed) throw workflowError(); },
  };
}
export type PiStructuredResume = ReturnType<typeof selectPiStructuredResume>;
