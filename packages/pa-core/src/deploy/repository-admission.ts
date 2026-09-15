import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { queryDeploymentStatus } from "../registry/index.js";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";
import type { RuntimeName } from "../types.js";

export const REPOSITORY_MUTATION_LEASE_FILE = "pa-repository-mutation.lease.json";
export const REPOSITORY_MUTATION_BORROWER_FILE = "pa-repository-mutation.borrower.json";
export const REPOSITORY_IMPLEMENT_LEASE_FILE = "pa-repository-mutation.implement.lease.json";
const REPOSITORY_SLOT_MUTEX_ANCHOR = "pa-repository-mutation.slots";
export const REPOSITORY_DIRTY_BORROW_APPROVAL_FILE = "repository-dirty-borrow.approval.json";
export const MAX_REPOSITORY_LEASE_BYTES = 64 * 1024;
export const MAX_REPOSITORY_BORROWER_BYTES = 64 * 1024;
export const MAX_REPOSITORY_DIRTY_APPROVAL_BYTES = 64 * 1024;
export const MAX_GIT_STATUS_SUMMARY_CHARS = 1_024;

const MUTATION_MUTEX_FILE = "pa-repository-mutation.lease.lock";
const MUTEX_TIMEOUT_MS = 5_000;
const MUTEX_POLL_MS = 2;
export const REPOSITORY_BORROWER_CLEANUP_MS = 5_000;
const BORROWER_WAIT_POLL_MS = 100;
const MIN_BORROWER_TIMEOUT_SECONDS = 60;
const MAX_BORROWER_TIMEOUT_SECONDS = 7_200;
const STRING_FIELD_LIMIT = 4_096;
const RUNTIMES: readonly RuntimeName[] = ["claude", "opencode", "droid", "pi"];

export type RepositoryAccess = "read-only" | "exclusive-builder" | "non-locking";
export type RepositoryEvidenceState = "absent" | "live" | "stale" | "malformed" | "oversized" | "root-conflicting";
export type RepositoryBorrowerEvidenceState = RepositoryEvidenceState;

export interface ProcessFingerprint {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly bootId: string;
}

export type RepositoryGitStatusKind = "ordinary" | "rename-or-copy" | "unmerged" | "untracked" | "ignored";

export interface RepositoryGitStatusEntry {
  readonly recordIndex: number;
  readonly kind: RepositoryGitStatusKind;
  readonly xy: string;
  readonly path: string;
  readonly pathBase64: string;
  readonly sourcePath?: string;
  readonly sourcePathBase64?: string;
}

export interface RepositoryGitSnapshot {
  readonly branch: string;
  readonly head: string;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly dirty: boolean;
  readonly statusSummary: string;
  /** Lossless complete `git status --porcelain=v2 --untracked-files=all -z` bytes. */
  readonly statusPorcelainV2Base64?: string;
  readonly statusRecordCount?: number;
  readonly statusEntries?: readonly RepositoryGitStatusEntry[];
  /** SHA-256 over 8-byte-length-prefixed branch, HEAD, and raw status bytes. */
  readonly digestSha256?: string;
}

export type RepositoryDirtyBorrowClassificationKind = "active-ticket-produced" | "active-ticket-preserved";

export interface RepositoryDirtyBorrowClassification {
  readonly path: string;
  readonly classification: RepositoryDirtyBorrowClassificationKind;
}

export interface RepositoryDirtyBorrowApproval {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly approvalReference: string;
  readonly approvedAt: string;
  readonly action: "preserve-and-continue";
  readonly parentDeploymentId: string;
  readonly parentDeploymentDirectory: string;
  readonly parentProcessFingerprint: ProcessFingerprint;
  readonly parentLeaseEvidenceIdentity: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly worktreeRoot?: string;
  readonly ticket: string;
  readonly branch: string;
  readonly snapshot: RepositoryGitSnapshot;
  readonly classifications: readonly RepositoryDirtyBorrowClassification[];
  readonly plannedNewPaths: readonly string[];
}

export type RepositoryAdmissionLaunchMode = "foreground" | "background" | "dry-run";
export type RepositoryOwnershipIntent = "none" | "preview" | "acquire-before-spawn";
export type RepositoryMutationSlot = "orchestrator" | "implement";
export type RepositoryAdmissionOperation = "git-status" | "lease-read" | "lease-write" | "lease-remove" | "lease-quarantine";

/** Immutable repository evidence carried by the shared execution plan. */
export interface RepositoryAdmissionEvidence {
  readonly access: RepositoryAccess;
  readonly launchMode: RepositoryAdmissionLaunchMode;
  readonly ownershipIntent: RepositoryOwnershipIntent;
  readonly force: boolean;
  readonly slot?: RepositoryMutationSlot;
  readonly gitSnapshot?: RepositoryGitSnapshot;
  readonly approvedMutationPaths?: readonly string[];
}

export interface ResolveRepositoryAdmissionEvidenceOptions {
  readonly team: string;
  readonly mode: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  /** Exact execution root; defaults to canonicalRepoRoot for primary-root compatibility. */
  readonly worktreeRoot?: string;
  readonly runtime: RuntimeName;
  readonly background?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly ticket?: string;
  readonly captureGitSnapshot?: (canonicalRepoRoot: string) => RepositoryGitSnapshot;
  readonly observeOperation?: (operation: RepositoryAdmissionOperation) => void;
  /** Internal runtime-authenticated intent; never exposed as a CLI flag. */
  readonly allowDirtyInheritedBorrow?: boolean;
}

export interface RepositoryMutationLease {
  readonly schemaVersion: 1;
  readonly ownershipToken: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly worktreeRoot?: string;
  readonly slot?: RepositoryMutationSlot;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: RuntimeName;
  readonly mode: string;
  readonly team?: string;
  readonly launchMode?: RepositoryAdmissionLaunchMode;
  readonly processFingerprint: ProcessFingerprint;
  readonly acquiredAt: string;
  readonly preLaunchGitSnapshot: RepositoryGitSnapshot;
}

/** Separate evidence for the one direct child borrowing a version 1 parent lease. */
export interface RepositoryMutationBorrower {
  readonly schemaVersion: 1;
  readonly borrowerToken: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly worktreeRoot?: string;
  readonly parentDeploymentId: string;
  readonly parentProcessFingerprint: ProcessFingerprint;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: "pi";
  readonly team: "builder";
  readonly mode: "implement";
  readonly launchMode: "background";
  readonly ticket: string;
  readonly branch: string;
  readonly processFingerprint: ProcessFingerprint;
  readonly registeredAt: string;
  readonly timeoutSeconds: number;
  readonly launchGitSnapshot: RepositoryGitSnapshot;
  readonly approvedMutationPaths?: readonly string[];
  readonly dirtyApprovalReceiptId?: string;
  readonly finalizationState?: "finalizing";
  readonly finalizationAttemptedAt?: string;
  readonly finalizedAt?: string;
  readonly finalGitSnapshot?: RepositoryGitSnapshot;
}

export interface GitCommandRunner {
  (args: readonly string[], cwd: string): string | Buffer;
}

export interface RepositoryAdmissionDependencies {
  readonly getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined;
  readonly runGit: GitCommandRunner;
  readonly now: () => Date;
  readonly createToken: () => string;
  readonly isDeploymentRunning: (deploymentId: string) => boolean;
  readonly isProcessInLineage?: (pid: number, ancestor: ProcessFingerprint) => boolean;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly getCurrentProcessFingerprint?: () => ProcessFingerprint | undefined;
}

interface ResolvedRepositoryAdmissionDependencies extends RepositoryAdmissionDependencies {
  readonly isProcessInLineage: (pid: number, ancestor: ProcessFingerprint) => boolean;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly getCurrentProcessFingerprint: () => ProcessFingerprint | undefined;
}

export interface RegisterRepositoryMutationBorrowerOptions {
  /** Legacy trusted-caller authentication. Model/tool processes must use verified process lineage instead. */
  readonly capability?: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly worktreeRoot?: string;
  readonly expectedGitDir?: string;
  readonly expectedGitCommonDir?: string;
  readonly parentDeploymentId: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: RuntimeName;
  readonly team: string;
  readonly mode: string;
  readonly launchMode: RepositoryAdmissionLaunchMode;
  readonly ticket: string;
  readonly branch: string;
  readonly timeoutSeconds: number;
  readonly force?: boolean;
  readonly pid?: number;
  readonly processFingerprint?: ProcessFingerprint;
  /** Immutable pre-admission plan snapshot; the mutex-held re-read must match it exactly. */
  readonly expectedGitSnapshot?: RepositoryGitSnapshot;
  /** Deterministic seam for the mutex-held Git snapshot. */
  readonly gitSnapshot?: RepositoryGitSnapshot;
  /** Exact parent-owned one-use approval path, required only for dirty admission. */
  readonly dirtyApprovalPath?: string;
  readonly dependencies?: Partial<RepositoryAdmissionDependencies>;
}

export interface AcquireRepositoryMutationLeaseOptions {
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly worktreeRoot?: string;
  readonly expectedGitDir?: string;
  readonly expectedGitCommonDir?: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: RuntimeName;
  readonly mode: string;
  readonly launchMode?: RepositoryAdmissionLaunchMode;
  readonly team?: string;
  readonly ticket?: string;
  readonly force?: boolean;
  readonly pid?: number;
  readonly ownershipToken?: string;
  readonly processFingerprint?: ProcessFingerprint;
  readonly gitSnapshot?: RepositoryGitSnapshot;
  readonly dependencies?: Partial<RepositoryAdmissionDependencies>;
}

export interface RepositoryEvidenceInspection {
  readonly state: RepositoryEvidenceState;
  readonly reason: string;
  readonly leasePath: string;
  readonly evidenceIdentity?: string;
  readonly lease?: RepositoryMutationLease;
  readonly observedOwner?: Partial<RepositoryMutationLease>;
}

export interface RepositoryBorrowerInspection {
  readonly state: RepositoryBorrowerEvidenceState;
  readonly reason: string;
  readonly borrowerPath: string;
  readonly evidenceIdentity?: string;
  readonly borrower?: RepositoryMutationBorrower;
  readonly observedBorrower?: Partial<RepositoryMutationBorrower>;
}

export type RepositoryLeaseAcquisition =
  | {
      readonly status: "acquired";
      readonly evidenceState: "absent";
      readonly leasePath: string;
      readonly lease: RepositoryMutationLease;
      readonly diagnostic: string;
      readonly quarantinedPath?: string;
    }
  | {
      readonly status: "rejected";
      readonly evidenceState: Exclude<RepositoryEvidenceState, "absent"> | "dirty-background";
      readonly leasePath: string;
      readonly diagnostic: string;
      readonly lease?: RepositoryMutationLease;
    };

export type RepositoryLeaseMutationResult =
  | { readonly status: "transferred" | "updated" | "released"; readonly lease?: RepositoryMutationLease }
  | { readonly status: "absent" | "token-mismatch" | "invalid-evidence" | "borrower-live" | "borrower-invalid" };

export type RepositoryBorrowRegistration =
  | {
      readonly status: "registered";
      readonly borrowerPath: string;
      readonly borrower: RepositoryMutationBorrower;
      readonly diagnostic: string;
      readonly quarantinedPath?: string;
    }
  | {
      readonly status: "rejected";
      readonly category: string;
      readonly borrowerPath: string;
      readonly diagnostic: string;
      readonly borrower?: RepositoryMutationBorrower;
    };

export type RepositoryBorrowerMutationResult =
  | { readonly status: "transferred" | "released"; readonly borrower?: RepositoryMutationBorrower }
  | { readonly status: "absent" | "token-mismatch" | "invalid-evidence" };

