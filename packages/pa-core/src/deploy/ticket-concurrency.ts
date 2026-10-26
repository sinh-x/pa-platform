import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { observeReadonlyRepositoryAuthority, readProcessFingerprint, type ProcessFingerprint } from "./repository-admission.js";
import { queryReadonlyDeploymentEvents, queryReadonlyHelperRegistry } from "../registry/index.js";
import { parseIdlePreparationReservation, type IdlePreparationReservation } from "./execution-custody.js";

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
  /** Native ordinary materializer intent under this same live capacity owner. */
  readonly materializationIntent?: OrdinaryMaterializationIntent;
}
export interface OrdinaryMaterializationIntent {
  readonly schemaVersion: "ordinary-materialization/v1";
  readonly baselineSha256: string;
  readonly worktreeRoot: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly operationId: string;
}
export interface RepositoryTicketTransaction {
  ordinaryIntent(owner: RepositoryTicketSlotHandoff & { deploymentId: string }, input: Omit<OrdinaryMaterializationIntent, "schemaVersion" | "operationId">, existingOnly?: boolean): OrdinaryMaterializationIntent;
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

/** Existing protected capacity observation, with no mutex or capacity update. */
export function observeReadonlyRepositoryTicketSlot(canonicalRepoRoot: string, ticket: string,
  getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined = readProcessFingerprint,
): { readonly slot: RepositoryTicketSlot; readonly identity: string } {
  const path = executionSlotPath(canonicalRepoRoot, ticket, false);
  const stat = lstatSync(path);
  if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("helper capacity evidence is not protected");
  const bytes = readReviewEvidenceFile(path, MAX_REPOSITORY_TICKET_SLOT_BYTES, "helper capacity");
  const slot: unknown = path.endsWith(".prepared.json") ? preparedSlotView(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isSlot(slot) || !fingerprintsEqual(slot.processFingerprint, getProcessFingerprint(slot.processFingerprint.pid))) throw new Error("helper capacity evidence is malformed or stale");
  return { slot, identity: createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.ctimeMs}:`).update(bytes).digest("hex") };
}

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
    const path = executionSlotPath(root, options.ticket);
    if (!existsSync(path)) return { status: "rejected", reason: "absent" };
    const inspected = inspectExecutionSlot(path, dependencies.getProcessFingerprint);
    if (inspected.state !== "live") {
      return { status: "rejected", reason: inspected.state === "stale" ? "stale-process" : inspected.state === "prepared" ? "identity-mismatch" : inspected.state === "invalid-preparation" ? "malformed" : inspected.state };
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

/** Distinct suffix preserves durable ownership even when record bytes are unreadable. */
export function preparedRepositoryTicketReservationPath(canonicalRepoRoot: string, ticket: string): string {
  return join(ticketSlotDirectory(canonicalRepoRoot), `${createHash("sha256").update(required(ticket, "ticket")).digest("hex")}.prepared.json`);
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
    const live: Array<RepositoryTicketSlot | IdlePreparationReservation> = [];
    const recovered = 0;
    for (const path of ticketEvidencePaths(directory)) {
      const inspected = inspectSlot(path, dependencies.getProcessFingerprint);
      if (inspected.state === "live" || inspected.state === "prepared") {
        const row = inspected.state === "prepared" ? inspected.reservation : inspected.slot;
        // Even --force cannot reclaim prepared/uncertain/idle reservations.
        if (("repoRoot" in row ? row.repoRoot : row.canonicalRepoRoot) !== root
          || ("repoKey" in row ? row.repoKey : row.canonicalRepoKey) !== options.canonicalRepoKey
          || path !== ("operationId" in row ? preparedRepositoryTicketReservationPath(root, row.ticket) : repositoryTicketSlotPath(root, row.ticket))
          || live.some((entry) => capacityRowsConflict(entry, row))) {
          return { status: "rejected", reason: "invalid-evidence", slotPath, diagnostic: ticketDiagnostic(options, "capacity identity or permit inventory conflicts", "preserve capacity evidence for operator reconciliation") };
        }
        live.push(row);
        continue;
      }
      // Legacy capacity remains occupied/uncertain until its matching owner
      // settles it. PID death and --force are not finalization proof.
      return { status: "rejected", reason: "invalid-evidence", slotPath,
        diagnostic: ticketDiagnostic(options, "persisted ticket capacity is stale or uncertain", "preserve capacity until matching terminal settlement; force cannot reclaim it") };
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
    const path = executionSlotPath(options.canonicalRepoRoot, options.ticket);
    const slot = readSlot(path);
    if (slot === undefined) return { status: "absent" };
    if (slot === null || !slotMatchesHandoff(slot, options)) return { status: "invalid-evidence" };
    if (!secureEqual(slot.slotToken, options.slotToken)) return { status: "token-mismatch" };
    if (!fingerprintsEqual(options.nextProcessFingerprint, dependencies.getProcessFingerprint(options.nextProcessFingerprint.pid))) return { status: "invalid-evidence" };
    const transferred = Object.freeze({ ...slot, processFingerprint: Object.freeze({ ...options.nextProcessFingerprint }) });
    if (path.endsWith(".prepared.json")) {
      const reservation = parseIdlePreparationReservation(readCapacityRecord(path));
      if (reservation.occupancy !== "active" || !reservation.custody.holder || reservation.custody.inFlightOperation !== null) return { status: "invalid-evidence" };
      publishPreparedCapacity(path, parseIdlePreparationReservation({ ...reservation, custody: { ...reservation.custody, holder: { ...reservation.custody.holder, process: transferred.processFingerprint } } }), true);
    } else replaceAtomic(path, transferred, dependencies.createToken);
    return { status: "transferred", slot: transferred };
  });
}

export function releaseRepositoryTicketSlot(options: RepositoryTicketSlotHandoff): RepositoryTicketSlotMutationResult {
  return withTicketMutex(options.canonicalRepoRoot, () => {
    const path = executionSlotPath(options.canonicalRepoRoot, options.ticket);
    const slot = readSlot(path);
    if (slot === undefined) return { status: "absent" };
    if (slot === null || !slotMatchesHandoff(slot, options)) return { status: "invalid-evidence" };
    if (!secureEqual(slot.slotToken, options.slotToken)) return { status: "token-mismatch" };
    // Every terminal caller (including the background runner) must retain the
    // permit if matching worktree custody failed to settle. Registry binding,
    // not a caller-selected path, identifies that checkout.
    try {
      const events = queryReadonlyDeploymentEvents(slot.deploymentId);
      if (events.length === 0) {
        // Once ordinary materialization intent is durable, an unstarted launch
        // may already own a created ref/checkout even if its call was interrupted.
        // Keep that same owner's intent/permit for reconciliation, never roll it
        // back merely because no runtime start was published yet.
        if (slot.materializationIntent) return { status: "invalid-evidence" };
        // Allocation precedes immutable launch publication. Only the actual
        // allocating process may roll back that launchless reservation; absence
        // of registry evidence or PID death never authorizes external recovery.
        const current = readProcessFingerprint(process.pid);
        if (!current || !fingerprintsEqual(slot.processFingerprint, current)) return { status: "invalid-evidence" };
      } else {
        const status = queryReadonlyHelperRegistry(slot.deploymentId).status;
        if (!status || status.repo_root !== slot.canonicalRepoRoot || status.ticket_id !== slot.ticket
          || (status.ticket_slot_id !== undefined && status.ticket_slot_id !== slot.slotId)
          || (status.repository_permit !== undefined && status.repository_permit !== slot.repositoryPermit)
          || !status.worktree_root) return { status: "invalid-evidence" };
        const worktree = physicalRoot(status.worktree_root);
        const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (physicalRoot(common) !== physicalGitCommonDir(slot.canonicalRepoRoot)) return { status: "invalid-evidence" };
        const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const custody = observeReadonlyRepositoryAuthority(gitDir);
        if (custody.owner || custody.borrower || custody.implement || custody.review) return { status: "invalid-evidence" };
      }
    } catch { return { status: "invalid-evidence" }; }
    if (path.endsWith(".prepared.json")) {
      const reservation = parseIdlePreparationReservation(readCapacityRecord(path));
      if (reservation.occupancy !== "active" || reservation.custody.inFlightOperation !== null) return { status: "invalid-evidence" };
      // Release execution capability only. The occupied reservation/checkout is
      // retained after terminal or no-spawn failure; no reclaim or return occurs.
      publishPreparedCapacity(path, parseIdlePreparationReservation({ ...reservation, occupancy: "settled-retained", custody: { state: "idle", holder: null, inFlightOperation: null } }), true);
    } else unlinkSync(path);
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

function inspectSlot(path: string, getProcessFingerprint: (pid: number) => ProcessFingerprint | undefined): { state: "live" | "stale"; slot: RepositoryTicketSlot } | { state: "prepared"; reservation: IdlePreparationReservation } | { state: "malformed" | "oversized" | "insecure" | "invalid-preparation" } {
  const prepared = path.endsWith(".prepared.json");
  let stat;
  try { stat = lstatSync(path); } catch { return { state: prepared ? "invalid-preparation" : "malformed" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) return { state: prepared ? "invalid-preparation" : "insecure" };
  if (stat.size > MAX_REPOSITORY_TICKET_SLOT_BYTES) return { state: prepared ? "invalid-preparation" : "oversized" };
  const value = readCapacityRecord(path);
  if (prepared) {
    try { return { state: "prepared", reservation: parseIdlePreparationReservation(value) }; }
    catch { return { state: "invalid-preparation" }; }
  }
  if (value && typeof value === "object" && "schemaVersion" in value && typeof value.schemaVersion === "string" && value.schemaVersion.startsWith("prepared-")) return { state: "invalid-preparation" };
  const slot = isSlot(value) ? value : null;
  if (!slot) return { state: "malformed" };
  return fingerprintsEqual(slot.processFingerprint, getProcessFingerprint(slot.processFingerprint.pid)) ? { state: "live", slot } : { state: "stale", slot };
}

function readSlot(path: string): RepositoryTicketSlot | null | undefined {
  const value = readCapacityRecord(path);
  if (value === undefined) return undefined;
  if (path.endsWith(".prepared.json")) return preparedSlotView(value);
  return isSlot(value) ? value : null;
}
function executionSlotPath(root: string, ticket: string, createDirectory = true): string {
  const directory = createDirectory ? ticketSlotDirectory(root) : join(physicalGitCommonDir(physicalRoot(root)), REPOSITORY_TICKET_SLOT_DIRECTORY);
  if (!createDirectory) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("helper capacity directory is absent or insecure; no repair permitted");
  }
  const name = createHash("sha256").update(required(ticket, "ticket")).digest("hex");
  const legacy = join(directory, `${name}.json`); const prepared = join(directory, `${name}.prepared.json`);
  const present = (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  const legacyPresent = present(legacy); const preparedPresent = present(prepared);
  if (legacyPresent && preparedPresent) throw new Error(formatBoundedFiveFieldDiagnostic({ condition: "conflicting ticket capacity evidence", source: "native ticket-slot storage",
    reason: "legacy and prepared records both exist for the same ticket", correction: "preserve both records for owning reconciliation", resumeAction: "retry only after supported reconciliation; no force or reclamation" }));
  return preparedPresent ? prepared : legacy;
}
function preparedSlotView(value: unknown): RepositoryTicketSlot | null | undefined {
  try {
    const row = parseIdlePreparationReservation(value);
    if (row.occupancy === "settled-retained") return undefined;
    if (row.occupancy !== "active" || !row.launch || row.custody.state !== "orchestrator-direct" || !row.custody.holder || row.custody.inFlightOperation !== null) return null;
    return Object.freeze({ schemaVersion: 1, slotToken: row.launch.slotToken, slotId: repositoryTicketSlotId(row.repoKey, row.ticket),
      canonicalRepoKey: row.repoKey, canonicalRepoRoot: row.repoRoot, ticket: row.ticket, deploymentId: row.custody.holder.deploymentId,
      deploymentDirectory: row.launch.deploymentDirectory, repositoryPermit: row.repositoryPermit, processFingerprint: row.custody.holder.process, acquiredAt: row.launch.acquiredAt });
  } catch { return null; }
}
function inspectExecutionSlot(path: string, fingerprint: (pid: number) => ProcessFingerprint | undefined): ReturnType<typeof inspectSlot> {
  if (!path.endsWith(".prepared.json")) return inspectSlot(path, fingerprint);
  const slot = readSlot(path);
  if (!slot) return { state: "invalid-preparation" };
  return fingerprintsEqual(slot.processFingerprint, fingerprint(slot.processFingerprint.pid)) ? { state: "live", slot } : { state: "stale", slot };
}

function readCapacityRecord(path: string): unknown {
  // lstat/open rather than existsSync: dangling symlinks are invalid, not absent.
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return null; }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_REPOSITORY_TICKET_SLOT_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) return null;
    const after = fstatSync(descriptor); const named = lstatSync(path);
    if (after.ctimeMs !== stat.ctimeMs || after.size !== stat.size || after.nlink !== 1 || named.ino !== stat.ino || named.dev !== stat.dev) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
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
    && typeof row["acquiredAt"] === "string" && Number.isFinite(Date.parse(row["acquiredAt"] as string))
    && (row["materializationIntent"] === undefined || isOrdinaryIntent(row["materializationIntent"]));
}

function isOrdinaryIntent(value: unknown): value is OrdinaryMaterializationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "baseSha,baselineSha256,branch,operationId,schemaVersion,worktreeRoot"
    && row.schemaVersion === "ordinary-materialization/v1" && typeof row.operationId === "string" && /^[0-9a-f]{64}$/.test(row.operationId)
    && typeof row.baselineSha256 === "string" && /^[0-9a-f]{64}$/.test(row.baselineSha256)
    && typeof row.baseSha === "string" && /^[0-9a-f]{40}$/.test(row.baseSha)
    && bounded(row.branch) && bounded(row.worktreeRoot) && isAbsolute(row.worktreeRoot as string);
}

function assertSlot(slot: RepositoryTicketSlot): void {
  const body = `${JSON.stringify(slot, null, 2)}\n`;
  if (!isSlot(slot) || Buffer.byteLength(body) > MAX_REPOSITORY_TICKET_SLOT_BYTES) throw new Error("ticket-concurrency: generated slot evidence is invalid or oversized");
}

function publishExclusive(path: string, slot: RepositoryTicketSlot, createToken: () => string): void {
  const temporary = `${path}.${required(createToken(), "publication token")}.tmp`;
  try {
    writeSlot(temporary, slot);
    linkSync(temporary, path); syncPreparedCapacityDirectory(slot.canonicalRepoRoot);
  } finally { try { unlinkSync(temporary); } catch { /* published or absent */ } }
}

function replaceAtomic(path: string, slot: RepositoryTicketSlot, createToken: () => string): void {
  const temporary = `${path}.${required(createToken(), "publication token")}.tmp`;
  try { writeSlot(temporary, slot); renameSync(temporary, path); syncPreparedCapacityDirectory(slot.canonicalRepoRoot); }
  finally { try { unlinkSync(temporary); } catch { /* rename consumed it */ } }
}

function writeSlot(path: string, slot: RepositoryTicketSlot): void {
  assertSlot(slot);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(slot, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Dormant preparation primitive. The trusted preparation service supplies authenticated
 * intent; this API does not authenticate an approval or activate the optional policy.
 * Uses the SAME directory/mutex/permit namespace as ordinary builder admission.
 * No process-death reclamation, expiry, return or delete operation is provided.
 */
export interface PreparedTicketCapacityTransaction {
  readonly inventory: () => readonly (RepositoryTicketSlot | IdlePreparationReservation)[];
  readonly reserve: (input: {
    ticket: string; operationId: string; reservationId: string; retainedAt: string;
  }) => { readonly status: "reserved"; readonly reservation: IdlePreparationReservation } | { readonly status: "capacity" };
  readonly update: (expected: IdlePreparationReservation, next: IdlePreparationReservation) => IdlePreparationReservation;
}
const activePreparedCapacityOwners = new WeakMap<PreparedTicketCapacityTransaction, string>();
/** Reuse a live owner without recursively acquiring the same repository mutex. */
export function withPreparedRepositoryTicketOwner<T>(transaction: PreparedTicketCapacityTransaction, canonicalRepoRoot: string, operation: () => T): T {
  if (activePreparedCapacityOwners.get(transaction) !== canonicalRepoRoot) throw new Error("prepared capacity owner is absent, expired or root-conflicting");
  const result = operation();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("prepared capacity owner callback must be synchronous");
  return result;
}
export type PreparedCapacityBoundary = "file-synced" | "linked" | "published" | "directory-synced";
export function withPreparedTicketCapacity<T>(options: {
  canonicalRepoKey: string; canonicalRepoRoot: string;
  dependencies?: Partial<RepositoryTicketSlotDependencies>;
  /** Fault injection for isolated tests; an exception preserves uncertain evidence. */
  boundary?: (point: PreparedCapacityBoundary) => void;
}, operation: (transaction: PreparedTicketCapacityTransaction) => T): T {
  const root = physicalRoot(options.canonicalRepoRoot);
  const key = required(options.canonicalRepoKey, "repository key");
  const dependencies = resolvedDependencies(options.dependencies);
  return withTicketMutex(root, () => {
    let active = true;
    const assertActive = () => { if (!active) throw new Error("prepared capacity transaction expired"); };
    const inventory = (): readonly (RepositoryTicketSlot | IdlePreparationReservation)[] => {
      assertActive();
      const rows: Array<RepositoryTicketSlot | IdlePreparationReservation> = [];
      for (const path of ticketEvidencePaths(ticketSlotDirectory(root))) {
        const inspected = inspectSlot(path, dependencies.getProcessFingerprint);
        if (inspected.state !== "prepared" && inspected.state !== "live" && inspected.state !== "stale") throw new Error("prepared capacity evidence is insecure or uncertain");
        const row = inspected.state === "prepared" ? inspected.reservation : inspected.slot;
        if (("repoRoot" in row ? row.repoRoot : row.canonicalRepoRoot) !== root
          || ("repoKey" in row ? row.repoKey : row.canonicalRepoKey) !== key
          || path !== ("operationId" in row ? preparedRepositoryTicketReservationPath(root, row.ticket) : repositoryTicketSlotPath(root, row.ticket))
          || rows.some((other) => capacityRowsConflict(other, row))) throw new Error("prepared capacity inventory conflicts");
        rows.push(row);
      }
      if (rows.length > MAX_REPOSITORY_TICKET_SLOTS) throw new Error("prepared capacity inventory exceeds limit");
      // A stale LEGACY process record is conservatively occupied here. Its existing
      // owner can reconcile it through ordinary admission, never this service.
      // Reaffirm a prior publish/replace that crashed before its directory fsync.
      syncPreparedCapacityDirectory(root);
      return Object.freeze(rows);
    };
    const transaction = Object.freeze<PreparedTicketCapacityTransaction>({
      inventory,
      reserve(input) {
        const rows = inventory();
        const existing = rows.find((row) => row.ticket === input.ticket);
        if (existing) {
          if (!("operationId" in existing) || existing.operationId !== input.operationId || existing.reservationId !== input.reservationId) throw new Error("prepared ticket already has different custody");
          syncPreparedCapacityDirectory(root);
          return { status: "reserved" as const, reservation: existing };
        }
        const permit = ([1, 2, 3, 4] as const).find((value) => !rows.some((row) => row.repositoryPermit === value));
        if (!permit) return { status: "capacity" as const };
        const reservation = parseIdlePreparationReservation({ schemaVersion: "prepared-reservation/v1", repoKey: key, repoRoot: root,
          ticket: input.ticket, operationId: input.operationId, reservationId: input.reservationId, repositoryPermit: permit,
          occupancy: "preparing", lineageId: null, custody: { state: "idle", holder: null, inFlightOperation: null }, receiptId: null, retainedAt: input.retainedAt });
        if (rows.some((row) => capacityRowsConflict(row, reservation))) throw new Error("prepared capacity operation or lineage already reserved");
        publishPreparedCapacity(preparedRepositoryTicketReservationPath(root, reservation.ticket), reservation, false, options.boundary);
        return { status: "reserved" as const, reservation };
      },
      update(expectedInput, nextInput) {
        assertActive();
        const expected = parseIdlePreparationReservation(expectedInput); const next = parseIdlePreparationReservation(nextInput);
        const current = inventory().find((row) => row.ticket === expected.ticket);
        if (!current || !("operationId" in current) || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("prepared capacity compare-and-swap failed");
        for (const field of ["repoKey", "repoRoot", "ticket", "operationId", "reservationId", "repositoryPermit", "retainedAt"] as const) {
          if (next[field] !== expected[field]) throw new Error("prepared capacity identity changed");
        }
        if (JSON.stringify(next) === JSON.stringify(expected)) { syncPreparedCapacityDirectory(root); return current; }
        if (inventory().some((row) => row.ticket !== expected.ticket && capacityRowsConflict(row, next))) throw new Error("prepared capacity operation or lineage conflicts");
        const allowed = expected.occupancy === "preparing" ? ["idle-ready", "uncertain-retained"]
          : expected.occupancy === "idle-ready" ? ["active", "uncertain-retained"]
          : expected.occupancy === "active" ? ["uncertain-retained"] : [];
        if (!allowed.includes(next.occupancy) || (expected.receiptId !== null && next.receiptId !== expected.receiptId)
          || (expected.lineageId !== null && next.lineageId !== expected.lineageId)) throw new Error("prepared capacity transition denied");
        if (next.occupancy === "active" && (next.custody.state !== "orchestrator-direct" || !next.custody.holder || next.custody.inFlightOperation !== null
          || !fingerprintsEqual(next.custody.holder.process, dependencies.getProcessFingerprint(next.custody.holder.process.pid)))) throw new Error("prepared capacity holder is not live");
        publishPreparedCapacity(preparedRepositoryTicketReservationPath(root, next.ticket), next, true, options.boundary);
        return next;
      },
    });
    activePreparedCapacityOwners.set(transaction, root);
    try {
      const result = operation(transaction);
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("prepared capacity transaction must be synchronous");
      return result;
    } finally { active = false; activePreparedCapacityOwners.delete(transaction); }
  });
}

function capacityRowsConflict(left: RepositoryTicketSlot | IdlePreparationReservation, right: RepositoryTicketSlot | IdlePreparationReservation): boolean {
  return left.ticket === right.ticket || left.repositoryPermit === right.repositoryPermit
    || ("operationId" in left && "operationId" in right && (left.operationId === right.operationId || left.reservationId === right.reservationId
      || (left.lineageId !== null && left.lineageId === right.lineageId)));
}

function publishPreparedCapacity(path: string, reservation: IdlePreparationReservation, replace: boolean, boundary?: (point: PreparedCapacityBoundary) => void): void {
  const body = Buffer.from(`${JSON.stringify(parseIdlePreparationReservation(reservation))}\n`);
  if (body.length > MAX_REPOSITORY_TICKET_SLOT_BYTES) throw new Error("prepared capacity record exceeds limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, body); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  boundary?.("file-synced");
  if (replace) renameSync(temporary, path);
  else { linkSync(temporary, path); boundary?.("linked"); unlinkSync(temporary); }
  boundary?.("published");
  syncPreparedCapacityDirectory(reservation.repoRoot);
  boundary?.("directory-synced");
  if (JSON.stringify(readCapacityRecord(path)) !== JSON.stringify(reservation)) throw new Error("prepared capacity readback failed");
}
function syncPreparedCapacityDirectory(root: string): void {
  const descriptor = openSync(ticketSlotDirectory(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function withRepositoryTicketTransaction<T>(canonicalRepoRoot: string, operation: (transaction: RepositoryTicketTransaction) => T): T {
  return withTicketMutex(canonicalRepoRoot, () => {
    let active = true;
    const transaction: RepositoryTicketTransaction = Object.freeze({ ordinaryIntent(owner: RepositoryTicketSlotHandoff & { deploymentId: string }, input: Omit<OrdinaryMaterializationIntent, "schemaVersion" | "operationId">, existingOnly = false) {
      if (!active || owner.canonicalRepoRoot !== canonicalRepoRoot) throw new Error("ordinary materialization transaction is not active");
      const observed = observeReadonlyRepositoryTicketSlot(canonicalRepoRoot, owner.ticket);
      const slot = observed.slot;
      if (!slotMatchesHandoff(slot, owner) || slot.slotToken !== owner.slotToken || slot.deploymentId !== owner.deploymentId || !fingerprintsEqual(slot.processFingerprint, readProcessFingerprint(process.pid))) throw new Error("ordinary materialization holder does not authenticate");
      const intent: OrdinaryMaterializationIntent = Object.freeze({ schemaVersion: "ordinary-materialization/v1", ...input,
        operationId: createHash("sha256").update(JSON.stringify([slot.slotToken, input])).digest("hex") });
      if (!isOrdinaryIntent(intent)) throw new Error("ordinary materialization intent is invalid");
      if (slot.materializationIntent) {
        if (JSON.stringify(slot.materializationIntent) !== JSON.stringify(intent)) throw new Error("ordinary materialization intent changed; retain existing work");
        return slot.materializationIntent;
      }
      if (existingOnly) throw new Error("existing branch has no retained ordinary materialization intent; preserve it");
      replaceAtomic(repositoryTicketSlotPath(canonicalRepoRoot, slot.ticket), { ...slot, materializationIntent: intent }, randomUUID);
      const retained = observeReadonlyRepositoryTicketSlot(canonicalRepoRoot, slot.ticket).slot.materializationIntent;
      if (JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error("ordinary materialization intent publication is uncertain");
      return intent;
    } });
    try {
      const result = operation(transaction);
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("repository ticket transaction must be synchronous");
      return result;
    } finally { active = false; }
  });
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
    source: "atomic repository ticket-slot/permit transaction",
    reason,
    correction: "preserve Treehouse leases and repository state; reconcile only matching PA slot evidence",
    resumeAction: resume,
  });
}
