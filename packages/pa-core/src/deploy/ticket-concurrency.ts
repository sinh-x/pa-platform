import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import { readProcessFingerprint, type ProcessFingerprint } from "./repository-admission.js";

export const MAX_REPOSITORY_TICKET_SLOTS = 4;
export const MAX_REPOSITORY_TICKET_SLOT_BYTES = 64 * 1024;
export const REPOSITORY_TICKET_SLOT_DIRECTORY = "pa-ticket-builder-slots";
const REPOSITORY_TICKET_SLOT_MUTEX = "pa-ticket-builder-slots.lock";
const MUTEX_TIMEOUT_MS = 5_000;
const MUTEX_POLL_MS = 2;
const STRING_LIMIT = 4_096;

export interface RepositoryTicketSlot {
  readonly schemaVersion: 1;
  readonly slotToken: string;
  readonly slotId: string;
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly ticket: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly repositoryPermit: 1 | 2 | 3 | 4;
  readonly processFingerprint: ProcessFingerprint;
  readonly acquiredAt: string;
}

export interface RepositoryTicketSlotHandoff {
  readonly canonicalRepoKey: string;
  readonly canonicalRepoRoot: string;
  readonly ticket: string;
  readonly slotToken: string;
  readonly slotId: string;
  readonly repositoryPermit: 1 | 2 | 3 | 4;
}

export interface RepositoryTicketSlotDependencies {
  readonly getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined;
  readonly now: () => Date;
  readonly createToken: () => string;
}

export type RepositoryTicketSlotAcquisition =
  | { readonly status: "acquired"; readonly slotPath: string; readonly slot: RepositoryTicketSlot; readonly diagnostic: string; readonly recovered: number }
  | { readonly status: "rejected"; readonly slotPath: string; readonly diagnostic: string; readonly reason: "duplicate-ticket" | "repository-capacity" | "invalid-evidence" };

export type RepositoryTicketSlotMutationResult =
  | { readonly status: "transferred"; readonly slot: RepositoryTicketSlot }
  | { readonly status: "released" | "absent" | "token-mismatch" | "invalid-evidence" };

export type RepositoryTicketSlotAuthentication =
  | { readonly status: "authenticated"; readonly evidenceIdentity: string }
  | { readonly status: "rejected"; readonly reason: "absent" | "malformed" | "oversized" | "insecure" | "stale-process" | "identity-mismatch" | "replaced" };

export function authenticateRepositoryTicketSlot(options: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  ticket: string;
  deploymentId: string;
  deploymentDirectory: string;
  slotId: string;
  repositoryPermit: 1 | 2 | 3 | 4;
  processFingerprint: ProcessFingerprint;
  expectedEvidenceIdentity?: string;
  dependencies?: Pick<RepositoryTicketSlotDependencies, "getProcessFingerprint">;
}): RepositoryTicketSlotAuthentication {
  const root = physicalRoot(options.canonicalRepoRoot);
  const dependencies = resolvedDependencies(options.dependencies);
  return withTicketMutex(root, () => {
    const path = repositoryTicketSlotPath(root, options.ticket);
    if (!existsSync(path)) return { status: "rejected", reason: "absent" };
    const inspected = inspectSlot(path, dependencies.getProcessFingerprint);
    if (inspected.state !== "live") {
      return { status: "rejected", reason: inspected.state === "stale" ? "stale-process" : inspected.state };
    }
    const slot = inspected.slot;
    if (slot.canonicalRepoKey !== options.canonicalRepoKey
      || slot.canonicalRepoRoot !== root
      || slot.ticket !== options.ticket
      || slot.deploymentId !== options.deploymentId
      || slot.deploymentDirectory !== options.deploymentDirectory
      || slot.slotId !== options.slotId
      || slot.repositoryPermit !== options.repositoryPermit
      || !fingerprintsEqual(slot.processFingerprint, options.processFingerprint)) {
      return { status: "rejected", reason: "identity-mismatch" };
    }
    const evidenceIdentity = slotEvidenceIdentity(slot);
    if (options.expectedEvidenceIdentity !== undefined && !secureEqual(evidenceIdentity, options.expectedEvidenceIdentity)) {
      return { status: "rejected", reason: "replaced" };
    }
    return { status: "authenticated", evidenceIdentity };
  });
}

export function repositoryTicketSlotId(canonicalRepoKey: string, ticket: string): string {
  return `pa:${required(canonicalRepoKey, "repository key")}:${required(ticket, "ticket")}`;
}

export function repositoryTicketSlotPath(canonicalRepoRoot: string, ticket: string): string {
  const directory = ticketSlotDirectory(canonicalRepoRoot);
  return join(directory, `${createHash("sha256").update(required(ticket, "ticket")).digest("hex")}.json`);
}