export type RepositoryBorrowerFinalizationResult =
  | {
      readonly status: "finalized" | "scope-noncompliant";
      readonly parentLease: "retained" | "released" | "absent" | "replacement-preserved";
      readonly finalGitSnapshot: RepositoryGitSnapshot;
    }
  | {
      readonly status: "uncertain-live";
      readonly borrower: RepositoryMutationBorrower;
    }
  | { readonly status: "absent" | "token-mismatch" | "invalid-evidence" };

export type RepositoryLeaseFinalizationResult = RepositoryLeaseMutationResult & {
  readonly waitedMs?: number;
  readonly diagnostic?: string;
};

export interface RepositoryLeaseFinalizationDependencies {
  readonly getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type RepositoryLeaseQuarantineResult =
  | { readonly status: "quarantined"; readonly quarantinePath: string; readonly diagnostic: string }
  | { readonly status: "rejected"; readonly evidenceState: RepositoryEvidenceState | "identity-mismatch"; readonly diagnostic: string };

export function classifyRepositoryAccess(team: string, _mode?: string): RepositoryAccess {
  const normalizedTeam = team.trim().split("/", 1)[0]?.toLowerCase();
  if (normalizedTeam === "requirements") return "read-only";
  if (normalizedTeam === "builder") return "exclusive-builder";
  return "non-locking";
}

export function classifyRepositoryMutationSlot(mode: string): RepositoryMutationSlot {
  return mode.trim().toLowerCase() === "orchestrator" ? "orchestrator" : "implement";
}

export function repositoryMutationLeasePath(worktreeRoot: string, slot: RepositoryMutationSlot = "orchestrator"): string {
  const gitDir = repositoryPhysicalGitDir(worktreeRoot);
  return join(gitDir, slot === "implement" ? REPOSITORY_IMPLEMENT_LEASE_FILE : REPOSITORY_MUTATION_LEASE_FILE);
}

export function repositoryMutationBorrowerPath(worktreeRoot: string): string {
  return join(repositoryPhysicalGitDir(worktreeRoot), REPOSITORY_MUTATION_BORROWER_FILE);
}

function repositoryPhysicalGitDir(worktreeRoot: string): string {
  const root = assertCanonicalRoot(worktreeRoot);
  const dotGit = join(root, ".git");
  try {
    const metadata = lstatSync(dotGit);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return realpathSync(dotGit);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid .git metadata");
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const physical = realpathSync(output);
    if (!isAbsolute(output) || resolve(output) !== physical) throw new Error("non-physical Git directory");
    return physical;
  } catch {
    throw new Error(`repository-admission: cannot resolve the physical Git directory for ${root}`);
  }
}

function repositoryPhysicalGitCommonDir(worktreeRoot: string): string {
  const root = assertCanonicalRoot(worktreeRoot);
  try {
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const physical = realpathSync(output);
    if (!isAbsolute(output) || resolve(output) !== physical) throw new Error("non-physical Git common directory");
    return physical;
  } catch {
    throw new Error(`repository-admission: cannot resolve the physical Git common directory for ${root}`);
  }
}

export function assertRepositoryGitIdentity(worktreeRoot: string, expectedGitDir: string, expectedGitCommonDir: string): void {
  assertExpectedGitIdentity(assertCanonicalRoot(worktreeRoot), expectedGitDir, expectedGitCommonDir);
}

function assertExpectedGitIdentity(worktree: string, expectedGitDir?: string, expectedGitCommonDir?: string): void {
  if (expectedGitDir !== undefined && repositoryPhysicalGitDir(worktree) !== expectedGitDir) {
    throw new Error("repository-admission: execution worktree Git directory changed after planning; no runtime was started");
  }
  if (expectedGitCommonDir !== undefined && repositoryPhysicalGitCommonDir(worktree) !== expectedGitCommonDir) {
    throw new Error("repository-admission: execution worktree Git common directory changed after planning; no runtime was started");
  }
}

function repositoryLeaseLocation(canonicalRepoRoot: string, worktreeRoot: string | undefined, slot: RepositoryMutationSlot, admittedGitDir?: string): { root: string; worktree: string; gitDir: string; leasePath: string; mutexPath: string; linked: boolean } {
  const root = assertCanonicalRoot(canonicalRepoRoot);
  const worktree = assertCanonicalRoot(worktreeRoot ?? root);
  const linked = worktree !== root;
  const gitDir = admittedGitDir === undefined ? repositoryPhysicalGitDir(worktree) : assertPhysicalDirectory(admittedGitDir, "admitted Git directory");
  const leasePath = join(gitDir, linked && slot === "implement" ? REPOSITORY_IMPLEMENT_LEASE_FILE : REPOSITORY_MUTATION_LEASE_FILE);
  const mutexPath = linked ? resolve(gitDir, REPOSITORY_SLOT_MUTEX_ANCHOR) : leasePath;
  return { root, worktree, gitDir, leasePath, mutexPath, linked };
}

export function repositoryDirtyBorrowApprovalPath(parentDeploymentDirectory: string): string {
  return join(assertCanonicalRoot(parentDeploymentDirectory), REPOSITORY_DIRTY_BORROW_APPROVAL_FILE);
}

/**
 * Plans mode-aware admission without touching repository ownership evidence.
 * Requirements and other non-exclusive teams return before Git status capture.
 */
export function resolveRepositoryAdmissionEvidence(options: ResolveRepositoryAdmissionEvidenceOptions): RepositoryAdmissionEvidence {
  const canonicalRepoRoot = assertCanonicalRoot(options.canonicalRepoRoot);
  const worktreeRoot = assertCanonicalRoot(options.worktreeRoot ?? canonicalRepoRoot);
  const access = classifyRepositoryAccess(options.team, options.mode);
  const launchMode: RepositoryAdmissionLaunchMode = options.dryRun ? "dry-run" : options.background ? "background" : "foreground";
  if (access !== "exclusive-builder") {
    return Object.freeze({ access, launchMode, ownershipIntent: "none", force: Boolean(options.force) });
  }

  options.observeOperation?.("git-status");
  const snapshot = Object.freeze({ ...(options.captureGitSnapshot ?? captureRepositoryGitSnapshot)(worktreeRoot) });
  if (snapshot.dirty && launchMode === "background" && worktreeRoot === canonicalRepoRoot && !options.allowDirtyInheritedBorrow) {
    throw new Error(formatDirtyBackgroundBuilderDiagnostic({
      canonicalRepoKey: options.canonicalRepoKey,
      canonicalRepoRoot,
      ...(worktreeRoot !== canonicalRepoRoot ? { worktreeRoot } : {}),
      team: options.team,
      mode: options.mode,
      runtime: options.runtime,
      snapshot,
      ...(options.ticket ? { ticket: options.ticket } : {}),
    }));
  }

  return Object.freeze({
    access,
    launchMode,
    ownershipIntent: launchMode === "dry-run" ? "preview" : "acquire-before-spawn",
    force: Boolean(options.force),
    slot: classifyRepositoryMutationSlot(options.mode),
    gitSnapshot: snapshot,
  });
}

export function captureRepositoryGitSnapshot(canonicalRepoRoot: string, runGit: GitCommandRunner = defaultGitRunner): RepositoryGitSnapshot {
  const root = assertCanonicalRoot(canonicalRepoRoot);
  let branch = "(detached)";
  try {
    branch = boundedField(gitText(runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root)).trim(), STRING_FIELD_LIMIT) || "(detached)";
  } catch {
    // Detached HEAD is valid evidence and does not cause admission to mutate Git.
  }
  const head = boundedField(gitText(runGit(["rev-parse", "HEAD"], root)).trim(), STRING_FIELD_LIMIT);
  const rawStatus = gitBytes(runGit(["status", "--porcelain=v2", "--untracked-files=all", "-z"], root));
  const entries = parseRepositoryGitStatus(rawStatus);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  for (const entry of entries) {
    if (entry.kind === "untracked") untrackedCount += 1;
    else if (entry.kind !== "ignored") {
      if ((entry.xy[0] ?? ".") !== ".") stagedCount += 1;
      if ((entry.xy[1] ?? ".") !== ".") unstagedCount += 1;
    }
  }
  const statusSummary = entries.map((entry) => `${entry.xy} ${displayPath(entry.path)}${entry.sourcePath ? ` <- ${displayPath(entry.sourcePath)}` : ""}`);
  return Object.freeze({
    branch,
    head,
    stagedCount,
    unstagedCount,
    untrackedCount,
    dirty: entries.some((entry) => entry.kind !== "ignored"),
    statusSummary: boundedField(statusSummary.join("\n"), MAX_GIT_STATUS_SUMMARY_CHARS),
    statusPorcelainV2Base64: rawStatus.toString("base64"),
    statusRecordCount: entries.length,
    statusEntries: Object.freeze(entries),
    digestSha256: repositoryGitSnapshotDigest(branch, head, rawStatus),
  });
}

export function repositoryGitSnapshotDigest(branch: string, head: string, rawStatus: Buffer): string {
  const hash = createHash("sha256");
  for (const field of [Buffer.from(branch, "utf8"), Buffer.from(head, "utf8"), rawStatus]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hash.update(length).update(field);
  }
  return hash.digest("hex");
}

export function parseRepositoryGitStatus(rawStatus: Buffer): readonly RepositoryGitStatusEntry[] {
  if (rawStatus.length === 0) return Object.freeze([]);
  if (rawStatus[rawStatus.length - 1] !== 0) throw new Error("repository-admission: incomplete porcelain-v2 status is not NUL terminated");
  const fields = splitNulFields(rawStatus);
  const entries: RepositoryGitStatusEntry[] = [];
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const record = fields[fieldIndex]!;
    const tag = String.fromCharCode(record[0] ?? 0);
    let kind: RepositoryGitStatusKind;
    let xy: string;
    let pathBytes: Buffer;
    let sourceBytes: Buffer | undefined;
    if (tag === "1") {
      kind = "ordinary";
      xy = asciiField(record, 1);
      pathBytes = trailingField(record, 8);
    } else if (tag === "2") {
      kind = "rename-or-copy";
      xy = asciiField(record, 1);
      pathBytes = trailingField(record, 9);
      sourceBytes = fields[++fieldIndex];
      if (!sourceBytes) throw new Error("repository-admission: porcelain-v2 rename/copy source path is incomplete");
    } else if (tag === "u") {
      kind = "unmerged";
      xy = asciiField(record, 1);
      pathBytes = trailingField(record, 10);
    } else if (tag === "?" || tag === "!") {
      kind = tag === "?" ? "untracked" : "ignored";
      xy = tag === "?" ? "??" : "!!";
      pathBytes = trailingField(record, 1);
    } else {
      throw new Error("repository-admission: unsupported or malformed porcelain-v2 status record");
    }
    const path = decodeGitPath(pathBytes);
    const sourcePath = sourceBytes ? decodeGitPath(sourceBytes) : undefined;
    entries.push(Object.freeze({
      recordIndex: entries.length + 1,
      kind,
      xy,
      path,
      pathBase64: pathBytes.toString("base64"),
      ...(sourcePath && sourceBytes ? { sourcePath, sourcePathBase64: sourceBytes.toString("base64") } : {}),
    }));
  }
  return Object.freeze(entries);
}

