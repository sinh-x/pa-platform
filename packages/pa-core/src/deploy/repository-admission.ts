import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";
import type { RuntimeName } from "../types.js";

export const REPOSITORY_MUTATION_LEASE_FILE = "pa-repository-mutation.lease.json";
export const MAX_REPOSITORY_LEASE_BYTES = 64 * 1024;
export const MAX_GIT_STATUS_SUMMARY_CHARS = 1_024;

const MUTATION_MUTEX_FILE = "pa-repository-mutation.lease.lock";
const MUTEX_TIMEOUT_MS = 5_000;
const STRING_FIELD_LIMIT = 4_096;
const RUNTIMES: readonly RuntimeName[] = ["claude", "opencode", "droid", "pi"];

export type RepositoryAccess = "read-only" | "exclusive-builder" | "non-locking";
export type RepositoryEvidenceState = "absent" | "live" | "stale" | "malformed" | "oversized" | "root-conflicting";

export interface ProcessFingerprint {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly bootId: string;
}

export interface RepositoryGitSnapshot {
  readonly branch: string;
  readonly head: string;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly dirty: boolean;
  readonly statusSummary: string;
}

export type RepositoryAdmissionLaunchMode = "foreground" | "background" | "dry-run";
export type RepositoryOwnershipIntent = "none" | "preview" | "acquire-before-spawn";
export type RepositoryAdmissionOperation = "git-status" | "lease-read" | "lease-write" | "lease-remove" | "lease-quarantine";

/** Immutable repository evidence carried by the shared execution plan. */
export interface RepositoryAdmissionEvidence {
  readonly access: RepositoryAccess;
  readonly launchMode: RepositoryAdmissionLaunchMode;
  readonly ownershipIntent: RepositoryOwnershipIntent;
  readonly force: boolean;
  readonly gitSnapshot?: RepositoryGitSnapshot;
}

export interface ResolveRepositoryAdmissionEvidenceOptions {
  readonly team: string;
  readonly mode: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly runtime: RuntimeName;
  readonly background?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly ticket?: string;
  readonly captureGitSnapshot?: (canonicalRepoRoot: string) => RepositoryGitSnapshot;
  readonly observeOperation?: (operation: RepositoryAdmissionOperation) => void;
}

export interface RepositoryMutationLease {
  readonly schemaVersion: 1;
  readonly ownershipToken: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: RuntimeName;
  readonly mode: string;
  readonly processFingerprint: ProcessFingerprint;
  readonly acquiredAt: string;
  readonly preLaunchGitSnapshot: RepositoryGitSnapshot;
}

export interface GitCommandRunner {
  (args: readonly string[], cwd: string): string;
}

export interface RepositoryAdmissionDependencies {
  readonly getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined;
  readonly runGit: GitCommandRunner;
  readonly now: () => Date;
  readonly createToken: () => string;
}

export interface AcquireRepositoryMutationLeaseOptions {
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly runtime: RuntimeName;
  readonly mode: string;
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
  readonly lease?: RepositoryMutationLease;
  readonly observedOwner?: Partial<RepositoryMutationLease>;
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
      readonly evidenceState: Exclude<RepositoryEvidenceState, "absent">;
      readonly leasePath: string;
      readonly diagnostic: string;
      readonly lease?: RepositoryMutationLease;
    };

export type RepositoryLeaseMutationResult =
  | { readonly status: "transferred" | "released"; readonly lease?: RepositoryMutationLease }
  | { readonly status: "absent" | "token-mismatch" | "invalid-evidence" };

export function classifyRepositoryAccess(team: string, _mode?: string): RepositoryAccess {
  const normalizedTeam = team.trim().split("/", 1)[0]?.toLowerCase();
  if (normalizedTeam === "requirements") return "read-only";
  if (normalizedTeam === "builder") return "exclusive-builder";
  return "non-locking";
}

export function repositoryMutationLeasePath(canonicalRepoRoot: string): string {
  return join(assertCanonicalRoot(canonicalRepoRoot), ".git", REPOSITORY_MUTATION_LEASE_FILE);
}

/**
 * Plans mode-aware admission without touching repository ownership evidence.
 * Requirements and other non-exclusive teams return before Git status capture.
 */