export function acquireRepositoryTicketSlot(options: {
  canonicalRepoKey: string;
  canonicalRepoRoot: string;
  ticket: string;
  deploymentId: string;
  deploymentDirectory: string;
  force?: boolean;
  pid?: number;
  processFingerprint?: ProcessFingerprint;
  dependencies?: Partial<RepositoryTicketSlotDependencies>;
}): RepositoryTicketSlotAcquisition {
  const root = physicalRoot(options.canonicalRepoRoot);
  const dependencies = resolvedDependencies(options.dependencies);
  const directory = ticketSlotDirectory(root);
  const slotPath = repositoryTicketSlotPath(root, options.ticket);
  return withTicketMutex(root, () => {
    const live: RepositoryTicketSlot[] = [];
    let recovered = 0;
    for (const path of ticketEvidencePaths(directory)) {
      const inspected = inspectSlot(path, dependencies.getProcessFingerprint);
      if (inspected.state === "live") {
        live.push(inspected.slot);
        continue;
      }
      if (inspected.state === "stale") {
        quarantine(path, dependencies.now, dependencies.createToken);
        recovered += 1;
        continue;
      }
      if (!options.force) {
        return { status: "rejected", reason: "invalid-evidence", slotPath, diagnostic: ticketDiagnostic(options, `persisted ticket-slot evidence is ${inspected.state} at ${path}`, "preserve the file and reconcile or retry with --force only after proving no recorded process is live") };
      }
      quarantine(path, dependencies.now, dependencies.createToken);
      recovered += 1;
    }
    if (live.some((slot) => slot.ticket === options.ticket)) {
      return { status: "rejected", reason: "duplicate-ticket", slotPath, diagnostic: ticketDiagnostic(options, `ticket ${options.ticket} already has a process-verified live builder slot`, "wait for the matching deployment to reach verified terminal finalization") };
    }
    if (live.length >= MAX_REPOSITORY_TICKET_SLOTS) {
      return { status: "rejected", reason: "repository-capacity", slotPath, diagnostic: ticketDiagnostic(options, `repository already has ${live.length} live ticket builders; the maximum is ${MAX_REPOSITORY_TICKET_SLOTS}`, "wait for one live ticket deployment to finalize before retrying") };
    }
    const used = new Set(live.map((slot) => slot.repositoryPermit));
    const repositoryPermit = ([1, 2, 3, 4] as const).find((permit) => !used.has(permit));
    if (!repositoryPermit) throw new Error("ticket-concurrency: permit allocation contradicted the live-slot count");
    const pid = options.pid ?? process.pid;
    const observed = dependencies.getProcessFingerprint(pid);
    const fingerprint = options.processFingerprint ?? observed;
    if (!fingerprint || !fingerprintsEqual(fingerprint, observed) || fingerprint.pid !== pid) {
      throw new Error(`ticket-concurrency: cannot verify process start fingerprint for PID ${pid}`);
    }
    const slot: RepositoryTicketSlot = Object.freeze({
      schemaVersion: 1,
      slotToken: required(dependencies.createToken(), "slot token"),
      slotId: repositoryTicketSlotId(options.canonicalRepoKey, options.ticket),
      canonicalRepoKey: required(options.canonicalRepoKey, "repository key"),
      canonicalRepoRoot: root,
      ticket: required(options.ticket, "ticket"),
      deploymentId: required(options.deploymentId, "deployment ID"),
      deploymentDirectory: absolutePath(options.deploymentDirectory, "deployment directory"),
      repositoryPermit,
      processFingerprint: Object.freeze({ ...fingerprint }),
      acquiredAt: dependencies.now().toISOString(),
    });
    assertSlot(slot);
    publishExclusive(slotPath, slot, dependencies.createToken);
    return { status: "acquired", slotPath, slot, recovered, diagnostic: ticketDiagnostic(options, `acquired ticket slot ${slot.slotId} and repository permit ${repositoryPermit}${recovered ? ` after recovering ${recovered} stale entries` : ""}`, "continue with Treehouse acquisition and release only matching PA evidence on failure or terminal handling") };
  });
}