export function validateRepositoryDirtyBorrowScope(
  canonicalRepoRoot: string,
  snapshot: RepositoryGitSnapshot,
  classifications: readonly RepositoryDirtyBorrowClassification[],
  plannedNewPaths: readonly string[],
): readonly string[] {
  const root = assertCanonicalRoot(canonicalRepoRoot);
  if (!isCompleteGitSnapshot(snapshot) || !snapshot.dirty || !snapshot.statusEntries) {
    throw new Error("dirty-borrow-approval: a complete dirty porcelain-v2 snapshot is required");
  }
  if (classifications.length !== snapshot.statusEntries.length) {
    throw new Error("dirty-borrow-approval: exactly one classification is required for every status record");
  }
  const classificationsByPath = new Map<string, RepositoryDirtyBorrowClassificationKind>();
  for (const item of classifications) {
    if (!isApprovedClassification(item.classification) || !validRepositoryRelativePath(root, item.path) || hasSymlinkTraversal(root, item.path)) {
      throw new Error("dirty-borrow-approval: every classification must name one exact repository-relative active-ticket path");
    }
    if (classificationsByPath.has(item.path)) throw new Error("dirty-borrow-approval: duplicate classifications are forbidden");
    classificationsByPath.set(item.path, item.classification);
  }
  const currentPaths: string[] = [];
  for (const entry of snapshot.statusEntries) {
    if (!classificationsByPath.has(entry.path)) throw new Error("dirty-borrow-approval: classification path set does not exactly match the status records");
    if (hasSymlinkTraversal(root, entry.path) || (entry.sourcePath && hasSymlinkTraversal(root, entry.sourcePath))) {
      throw new Error("dirty-borrow-approval: symlinked current paths cannot receive mutation authority");
    }
    currentPaths.push(entry.path);
    if (entry.sourcePath) currentPaths.push(entry.sourcePath);
  }
  if (classificationsByPath.size !== snapshot.statusEntries.length) throw new Error("dirty-borrow-approval: unrelated classifications are forbidden");
  const planned = new Set<string>();
  for (const path of plannedNewPaths) {
    if (!validRepositoryRelativePath(root, path) || containsGlobSyntax(path) || currentPaths.includes(path) || pathEntryExists(resolve(root, path)) || hasSymlinkTraversal(root, path)) {
      throw new Error("dirty-borrow-approval: planned new paths must be unique, nonexistent, exact repository-relative paths without glob syntax");
    }
    if (planned.has(path)) throw new Error("dirty-borrow-approval: duplicate planned new paths are forbidden");
    planned.add(path);
  }
  return Object.freeze([...new Set([...currentPaths, ...planned])].sort());
}

export function publishRepositoryDirtyBorrowApproval(
  approval: RepositoryDirtyBorrowApproval,
  dependencies?: Partial<RepositoryAdmissionDependencies>,
): string {
  const { root, worktree, leasePath, mutexPath } = repositoryLeaseLocation(approval.canonicalRepoRoot, approval.worktreeRoot, "orchestrator");
  const approvalPath = repositoryDirtyBorrowApprovalPath(approval.parentDeploymentDirectory);
  const resolvedDependencies = resolveDependencies(dependencies);
  return withMutationMutex(mutexPath, () => {
    if (!isRepositoryDirtyBorrowApproval(approval)) throw new Error("dirty-borrow-approval: generated receipt is invalid or incomplete");
    validateRepositoryDirtyBorrowScope(worktree, approval.snapshot, approval.classifications, approval.plannedNewPaths);
    const inspection = inspectLeaseUnlocked(root, leasePath, resolvedDependencies.getProcessFingerprint);
    if (inspection.state !== "live" || !inspection.lease
      || inspection.lease.deploymentId !== approval.parentDeploymentId
      || inspection.lease.deploymentDirectory !== approval.parentDeploymentDirectory
      || inspection.lease.runtime !== "pi"
      || inspection.lease.mode !== "orchestrator"
      || normalizedTeam(inspection.lease.team ?? "") !== "builder"
      || inspection.lease.launchMode !== "foreground"
      || inspection.lease.canonicalRepoKey !== approval.canonicalRepoKey
      || (inspection.lease.worktreeRoot ?? root) !== worktree
      || inspection.evidenceIdentity !== approval.parentLeaseEvidenceIdentity
      || !fingerprintsEqual(inspection.lease.processFingerprint, approval.parentProcessFingerprint)
      || !resolvedDependencies.isDeploymentRunning(approval.parentDeploymentId)) {
      throw new Error("dirty-borrow-approval: parent owner identity is not process-verified and registry-running");
    }
    publishApprovalExclusive(approvalPath, approval, resolvedDependencies.createToken);
    return approvalPath;
  });
}

export function removeRepositoryDirtyBorrowApproval(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  approvalPath: string;
  receiptId: string;
}): "removed" | "absent" | "replacement-preserved" {
  const { root, worktree, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, "orchestrator");
  return withMutationMutex(mutexPath, () => {
    const approval = readValidApprovalUnlocked(options.approvalPath);
    if (approval === undefined) return "absent";
    if (!approval || approval.canonicalRepoRoot !== root || (approval.worktreeRoot ?? root) !== worktree || !secureStringsEqual(approval.receiptId, options.receiptId)) return "replacement-preserved";
    unlinkSync(options.approvalPath);
    return "removed";
  });
}

export function readProcessFingerprint(pid: number): ProcessFingerprint | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    const fieldsFromState = stat.slice(closingParenthesis + 2).trim().split(/\s+/);
    const startTimeTicks = fieldsFromState[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!startTimeTicks || !bootId) return undefined;
    return Object.freeze({ pid, startTimeTicks, bootId });
  } catch {
    return undefined;
  }
}

export function inspectRepositoryMutationLease(
  canonicalRepoRoot: string,
  dependencies: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint"> & { worktreeRoot?: string; slot?: RepositoryMutationSlot; repositoryGitDir?: string } = { getProcessFingerprint: readProcessFingerprint },
): RepositoryEvidenceInspection {
  const { root, leasePath, mutexPath } = repositoryLeaseLocation(canonicalRepoRoot, dependencies.worktreeRoot, dependencies.slot ?? "orchestrator", dependencies.repositoryGitDir);
  return withMutationMutex(mutexPath, () => inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint));
}

export function inspectRepositoryMutationBorrower(
  canonicalRepoRoot: string,
  dependencies: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint"> & { worktreeRoot?: string; repositoryGitDir?: string } = { getProcessFingerprint: readProcessFingerprint },
): RepositoryBorrowerInspection {
  const { root, gitDir, mutexPath } = repositoryLeaseLocation(canonicalRepoRoot, dependencies.worktreeRoot, "orchestrator", dependencies.repositoryGitDir);
  const borrowerPath = join(gitDir, REPOSITORY_MUTATION_BORROWER_FILE);
  return withMutationMutex(mutexPath, () => inspectBorrowerUnlocked(root, borrowerPath, dependencies.getProcessFingerprint));
}

/**
 * Authenticates a direct Pi builder/implement child against the live parent lease
 * and publishes separate borrower evidence before the adapter spawns the child.
 */
export function registerRepositoryMutationBorrower(options: RegisterRepositoryMutationBorrowerOptions): RepositoryBorrowRegistration {
  const { root, worktree, leasePath, mutexPath, linked } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, "orchestrator");
  const borrowerPath = repositoryMutationBorrowerPath(worktree);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const reject = (category: string, reason: string, borrower?: RepositoryMutationBorrower): RepositoryBorrowRegistration => ({
      status: "rejected",
      category,
      borrowerPath,
      diagnostic: formatRepositoryBorrowerDiagnostic({ category, reason, canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, worktreeRoot: worktree, slot: "implement" }),
      ...(borrower ? { borrower } : {}),
    });
    try { assertExpectedGitIdentity(worktree, options.expectedGitDir, options.expectedGitCommonDir); }
    catch (error) { return reject("repository-identity", error instanceof Error ? error.message : String(error)); }
    const leaseInspection = inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint);
    const lease = leaseInspection.lease;
    if (leaseInspection.state !== "live" || !lease) return reject("parent-state", "the claimed parent lease is not process-verified live version 1 evidence");
    if (!dependencies.isDeploymentRunning(lease.deploymentId)) return reject("parent-registry", "the claimed parent deployment is not registry-running");
    if (lease.runtime !== "pi" || lease.mode !== "orchestrator" || (lease.team !== undefined && normalizedTeam(lease.team) !== "builder")) return reject("parent-identity", "the live owner is not a Pi builder/orchestrator parent");
    if (lease.deploymentId !== options.parentDeploymentId) return reject("parent-identity", "the claimed parent deployment does not own the live lease");
    if (lease.canonicalRepoKey !== options.canonicalRepoKey || lease.canonicalRepoRoot !== root || (lease.worktreeRoot ?? root) !== worktree) return reject("repository-identity", "the claimed canonical repository or execution worktree does not match the parent lease");
    const pid = options.pid ?? process.pid;
    const observedFingerprint = dependencies.getProcessFingerprint(pid);
    const fingerprint = options.processFingerprint ?? observedFingerprint;
    if (!fingerprint || fingerprint.pid !== pid || !fingerprintsEqual(fingerprint, observedFingerprint)) {
      return reject("child-process", "the registering child launch process fingerprint could not be verified");
    }
    const capabilityPresented = options.capability !== undefined;
    const capabilityAuthenticated = capabilityPresented
      && Buffer.byteLength(options.capability ?? "") <= MAX_REPOSITORY_BORROWER_BYTES
      && secureStringsEqual(lease.ownershipToken, options.capability ?? "");
    const lineageAuthenticated = !capabilityPresented && dependencies.isProcessInLineage(pid, lease.processFingerprint);
    if (!capabilityAuthenticated && !lineageAuthenticated) {
      return reject(capabilityPresented ? "capability" : "parent-lineage", capabilityPresented
        ? "the private parent capability is malformed or did not authenticate"
        : "the registering process is not within the process-verified parent launcher lineage");
    }
    if (options.deploymentId === lease.deploymentId) return reject("child-identity", "a parent cannot borrow its own lease");
    if (options.runtime !== "pi" || normalizedTeam(options.team) !== "builder" || options.mode !== "implement" || options.launchMode !== "background") {
      return reject("launch-mode", "only a background Pi builder/implement direct child may borrow authority");
    }
    if (!options.ticket.trim() || options.branch !== lease.preLaunchGitSnapshot.branch || !options.branch.startsWith(`feature/${options.ticket}-`)) {
      return reject("child-context", "ticket and exact linked feature branch must match the parent launch snapshot");
    }
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < MIN_BORROWER_TIMEOUT_SECONDS || options.timeoutSeconds > MAX_BORROWER_TIMEOUT_SECONDS) {
      return reject("child-timeout", `the child timeout must be an integer from ${MIN_BORROWER_TIMEOUT_SECONDS} through ${MAX_BORROWER_TIMEOUT_SECONDS} seconds`);
    }

    // This read is authoritative: it occurs under the same mutex as receipt
    // consumption and borrower publication.
    const gitSnapshot = Object.freeze({ ...(options.gitSnapshot ?? captureRepositoryGitSnapshot(worktree, dependencies.runGit)) });
    if (!isGitSnapshot(gitSnapshot)) return reject("git-state", "the mutex-held Git snapshot is malformed");
    if (!gitSnapshot.dirty && options.expectedGitSnapshot && (!isGitSnapshot(options.expectedGitSnapshot) || !repositoryGitSnapshotsEqual(options.expectedGitSnapshot, gitSnapshot))) {
      return reject("launch-snapshot", "the mutex-held child launch Git snapshot does not exactly match its immediate immutable reread");
    }
    if (!gitSnapshot.dirty && gitSnapshot.branch !== options.branch) return reject("launch-snapshot", "the child launch Git branch does not exactly match the authenticated parent branch");

    let approvedMutationPaths: readonly string[] | undefined;
    let dirtyApprovalReceiptId: string | undefined;
    if (gitSnapshot.dirty) {
      if (lease.launchMode !== "foreground" || normalizedTeam(lease.team ?? "") !== "builder") return reject("dirty-approval", "dirty borrowing requires the exact foreground Pi builder/orchestrator parent");
      const expectedApprovalPath = repositoryDirtyBorrowApprovalPath(lease.deploymentDirectory);
      if (!options.dirtyApprovalPath || options.dirtyApprovalPath !== expectedApprovalPath) {
        return reject("dirty-approval", "dirty inherited admission requires the exact parent-owned one-use approval receipt; force does not bypass this condition");
      }
      const approval = readValidApprovalUnlocked(expectedApprovalPath);
      // A presented exact-path receipt is consumed once before every remaining
      // matching-attempt check, including drift, sibling, and process failures.
      if (existsSync(expectedApprovalPath)) {
        try { unlinkSync(expectedApprovalPath); }
        catch { return reject("dirty-approval", "the parent-owned approval receipt could not be safely consumed"); }
      }
      if (!approval) return reject("dirty-approval", "the parent-owned approval receipt is missing, malformed, oversized, insecure, or already consumed");
      let scope: readonly string[];
      try {
        scope = validateRepositoryDirtyBorrowScope(worktree, approval.snapshot, approval.classifications, approval.plannedNewPaths);
      } catch {
        return reject("dirty-approval", "the approval receipt classifications or planned new paths are incomplete or invalid");
      }
      if (approval.parentDeploymentId !== lease.deploymentId
        || approval.parentDeploymentDirectory !== lease.deploymentDirectory
        || approval.parentLeaseEvidenceIdentity !== leaseInspection.evidenceIdentity
        || !fingerprintsEqual(approval.parentProcessFingerprint, lease.processFingerprint)
        || approval.canonicalRepoKey !== options.canonicalRepoKey
        || approval.canonicalRepoRoot !== root
        || (approval.worktreeRoot ?? root) !== worktree
        || approval.ticket !== options.ticket
        || approval.branch !== options.branch
        || approval.action !== "preserve-and-continue"
        || !repositoryGitSnapshotsEqual(approval.snapshot, gitSnapshot)) {
        return reject("dirty-approval", "the consumed approval receipt does not exactly match parent, child, repository, ticket, branch, lineage, or complete Git state");
      }
      if (options.expectedGitSnapshot && (!isGitSnapshot(options.expectedGitSnapshot) || !repositoryGitSnapshotsEqual(options.expectedGitSnapshot, gitSnapshot))) {
        return reject("launch-snapshot", "the consumed receipt attempt changed between immediate and mutex-held complete Git rereads");
      }
      approvedMutationPaths = scope;
      dirtyApprovalReceiptId = approval.receiptId;
    }

    if (linked) {
      const implementLeasePath = repositoryMutationLeasePath(worktree, "implement");
      const implementInspection = inspectLeaseUnlocked(root, implementLeasePath, dependencies.getProcessFingerprint);
      if (implementInspection.state === "live") return reject("borrower-state", "a process-verified live implement owner already occupies the worktree implement slot");
      if (implementInspection.state !== "absent") return reject("borrower-state", `recoverable implement-slot evidence is ${implementInspection.state}`);
    }

    let inspection = inspectBorrowerUnlocked(root, borrowerPath, dependencies.getProcessFingerprint);
    let quarantinedPath: string | undefined;
    if (inspection.state !== "absent") {
      if (inspection.state === "live" || !options.force) {
        return reject("borrower-state", inspection.state === "live" ? "a process-verified live sibling already occupies the parent execution slot" : `recoverable borrower evidence is ${inspection.state}`, inspection.borrower);
      }
      quarantinedPath = quarantineLeaseUnlocked(borrowerPath, dependencies.now, dependencies.createToken);
      inspection = { state: "absent", reason: "recoverable borrower evidence was atomically quarantined", borrowerPath };
    }

    const borrower: RepositoryMutationBorrower = Object.freeze({
      schemaVersion: 1,
      borrowerToken: boundedRequired(dependencies.createToken(), "borrower token"),
      canonicalRepoKey: boundedRequired(options.canonicalRepoKey, "canonical repository key"),
      canonicalRepoRoot: root,
      ...(worktree !== root ? { worktreeRoot: worktree } : {}),
      parentDeploymentId: lease.deploymentId,
      parentProcessFingerprint: Object.freeze({ ...lease.processFingerprint }),
      deploymentId: boundedRequired(options.deploymentId, "child deployment ID"),
      deploymentDirectory: assertCanonicalRoot(options.deploymentDirectory),
      runtime: "pi",
      team: "builder",
      mode: "implement",
      launchMode: "background",
      ticket: boundedRequired(options.ticket, "ticket"),
      branch: boundedRequired(options.branch, "branch"),
      processFingerprint: Object.freeze({ ...fingerprint }),
      registeredAt: dependencies.now().toISOString(),
      timeoutSeconds: options.timeoutSeconds,
      launchGitSnapshot: gitSnapshot,
      ...(approvedMutationPaths ? { approvedMutationPaths } : {}),
      ...(dirtyApprovalReceiptId ? { dirtyApprovalReceiptId } : {}),
    });
    assertBorrower(borrower);
    publishBorrowerExclusive(borrowerPath, borrower, dependencies.createToken);
    return {
      status: "registered",
      borrowerPath,
      borrower,
      diagnostic: formatRepositoryBorrowerDiagnostic({ category: "registered", reason: inspection.reason, canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, worktreeRoot: worktree, slot: "implement" }),
      ...(quarantinedPath ? { quarantinedPath } : {}),
    };
  });
}

