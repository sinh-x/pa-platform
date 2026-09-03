import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExecutionPlan } from "./plan.js";

const LEASE_SCHEMA_VERSION = 1;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const DIAGNOSTIC_MAX = 2_000;
const LEASE_FILE_NAME = "pa-repository-mutation.lease.json";
const LIFECYCLE_FILE_NAME = "repository-lifecycle.json";
const TRANSITION_LOCK_FILE_NAME = "repository-lifecycle.transition.lock";

export type CheckoutKind = "branch" | "detached";

export interface RepositoryCheckoutState {
  kind: CheckoutKind;
  branch?: string;
  head: string;
  porcelain: string;
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
}

export interface RepositoryLeaseEvidence {
  schemaVersion: 1;
  role: "reader" | "owner" | "delegate" | "dry-run";
  state: "active" | "released" | "recovery-required" | "not-required";
  repositoryKey: string;
  repositoryRoot: string;
  deploymentId: string;
  ownerDeploymentId?: string;
  leasePath?: string;
  acquiredAt?: string;
  releasedAt?: string;
  before?: RepositoryCheckoutState;
  after?: RepositoryCheckoutState;
  diagnostic?: string;
  branchCleanup?: RepositoryBranchCleanupEvidence;
}

export interface RepositoryBranchCleanupEvidence {
  featureBranch: string;
  mergeEvidence: string;
  policy: BranchCleanupPolicy;
  attemptedAt?: string;
  result?: BranchCleanupResult;
}

interface RepositoryLifecycleRecord extends RepositoryLeaseEvidence {
  leaseToken?: string;
}

interface DurableLease {
  schemaVersion: 1;
  token: string;
  repositoryKey: string;
  repositoryRoot: string;
  deploymentId: string;
  deploymentDir: string;
  runtime: string;
  mode: string;
  pid: number;
  acquiredAt: string;
  before: RepositoryCheckoutState;
}

export interface RepositoryLifecycleOptions {
  dryRun?: boolean;
  resumeDeploymentId?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
}

export interface RepositoryLifecycleResult {
  ok: boolean;
  evidence?: RepositoryLeaseEvidence;
  diagnostic?: string;
}

export interface BranchCleanupPolicy {
  deleteLocal: boolean;
  deleteRemote?: boolean;
}

export interface BranchCleanupResult {
  deletedLocal: boolean;
  deletedRemote: boolean;
  diagnostic?: string;
}

export function combineRuntimeAndLifecycleError(runtimeError?: string, lifecycleError?: string): string | undefined {
  return lifecycleError ? [runtimeError, lifecycleError].filter(Boolean).join("; ") : runtimeError;
}

export type MergeEvidence =
  | { kind: "github"; pr: number; mergeCommit: string; target: string; ci: "passed" | "verified" | "unverified"; verified: true }
  | { kind: "local"; mergeCommit: string; target: string; remote: string; ancestor: true; verified: true };

/**
 * Activates the repository contract after resolution and before primer/runtime work.
 * The returned immutable plan is the only plan adapters may launch.
 */