export function transferRepositoryTicketSlot(options: RepositoryTicketSlotHandoff & {
  nextProcessFingerprint: ProcessFingerprint;
  dependencies?: Pick<RepositoryTicketSlotDependencies, "getProcessFingerprint" | "createToken">;
}): RepositoryTicketSlotMutationResult {
  const dependencies = resolvedDependencies(options.dependencies);
  return withTicketMutex(options.canonicalRepoRoot, () => {
    const path = repositoryTicketSlotPath(options.canonicalRepoRoot, options.ticket);
    const slot = readSlot(path);
    if (slot === undefined) return { status: "absent" };
    if (slot === null || !slotMatchesHandoff(slot, options)) return { status: "invalid-evidence" };
    if (!secureEqual(slot.slotToken, options.slotToken)) return { status: "token-mismatch" };
    if (!fingerprintsEqual(options.nextProcessFingerprint, dependencies.getProcessFingerprint(options.nextProcessFingerprint.pid))) return { status: "invalid-evidence" };
    const transferred = Object.freeze({ ...slot, processFingerprint: Object.freeze({ ...options.nextProcessFingerprint }) });
    replaceAtomic(path, transferred, dependencies.createToken);
    return { status: "transferred", slot: transferred };
  });
}

export function releaseRepositoryTicketSlot(options: RepositoryTicketSlotHandoff): RepositoryTicketSlotMutationResult {
  return withTicketMutex(options.canonicalRepoRoot, () => {
    const path = repositoryTicketSlotPath(options.canonicalRepoRoot, options.ticket);
    const slot = readSlot(path);
    if (slot === undefined) return { status: "absent" };
    if (slot === null || !slotMatchesHandoff(slot, options)) return { status: "invalid-evidence" };
    if (!secureEqual(slot.slotToken, options.slotToken)) return { status: "token-mismatch" };
    unlinkSync(path);
    return { status: "released" };
  });
}

function slotMatchesHandoff(slot: RepositoryTicketSlot, handoff: RepositoryTicketSlotHandoff): boolean {
  return slot.canonicalRepoKey === handoff.canonicalRepoKey
    && slot.canonicalRepoRoot === handoff.canonicalRepoRoot
    && slot.ticket === handoff.ticket
    && slot.slotId === handoff.slotId
    && slot.repositoryPermit === handoff.repositoryPermit;
}