export function acquireRepositoryMutationLease(options: AcquireRepositoryMutationLeaseOptions): RepositoryLeaseAcquisition {
  const slot = classifyRepositoryMutationSlot(options.mode);
  const { root, worktree, leasePath, mutexPath, linked } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, slot);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    assertExpectedGitIdentity(worktree, options.expectedGitDir, options.expectedGitCommonDir);
    // Runtime adapters intentionally omit gitSnapshot so this read occurs after
    // planning/tool setup and inside the same admission-critical section that
    // publishes ownership. Tests and lower-level callers may provide a fixed
    // snapshot when exercising the ownership primitive in synthetic fixtures.
    const gitSnapshot = Object.freeze({ ...(options.gitSnapshot ?? captureRepositoryGitSnapshot(worktree, dependencies.runGit)) });
    if (options.launchMode === "background" && gitSnapshot.dirty && worktree === root) {
      return {
        status: "rejected",
        evidenceState: "dirty-background",
        leasePath,
        diagnostic: formatDirtyBackgroundBuilderDiagnostic({
          canonicalRepoKey: options.canonicalRepoKey,
          canonicalRepoRoot: root,
          ...(worktree !== root ? { worktreeRoot: worktree } : {}),
          team: options.team ?? "builder",
          mode: options.mode,
          runtime: options.runtime,
          snapshot: gitSnapshot,
          ...(options.ticket ? { ticket: options.ticket } : {}),
        }),
      };
    }

    let inspection = inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint);
    if (inspection.state === "live") {
      return {
        status: "rejected",
        evidenceState: inspection.state,
        leasePath,
        diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, worktreeRoot: worktree, slot, inspection }),
        ...(inspection.lease ? { lease: inspection.lease } : {}),
      };
    }
    const borrowerPath = repositoryMutationBorrowerPath(worktree);
    const borrowerInspection = slot === "implement" || !linked
      ? inspectBorrowerUnlocked(root, borrowerPath, dependencies.getProcessFingerprint)
      : { state: "absent" as const, reason: "orchestrator slot is independent", borrowerPath };
    let quarantinedPath: string | undefined;
    if (borrowerInspection.state === "live") {
      return {
        status: "rejected",
        evidenceState: borrowerInspection.state,
        leasePath,
        diagnostic: formatRepositoryBorrowerDiagnostic({
          category: "borrower-state",
          reason: "a process-verified live borrower retains repository authority",
          canonicalRepoKey: options.canonicalRepoKey,
          canonicalRepoRoot: root,
          worktreeRoot: worktree,
          slot,
        }),
      };
    }
    if (inspection.state !== "absent" && !options.force) {
      return {
        status: "rejected",
        evidenceState: inspection.state,
        leasePath,
        diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, worktreeRoot: worktree, slot, inspection }),
        ...(inspection.lease ? { lease: inspection.lease } : {}),
      };
    }
    if (borrowerInspection.state !== "absent") {
      if (!options.force) {
        return {
          status: "rejected",
          evidenceState: borrowerInspection.state,
          leasePath,
          diagnostic: formatRepositoryBorrowerDiagnostic({
            category: "borrower-state",
            reason: `borrower evidence is ${borrowerInspection.state}`,
            canonicalRepoKey: options.canonicalRepoKey,
            canonicalRepoRoot: root,
            worktreeRoot: worktree,
            slot,
          }),
        };
      }
      quarantinedPath = quarantineLeaseUnlocked(borrowerPath, dependencies.now, dependencies.createToken);
    }

    if (inspection.state !== "absent") {
      quarantinedPath = quarantineLeaseUnlocked(leasePath, dependencies.now, dependencies.createToken);
      inspection = { state: "absent", reason: "recoverable evidence was atomically quarantined", leasePath };
    }

    const pid = options.pid ?? process.pid;
    const observedFingerprint = dependencies.getProcessFingerprint(pid);
    const fingerprint = options.processFingerprint ?? observedFingerprint;
    if (!fingerprint || fingerprint.pid !== pid || !fingerprintsEqual(fingerprint, observedFingerprint)) {
      throw new Error(`repository-admission: cannot verify process start fingerprint for PID ${pid}`);
    }
    const lease: RepositoryMutationLease = Object.freeze({
      schemaVersion: 1,
      ownershipToken: boundedRequired(options.ownershipToken ?? dependencies.createToken(), "ownership token"),
      canonicalRepoKey: boundedRequired(options.canonicalRepoKey, "canonical repository key"),
      canonicalRepoRoot: root,
      ...(worktree !== root ? { worktreeRoot: worktree, slot } : {}),
      deploymentId: boundedRequired(options.deploymentId, "deployment ID"),
      deploymentDirectory: boundedRequired(options.deploymentDirectory, "deployment directory"),
      runtime: options.runtime,
      mode: boundedRequired(options.mode, "mode"),
      ...(options.team ? { team: boundedRequired(options.team, "team") } : {}),
      ...(options.launchMode ? { launchMode: options.launchMode } : {}),
      processFingerprint: Object.freeze({ ...fingerprint }),
      acquiredAt: dependencies.now().toISOString(),
      preLaunchGitSnapshot: Object.freeze({ ...gitSnapshot }),
    });
    assertLease(lease);
    publishLeaseExclusive(leasePath, lease, dependencies.createToken);
    return {
      status: "acquired",
      evidenceState: "absent",
      leasePath,
      lease,
      diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, worktreeRoot: worktree, slot, inspection, recovered: Boolean(quarantinedPath) }),
      ...(quarantinedPath ? { quarantinedPath } : {}),
    };
  });
}

export function repositoryGitSnapshotsEqual(left: RepositoryGitSnapshot, right: RepositoryGitSnapshot): boolean {
  return left.branch === right.branch
    && left.head === right.head
    && left.stagedCount === right.stagedCount
    && left.unstagedCount === right.unstagedCount
    && left.untrackedCount === right.untrackedCount
    && left.dirty === right.dirty
    && left.statusSummary === right.statusSummary
    && left.statusPorcelainV2Base64 === right.statusPorcelainV2Base64
    && left.statusRecordCount === right.statusRecordCount
    && left.digestSha256 === right.digestSha256
    && JSON.stringify(left.statusEntries) === JSON.stringify(right.statusEntries);
}

export function updateRepositoryMutationLeaseGitSnapshot(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  slot?: RepositoryMutationSlot;
  ownershipToken: string;
  gitSnapshot: RepositoryGitSnapshot;
  dependencies?: Pick<RepositoryAdmissionDependencies, "createToken">;
}): RepositoryLeaseMutationResult {
  const { root, worktree, leasePath, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, options.slot ?? "orchestrator");
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidLeaseUnlocked(leasePath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree || !isGitSnapshot(options.gitSnapshot)) return { status: "invalid-evidence" };
    if (parsed.ownershipToken !== options.ownershipToken) return { status: "token-mismatch" };
    const lease = Object.freeze({ ...parsed, preLaunchGitSnapshot: Object.freeze({ ...options.gitSnapshot }) });
    replaceLeaseAtomic(leasePath, lease, dependencies.createToken);
    return { status: "updated", lease };
  });
}