export function resolveRepositoryAdmissionEvidence(options: ResolveRepositoryAdmissionEvidenceOptions): RepositoryAdmissionEvidence {
  const canonicalRepoRoot = assertCanonicalRoot(options.canonicalRepoRoot);
  const access = classifyRepositoryAccess(options.team, options.mode);
  const launchMode: RepositoryAdmissionLaunchMode = options.dryRun ? "dry-run" : options.background ? "background" : "foreground";
  if (access !== "exclusive-builder") {
    return Object.freeze({ access, launchMode, ownershipIntent: "none", force: Boolean(options.force) });
  }

  options.observeOperation?.("git-status");
  const snapshot = Object.freeze({ ...(options.captureGitSnapshot ?? captureRepositoryGitSnapshot)(canonicalRepoRoot) });
  if (snapshot.dirty && launchMode === "background") {
    throw new Error(formatDirtyBackgroundBuilderDiagnostic({
      canonicalRepoKey: options.canonicalRepoKey,
      canonicalRepoRoot,
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
    gitSnapshot: snapshot,
  });
}

export function captureRepositoryGitSnapshot(canonicalRepoRoot: string, runGit: GitCommandRunner = defaultGitRunner): RepositoryGitSnapshot {
  const root = assertCanonicalRoot(canonicalRepoRoot);
  let branch = "(detached)";
  try {
    branch = boundedField(runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root).trim(), STRING_FIELD_LIMIT) || "(detached)";
  } catch {
    // Detached HEAD is valid evidence and does not cause admission to mutate Git.
  }
  const head = boundedField(runGit(["rev-parse", "HEAD"], root).trim(), STRING_FIELD_LIMIT);
  const porcelain = runGit(["status", "--porcelain=v1", "--untracked-files=all", "-z"], root);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  const summary: string[] = [];
  const records = porcelain.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    if (x === "?" && y === "?") untrackedCount += 1;
    else {
      if (x !== " " && x !== "!") stagedCount += 1;
      if (y !== " " && y !== "!") unstagedCount += 1;
    }
    summary.push(record.replace(/[\r\n]/g, " "));
    if (x === "R" || x === "C") index += 1;
  }
  return Object.freeze({
    branch,
    head,
    stagedCount,
    unstagedCount,
    untrackedCount,
    dirty: stagedCount + unstagedCount + untrackedCount > 0,
    statusSummary: boundedField(summary.join("\n"), MAX_GIT_STATUS_SUMMARY_CHARS),
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
  dependencies: Pick<RepositoryAdmissionDependencies, "getProcessFingerprint"> = { getProcessFingerprint: readProcessFingerprint },
): RepositoryEvidenceInspection {
  const root = assertCanonicalRoot(canonicalRepoRoot);
  const leasePath = repositoryMutationLeasePath(root);
  return withMutationMutex(leasePath, () => inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint));
}

export function acquireRepositoryMutationLease(options: AcquireRepositoryMutationLeaseOptions): RepositoryLeaseAcquisition {
  const root = assertCanonicalRoot(options.canonicalRepoRoot);
  const leasePath = repositoryMutationLeasePath(root);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(leasePath, () => {
    let inspection = inspectLeaseUnlocked(root, leasePath, dependencies.getProcessFingerprint);
    let quarantinedPath: string | undefined;
    if (inspection.state !== "absent") {
      if (inspection.state === "live" || !options.force) {
        return {
          status: "rejected",
          evidenceState: inspection.state,
          leasePath,
          diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, inspection }),
          ...(inspection.lease ? { lease: inspection.lease } : {}),
        };
      }
      quarantinedPath = quarantineLeaseUnlocked(leasePath, dependencies.now, dependencies.createToken);
      inspection = { state: "absent", reason: "recoverable evidence was atomically quarantined", leasePath };
    }

    const pid = options.pid ?? process.pid;
    const observedFingerprint = dependencies.getProcessFingerprint(pid);
    const fingerprint = options.processFingerprint ?? observedFingerprint;
    if (!fingerprint || fingerprint.pid !== pid || !fingerprintsEqual(fingerprint, observedFingerprint)) {
      throw new Error(`repository-admission: cannot verify process start fingerprint for PID ${pid}`);
    }
    const gitSnapshot = options.gitSnapshot ?? captureRepositoryGitSnapshot(root, dependencies.runGit);
    const lease: RepositoryMutationLease = Object.freeze({
      schemaVersion: 1,
      ownershipToken: boundedRequired(options.ownershipToken ?? dependencies.createToken(), "ownership token"),
      canonicalRepoKey: boundedRequired(options.canonicalRepoKey, "canonical repository key"),
      canonicalRepoRoot: root,
      deploymentId: boundedRequired(options.deploymentId, "deployment ID"),
      deploymentDirectory: boundedRequired(options.deploymentDirectory, "deployment directory"),
      runtime: options.runtime,
      mode: boundedRequired(options.mode, "mode"),
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
      diagnostic: formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: options.canonicalRepoKey, canonicalRepoRoot: root, inspection, recovered: Boolean(quarantinedPath) }),
      ...(quarantinedPath ? { quarantinedPath } : {}),
    };
  });
}