function ticketSlotDirectory(canonicalRepoRoot: string): string {
  const root = physicalRoot(canonicalRepoRoot);
  const common = physicalGitCommonDir(root);
  const directory = join(common, REPOSITORY_TICKET_SLOT_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ticket-concurrency: slot evidence parent must be a real directory");
  chmodSync(directory, 0o700);
  return directory;
}

function ticketEvidencePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function inspectSlot(path: string, getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined): { state: "live" | "stale"; slot: RepositoryTicketSlot } | { state: "malformed" | "oversized" | "insecure" } {
  let stat;
  try { stat = lstatSync(path); } catch { return { state: "malformed" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return { state: "insecure" };
  if (stat.size > MAX_REPOSITORY_TICKET_SLOT_BYTES) return { state: "oversized" };
  const slot = readSlot(path);
  if (!slot) return { state: "malformed" };
  return fingerprintsEqual(slot.processFingerprint, getProcessFingerprint(slot.processFingerprint.pid)) ? { state: "live", slot } : { state: "stale", slot };
}

function readSlot(path: string): RepositoryTicketSlot | null | undefined {
  if (!existsSync(path)) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_REPOSITORY_TICKET_SLOT_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isSlot(value) ? value : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function isSlot(value: unknown): value is RepositoryTicketSlot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row["schemaVersion"] === 1
    && bounded(row["slotToken"])
    && bounded(row["slotId"])
    && bounded(row["canonicalRepoKey"])
    && bounded(row["canonicalRepoRoot"]) && isAbsolute(row["canonicalRepoRoot"] as string)
    && bounded(row["ticket"])
    && row["slotId"] === `pa:${row["canonicalRepoKey"]}:${row["ticket"]}`
    && bounded(row["deploymentId"])
    && bounded(row["deploymentDirectory"]) && isAbsolute(row["deploymentDirectory"] as string)
    && (row["repositoryPermit"] === 1 || row["repositoryPermit"] === 2 || row["repositoryPermit"] === 3 || row["repositoryPermit"] === 4)
    && isFingerprint(row["processFingerprint"])
    && typeof row["acquiredAt"] === "string" && Number.isFinite(Date.parse(row["acquiredAt"] as string));
}

function assertSlot(slot: RepositoryTicketSlot): void {
  const body = `${JSON.stringify(slot, null, 2)}\n`;
  if (!isSlot(slot) || Buffer.byteLength(body) > MAX_REPOSITORY_TICKET_SLOT_BYTES) throw new Error("ticket-concurrency: generated slot evidence is invalid or oversized");
}

function publishExclusive(path: string, slot: RepositoryTicketSlot, createToken: () => string): void {
  const temporary = `${path}.${required(createToken(), "publication token")}.tmp`;
  try {
    writeSlot(temporary, slot);
    linkSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* published or absent */ } }
}

function replaceAtomic(path: string, slot: RepositoryTicketSlot, createToken: () => string): void {
  const temporary = `${path}.${required(createToken(), "publication token")}.tmp`;
  try { writeSlot(temporary, slot); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch { /* rename consumed it */ } }
}

function writeSlot(path: string, slot: RepositoryTicketSlot): void {
  assertSlot(slot);
  writeFileSync(path, `${JSON.stringify(slot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function quarantine(path: string, now: () => Date, createToken: () => string): void {
  const destination = `${path}.quarantine.${now().toISOString().replace(/[:.]/g, "-")}.${required(createToken(), "quarantine token")}`;
  linkSync(path, destination);
  unlinkSync(path);
}

export function withRepositoryTicketTransaction<T>(canonicalRepoRoot: string, operation: () => T): T {
  return withTicketMutex(canonicalRepoRoot, operation);
}

function withTicketMutex<T>(canonicalRepoRoot: string, operation: () => T): T {
  const directory = ticketSlotDirectory(canonicalRepoRoot);
  const mutexPath = join(directory, REPOSITORY_TICKET_SLOT_MUTEX);
  const descriptor = openSync(mutexPath, "a", 0o600); closeSync(descriptor); chmodSync(mutexPath, 0o600);
  const signalDirectory = mkdtempSync(join(tmpdir(), "pa-ticket-slots-"));
  const readyPath = join(signalDirectory, "ready");
  const donePath = join(signalDirectory, "done");
  const script = "trap 'rm -f -- \"$1\"; : > \"$2\"' EXIT; : > \"$1\"; IFS= read -r _";
  const holder = spawn("flock", ["--exclusive", "--wait", String(MUTEX_TIMEOUT_MS / 1000), mutexPath, "/bin/sh", "-c", script, "pa-ticket-slots", readyPath, donePath], { stdio: ["pipe", "ignore", "ignore"] });
  holder.stdin.on("error", () => {});
  try { waitForPath(readyPath, "acquire"); return operation(); }
  finally {
    holder.stdin.end("release\n");
    try { waitForPath(donePath, "release"); } catch { holder.kill("SIGKILL"); }
    rmSync(signalDirectory, { recursive: true, force: true });
  }
}

function waitForPath(path: string, action: string): void {
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`ticket-concurrency: could not ${action} repository transaction within ${MUTEX_TIMEOUT_MS}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MUTEX_POLL_MS);
  }
}

function physicalRoot(value: string): string {
  const path = absolutePath(value, "canonical repository root");
  const physical = realpathSync(path);
  if (physical !== path || !lstatSync(path).isDirectory()) throw new Error("ticket-concurrency: canonical repository root must be a physical directory");
  return path;
}

function physicalGitCommonDir(root: string): string {
  const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const physical = realpathSync(output);
  if (!isAbsolute(output) || resolve(output) !== physical) throw new Error("ticket-concurrency: Git common directory is not physical");
  return physical;
}

function absolutePath(value: string, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) throw new Error(`ticket-concurrency: ${label} must be an exact absolute path`);
  return value;
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > STRING_LIMIT) throw new Error(`ticket-concurrency: ${label} is required and must be at most ${STRING_LIMIT} characters`);
  return trimmed;
}

function bounded(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= STRING_LIMIT; }
function isFingerprint(value: unknown): value is ProcessFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row["pid"]) && Number(row["pid"]) > 0 && bounded(row["startTimeTicks"]) && bounded(row["bootId"]);
}
function fingerprintsEqual(left: ProcessFingerprint, right: ProcessFingerprint | undefined): boolean { return Boolean(right && left.pid === right.pid && left.startTimeTicks === right.startTimeTicks && left.bootId === right.bootId); }
function slotEvidenceIdentity(slot: RepositoryTicketSlot): string { return createHash("sha256").update(JSON.stringify(slot)).digest("hex"); }
function secureEqual(left: string, right: string): boolean { return createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest()); }
function resolvedDependencies(overrides?: Partial<RepositoryTicketSlotDependencies>): RepositoryTicketSlotDependencies { return { getProcessFingerprint: overrides?.getProcessFingerprint ?? readProcessFingerprint, now: overrides?.now ?? (() => new Date()), createToken: overrides?.createToken ?? randomUUID }; }
function ticketDiagnostic(options: { canonicalRepoKey: string; canonicalRepoRoot: string; ticket: string }, reason: string, resume: string): string {
  return formatBoundedFiveFieldDiagnostic({
    condition: "repository ticket concurrency admission",
    source: `atomic ticket-slot/permit transaction for repo=${options.canonicalRepoKey} root=${options.canonicalRepoRoot} ticket=${options.ticket}`,
    reason,
    correction: "preserve Treehouse leases and repository state; reconcile only matching PA slot evidence",
    resumeAction: resume,
  });
}