export function transferRepositoryMutationBorrower(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  borrowerToken: string;
  nextProcessFingerprint: ProcessFingerprint;
  dependencies?: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint" | "createToken">;
}): RepositoryBorrowerMutationResult {
  const { root, worktree, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, "orchestrator");
  const borrowerPath = repositoryMutationBorrowerPath(worktree);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidBorrowerUnlocked(borrowerPath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree) return { status: "invalid-evidence" };
    if (!secureStringsEqual(parsed.borrowerToken, options.borrowerToken)) return { status: "token-mismatch" };
    if (!isProcessFingerprint(options.nextProcessFingerprint)
      || !fingerprintsEqual(options.nextProcessFingerprint, dependencies.getProcessFingerprint(options.nextProcessFingerprint.pid))) {
      return { status: "invalid-evidence" };
    }
    const borrower = Object.freeze({ ...parsed, processFingerprint: Object.freeze({ ...options.nextProcessFingerprint }) });
    replaceBorrowerAtomic(borrowerPath, borrower, dependencies.createToken);
    return { status: "transferred", borrower };
  });
}

export function releaseRepositoryMutationBorrower(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  repositoryGitDir?: string;
  borrowerToken: string;
}): RepositoryBorrowerMutationResult {
  const { root, worktree, gitDir, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, "orchestrator", options.repositoryGitDir);
  const borrowerPath = join(gitDir, REPOSITORY_MUTATION_BORROWER_FILE);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidBorrowerUnlocked(borrowerPath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree) return { status: "invalid-evidence" };
    if (!secureStringsEqual(parsed.borrowerToken, options.borrowerToken)) return { status: "token-mismatch" };
    unlinkSync(borrowerPath);
    return { status: "released" };
  });
}

export function finalizeRepositoryMutationBorrower(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  repositoryGitDir?: string;
  borrowerToken: string;
  deploymentId: string;
  finalGitSnapshot?: RepositoryGitSnapshot;
  dependencies?: Partial<RepositoryAdmissionDependencies>;
}): RepositoryBorrowerFinalizationResult {
  const { root, worktree, gitDir, leasePath, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, "orchestrator", options.repositoryGitDir);
  const borrowerPath = join(gitDir, REPOSITORY_MUTATION_BORROWER_FILE);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidBorrowerUnlocked(borrowerPath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree) return { status: "invalid-evidence" };
    if (!secureStringsEqual(parsed.borrowerToken, options.borrowerToken) || parsed.deploymentId !== options.deploymentId) return { status: "token-mismatch" };

    const terminalFingerprint = dependencies.getCurrentProcessFingerprint();
    const matchingTerminalProcess = Boolean(
      terminalFingerprint
      && fingerprintsEqual(parsed.processFingerprint, terminalFingerprint)
      && fingerprintsEqual(terminalFingerprint, dependencies.getProcessFingerprint(terminalFingerprint.pid)),
    );
    const observedRunner = dependencies.getProcessFingerprint(parsed.processFingerprint.pid);
    const recordedRunnerIsLive = fingerprintsEqual(parsed.processFingerprint, observedRunner);
    const runnerLivenessUnverifiable = observedRunner === undefined && dependencies.isProcessAlive(parsed.processFingerprint.pid);
    if (!matchingTerminalProcess && (recordedRunnerIsLive || runnerLivenessUnverifiable)) {
      const finalizing = Object.freeze({
        ...parsed,
        finalizationState: "finalizing" as const,
        finalizationAttemptedAt: dependencies.now().toISOString(),
      });
      replaceBorrowerAtomic(borrowerPath, finalizing, dependencies.createToken);
      return { status: "uncertain-live", borrower: finalizing };
    }

    const finalGitSnapshot = Object.freeze({ ...(options.finalGitSnapshot ?? captureRepositoryGitSnapshot(worktree, dependencies.runGit)) });
    if (!isGitSnapshot(finalGitSnapshot)) return { status: "invalid-evidence" };
    const approved = new Set(parsed.approvedMutationPaths ?? []);
    const finalEntries = finalGitSnapshot.statusEntries ?? [];
    const scopeCompliant = parsed.dirtyApprovalReceiptId === undefined || (
      isCompleteGitSnapshot(finalGitSnapshot)
      && finalGitSnapshot.branch === parsed.branch
      && finalEntries.every((entry) => approved.has(entry.path) && (!entry.sourcePath || approved.has(entry.sourcePath)))
    );
    const finalized = Object.freeze({
      ...parsed,
      finalizedAt: dependencies.now().toISOString(),
      finalGitSnapshot,
    });
    replaceBorrowerAtomic(borrowerPath, finalized, dependencies.createToken);

    const parentInspection = inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint);
    const parent = parentInspection.lease;
    let parentLease: "retained" | "released" | "absent" | "replacement-preserved";
    if (parentInspection.state === "absent") parentLease = "absent";
    else if (!parent || parent.deploymentId !== parsed.parentDeploymentId || parent.canonicalRepoRoot !== root || (parent.worktreeRoot ?? root) !== worktree || !fingerprintsEqual(parent.processFingerprint, parsed.parentProcessFingerprint)) parentLease = "replacement-preserved";
    else if (parentInspection.state === "live" && dependencies.isDeploymentRunning(parent.deploymentId)) parentLease = "retained";
    else {
      unlinkSync(leasePath);
      parentLease = "released";
    }
    if (parsed.dirtyApprovalReceiptId && parent) {
      const approvalPath = repositoryDirtyBorrowApprovalPath(parent.deploymentDirectory);
      const matchingApproval = readValidApprovalUnlocked(approvalPath);
      if (matchingApproval && secureStringsEqual(matchingApproval.receiptId, parsed.dirtyApprovalReceiptId)) unlinkSync(approvalPath);
    }
    unlinkSync(borrowerPath);
    return { status: scopeCompliant ? "finalized" : "scope-noncompliant", parentLease, finalGitSnapshot };
  });
}

/**
 * Normal owner finalization waits only for its matching live direct borrower.
 * The absolute deadline is the borrower's admission time plus its configured
 * timeout and the fixed cleanup allowance; force never shortens this wait.
 */
export async function finalizeRepositoryMutationLease(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  repositoryGitDir?: string;
  slot?: RepositoryMutationSlot;
  ownershipToken: string;
  dependencies?: Partial<RepositoryLeaseFinalizationDependencies>;
}): Promise<RepositoryLeaseFinalizationResult> {
  const startedAt = options.dependencies?.now?.() ?? Date.now();
  const now = options.dependencies?.now ?? Date.now;
  const sleep = options.dependencies?.sleep ?? ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  const getProcessFingerprint = options.dependencies?.getProcessFingerprint ?? readProcessFingerprint;
  const ownerInspection = inspectRepositoryMutationLease(options.canonicalRepoRoot, { getProcessFingerprint, worktreeRoot: options.worktreeRoot, repositoryGitDir: options.repositoryGitDir, slot: options.slot });
  if (ownerInspection.state === "absent") return { status: "absent", waitedMs: 0 };
  if (!ownerInspection.lease || ownerInspection.lease.canonicalRepoRoot !== options.canonicalRepoRoot) return { status: "invalid-evidence", waitedMs: 0 };
  if (!secureStringsEqual(ownerInspection.lease.ownershipToken, options.ownershipToken)) return { status: "token-mismatch", waitedMs: 0 };
  const parentDeploymentId = ownerInspection.lease.deploymentId;

  while (true) {
    const inspection = options.slot === "implement"
      ? { state: "absent" as const }
      : inspectRepositoryMutationBorrower(options.canonicalRepoRoot, { getProcessFingerprint, worktreeRoot: options.worktreeRoot, repositoryGitDir: options.repositoryGitDir });
    if (inspection.state !== "live") break;
    const borrower = inspection.borrower;
    if (!borrower || borrower.parentDeploymentId !== parentDeploymentId) {
      return {
        status: "borrower-live",
        waitedMs: Math.max(0, now() - startedAt),
        diagnostic: formatRepositoryBorrowerDiagnostic({
          category: "parent-finalization",
          reason: "verified live borrower evidence is not safely attributable to this parent",
          canonicalRepoKey: "unknown",
          canonicalRepoRoot: options.canonicalRepoRoot,
        }),
      };
    }
    const admittedAt = Date.parse(borrower.registeredAt);
    const maximumWait = borrower.timeoutSeconds * 1_000 + REPOSITORY_BORROWER_CLEANUP_MS;
    const deadline = Math.min(admittedAt + maximumWait, startedAt + maximumWait);
    const remaining = deadline - now();
    if (!Number.isFinite(deadline) || remaining <= 0) {
      return {
        status: "borrower-live",
        waitedMs: Math.max(0, now() - startedAt),
        diagnostic: formatRepositoryBorrowerDiagnostic({
          category: "parent-finalization",
          reason: `the live child exceeded its configured timeout plus ${REPOSITORY_BORROWER_CLEANUP_MS}ms cleanup; parent ownership remains retained`,
          canonicalRepoKey: borrower.canonicalRepoKey,
          canonicalRepoRoot: options.canonicalRepoRoot,
        }),
      };
    }
    await sleep(Math.min(BORROWER_WAIT_POLL_MS, remaining));
  }

  const released = releaseRepositoryMutationLease({
    canonicalRepoRoot: options.canonicalRepoRoot,
    worktreeRoot: options.worktreeRoot,
    repositoryGitDir: options.repositoryGitDir,
    slot: options.slot,
    ownershipToken: options.ownershipToken,
    dependencies: { getProcessFingerprint },
  });
  return { ...released, waitedMs: Math.max(0, now() - startedAt) };
}

export function transferRepositoryMutationLease(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  slot?: RepositoryMutationSlot;
  ownershipToken: string;
  nextProcessFingerprint: ProcessFingerprint;
  dependencies?: Partial<RepositoryAdmissionDependencies>;
}): RepositoryLeaseMutationResult {
  const { root, worktree, leasePath, mutexPath } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, options.slot ?? "orchestrator");
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidLeaseUnlocked(leasePath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree) return { status: "invalid-evidence" };
    if (parsed.ownershipToken !== options.ownershipToken) return { status: "token-mismatch" };
    if (!isProcessFingerprint(options.nextProcessFingerprint)
      || !fingerprintsEqual(options.nextProcessFingerprint, dependencies.getProcessFingerprint(options.nextProcessFingerprint.pid))) {
      return { status: "invalid-evidence" };
    }
    const lease = Object.freeze({ ...parsed, processFingerprint: Object.freeze({ ...options.nextProcessFingerprint }) });
    replaceLeaseAtomic(leasePath, lease, dependencies.createToken);
    return { status: "transferred", lease };
  });
}