export function transferRepositoryMutationLease(options: {
  canonicalRepoRoot: string;
  ownershipToken: string;
  nextProcessFingerprint: ProcessFingerprint;
  dependencies?: Partial<RepositoryAdmissionDependencies>;
}): RepositoryLeaseMutationResult {
  const root = assertCanonicalRoot(options.canonicalRepoRoot);
  const leasePath = repositoryMutationLeasePath(root);
  const dependencies = resolveDependencies(options.dependencies);
  return withMutationMutex(leasePath, () => {
    const parsed = readValidLeaseUnlocked(leasePath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root) return { status: "invalid-evidence" };
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
  ownershipToken: string;
}): RepositoryLeaseMutationResult {
  const root = assertCanonicalRoot(options.canonicalRepoRoot);
  const leasePath = repositoryMutationLeasePath(root);
  return withMutationMutex(leasePath, () => {
    const parsed = readValidLeaseUnlocked(leasePath);
    if (parsed === undefined) return { status: "absent" };
    if (parsed === null || parsed.canonicalRepoRoot !== root) return { status: "invalid-evidence" };
    if (parsed.ownershipToken !== options.ownershipToken) return { status: "token-mismatch" };
    unlinkSync(leasePath);
    return { status: "released" };
  });
}

export function formatDirtyBackgroundBuilderDiagnostic(input: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  team: string;
  mode: string;
  runtime: RuntimeName;
  snapshot: RepositoryGitSnapshot;
  ticket?: string;
}): string {
  const retry = [runtimeBinary(input.runtime), "deploy", input.team, "--mode", input.mode, "--repo", input.canonicalRepoKey];
  if (input.ticket) retry.push("--ticket", input.ticket);
  const snapshot = input.snapshot;
  return boundDiagnostic(
    `Repository admission: repo=${boundedField(input.canonicalRepoKey, 160)} root=${boundedField(input.canonicalRepoRoot, 700)}; state=dirty-background; reason=dirty builder repositories require foreground interaction and no ownership was acquired. Git: branch=${boundedField(snapshot.branch, 160)}, head=${boundedField(snapshot.head, 160)}, staged=${snapshot.stagedCount}, unstaged=${snapshot.unstagedCount}, untracked=${snapshot.untrackedCount}. Recovery: retry in the foreground with ${shellCommand(retry)}. Deploy force does not bypass dirty-background interaction.`,
  );
}

export function formatRepositoryAdmissionDiagnostic(input: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  inspection: RepositoryEvidenceInspection;
  recovered?: boolean;
}): string {
  const key = boundedField(input.canonicalRepoKey, 160);
  const root = boundedField(input.canonicalRepoRoot, 700);
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
    const leasePath = repositoryMutationLeasePath(input.canonicalRepoRoot);
    recovery = ` Recovery: retry the same deploy command with --force. Manual quarantine: ${shellCommand(["mv", "--", leasePath, `${leasePath}.manual-quarantine`])}.`;
  } else if (input.recovered) {
    recovery = " Recovery: recoverable evidence was quarantined exactly and replacement ownership was acquired.";
  }
  const message = `Repository admission: repo=${key} root=${root}; state=${input.inspection.state}; reason=${boundedField(input.inspection.reason, 500)}.${ownerText}${recovery}`;
  return boundDiagnostic(message);
}