export function activateRepositoryLifecycle(plan: ExecutionPlan, options: RepositoryLifecycleOptions = {}): ExecutionPlan {
  if (options.resumeDeploymentId) assertResumeUsesRegisteredLifecycle(options.resumeDeploymentId, plan);

  const baseEvidence: RepositoryLeaseEvidence = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    role: options.dryRun ? "dry-run" : plan.repositoryAccess === "read-only" ? "reader" : "owner",
    state: options.dryRun || plan.repositoryAccess === "read-only" ? "not-required" : "active",
    repositoryKey: plan.repoKey,
    repositoryRoot: plan.repoRoot,
    deploymentId: plan.lifecycle.deploymentId,
    ...branchCleanupFromEnvironment({ ...process.env, ...plan.environment }),
  };

  if (options.dryRun || plan.repositoryAccess === "read-only") {
    persistLifecycle(plan.lifecycle.deploymentDir, baseEvidence);
    return withLifecycle(plan, baseEvidence);
  }

  const leasePath = repositoryLeasePath(plan.repoRoot);
  const inherited = options.env ?? process.env;
  const inheritedOwner = inherited["PA_REPOSITORY_LEASE_OWNER"];
  const inheritedToken = inherited["PA_REPOSITORY_LEASE_TOKEN"];
  const existing = readLeaseIfPresent(leasePath);

  if (existing && inheritedOwner === existing.deploymentId && inheritedToken === existing.token && sameRepository(existing, plan)) {
    if (!processAlive(existing.pid)) {
      throw lifecycleError(`Repository mutation lease delegation was rejected because owner ${ownerSummary(existing)} is not live.`, existing);
    }
    const evidence: RepositoryLeaseEvidence = {
      ...baseEvidence,
      role: "delegate",
      ownerDeploymentId: existing.deploymentId,
      leasePath,
      acquiredAt: existing.acquiredAt,
      before: existing.before,
    };
    persistLifecycle(plan.lifecycle.deploymentDir, evidence);
    return withLifecycle(plan, evidence, existing.token);
  }

  acquireDurableLease(plan, leasePath, options.pid ?? process.pid);
  const acquired = readLeaseRequired(leasePath);
  const evidence: RepositoryLeaseEvidence = {
    ...baseEvidence,
    role: "owner",
    ownerDeploymentId: acquired.deploymentId,
    leasePath,
    acquiredAt: acquired.acquiredAt,
    before: acquired.before,
  };
  try {
    persistLifecycle(plan.lifecycle.deploymentDir, { ...evidence, leaseToken: acquired.token });
  } catch (error) {
    const current = readLeaseIfPresent(leasePath);
    if (current?.token === acquired.token && current.deploymentId === acquired.deploymentId) {
      unlinkSync(leasePath);
      syncDirectory(dirname(leasePath));
    }
    throw error;
  }
  return withLifecycle(plan, evidence, acquired.token);
}

/** Background-runner entrypoint transfer; it must run before the runtime child starts. */
export function transferRepositoryLeaseByDeployment(deploymentDir: string, pid: number): void {
  withTransitionLock(deploymentDir, () => transferRepositoryLeaseByDeploymentUnlocked(deploymentDir, pid));
}

function transferRepositoryLeaseByDeploymentUnlocked(deploymentDir: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Repository mutation lease requires a positive background owner PID.");
  const lifecyclePath = resolve(deploymentDir, LIFECYCLE_FILE_NAME);
  if (!existsSync(lifecyclePath)) return;
  const evidence = readLifecycle(lifecyclePath);
  if (evidence.role !== "owner" || evidence.state !== "active" || !evidence.leasePath) return;
  const lease = readLeaseIfPresent(evidence.leasePath);
  if (!lease) {
    const persisted = readLifecycle(lifecyclePath);
    if (persisted.state === "released" && persisted.deploymentId === evidence.deploymentId) return;
    throw new Error(`Repository mutation lease disappeared before background ownership transfer: ${evidence.leasePath}`);
  }
  if (lease.deploymentId !== evidence.deploymentId || lease.repositoryKey !== evidence.repositoryKey || lease.repositoryRoot !== evidence.repositoryRoot || lease.token !== evidence.leaseToken) throw new Error(`Refusing to transfer another owner's repository mutation lease: ${ownerSummary(lease)}.`);
  atomicWriteJson(evidence.leasePath, { ...lease, pid });
}

/**
 * Restores and releases an owned lease. Delegates never restore or release their
 * owner's checkout. Repeated calls are safe and never unlink another owner.
 */
export function finalizeRepositoryLifecycle(planOrDeploymentDir: ExecutionPlan | string): RepositoryLifecycleResult {
  const deploymentDir = typeof planOrDeploymentDir === "string" ? planOrDeploymentDir : planOrDeploymentDir.lifecycle.deploymentDir;
  return withTransitionLock(deploymentDir, () => finalizeRepositoryLifecycleUnlocked(deploymentDir));
}

/** Persist authenticated merge evidence produced after deployment activation. */
export function recordRepositoryBranchCleanupByDeployment(
  deploymentDir: string,
  featureBranch: string,
  mergeEvidence: string,
  policy: BranchCleanupPolicy,
  leaseToken: string,
): void {
  withTransitionLock(deploymentDir, () => {
    const lifecyclePath = resolve(deploymentDir, LIFECYCLE_FILE_NAME);
    const evidence = readLifecycle(lifecyclePath);
    if (evidence.role !== "owner" || evidence.state !== "active" || !evidence.leasePath || !evidence.leaseToken || !leaseToken || evidence.leaseToken !== leaseToken) {
      throw new Error("Repository branch cleanup evidence rejected: active lifecycle owner authentication failed.");
    }
    const lease = readLeaseRequired(evidence.leasePath);
    if (lease.token !== leaseToken || lease.deploymentId !== evidence.deploymentId || lease.repositoryKey !== evidence.repositoryKey || lease.repositoryRoot !== evidence.repositoryRoot) {
      throw new Error(`Repository branch cleanup evidence rejected for non-owner ${evidence.deploymentId}.`);
    }
    validateBranch(featureBranch);
    parseMergeEvidence(mergeEvidence);
    persistLifecycle(deploymentDir, {
      ...evidence,
      branchCleanup: { featureBranch, mergeEvidence, policy: { ...policy } },
    });
  });
}