export function releaseRepositoryMutationLease(options: {
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  repositoryGitDir?: string;
  slot?: RepositoryMutationSlot;
  ownershipToken: string;
  dependencies?: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint">;
}): RepositoryLeaseMutationResult {
  const slot = options.slot ?? "orchestrator";
  const { root, worktree, gitDir, leasePath, mutexPath, linked } = repositoryLeaseLocation(options.canonicalRepoRoot, options.worktreeRoot, slot, options.repositoryGitDir);
  const borrowerPath = join(gitDir, REPOSITORY_MUTATION_BORROWER_FILE);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(mutexPath, () => {
    const parsed = readValidLeaseUnlocked(leasePath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root || (parsed.worktreeRoot ?? root) !== worktree) return { status: "invalid-evidence" };
    if (!secureStringsEqual(parsed.ownershipToken, options.ownershipToken)) return { status: "token-mismatch" };
    const borrowerInspection = slot === "implement" && linked
      ? { state: "absent" as const, reason: "independent implement owner has no borrower", borrowerPath }
      : inspectBorrowerUnlocked(root, borrowerPath, dependencies.getProcessFingerprint);
    if (borrowerInspection.state === "live") return { status: "borrower-live" };
    if (borrowerInspection.state !== "absent") {
      if (!borrowerInspection.borrower || borrowerInspection.borrower.parentDeploymentId !== parsed.deploymentId) return { status: "borrower-invalid" };
      unlinkSync(borrowerPath);
    }
    const approvalPath = repositoryDirtyBorrowApprovalPath(parsed.deploymentDirectory);
    if (existsSync(approvalPath)) {
      try { unlinkSync(approvalPath); } catch { /* unsafe replacement evidence is preserved for diagnosis */ }
    }
    unlinkSync(leasePath);
    return { status: "released" };
  });
}

/**
 * Safely quarantines the exact recoverable evidence named by a prior diagnostic.
 * The shared advisory mutex is reacquired, evidence is re-read, verified-live
 * ownership is refused, and replacement evidence fails the identity check.
 */
export function quarantineRepositoryMutationLease(options: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  expectedEvidenceIdentity: string;
  dependencies?: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint" | "now" | "createToken">;
}): RepositoryLeaseQuarantineResult {
  const root = assertCanonicalRoot(options.canonicalRepoRoot);
  const leasePath = repositoryMutationLeasePath(root);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(leasePath, () => {
    const inspection = inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint);
    if (inspection.state === "absent") {
      return { status: "rejected", evidenceState: "absent", diagnostic: boundDiagnostic(`Repository quarantine: repo=${boundedField(options.canonicalRepoKey, 160)} root=${boundedField(root, 700)}; state=absent; reason=ownership evidence no longer exists.`) };
    }
    if (inspection.state === "live") {
      return { status: "rejected", evidenceState: "live", diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, inspection }) };
    }
    if (!inspection.evidenceIdentity || inspection.evidenceIdentity !== options.expectedEvidenceIdentity) {
      return { status: "rejected", evidenceState: "identity-mismatch", diagnostic: boundDiagnostic(`Repository quarantine: repo=${boundedField(options.canonicalRepoKey, 160)} root=${boundedField(root, 700)}; state=identity-mismatch; reason=ownership evidence changed after inspection. Re-inspect before retrying; replacement evidence was preserved.`) };
    }
    const quarantinePath = quarantineLeaseUnlocked(leasePath, dependencies.now, dependencies.createToken);
    return { status: "quarantined", quarantinePath, diagnostic: boundDiagnostic(`Repository quarantine: repo=${boundedField(options.canonicalRepoKey, 160)} root=${boundedField(root, 700)}; state=quarantined; evidence=${boundedField(options.expectedEvidenceIdentity, 240)}; destination=${boundedField(quarantinePath, 700)}.`) };
  });
}

export function formatDirtyBackgroundBuilderDiagnostic(input: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  team: string;
  mode: string;
  runtime: RuntimeName;
  snapshot: RepositoryGitSnapshot;
  ticket?: string;
}): string {
  const retry = [runtimeBinary(input.runtime), "deploy", input.team, "--mode", input.mode, "--repo", input.canonicalRepoKey];
  if (input.ticket) retry.push("--ticket", input.ticket);
  const snapshot = input.snapshot;
  const roots = input.worktreeRoot && input.worktreeRoot !== input.canonicalRepoRoot
    ? `repo_root=${boundedField(input.canonicalRepoRoot, 700)} worktree_root=${boundedField(input.worktreeRoot, 700)}`
    : `root=${boundedField(input.canonicalRepoRoot, 700)}`;
  return boundDiagnostic(
    `Repository admission: repo=${boundedField(input.canonicalRepoKey, 160)} ${roots}; state=dirty-background; reason=dirty builder repositories require foreground interaction and no ownership was acquired. Git: branch=${boundedField(snapshot.branch, 160)}, head=${boundedField(snapshot.head, 160)}, staged=${snapshot.stagedCount}, unstaged=${snapshot.unstagedCount}, untracked=${snapshot.untrackedCount}. Recovery: retry in the foreground with ${shellCommand(retry)}. Deploy force does not bypass dirty-background interaction.`,
  );
}

export function formatRepositoryBorrowerDiagnostic(input: {
  category: string;
  reason: string;
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  slot?: RepositoryMutationSlot;
}): string {
  const dirtyRecovery = new Set(["dirty-approval", "launch-snapshot", "immediate-reread", "pre-spawn-reread", "child-context", "repository-identity", "parent-identity", "parent-registry", "parent-state", "approved-path-containment"]);
  const siblingRecovery = new Set([
    "borrower-state",
    "sibling-finalizing",
    "parent-finalization",
    "uncertain-live",
    "owner-finalization-borrower-live",
  ]);
  const [correction, resumeAction] = dirtyRecovery.has(input.category)
    ? [
        "preserve parent ownership and capture a fresh complete NUL-safe Git snapshot with one classification for every entry and exact context",
        "obtain a fresh one-use Sinh approval, then require unchanged immediate and mutex-held rereads before retrying",
      ]
    : siblingRecovery.has(input.category)
      ? [
          "preserve the blocking borrower/finalizing evidence and verify the recorded sibling runner has terminated",
          "finalize the matching borrower only after verified death; do not dispatch a sibling or unrelated builder while liveness is uncertain",
        ]
      : [
          "preserve parent ownership and provide fresh runtime-authenticated exact-context evidence",
          "for clean borrowing, retry only after the parent confirms no live sibling and a zero-entry Git snapshot",
        ];
  const roots = input.worktreeRoot && input.worktreeRoot !== input.canonicalRepoRoot
    ? `repo_root=${boundedField(input.canonicalRepoRoot, 700)} worktree_root=${boundedField(input.worktreeRoot, 700)}`
    : `root=${boundedField(input.canonicalRepoRoot, 700)}`;
  const slot = input.slot ? ` slot=${input.slot}` : "";
  return boundDiagnostic(
    `Condition: inherited repository admission ${boundedField(input.category, 120)}. Source: repository-admission borrower evidence for repo=${boundedField(input.canonicalRepoKey, 160)} ${roots}${slot}. Reason: ${boundedField(input.reason, 500)}. Correction: ${correction}. Resume Action: ${resumeAction}.`,
  );
}

export function formatRepositoryAdmissionDiagnostic(input: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  worktreeRoot?: string;
  slot?: RepositoryMutationSlot;
  inspection: RepositoryEvidenceInspection;
  recovered?: boolean;
}): string {
  const key = boundedField(input.canonicalRepoKey, 160);
  const root = boundedField(input.canonicalRepoRoot, 700);
  const worktree = boundedField(input.worktreeRoot ?? input.canonicalRepoRoot, 700);
  const slot = input.slot ? ` slot=${input.slot}` : "";
  const owner = input.inspection.lease ?? input.inspection.observedOwner;
  const ownerText = owner
    ? ` Owner: deployment=${boundedField(owner.deploymentId ?? "unknown", 160)}, runtime=${boundedField(owner.runtime ?? "unknown", 80)}, mode=${boundedField(owner.mode ?? "unknown", 120)}, pid=${owner.processFingerprint?.pid ?? "unknown"}.`
    : " Owner: unavailable.";
  let recovery = "";
  if (input.inspection.state === "live") {
    recovery = owner?.deploymentId
      ? ` Recovery: wait for the owner to finish or inspect it with ${shellCommand(["ppa", "status", owner.deploymentId])}. Do not remove or force the live lease.`
      : " Recovery: wait for the verified live process to finish. Do not remove or force the live lease.";
  } else if (input.inspection.state !== "absent") {
    const safeQuarantine = worktree !== root
      ? " Linked-worktree recovery remains scoped to this exact worktree and slot; retry from that physical worktree with --force after verifying the recorded owner is dead."
      : input.inspection.evidenceIdentity
        ? ` Safe manual quarantine: ${shellCommand(["ppa", "repository", "quarantine", "--repo", input.canonicalRepoKey, "--expected-evidence", input.inspection.evidenceIdentity])}.`
        : " Safe manual quarantine requires a fresh `ppa repository inspect --repo <key>` result.";
    recovery = ` Recovery: retry the same deploy command with --force.${safeQuarantine}`;
  } else if (input.recovered) {
    recovery = " Recovery: recoverable evidence was quarantined exactly and replacement ownership was acquired.";
  }
  const location = worktree === root ? `root=${root}` : `repo_root=${root} worktree_root=${worktree}`;
  const message = `Repository admission: repo=${key} ${location}${slot}; state=${input.inspection.state}; reason=${boundedField(input.inspection.reason, 500)}.${ownerText}${recovery}`;
  return boundDiagnostic(message);
}

function inspectLeaseUnlocked(
  root: string,
  leasePath: string,
  getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined,
): RepositoryEvidenceInspection {
  if (!existsSync(leasePath)) return { state: "absent", reason: "no ownership evidence exists", leasePath };
  const evidenceIdentity = evidenceIdentityUnlocked(leasePath);
  const size = statSync(leasePath).size;
  if (size > MAX_REPOSITORY_LEASE_BYTES) return { state: "oversized", reason: `ownership evidence exceeds ${MAX_REPOSITORY_LEASE_BYTES} bytes`, leasePath, evidenceIdentity };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch {
    return { state: "malformed", reason: "ownership evidence is not valid JSON", leasePath, evidenceIdentity };
  }
  const observedOwner = objectEvidence(value);
  const observedFingerprint = observedOwner?.processFingerprint;
  if (observedFingerprint && fingerprintsEqual(observedFingerprint, getProcessFingerprint(observedFingerprint.pid))) {
    const lease = isRepositoryMutationLease(value) ? value : undefined;
    const rootReason = lease && lease.canonicalRepoRoot !== root ? "verified live process owns root-conflicting evidence" : "PID and process-start fingerprint match a live owner";
    return { state: "live", reason: rootReason, leasePath, evidenceIdentity, ...(lease ? { lease } : {}), ...(observedOwner ? { observedOwner } : {}) };
  }
  if (!isRepositoryMutationLease(value)) return { state: "malformed", reason: "ownership evidence does not match schema version 1", leasePath, evidenceIdentity, ...(observedOwner ? { observedOwner } : {}) };
  if (value.canonicalRepoRoot !== root) return { state: "root-conflicting", reason: "evidence canonical root does not match the lease location", leasePath, evidenceIdentity, lease: value };
  return { state: "stale", reason: "owner PID is dead or its process-start fingerprint was reused", leasePath, evidenceIdentity, lease: value };
}

function inspectBorrowerUnlocked(
  root: string,
  borrowerPath: string,
  getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined,
): RepositoryBorrowerInspection {
  if (!existsSync(borrowerPath)) return { state: "absent", reason: "no borrower evidence exists", borrowerPath };
  const evidenceIdentity = evidenceIdentityUnlocked(borrowerPath);
  const size = statSync(borrowerPath).size;
  if (size > MAX_REPOSITORY_BORROWER_BYTES) return { state: "oversized", reason: `borrower evidence exceeds ${MAX_REPOSITORY_BORROWER_BYTES} bytes`, borrowerPath, evidenceIdentity };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(borrowerPath, "utf8"));
  } catch {
    return { state: "malformed", reason: "borrower evidence is not valid JSON", borrowerPath, evidenceIdentity };
  }
  const observedBorrower = objectBorrowerEvidence(value);
  const observedFingerprint = observedBorrower?.processFingerprint;
  if (observedFingerprint && fingerprintsEqual(observedFingerprint, getProcessFingerprint(observedFingerprint.pid))) {
    const borrower = isRepositoryMutationBorrower(value) ? value : undefined;
    const reason = borrower && borrower.canonicalRepoRoot !== root ? "verified live process owns root-conflicting borrower evidence" : "PID and process-start fingerprint match a live borrower";
    return { state: "live", reason, borrowerPath, evidenceIdentity, ...(borrower ? { borrower } : {}), ...(observedBorrower ? { observedBorrower } : {}) };
  }
  if (!isRepositoryMutationBorrower(value)) return { state: "malformed", reason: "borrower evidence does not match schema version 1", borrowerPath, evidenceIdentity, ...(observedBorrower ? { observedBorrower } : {}) };
  if (value.canonicalRepoRoot !== root) return { state: "root-conflicting", reason: "borrower canonical root does not match its evidence location", borrowerPath, evidenceIdentity, borrower: value };
  return { state: "stale", reason: "borrower PID is dead or its process-start fingerprint was reused", borrowerPath, evidenceIdentity, borrower: value };
}