function inspectLeaseUnlocked(
  root: string,
  leasePath: string,
  getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined,
): RepositoryEvidenceInspection {
  if (!existsSync(leasePath)) return { state: "absent", reason: "no ownership evidence exists", leasePath };
  const size = statSync(leasePath).size;
  if (size > MAX_REPOSITORY_LEASE_BYTES) return { state: "oversized", reason: `ownership evidence exceeds ${MAX_REPOSITORY_LEASE_BYTES} bytes`, leasePath };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch {
    return { state: "malformed", reason: "ownership evidence is not valid JSON", leasePath };
  }
  const observedOwner = objectEvidence(value);
  const observedFingerprint = observedOwner?.processFingerprint;
  if (observedFingerprint && fingerprintsEqual(observedFingerprint, getProcessFingerprint(observedFingerprint.pid))) {
    const lease = isRepositoryMutationLease(value) ? value : undefined;
    const rootReason = lease && lease.canonicalRepoRoot !== root ? "verified live process owns root-conflicting evidence" : "PID and process-start fingerprint match a live owner";
    return { state: "live", reason: rootReason, leasePath, ...(lease ? { lease } : {}), ...(observedOwner ? { observedOwner } : {}) };
  }
  if (!isRepositoryMutationLease(value)) return { state: "malformed", reason: "ownership evidence does not match schema version 1", leasePath, ...(observedOwner ? { observedOwner } : {}) };
  if (value.canonicalRepoRoot !== root) return { state: "root-conflicting", reason: "evidence canonical root does not match the lease location", leasePath, lease: value };
  return { state: "stale", reason: "owner PID is dead or its process-start fingerprint was reused", leasePath, lease: value };
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

function isRepositoryMutationLease(value: unknown): value is RepositoryMutationLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row["schemaVersion"] === 1
    && boundedString(row["ownershipToken"])
    && boundedString(row["canonicalRepoKey"])
    && boundedString(row["canonicalRepoRoot"])
    && isAbsolute(row["canonicalRepoRoot"] as string)
    && boundedString(row["deploymentId"])
    && boundedString(row["deploymentDirectory"])
    && isAbsolute(row["deploymentDirectory"] as string)
    && typeof row["runtime"] === "string"
    && RUNTIMES.includes(row["runtime"] as RuntimeName)
    && boundedString(row["mode"])
    && isProcessFingerprint(row["processFingerprint"])
    && validTimestamp(row["acquiredAt"])
    && isGitSnapshot(row["preLaunchGitSnapshot"]);
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
  return boundedString(row["branch"])
    && boundedString(row["head"])
    && counts.every((count) => Number.isInteger(count) && Number(count) >= 0)
    && typeof row["dirty"] === "boolean"
    && row["dirty"] === counts.some((count) => Number(count) > 0)
    && typeof row["statusSummary"] === "string"
    && row["statusSummary"].length <= MAX_GIT_STATUS_SUMMARY_CHARS;
}

function assertLease(lease: RepositoryMutationLease): void {
  if (!isRepositoryMutationLease(lease)) throw new Error("repository-admission: generated ownership evidence is invalid");
  const bytes = Buffer.byteLength(`${JSON.stringify(lease, null, 2)}\n`);
  if (bytes > MAX_REPOSITORY_LEASE_BYTES) throw new Error(`repository-admission: generated ownership evidence exceeds ${MAX_REPOSITORY_LEASE_BYTES} bytes`);
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

function writeLeaseFile(path: string, lease: RepositoryMutationLease): void {
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function quarantineLeaseUnlocked(path: string, now: () => Date, createToken: () => string): string {
  const quarantine = `${path}.quarantine.${now().toISOString().replace(/[:.]/g, "-")}.${boundedField(createToken(), 80)}`;
  renameSync(path, quarantine);
  return quarantine;
}

function withMutationMutex<T>(leasePath: string, operation: () => T): T {
  const mutexPath = join(resolve(leasePath, ".."), MUTATION_MUTEX_FILE);
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(mutexPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`repository-admission: could not acquire atomic ownership-operation mutex: ${error instanceof Error ? error.message : String(error)}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(mutexPath); } catch { /* preserve the operation result if cleanup races with external interference */ }
  }
}

function resolveDependencies(overrides: Partial<RepositoryAdmissionDependencies> | undefined): RepositoryAdmissionDependencies {
  return {
    getProcessFingerprint: overrides?.getProcessFingerprint ?? readProcessFingerprint,
    runGit: overrides?.runGit ?? defaultGitRunner,
    now: overrides?.now ?? (() => new Date()),
    createToken: overrides?.createToken ?? randomUUID,
  };
}

function defaultGitRunner(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function fingerprintsEqual(expected: ProcessFingerprint, observed: ProcessFingerprint | undefined): boolean {
  return Boolean(observed && expected.pid === observed.pid && expected.startTimeTicks === observed.startTimeTicks && expected.bootId === observed.bootId);
}

function assertCanonicalRoot(value: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) throw new Error("repository-admission: canonical repository root must be an exact absolute normalized path");
  return value;
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