function finalizeRepositoryLifecycleUnlocked(deploymentDir: string): RepositoryLifecycleResult {
  const lifecyclePath = resolve(deploymentDir, LIFECYCLE_FILE_NAME);
  if (!existsSync(lifecyclePath)) return { ok: true };
  const evidence = readLifecycle(lifecyclePath);
  if (evidence.state === "released" || evidence.state === "not-required") return { ok: true, evidence };
  if (evidence.role === "delegate" || evidence.role === "dry-run") {
    const released = { ...evidence, state: "released" as const, releasedAt: new Date().toISOString() };
    persistLifecycle(deploymentDir, released);
    return { ok: true, evidence: released };
  }
  if (!evidence.leasePath || !evidence.before) return recoveryRequired(deploymentDir, evidence, "Repository mutation lease evidence is incomplete; preserve the checkout and inspect the lifecycle sidecar before retrying.");

  const lease = readLeaseIfPresent(evidence.leasePath);
  if (!lease) {
    try {
      const after = captureCheckout(evidence.repositoryRoot);
      assertCheckoutEqual(evidence.before, after);
      const released = applyBranchCleanup({ ...evidence, state: "released" as const, releasedAt: new Date().toISOString(), after });
      persistLifecycle(deploymentDir, released);
      return { ok: true, evidence: released };
    } catch (error) {
      return recoveryRequired(deploymentDir, evidence, bounded(`Repository mutation lease disappeared before an ownership-matched release could be verified. ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (lease.deploymentId !== evidence.deploymentId || lease.repositoryKey !== evidence.repositoryKey || lease.repositoryRoot !== evidence.repositoryRoot || lease.token !== evidence.leaseToken) {
    return recoveryRequired(deploymentDir, evidence, `Refusing to release another owner's repository mutation lease: ${ownerSummary(lease)}.`);
  }

  try {
    restoreCheckout(lease.repositoryRoot, lease.before);
    const after = captureCheckout(lease.repositoryRoot);
    assertCheckoutEqual(lease.before, after);
    const current = readLeaseRequired(evidence.leasePath);
    if (current.token !== lease.token || current.deploymentId !== lease.deploymentId) {
      return recoveryRequired(deploymentDir, evidence, `Repository mutation lease ownership changed during restoration; current owner is ${ownerSummary(current)}.`);
    }
    const released = applyBranchCleanup({ ...evidence, state: "released" as const, releasedAt: new Date().toISOString(), after });
    unlinkSync(evidence.leasePath);
    syncDirectory(dirname(evidence.leasePath));
    persistLifecycle(deploymentDir, released);
    return { ok: true, evidence: released };
  } catch (error) {
    return recoveryRequired(deploymentDir, evidence, recoveryDiagnostic(error, lease));
  }
}

/** Reject old worktree orchestration evidence without writing to the report or repository. */
export function assertRegisteredProjectOrchestrationReport(content: string, reportPath = "orchestration report"): void {
  const normalized = content.replace(/[*_`>#|]/g, "");
  const legacy = /(?:^|\n)\s*(?:Execution strategy|Worktree|Worktree path|Canonical Repository|Canonical checkout)\s*(?::|$)/im.test(normalized)
    || /PA-managed worktree|strategy\s*=\s*(?:canonical|worktree)|git\s+(?:-C\s+\S+\s+)?worktree\s+(?:add|remove|prune)/i.test(normalized);
  if (!legacy) return;
  throw new Error(bounded(`Legacy worktree orchestration report rejected without mutation: ${reportPath}. Inspect the named report and checkout, preserve every unmerged commit and dirty file, restore the registered checkout manually if necessary, then resolve or archive the legacy run and start a fresh registered-project-path orchestration. Automatic migration is prohibited.`));
}

export function parseMergeEvidence(value: string): MergeEvidence {
  const fields = new Map(value.split(";").slice(1).map((part) => {
    const index = part.indexOf("=");
    return index < 1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
  const sha = /^[0-9a-f]{40}$/;
  const branch = /^(?!-)(?!.*(?:\.\.|@\{|[~^:?*\\\[\s]))[^/]+(?:\/[^/]+)*$/;
  if (value.startsWith("github:")) {
    const prText = value.slice("github:".length).split(";", 1)[0]?.replace(/^pr=/, "") ?? "";
    const pr = Number(prText);
    const mergeCommit = fields.get("merge_commit") ?? "";
    const target = fields.get("target") ?? "";
    const ci = fields.get("ci");
    if (!Number.isInteger(pr) || pr <= 0 || !sha.test(mergeCommit) || !branch.test(target) || !new Set(["passed", "verified", "unverified"]).has(ci ?? "") || fields.get("verified") !== "true") throw new Error("Malformed GitHub merge evidence.");
    return { kind: "github", pr, mergeCommit, target, ci: ci as "passed" | "verified" | "unverified", verified: true };
  }
  if (value.startsWith("local:")) {
    const first = value.slice("local:".length).split(";", 1)[0] ?? "";
    const [firstKey, firstValue] = first.split("=", 2);
    if (firstKey && firstValue) fields.set(firstKey, firstValue);
    const mergeCommit = fields.get("merge_commit") ?? "";
    const target = fields.get("target") ?? "";
    const remote = fields.get("remote") ?? "";
    if (!sha.test(mergeCommit) || !sha.test(remote) || !branch.test(target) || fields.get("ancestor") !== "true" || fields.get("verified") !== "true") throw new Error("Malformed local merge evidence.");
    return { kind: "local", mergeCommit, target, remote, ancestor: true, verified: true };
  }
  throw new Error("Unsupported merge evidence class; expected github or local.");
}

/** Optional cleanup policy; default-deny callers must explicitly permit deletion. */
export function cleanupMergedFeatureBranch(repoRoot: string, featureBranch: string, rawEvidence: string, policy: BranchCleanupPolicy): BranchCleanupResult {
  if (!policy.deleteLocal && !policy.deleteRemote) return { deletedLocal: false, deletedRemote: false, diagnostic: "Branch cleanup policy does not permit deletion." };
  const evidence = parseMergeEvidence(rawEvidence);
  validateBranch(featureBranch);
  const current = git(repoRoot, ["branch", "--show-current"]);
  if (current === featureBranch) throw new Error(`Never delete currently checked-out branch ${featureBranch}.`);
  const featureHead = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${featureBranch}`]);
  const targetRef = firstExistingRef(repoRoot, [`refs/remotes/origin/${evidence.target}`, `refs/heads/${evidence.target}`]);
  if (!targetRef) throw new Error(`Merge evidence target ${evidence.target} is not available locally.`);
  requireAncestor(repoRoot, featureHead, targetRef, `Feature branch ${featureBranch} is not merged into ${evidence.target}.`);
  requireAncestor(repoRoot, evidence.mergeCommit, targetRef, `Persisted merge commit ${evidence.mergeCommit} is not contained by ${evidence.target}.`);
  if (evidence.kind === "local" && evidence.remote !== git(repoRoot, ["rev-parse", targetRef])) throw new Error("Local merge evidence remote SHA does not match the verified target ref.");

  let deletedLocal = false;
  let deletedRemote = false;
  if (policy.deleteLocal) {
    git(repoRoot, ["update-ref", "-d", `refs/heads/${featureBranch}`, featureHead]);
    deletedLocal = true;
  }
  if (policy.deleteRemote) {
    if (!deletedLocal && current === featureBranch) throw new Error(`Never delete currently checked-out branch ${featureBranch}.`);
    git(repoRoot, ["push", "origin", "--delete", featureBranch]);
    deletedRemote = true;
  }
  return { deletedLocal, deletedRemote };
}

function acquireDurableLease(plan: ExecutionPlan, leasePath: string, pid: number): void {
  mkdirSync(dirname(leasePath), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = readLeaseIfPresent(leasePath);
    if (existing) {
      if (processAlive(existing.pid)) throw lifecycleError(`Repository mutation lease conflict: ${ownerSummary(existing)}. Retry after the owner completes.`, existing);
      recoverStaleLease(existing, leasePath);
      continue;
    }

    const before = captureCheckout(plan.repoRoot);
    assertClean(before, plan.repoKey, plan.repoRoot);
    const lease: DurableLease = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      token: randomUUID(),
      repositoryKey: plan.repoKey,
      repositoryRoot: plan.repoRoot,
      deploymentId: plan.lifecycle.deploymentId,
      deploymentDir: plan.lifecycle.deploymentDir,
      runtime: plan.runtime,
      mode: plan.mode,
      pid,
      acquiredAt: new Date().toISOString(),
      before,
    };
    try {
      createExclusiveJson(leasePath, lease);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const owner = readLeaseIfPresent(leasePath);
  throw new Error(bounded(`Repository mutation lease could not be serialized${owner ? `; current owner ${ownerSummary(owner)}` : " after concurrent recovery"}.`));
}

function recoverStaleLease(lease: DurableLease, leasePath: string): void {
  try {
    restoreCheckout(lease.repositoryRoot, lease.before);
    assertCheckoutEqual(lease.before, captureCheckout(lease.repositoryRoot));
  } catch (error) {
    const diagnostic = bounded(`Stale repository mutation lease recovery is required before another deployment may run. ${recoveryDiagnostic(error, lease)}`);
    const persistence = persistStaleRecoveryRequired(lease, leasePath, diagnostic);
    throw lifecycleError(`${diagnostic}${persistence ? ` Recovery evidence persistence also failed: ${persistence}` : ""}`, lease);
  }
  const quarantine = `${leasePath}.recovered-${Date.now()}-${process.pid}`;
  try {
    renameSync(leasePath, quarantine);
    syncDirectory(dirname(leasePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const recovered: RepositoryLeaseEvidence = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    role: "owner",
    state: "released",
    repositoryKey: lease.repositoryKey,
    repositoryRoot: lease.repositoryRoot,
    deploymentId: lease.deploymentId,
    ownerDeploymentId: lease.deploymentId,
    leasePath,
    acquiredAt: lease.acquiredAt,
    releasedAt: new Date().toISOString(),
    before: lease.before,
    after: captureCheckout(lease.repositoryRoot),
    diagnostic: `Recovered stale owner PID ${lease.pid} after liveness and exact-checkout verification.`,
  };
  try { persistLifecycle(lease.deploymentDir, recovered); } catch { /* quarantine remains durable recovery evidence */ }
}

function restoreCheckout(repoRoot: string, before: RepositoryCheckoutState): void {
  const current = captureCheckout(repoRoot);
  assertClean(current, "registered repository", repoRoot);
  if (before.kind === "branch") {
    if (!before.branch) throw new Error("Captured branch identity is missing.");
    const originalRef = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${before.branch}`]);
    if (originalRef !== before.head) throw new Error(`Original branch ${before.branch} moved from ${before.head} to ${originalRef}; refusing to reset or discard commits.`);
    if (current.branch !== before.branch) git(repoRoot, ["checkout", "--quiet", before.branch]);
  } else if (current.kind !== "detached" || current.head !== before.head) {
    git(repoRoot, ["checkout", "--quiet", "--detach", before.head]);
  }
}

export function captureRepositoryCheckout(repoRoot: string): RepositoryCheckoutState {
  return captureCheckout(repoRoot);
}

function captureCheckout(repoRoot: string): RepositoryCheckoutState {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const branch = gitOptional(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return {
    kind: branch ? "branch" : "detached",
    ...(branch ? { branch } : {}),
    head,
    porcelain: gitRaw(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: splitNul(gitRaw(repoRoot, ["diff", "--cached", "--name-only", "-z"])),
    unstaged: splitNul(gitRaw(repoRoot, ["diff", "--name-only", "-z"])),
    untracked: splitNul(gitRaw(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])),
  };
}

function assertClean(state: RepositoryCheckoutState, repoKey: string, repoRoot: string): void {
  if (!state.porcelain && state.staged.length === 0 && state.unstaged.length === 0 && state.untracked.length === 0) return;
  throw new Error(bounded(`Mutating deployment rejected before checkout mutation: registered repository ${repoKey} at ${repoRoot} is dirty (staged=${state.staged.length}, unstaged=${state.unstaged.length}, untracked=${state.untracked.length}). Preserve the files and restore a zero-entry porcelain status before retrying.`));
}

function assertCheckoutEqual(expected: RepositoryCheckoutState, actual: RepositoryCheckoutState): void {
  if (expected.kind !== actual.kind || expected.branch !== actual.branch || expected.head !== actual.head || expected.porcelain !== actual.porcelain || !sameList(expected.staged, actual.staged) || !sameList(expected.unstaged, actual.unstaged) || !sameList(expected.untracked, actual.untracked)) {
    throw new Error(`Exact checkout restoration failed: expected ${checkoutSummary(expected)}; found ${checkoutSummary(actual)}. No reset, clean, or untracked-file deletion was attempted.`);
  }
}

function assertResumeUsesRegisteredLifecycle(deploymentId: string, plan: ExecutionPlan): void {
  const priorDir = resolve(dirname(plan.lifecycle.deploymentDir), deploymentId);
  const lifecycle = resolve(priorDir, LIFECYCLE_FILE_NAME);
  if (existsSync(lifecycle)) {
    const prior = readLifecycle(lifecycle);
    if (prior.repositoryKey !== plan.repoKey || prior.repositoryRoot !== plan.repoRoot) throw new Error(bounded(`Resume repository identity mismatch: deployment ${deploymentId} recorded ${prior.repositoryKey} at ${prior.repositoryRoot}, but this plan resolved ${plan.repoKey} at ${plan.repoRoot}.`));
  }
  for (const candidate of [resolve(priorDir, "primer.md"), resolve(priorDir, "orchestration-report.md")]) {
    if (existsSync(candidate)) assertRegisteredProjectOrchestrationReport(readBounded(candidate), candidate);
  }
}

function repositoryLeasePath(repoRoot: string): string {
  const gitDirText = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  const gitDir = isAbsolute(gitDirText) ? gitDirText : resolve(repoRoot, gitDirText);
  return resolve(gitDir, LEASE_FILE_NAME);
}

function withLifecycle(plan: ExecutionPlan, repositoryLease: RepositoryLeaseEvidence, token?: string): ExecutionPlan {
  const environment = Object.freeze({
    ...plan.environment,
    ...(repositoryLease.ownerDeploymentId ? { PA_REPOSITORY_LEASE_OWNER: repositoryLease.ownerDeploymentId } : {}),
    ...(repositoryLease.leasePath ? { PA_REPOSITORY_LEASE_PATH: repositoryLease.leasePath } : {}),
    ...(token ? { PA_REPOSITORY_LEASE_TOKEN: token } : {}),
  });
  return Object.freeze({ ...plan, environment, repositoryLease: freezeRepositoryLeaseEvidence(repositoryLease) });
}

function freezeRepositoryLeaseEvidence(evidence: RepositoryLeaseEvidence): Readonly<RepositoryLeaseEvidence> {
  const freezeCheckout = (state: RepositoryCheckoutState | undefined): RepositoryCheckoutState | undefined => state && Object.freeze({
    ...state,
    staged: Object.freeze([...state.staged]),
    unstaged: Object.freeze([...state.unstaged]),
    untracked: Object.freeze([...state.untracked]),
  });
  const branchCleanup = evidence.branchCleanup && Object.freeze({
    ...evidence.branchCleanup,
    policy: Object.freeze({ ...evidence.branchCleanup.policy }),
    ...(evidence.branchCleanup.result ? { result: Object.freeze({ ...evidence.branchCleanup.result }) } : {}),
  });
  return Object.freeze({
    ...evidence,
    ...(evidence.before ? { before: freezeCheckout(evidence.before) } : {}),
    ...(evidence.after ? { after: freezeCheckout(evidence.after) } : {}),
    ...(branchCleanup ? { branchCleanup } : {}),
  });
}

function readLeaseIfPresent(path: string): DurableLease | undefined {
  if (!existsSync(path)) return undefined;
  const value = readJson(path) as Partial<DurableLease>;
  if (value.schemaVersion !== LEASE_SCHEMA_VERSION || typeof value.token !== "string" || typeof value.repositoryKey !== "string" || typeof value.repositoryRoot !== "string" || typeof value.deploymentId !== "string" || typeof value.deploymentDir !== "string" || typeof value.runtime !== "string" || typeof value.mode !== "string" || !Number.isInteger(value.pid) || Number(value.pid) <= 0 || typeof value.acquiredAt !== "string" || !validCheckout(value.before)) {
    throw new Error(bounded(`Repository mutation lease evidence at ${path} is malformed. Do not delete it blindly; inspect repository state and preserve the file for manual recovery.`));
  }
  return value as DurableLease;
}

function readLeaseRequired(path: string): DurableLease {
  const lease = readLeaseIfPresent(path);
  if (!lease) throw new Error(`Repository mutation lease is missing: ${path}`);
  return lease;
}

function readLifecycle(path: string): RepositoryLifecycleRecord {
  const value = readJson(path) as Partial<RepositoryLifecycleRecord>;
  if (value.schemaVersion !== LEASE_SCHEMA_VERSION || typeof value.role !== "string" || typeof value.state !== "string" || typeof value.repositoryKey !== "string" || typeof value.repositoryRoot !== "string" || typeof value.deploymentId !== "string") throw new Error(bounded(`Repository lifecycle evidence is malformed: ${path}.`));
  return value as RepositoryLifecycleRecord;
}

function validCheckout(value: unknown): value is RepositoryCheckoutState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RepositoryCheckoutState>;
  return (state.kind === "branch" || state.kind === "detached") && typeof state.head === "string" && typeof state.porcelain === "string" && Array.isArray(state.staged) && Array.isArray(state.unstaged) && Array.isArray(state.untracked) && (state.kind === "detached" || typeof state.branch === "string");
}

function persistLifecycle(deploymentDir: string, evidence: RepositoryLifecycleRecord): void {
  mkdirSync(deploymentDir, { recursive: true });
  atomicWriteJson(resolve(deploymentDir, LIFECYCLE_FILE_NAME), evidence);
}

function recoveryRequired(deploymentDir: string, evidence: RepositoryLeaseEvidence, diagnostic: string): RepositoryLifecycleResult {
  const safe = bounded(diagnostic);
  const failed = { ...evidence, state: "recovery-required" as const, diagnostic: safe };
  persistLifecycle(deploymentDir, failed);
  return { ok: false, evidence: failed, diagnostic: safe };
}

function persistStaleRecoveryRequired(lease: DurableLease, leasePath: string, diagnostic: string): string | undefined {
  const evidence: RepositoryLeaseEvidence = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    role: "owner",
    state: "recovery-required",
    repositoryKey: lease.repositoryKey,
    repositoryRoot: lease.repositoryRoot,
    deploymentId: lease.deploymentId,
    ownerDeploymentId: lease.deploymentId,
    leasePath,
    acquiredAt: lease.acquiredAt,
    before: lease.before,
    diagnostic: bounded(diagnostic),
  };
  try {
    persistLifecycle(lease.deploymentDir, evidence);
    return undefined;
  } catch (error) {
    const persistenceError = bounded(error instanceof Error ? error.message : String(error));
    try {
      atomicWriteJson(`${leasePath}.recovery-required.json`, { ...evidence, diagnostic: bounded(`${diagnostic} Lifecycle persistence failed: ${persistenceError}`) });
      return persistenceError;
    } catch (fallbackError) {
      return bounded(`${persistenceError}; fallback persistence failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }
}

function branchCleanupFromEnvironment(environment: Readonly<Record<string, string | undefined>>): Pick<RepositoryLeaseEvidence, "branchCleanup"> | Record<string, never> {
  const featureBranch = environment["PA_FEATURE_BRANCH"];
  const mergeEvidence = environment["PA_MERGE_EVIDENCE"];
  if (!featureBranch || !mergeEvidence) return {};
  return {
    branchCleanup: {
      featureBranch,
      mergeEvidence,
      policy: {
        deleteLocal: environment["PA_BRANCH_CLEANUP_LOCAL"] === "true",
        deleteRemote: environment["PA_BRANCH_CLEANUP_REMOTE"] === "true",
      },
    },
  };
}

function applyBranchCleanup(evidence: RepositoryLeaseEvidence): RepositoryLeaseEvidence {
  const request = evidence.branchCleanup;
  if (!request || request.attemptedAt) return evidence;
  const attemptedAt = new Date().toISOString();
  try {
    const result = cleanupMergedFeatureBranch(evidence.repositoryRoot, request.featureBranch, request.mergeEvidence, request.policy);
    return { ...evidence, branchCleanup: { ...request, attemptedAt, result } };
  } catch (error) {
    const diagnostic = bounded(`Branch cleanup failed after checkout restoration; repository lease release continued: ${error instanceof Error ? error.message : String(error)}`);
    return { ...evidence, branchCleanup: { ...request, attemptedAt, result: { deletedLocal: false, deletedRemote: false, diagnostic } } };
  }
}

function withTransitionLock<T>(deploymentDir: string, operation: () => T): T {
  mkdirSync(deploymentDir, { recursive: true });
  const lockPath = resolve(deploymentDir, TRANSITION_LOCK_FILE_NAME);
  mkdirSync(lockPath, { recursive: true });
  const token = randomUUID();
  const claimName = `${process.hrtime.bigint().toString().padStart(20, "0")}-${token}.json`;
  const claimPath = resolve(lockPath, claimName);
  createExclusiveJson(claimPath, { token, pid: process.pid });
  const deadline = Date.now() + 5_000;
  while (true) {
    for (const candidate of readdirSync(lockPath).filter((name) => name.endsWith(".json")).sort()) {
      try {
        const value = readJson(resolve(lockPath, candidate)) as { token?: unknown; pid?: unknown };
        if (typeof value.token === "string" && Number.isInteger(value.pid) && Number(value.pid) > 0 && !processAlive(Number(value.pid))) unlinkSync(resolve(lockPath, candidate));
      } catch { /* preserve unknown transition evidence and fail boundedly */ }
    }
    const owner = readdirSync(lockPath).filter((name) => name.endsWith(".json")).sort()[0];
    if (owner === claimName) break;
    if (Date.now() >= deadline) {
      try { unlinkSync(claimPath); } catch { /* claim may already be absent */ }
      throw new Error(bounded(`Repository lifecycle transition lock unavailable: ${lockPath}.`));
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return operation();
  } finally {
    try { unlinkSync(claimPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function recoveryDiagnostic(error: unknown, lease: DurableLease): string {
  const reason = error instanceof Error ? error.message : String(error);
  return bounded(`Repository recovery required for ${lease.repositoryKey} at ${lease.repositoryRoot}; lease owner deployment=${lease.deploymentId}, pid=${lease.pid}, acquired=${lease.acquiredAt}. ${reason} Preserve dirty/unmerged work, do not run git reset/clean or delete the lease, restore ${checkoutSummary(lease.before)} manually, then retry terminal recovery.`);
}

function lifecycleError(prefix: string, lease: DurableLease): Error {
  return new Error(bounded(`${prefix} Lease path=${repositoryLeasePath(lease.repositoryRoot)}. Recovery: verify owner liveness and registry status; never remove a live owner's lease. If stale, preserve dirty/unmerged work and retry so exact checkout recovery can run.`));
}

function ownerSummary(lease: DurableLease): string {
  return `deployment=${lease.deploymentId}, pid=${lease.pid}, runtime=${lease.runtime}, mode=${lease.mode}, acquired=${lease.acquiredAt}, repo=${lease.repositoryKey}@${lease.repositoryRoot}`;
}

function checkoutSummary(state: RepositoryCheckoutState): string {
  return `${state.kind === "branch" ? `branch=${state.branch}` : "detached"}@${state.head}, staged=${state.staged.length}, unstaged=${state.unstaged.length}, untracked=${state.untracked.length}`;
}

function sameRepository(lease: DurableLease, plan: ExecutionPlan): boolean {
  return lease.repositoryKey === plan.repoKey && lease.repositoryRoot === plan.repoRoot;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function createExclusiveJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function readJson(path: string): unknown {
  const body = readBounded(path);
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error(bounded(`Invalid JSON evidence at ${path}; preserve it for manual recovery.`)); }
}

function readBounded(path: string): string {
  const body = readFileSync(path, "utf8");
  if (Buffer.byteLength(body) > MAX_EVIDENCE_BYTES) throw new Error(bounded(`Evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes: ${path}.`));
  return body;
}

function git(repoRoot: string, args: string[]): string {
  return gitRaw(repoRoot, args).replace(/[\r\n]+$/, "");
}

function gitRaw(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    throw new Error(bounded(`git ${args[0] ?? "command"} failed: ${typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? (error instanceof Error ? error.message : String(error))}`));
  }
}

function gitOptional(repoRoot: string, args: string[]): string | undefined {
  try { const value = git(repoRoot, args); return value || undefined; }
  catch { return undefined; }
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateBranch(branch: string): void {
  if (!branch || branch.startsWith("-") || gitCheckRef(branch) === false) throw new Error(`Invalid feature branch name: ${branch}`);
}

function gitCheckRef(branch: string): boolean {
  try { execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function firstExistingRef(repoRoot: string, refs: string[]): string | undefined {
  return refs.find((ref) => gitOptional(repoRoot, ["rev-parse", "--verify", ref]) !== undefined);
}

function requireAncestor(repoRoot: string, ancestor: string, descendant: string, message: string): void {
  try { execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoRoot, stdio: "ignore" }); }
  catch { throw new Error(message); }
}

function bounded(value: string): string {
  return value.length <= DIAGNOSTIC_MAX ? value : `${value.slice(0, DIAGNOSTIC_MAX - 3)}...`;
}