function readValidLeaseUnlocked(path: string): RepositoryMutationLease | null | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_REPOSITORY_LEASE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRepositoryMutationLease(value) ? value : null;
  } catch {
    return null;
  }
}

function readValidBorrowerUnlocked(path: string): RepositoryMutationBorrower | null | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_REPOSITORY_BORROWER_BYTES) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRepositoryMutationBorrower(value) ? value : null;
  } catch {
    return null;
  }
}

function readValidApprovalUnlocked(path: string): RepositoryDirtyBorrowApproval | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_REPOSITORY_DIRTY_APPROVAL_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRepositoryDirtyBorrowApproval(value) ? value : null;
  } catch {
    return null;
  }
}

function objectEvidence(value: unknown): Partial<RepositoryMutationLease> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fingerprint = isProcessFingerprint(row["processFingerprint"]) ? row["processFingerprint"] : undefined;
  return {
    ...(typeof row["deploymentId"] === "string" ? { deploymentId: row["deploymentId"] } : {}),
    ...(typeof row["runtime"] === "string" && RUNTIMES.includes(row["runtime"] as RuntimeName) ? { runtime: row["runtime"] as RuntimeName } : {}),
    ...(typeof row["mode"] === "string" ? { mode: row["mode"] } : {}),
    ...(fingerprint ? { processFingerprint: fingerprint } : {}),
  };
}

function objectBorrowerEvidence(value: unknown): Partial<RepositoryMutationBorrower> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fingerprint = isProcessFingerprint(row["processFingerprint"]) ? row["processFingerprint"] : undefined;
  return {
    ...(typeof row["parentDeploymentId"] === "string" ? { parentDeploymentId: row["parentDeploymentId"] } : {}),
    ...(typeof row["deploymentId"] === "string" ? { deploymentId: row["deploymentId"] } : {}),
    ...(fingerprint ? { processFingerprint: fingerprint } : {}),
  };
}

function isRepositoryMutationLease(value: unknown): value is RepositoryMutationLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row["schemaVersion"] === 1
    && boundedString(row["ownershipToken"])
    && boundedString(row["canonicalRepoKey"])
    && boundedString(row["canonicalRepoRoot"])
    && isAbsolute(row["canonicalRepoRoot"] as string)
    && (row["worktreeRoot"] === undefined || (boundedString(row["worktreeRoot"]) && isAbsolute(row["worktreeRoot"] as string)))
    && (row["slot"] === undefined || row["slot"] === "orchestrator" || row["slot"] === "implement")
    && boundedString(row["deploymentId"])
    && boundedString(row["deploymentDirectory"])
    && isAbsolute(row["deploymentDirectory"] as string)
    && typeof row["runtime"] === "string"
    && RUNTIMES.includes(row["runtime"] as RuntimeName)
    && boundedString(row["mode"])
    && (row["team"] === undefined || boundedString(row["team"]))
    && (row["launchMode"] === undefined || row["launchMode"] === "foreground" || row["launchMode"] === "background" || row["launchMode"] === "dry-run")
    && isProcessFingerprint(row["processFingerprint"])
    && validTimestamp(row["acquiredAt"])
    && isGitSnapshot(row["preLaunchGitSnapshot"]);
}

function isRepositoryMutationBorrower(value: unknown): value is RepositoryMutationBorrower {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row["schemaVersion"] === 1
    && boundedString(row["borrowerToken"])
    && boundedString(row["canonicalRepoKey"])
    && boundedString(row["canonicalRepoRoot"])
    && isAbsolute(row["canonicalRepoRoot"] as string)
    && (row["worktreeRoot"] === undefined || (boundedString(row["worktreeRoot"]) && isAbsolute(row["worktreeRoot"] as string)))
    && boundedString(row["parentDeploymentId"])
    && isProcessFingerprint(row["parentProcessFingerprint"])
    && boundedString(row["deploymentId"])
    && boundedString(row["deploymentDirectory"])
    && isAbsolute(row["deploymentDirectory"] as string)
    && row["runtime"] === "pi"
    && row["team"] === "builder"
    && row["mode"] === "implement"
    && row["launchMode"] === "background"
    && boundedString(row["ticket"])
    && boundedString(row["branch"])
    && isProcessFingerprint(row["processFingerprint"])
    && validTimestamp(row["registeredAt"])
    && Number.isInteger(row["timeoutSeconds"])
    && Number(row["timeoutSeconds"]) >= MIN_BORROWER_TIMEOUT_SECONDS
    && Number(row["timeoutSeconds"]) <= MAX_BORROWER_TIMEOUT_SECONDS
    && isGitSnapshot(row["launchGitSnapshot"])
    && (row["approvedMutationPaths"] === undefined || isExactPathArray(row["approvedMutationPaths"], (row["worktreeRoot"] ?? row["canonicalRepoRoot"]) as string))
    && (row["dirtyApprovalReceiptId"] === undefined || boundedString(row["dirtyApprovalReceiptId"]))
    && ((row["dirtyApprovalReceiptId"] === undefined) === (row["approvedMutationPaths"] === undefined))
    && (row["finalizationState"] === undefined || row["finalizationState"] === "finalizing")
    && (row["finalizationAttemptedAt"] === undefined || validTimestamp(row["finalizationAttemptedAt"]))
    && ((row["finalizationState"] === undefined) === (row["finalizationAttemptedAt"] === undefined))
    && (row["finalizedAt"] === undefined || validTimestamp(row["finalizedAt"]))
    && (row["finalGitSnapshot"] === undefined || isGitSnapshot(row["finalGitSnapshot"]));
}

function isRepositoryDirtyBorrowApproval(value: unknown): value is RepositoryDirtyBorrowApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row["schemaVersion"] !== 1
    || !boundedString(row["receiptId"])
    || !boundedString(row["approvalReference"])
    || !validTimestamp(row["approvedAt"])
    || row["action"] !== "preserve-and-continue"
    || !boundedString(row["parentDeploymentId"])
    || !boundedString(row["parentDeploymentDirectory"])
    || !isAbsolute(row["parentDeploymentDirectory"] as string)
    || !isProcessFingerprint(row["parentProcessFingerprint"])
    || !boundedString(row["parentLeaseEvidenceIdentity"])
    || !boundedString(row["canonicalRepoKey"])
    || !boundedString(row["canonicalRepoRoot"])
    || !isAbsolute(row["canonicalRepoRoot"] as string)
    || (row["worktreeRoot"] !== undefined && (!boundedString(row["worktreeRoot"]) || !isAbsolute(row["worktreeRoot"] as string)))
    || !boundedString(row["ticket"])
    || !boundedString(row["branch"])
    || !isCompleteGitSnapshot(row["snapshot"] as RepositoryGitSnapshot)
    || (row["snapshot"] as RepositoryGitSnapshot).branch !== row["branch"]
    || !Array.isArray(row["classifications"])
    || !Array.isArray(row["plannedNewPaths"])) return false;
  return (row["classifications"] as unknown[]).every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const classification = item as Record<string, unknown>;
    return typeof classification["path"] === "string" && isApprovedClassification(classification["classification"]);
  }) && (row["plannedNewPaths"] as unknown[]).every((path) => typeof path === "string");
}

function isProcessFingerprint(value: unknown): value is ProcessFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row["pid"]) && Number(row["pid"]) > 0 && boundedString(row["startTimeTicks"]) && boundedString(row["bootId"]);
}

function isGitSnapshot(value: unknown): value is RepositoryGitSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const counts = [row["stagedCount"], row["unstagedCount"], row["untrackedCount"]];
  const completeFields = [row["statusPorcelainV2Base64"], row["statusRecordCount"], row["statusEntries"], row["digestSha256"]];
  return boundedString(row["branch"])
    && boundedString(row["head"])
    && counts.every((count) => Number.isInteger(count) && Number(count) >= 0)
    && typeof row["dirty"] === "boolean"
    && row["dirty"] === counts.some((count) => Number(count) > 0)
    && typeof row["statusSummary"] === "string"
    && row["statusSummary"].length <= MAX_GIT_STATUS_SUMMARY_CHARS
    && (completeFields.every((field) => field === undefined) || isCompleteGitSnapshot(row as unknown as RepositoryGitSnapshot));
}

function isCompleteGitSnapshot(value: unknown): value is RepositoryGitSnapshot & Required<Pick<RepositoryGitSnapshot, "statusPorcelainV2Base64" | "statusRecordCount" | "statusEntries" | "digestSha256">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as RepositoryGitSnapshot;
  if (typeof snapshot.statusPorcelainV2Base64 !== "string"
    || !Number.isInteger(snapshot.statusRecordCount)
    || !Array.isArray(snapshot.statusEntries)
    || typeof snapshot.digestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(snapshot.digestSha256)) return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(snapshot.statusPorcelainV2Base64, "base64");
    if (raw.toString("base64") !== snapshot.statusPorcelainV2Base64) return false;
    const parsed = parseRepositoryGitStatus(raw);
    if (parsed.length !== snapshot.statusRecordCount || JSON.stringify(parsed) !== JSON.stringify(snapshot.statusEntries)) return false;
  } catch {
    return false;
  }
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of snapshot.statusEntries) {
    if (!isGitStatusEntry(entry)) return false;
    if (entry.kind === "untracked") untracked += 1;
    else if (entry.kind !== "ignored") {
      if ((entry.xy[0] ?? ".") !== ".") staged += 1;
      if ((entry.xy[1] ?? ".") !== ".") unstaged += 1;
    }
  }
  return snapshot.statusRecordCount === snapshot.statusEntries.length
    && snapshot.stagedCount === staged
    && snapshot.unstagedCount === unstaged
    && snapshot.untrackedCount === untracked
    && snapshot.dirty === snapshot.statusEntries.some((entry) => entry.kind !== "ignored")
    && snapshot.digestSha256 === repositoryGitSnapshotDigest(snapshot.branch, snapshot.head, raw);
}

function isGitStatusEntry(value: unknown): value is RepositoryGitStatusEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const kinds: readonly RepositoryGitStatusKind[] = ["ordinary", "rename-or-copy", "unmerged", "untracked", "ignored"];
  return Number.isInteger(row["recordIndex"])
    && Number(row["recordIndex"]) > 0
    && typeof row["kind"] === "string"
    && kinds.includes(row["kind"] as RepositoryGitStatusKind)
    && typeof row["xy"] === "string"
    && (row["xy"] as string).length === 2
    && typeof row["path"] === "string"
    && canonicalBase64Matches(row["pathBase64"], row["path"])
    && ((row["sourcePath"] === undefined && row["sourcePathBase64"] === undefined)
      || (typeof row["sourcePath"] === "string" && canonicalBase64Matches(row["sourcePathBase64"], row["sourcePath"] as string)));
}

function assertLease(lease: RepositoryMutationLease): void {
  if (!isRepositoryMutationLease(lease)) throw new Error("repository-admission: generated ownership evidence is invalid");
  const bytes = Buffer.byteLength(`${JSON.stringify(lease, null, 2)}\n`);
  if (bytes > MAX_REPOSITORY_LEASE_BYTES) throw new Error(`repository-admission: generated ownership evidence exceeds ${MAX_REPOSITORY_LEASE_BYTES} bytes`);
}

function assertBorrower(borrower: RepositoryMutationBorrower): void {
  if (!isRepositoryMutationBorrower(borrower)) throw new Error("repository-admission: generated borrower evidence is invalid");
  const bytes = Buffer.byteLength(`${JSON.stringify(borrower, null, 2)}\n`);
  if (bytes > MAX_REPOSITORY_BORROWER_BYTES) throw new Error(`repository-admission: generated borrower evidence exceeds ${MAX_REPOSITORY_BORROWER_BYTES} bytes`);
}

function publishLeaseExclusive(path: string, lease: RepositoryMutationLease, createToken: () => string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = temporaryPath(path, createToken());
  try {
    writeLeaseFile(temporary, lease);
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* no temporary remains after a successful cleanup */ }
  }
}

function assertProtectedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("repository-admission: protected evidence parent must be a real directory");
}

function publishApprovalExclusive(path: string, approval: RepositoryDirtyBorrowApproval, createToken: () => string): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  assertProtectedDirectory(resolve(path, ".."));
  const temporary = temporaryPath(path, createToken());
  try {
    writeApprovalFile(temporary, approval);
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* no temporary remains after a successful cleanup */ }
  }
}

function publishBorrowerExclusive(path: string, borrower: RepositoryMutationBorrower, createToken: () => string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = temporaryPath(path, createToken());
  try {
    writeBorrowerFile(temporary, borrower);
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* no temporary remains after a successful cleanup */ }
  }
}

function replaceLeaseAtomic(path: string, lease: RepositoryMutationLease, createToken: () => string): void {
  assertLease(lease);
  const temporary = temporaryPath(path, createToken());
  try {
    writeLeaseFile(temporary, lease);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}

function replaceBorrowerAtomic(path: string, borrower: RepositoryMutationBorrower, createToken: () => string): void {
  assertBorrower(borrower);
  const temporary = temporaryPath(path, createToken());
  try {
    writeBorrowerFile(temporary, borrower);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}

function writeLeaseFile(path: string, lease: RepositoryMutationLease): void {
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function writeBorrowerFile(path: string, borrower: RepositoryMutationBorrower): void {
  writeFileSync(path, `${JSON.stringify(borrower, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function writeApprovalFile(path: string, approval: RepositoryDirtyBorrowApproval): void {
  const body = `${JSON.stringify(approval, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_REPOSITORY_DIRTY_APPROVAL_BYTES) throw new Error(`dirty-borrow-approval: receipt exceeds ${MAX_REPOSITORY_DIRTY_APPROVAL_BYTES} bytes`);
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function quarantineLeaseUnlocked(path: string, now: () => Date, createToken: () => string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const quarantine = `${path}.quarantine.${now().toISOString().replace(/[:.]/g, "-")}.${boundedField(createToken(), 80)}${attempt === 0 ? "" : `-${attempt}`}`;
    try {
      // A hard link gives no-clobber publication. Removing the source only after
      // that succeeds preserves exact bytes across a crash at either step.
      linkSync(path, quarantine);
      unlinkSync(path);
      return quarantine;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("repository-admission: could not allocate a unique quarantine destination");
}

/**
 * Runs a synchronous lease operation while a crash-releasing OS advisory lock is
 * held by a tiny `flock` helper. The helper waits on a parent-owned stdin pipe, so
 * abrupt parent death closes the pipe and the kernel releases the lock. The mutex
 * file is durable coordination metadata, not ownership, and is never unlinked.
 */
function withMutationMutex<T>(leasePath: string, operation: () => T): T {
  const mutexPath = join(resolve(leasePath, ".."), MUTATION_MUTEX_FILE);
  mkdirSync(resolve(mutexPath, ".."), { recursive: true });
  const descriptor = openSync(mutexPath, "a", 0o600);
  closeSync(descriptor);
  chmodSync(mutexPath, 0o600);

  const signalDirectory = mkdtempSync(join(tmpdir(), "pa-repository-mutex-"));
  const readyPath = join(signalDirectory, "ready");
  const donePath = join(signalDirectory, "done");
  const script = "trap 'rm -f -- \"$1\"; : > \"$2\"' EXIT; : > \"$1\"; IFS= read -r _";
  const holder = spawn("flock", ["--exclusive", "--wait", String(MUTEX_TIMEOUT_MS / 1000), mutexPath, "/bin/sh", "-c", script, "pa-repository-mutex", readyPath, donePath], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  holder.stdin.on("error", () => { /* a failed helper is reported by the handshake timeout */ });
  try {
    waitForPath(readyPath, MUTEX_TIMEOUT_MS, "acquire crash-safe ownership-operation mutex");
    return operation();
  } finally {
    holder.stdin.end("release\n");
    try {
      waitForPath(donePath, MUTEX_TIMEOUT_MS, "release crash-safe ownership-operation mutex");
    } catch {
      holder.kill("SIGKILL");
    }
    rmSync(signalDirectory, { recursive: true, force: true });
  }
}

function waitForPath(path: string, timeoutMs: number, action: string): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`repository-admission: could not ${action} within ${timeoutMs}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MUTEX_POLL_MS);
  }
}

function evidenceIdentityUnlocked(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const prefixBytes = Number(stat.size < BigInt(MAX_REPOSITORY_LEASE_BYTES) ? stat.size : BigInt(MAX_REPOSITORY_LEASE_BYTES));
    const buffer = Buffer.alloc(prefixBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const hash = createHash("sha256")
      .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeNs}:`)
      .update(buffer.subarray(0, offset))
      .digest("hex");
    return `v1-${hash}`;
  } finally {
    closeSync(descriptor);
  }
}

function resolveDependencies(overrides: Partial<RepositoryAdmissionDependencies> | undefined): ResolvedRepositoryAdmissionDependencies {
  return {
    getProcessFingerprint: overrides?.getProcessFingerprint ?? readProcessFingerprint,
    runGit: overrides?.runGit ?? defaultGitRunner,
    now: overrides?.now ?? (() => new Date()),
    createToken: overrides?.createToken ?? randomUUID,
    isDeploymentRunning: overrides?.isDeploymentRunning ?? ((deploymentId) => queryDeploymentStatus(deploymentId)?.status === "running"),
    isProcessInLineage: overrides?.isProcessInLineage ?? processIsWithinFingerprintLineage,
    isProcessAlive: overrides?.isProcessAlive ?? processIsAlive,
    getCurrentProcessFingerprint: overrides?.getCurrentProcessFingerprint ?? (() => readProcessFingerprint(process.pid)),
  };
}

function processIsWithinFingerprintLineage(pid: number, ancestor: ProcessFingerprint): boolean {
  if (!fingerprintsEqual(ancestor, readProcessFingerprint(ancestor.pid))) return false;
  let current = pid;
  for (let depth = 0; depth < 64 && current > 0; depth += 1) {
    if (current === ancestor.pid) return true;
    const parent = readProcessParentPid(current);
    if (parent === undefined || parent === current) return false;
    current = parent;
  }
  return false;
}

function readProcessParentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    const parent = Number(stat.slice(closingParenthesis + 2).trim().split(/\s+/)[1]);
    return Number.isInteger(parent) && parent >= 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function defaultGitRunner(args: readonly string[], cwd: string): Buffer {
  return execFileSync("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
}

function gitText(output: string | Buffer): string {
  return typeof output === "string" ? output : output.toString("utf8");
}

function gitBytes(output: string | Buffer): Buffer {
  return typeof output === "string" ? Buffer.from(output, "utf8") : Buffer.from(output);
}

function splitNulFields(raw: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    fields.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (fields.some((field) => field.length === 0)) throw new Error("repository-admission: porcelain-v2 contains an empty record");
  return fields;
}

function asciiField(record: Buffer, tokenIndex: number): string {
  let start = 0;
  for (let current = 0; current < tokenIndex; current += 1) {
    const separator = record.indexOf(0x20, start);
    if (separator < 0) throw new Error("repository-admission: malformed porcelain-v2 fixed fields");
    start = separator + 1;
  }
  const end = record.indexOf(0x20, start);
  if (end < 0) throw new Error("repository-admission: malformed porcelain-v2 fixed fields");
  return record.subarray(start, end).toString("ascii");
}

function trailingField(record: Buffer, separatorCount: number): Buffer {
  let offset = 0;
  for (let count = 0; count < separatorCount; count += 1) {
    const separator = record.indexOf(0x20, offset);
    if (separator < 0) throw new Error("repository-admission: malformed porcelain-v2 path field");
    offset = separator + 1;
  }
  const path = record.subarray(offset);
  if (path.length === 0) throw new Error("repository-admission: empty porcelain-v2 path is forbidden");
  return path;
}

function decodeGitPath(path: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(path);
  } catch {
    throw new Error("repository-admission: non-UTF-8 Git paths cannot be safely approved for mutation");
  }
}

function displayPath(path: string): string {
  return JSON.stringify(path);
}

function canonicalBase64Matches(value: unknown, decoded: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value && decodeGitPath(bytes) === decoded;
  } catch {
    return false;
  }
}

function isApprovedClassification(value: unknown): value is RepositoryDirtyBorrowClassificationKind {
  return value === "active-ticket-produced" || value === "active-ticket-preserved";
}

function validRepositoryRelativePath(root: string, path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path) || path.includes("\\")) return false;
  const absolute = resolve(root, path);
  const back = relative(root, absolute);
  return back === path && back !== ".." && !back.startsWith(`..${sep}`);
}

function containsGlobSyntax(path: string): boolean {
  return /[*?\[\]{}]/.test(path);
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function hasSymlinkTraversal(root: string, path: string): boolean {
  const components = path.split("/");
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  return false;
}

function isExactPathArray(value: unknown, root: string): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((path) => typeof path === "string" && validRepositoryRelativePath(root, path))
    && new Set(value).size === value.length;
}

function normalizedTeam(team: string): string {
  return team.trim().split("/", 1)[0]?.toLowerCase() ?? "";
}

function secureStringsEqual(expected: string, observed: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const observedHash = createHash("sha256").update(observed).digest();
  return expectedHash.equals(observedHash);
}

function fingerprintsEqual(expected: ProcessFingerprint, observed: ProcessFingerprint | undefined): boolean {
  return Boolean(observed && expected.pid === observed.pid && expected.startTimeTicks === observed.startTimeTicks && expected.bootId === observed.bootId);
}

function assertCanonicalRoot(value: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) throw new Error("repository-admission: canonical repository root must be an exact absolute normalized path");
  return value;
}

function assertPhysicalDirectory(value: string, label: string): string {
  const path = assertCanonicalRoot(value);
  try {
    if (!statSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("not physical");
    return path;
  } catch {
    throw new Error(`repository-admission: ${label} must remain an exact physical directory`);
  }
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= STRING_FIELD_LIMIT;
}

function boundedRequired(value: string, label: string): string {
  const bounded = boundedField(value.trim(), STRING_FIELD_LIMIT);
  if (!bounded) throw new Error(`repository-admission: ${label} is required`);
  return bounded;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function boundedField(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function boundDiagnostic(value: string): string {
  if (value.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS) return value;
  return `${value.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS - 3)}...`;
}

function temporaryPath(path: string, token: string): string {
  return `${path}.${process.pid}.${boundedField(token.replace(/[^A-Za-z0-9_-]/g, "_"), 80)}.tmp`;
}

function shellCommand(parts: readonly string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}

function runtimeBinary(runtime: RuntimeName): string {
  if (runtime === "pi") return "ppa";
  if (runtime === "claude") return "cpa";
  if (runtime === "droid") return "dpa";
  return "opa";
}
