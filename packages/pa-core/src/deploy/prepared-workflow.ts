import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";

/** Inactive contracts and core transaction engine; no production host/tool/launch activation. */
export const PREPARED_WORKFLOW_VERSION = "prepared-workflow/v1";
export const PREPARED_POLICY_VERSION = "prepared-autonomy/v1";
// Independent record limit: do not import the capacity owner here. That owner
// validates reservation schemas through execution-custody -> this module.
export const MAX_PROTECTED_WORKFLOW_BYTES = 64 * 1024;
export const WORKFLOW_OUTPUT_LIMITS = Object.freeze({ markdown: 1_048_576, html: 4_194_304, diff: 10_485_760 });
export type PreparationState = "not-requested" | "preparing" | "ready" | "consumed" | "not-ready-capacity" | "not-ready-failed" | "uncertain-blocked";
export interface SourceVersion {
  readonly ref: string;
  readonly version: string;
  readonly sha256: string;
}
export interface PreparationContract {
  readonly schemaVersion: typeof PREPARED_WORKFLOW_VERSION;
  readonly policyVersion: typeof PREPARED_POLICY_VERSION;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly ticket: string;
  readonly branch: string;
  readonly integrationTarget: string;
  readonly approvalBaseSha: string;
  readonly requirements: SourceVersion;
  readonly uat: SourceVersion;
  readonly promotionEvidence: string;
  readonly signoffEvidence: string;
  readonly finalChecks: SourceVersion;
  readonly finalCheckCount: 13;
  readonly matrix: SourceVersion;
  readonly matrixApprovalEvidence: string;
}
/** Informational only. Parsing these bytes NEVER authenticates promotion, approval or custody. */
export interface PreparedReceipt {
  readonly schemaVersion: "prepared-receipt/v1";
  readonly operationId: string;
  readonly receiptId: string;
  readonly state: "ready" | "consumed";
  readonly contract: PreparationContract;
  readonly preparationBaseSha: string;
  readonly preparedHeadSha: string;
  readonly worktreeRoot: string;
  readonly leaseRef: string;
  readonly capacityRef: string;
  readonly custodyRef: string;
  readonly ticketReread: SourceVersion;
  readonly observedAt: string;
  readonly nextOwner: "builder";
}
export interface OperatorActivationProjection {
  readonly schemaVersion: "prepared-activation-projection/v1";
  readonly policyVersion: typeof PREPARED_POLICY_VERSION;
  readonly state: "inactive" | "mismatched" | "revoked" | "pending-runtime";
  readonly runtimeSha: string;
  readonly runtimeVersion: string;
  readonly configSha: string;
  readonly verification: SourceVersion;
  readonly decisionRef: string;
}

/** All error text is fixed: rejected user/protected input is never echoed into a public diagnostic. */
export function workflowError(): Error {
  return new Error(formatBoundedFiveFieldDiagnostic({
    condition: "prepared workflow stopped",
    source: "versioned contract or protected persistence",
    reason: "missing, insecure, unsupported, conflicting or uncertain evidence",
    correction: "preserve state; reconcile evidence with the owning service/operator",
    resumeAction: "resume only with matching supported authority; optional automation remains inactive",
  }));
}
export function workflowObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw workflowError();
  const row = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (Reflect.ownKeys(row).length !== keys.length || keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))) throw workflowError();
  return row;
}
/** Authority/resource callbacks are synchronous. Never treat a pending Promise as approval. */
export function workflowSynchronous<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) {
    // Observe native Promise rejection without awaiting it or allowing successors.
    if (value instanceof Promise) void value.catch(() => undefined);
    throw workflowError();
  }
  return value;
}
export function workflowText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw workflowError();
  return value;
}
export function workflowSha(value: unknown, length = 64): string {
  const text = workflowText(value);
  if (!(length === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(text)) throw workflowError();
  return text;
}
export function workflowPath(value: unknown): string {
  const path = workflowText(value);
  if (!isAbsolute(path) || resolve(path) !== path) throw workflowError();
  return path;
}
export function workflowTimestamp(value: unknown): string {
  const text = workflowText(value);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw workflowError();
  return text;
}
export function parseSourceVersion(value: unknown): SourceVersion {
  const row = workflowObject(value, ["ref", "version", "sha256"]);
  return Object.freeze({ ref: workflowText(row["ref"]), version: workflowText(row["version"]), sha256: workflowSha(row["sha256"]) });
}
export function parsePreparationContract(value: unknown): PreparationContract {
  const row = workflowObject(value, ["schemaVersion", "policyVersion", "repoKey", "repoRoot", "ticket", "branch", "integrationTarget", "approvalBaseSha", "requirements", "uat", "promotionEvidence", "signoffEvidence", "finalChecks", "finalCheckCount", "matrix", "matrixApprovalEvidence"]);
  const repoKey = workflowText(row["repoKey"]); const ticket = workflowText(row["ticket"]);
  const branch = workflowText(row["branch"]);
  if (row["schemaVersion"] !== PREPARED_WORKFLOW_VERSION || row["policyVersion"] !== PREPARED_POLICY_VERSION
    || row["finalCheckCount"] !== 13 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoKey)
    || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || !branch.startsWith(`feature/${ticket}-`)
    || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.lock$/.test(branch)) throw workflowError();
  const requirements = parseSourceVersion(row["requirements"]); const uat = parseSourceVersion(row["uat"]);
  const matrix = parseSourceVersion(row["matrix"]);
  if (requirements.ref === uat.ref || matrix.ref !== requirements.ref) throw workflowError();
  return Object.freeze({ schemaVersion: PREPARED_WORKFLOW_VERSION, policyVersion: PREPARED_POLICY_VERSION,
    repoKey, repoRoot: workflowPath(row["repoRoot"]), ticket, branch, integrationTarget: workflowText(row["integrationTarget"]),
    approvalBaseSha: workflowSha(row["approvalBaseSha"], 40), requirements, uat,
    promotionEvidence: workflowText(row["promotionEvidence"]), signoffEvidence: workflowText(row["signoffEvidence"]),
    finalChecks: parseSourceVersion(row["finalChecks"]), finalCheckCount: 13, matrix,
    matrixApprovalEvidence: workflowText(row["matrixApprovalEvidence"]) });
}
export function parsePreparedReceipt(value: unknown): PreparedReceipt {
  const row = workflowObject(value, ["schemaVersion", "operationId", "receiptId", "state", "contract", "preparationBaseSha", "preparedHeadSha", "worktreeRoot", "leaseRef", "capacityRef", "custodyRef", "ticketReread", "observedAt", "nextOwner"]);
  const contract = parsePreparationContract(row["contract"]); const worktreeRoot = workflowPath(row["worktreeRoot"]);
  const operationId = preparationIdentity(contract);
  if (row["schemaVersion"] !== "prepared-receipt/v1" || row["operationId"] !== operationId
    || typeof row["state"] !== "string" || !["ready", "consumed"].includes(row["state"]) || row["nextOwner"] !== "builder" || worktreeRoot === contract.repoRoot) throw workflowError();
  return Object.freeze({ schemaVersion: "prepared-receipt/v1", operationId, receiptId: workflowSha(row["receiptId"]),
    state: row["state"] as "ready" | "consumed", contract, preparationBaseSha: workflowSha(row["preparationBaseSha"], 40),
    preparedHeadSha: workflowSha(row["preparedHeadSha"], 40), worktreeRoot, leaseRef: workflowText(row["leaseRef"]),
    capacityRef: workflowText(row["capacityRef"]), custodyRef: workflowText(row["custodyRef"]), ticketReread: parseSourceVersion(row["ticketReread"]),
    observedAt: workflowTimestamp(row["observedAt"]), nextOwner: "builder" });
}
export function parseActivationProjection(value: unknown): OperatorActivationProjection {
  const row = workflowObject(value, ["schemaVersion", "policyVersion", "state", "runtimeSha", "runtimeVersion", "configSha", "verification", "decisionRef"]);
  if (row["schemaVersion"] !== "prepared-activation-projection/v1" || row["policyVersion"] !== PREPARED_POLICY_VERSION
    || typeof row["state"] !== "string" || !["inactive", "mismatched", "revoked", "pending-runtime"].includes(row["state"])) throw workflowError();
  return Object.freeze({ schemaVersion: "prepared-activation-projection/v1", policyVersion: PREPARED_POLICY_VERSION,
    state: row["state"] as OperatorActivationProjection["state"], runtimeSha: workflowSha(row["runtimeSha"], 40),
    runtimeVersion: workflowText(row["runtimeVersion"]), configSha: workflowSha(row["configSha"], 40),
    verification: parseSourceVersion(row["verification"]), decisionRef: workflowText(row["decisionRef"]) });
}
/** Deliberately not a service resolver. Even a perfectly formed mutable projection grants zero authority. */
export function preparedCapability(_publicProjection?: unknown): Readonly<{ enabled: false; legacyUnchanged: true; reason: "phase-1-inactive" }> {
  return Object.freeze({ enabled: false, legacyUnchanged: true, reason: "phase-1-inactive" });
}
export function requirePreparedCapability(_publicProjection?: unknown): never { throw workflowError(); }
/** Reconstruct from an allowlist, never spread a protected activation record into public status. */
export function inactiveOperatorProjection(): Readonly<{ schemaVersion: "prepared-activation-status/v1"; policyVersion: typeof PREPARED_POLICY_VERSION; state: "inactive"; activationAvailable: false }> {
  return Object.freeze({ schemaVersion: "prepared-activation-status/v1", policyVersion: PREPARED_POLICY_VERSION, state: "inactive", activationAvailable: false });
}
export function workflowDigest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function preparationIdentity(value: PreparationContract): string { return workflowDigest(JSON.stringify(parsePreparationContract(value))); }

/**
 * Composition contract for EXISTING mutex owners, not new production locking/admission.
 * Order: canonical repository capacity -> worktree admission -> journal publication.
 * Never call capacity while holding worktree; never await/return a Promise under either.
 * Phase 2 must bind these synchronous wrappers to the existing owners at trusted launch.
 */
export interface PreparedLockOwners {
  readonly repository: <T>(action: () => T) => T;
  readonly worktree: <T>(action: () => T) => T;
}
export interface PreparedLockScope { readonly kind: "prepared-lock-scope" }
const liveScopes = new WeakSet<PreparedLockScope>();
let lockCompositionActive = false;
export function withPreparedWorkflowLocks<T>(owners: PreparedLockOwners, action: (scope: PreparedLockScope) => T): T {
  if (lockCompositionActive) throw workflowError();
  lockCompositionActive = true;
  try {
    return owners.repository(() => owners.worktree(() => {
      const scope = Object.freeze({ kind: "prepared-lock-scope" as const }); liveScopes.add(scope);
      try {
        const result = action(scope);
        if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw workflowError();
        return result;
      } finally { liveScopes.delete(scope); }
    }));
  } finally { lockCompositionActive = false; }
}
function assertScope(scope: PreparedLockScope): void { if (!liveScopes.has(scope)) throw workflowError(); }

export interface WorkflowIntent {
  readonly schemaVersion: "prepared-intent/v1";
  readonly operationId: string;
  readonly contract: PreparationContract;
  readonly createdAt: string;
}
export interface WorkflowJournalEntry {
  readonly schemaVersion: "prepared-journal/v1";
  readonly operationId: string;
  readonly sequence: number;
  readonly previousSha256: string;
  readonly action: "reservation" | "allocation" | "branch" | "ticket-reread";
  readonly outcome: "observed" | "failed" | "uncertain";
  readonly evidence: SourceVersion;
  readonly recordedAt: string;
}
function parseIntent(value: unknown): WorkflowIntent {
  const row = workflowObject(value, ["schemaVersion", "operationId", "contract", "createdAt"]);
  const contract = parsePreparationContract(row["contract"]);
  if (row["schemaVersion"] !== "prepared-intent/v1" || row["operationId"] !== preparationIdentity(contract)) throw workflowError();
  return Object.freeze({ schemaVersion: "prepared-intent/v1", operationId: preparationIdentity(contract), contract, createdAt: workflowTimestamp(row["createdAt"]) });
}
function parseEntry(value: unknown): WorkflowJournalEntry {
  const row = workflowObject(value, ["schemaVersion", "operationId", "sequence", "previousSha256", "action", "outcome", "evidence", "recordedAt"]);
  if (row["schemaVersion"] !== "prepared-journal/v1" || !Number.isInteger(row["sequence"]) || Number(row["sequence"]) < 1 || Number(row["sequence"]) > 64
    || typeof row["action"] !== "string" || !["reservation", "allocation", "branch", "ticket-reread"].includes(row["action"])
    || typeof row["outcome"] !== "string" || !["observed", "failed", "uncertain"].includes(row["outcome"])) throw workflowError();
  return Object.freeze({ schemaVersion: "prepared-journal/v1", operationId: workflowSha(row["operationId"]), sequence: Number(row["sequence"]),
    previousSha256: workflowSha(row["previousSha256"]), action: row["action"] as WorkflowJournalEntry["action"],
    outcome: row["outcome"] as WorkflowJournalEntry["outcome"], evidence: parseSourceVersion(row["evidence"]), recordedAt: workflowTimestamp(row["recordedAt"]) });
}

/** Crash seams are for isolated fixtures; throwing always preserves state, never compensates resources. */
export type PublicationBoundary = "file-synced" | "linked" | "temporary-unlinked" | "directory-synced";
/**
 * Bounded immutable record primitive. Caller supplies an EXISTING owner-only directory,
 * never agent-selected roots. No mkdir/chmod/repair/overwrite/delete of authority.
 * Trusted same-UID storage owner is assumed; this is not confinement from that owner.
 * /proc/self/fd anchors operations to the opened Linux directory (no path write-through).
 *
 * Publication protocol: exclusive temporary -> complete write -> file fsync ->
 * no-clobber link -> unlink temporary -> directory fsync -> bounded readback.
 * An exception before link leaves only forensic temporary state. After link but
 * before unlink, BOTH names remain: the target has nlink=2 and reads reject.
 * After unlink, retry of identical bytes fsyncs the directory before returning.
 * A conflicting existing name is never overwritten or automatically quarantined.
 * This intentionally prefers uncertain-blocked over automatic crash repair.
 * A caller must not begin resource effects until intent() has RETURNED. The
 * transaction engine below additionally journals every individual action intent;
 * this storage primitive itself never allocates, spawns or transfers authority.
 */
export class ProtectedWorkflowStore {
  readonly #root: string;
  constructor(root: string) { this.#root = workflowPath(root); this.#directory((_) => undefined); }
  #directory<T>(action: (descriptor: number) => T): T {
    let descriptor: number | undefined;
    try {
      let part = this.#root;
      while (true) {
        const stat = lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw workflowError();
        if (part === parse(part).root) break;
        part = dirname(part);
      }
      if (realpathSync(this.#root) !== this.#root) throw workflowError();
      descriptor = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw workflowError();
      const result = action(descriptor);
      const after = lstatSync(this.#root);
      if (after.dev !== stat.dev || after.ino !== stat.ino || (after.mode & 0o7777) !== 0o700) throw workflowError();
      return result;
    } catch { throw workflowError(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  #name(name: string): string {
    if (!/^[0-9a-f]{64}\.(intent|[1-9][0-9]?|transaction-[1-9][0-9]{0,2})\.json$/.test(name)) throw workflowError();
    return name;
  }
  #read(descriptor: number, name: string): Buffer {
    const path = join(`/proc/self/fd/${descriptor}`, this.#name(name));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600
        || before.size < 1 || before.size > MAX_PROTECTED_WORKFLOW_BYTES) throw workflowError();
      const bytes = Buffer.alloc(MAX_PROTECTED_WORKFLOW_BYTES + 1); let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = fstatSync(fd); const named = lstatSync(path);
      if (size !== before.size || size > MAX_PROTECTED_WORKFLOW_BYTES || after.size !== before.size || after.ctimeMs !== before.ctimeMs
        || after.nlink !== 1 || named.ino !== before.ino || named.dev !== before.dev) throw workflowError();
      return bytes.subarray(0, size);
    } finally { closeSync(fd); }
  }
  read(name: string): unknown {
    return this.#directory((fd) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#read(fd, name))) as unknown);
  }
  /** Reestablish publication durability on a resumed, successfully validated chain. */
  reaffirm(scope: PreparedLockScope): void { assertScope(scope); this.#directory((fd) => fsyncSync(fd)); }
  /** Enumerate before replay so gaps/orphan successors cannot masquerade as absence. */
  records(): readonly string[] {
    return this.#directory((fd) => {
      const names = readdirSync(`/proc/self/fd/${fd}`);
      if (names.length > 4_096) throw workflowError();
      return Object.freeze(names.filter((name) => name.endsWith(".json")).map((name) => this.#name(name)).sort());
    });
  }
  publish(scope: PreparedLockScope, name: string, value: unknown, boundary?: (point: PublicationBoundary) => void): "published" | "identical" {
    assertScope(scope);
    // Canonical JSON roundtrip rejects unsupported values; records are size bounded BEFORE IO.
    const body = JSON.stringify(value);
    if (body === undefined || Buffer.byteLength(body) + 1 > MAX_PROTECTED_WORKFLOW_BYTES) throw workflowError();
    const bytes = Buffer.from(`${body}\n`);
    return this.#directory((directory) => {
      const target = join(`/proc/self/fd/${directory}`, this.#name(name));
      try {
        lstatSync(target);
        if (!this.#read(directory, name).equals(bytes)) throw workflowError();
        fsyncSync(directory); // repeat publication also establishes durability before any successor
        return "identical";
      } catch (error) { if (!isAbsent(error)) throw error; }
      const temporary = join(`/proc/self/fd/${directory}`, `.${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        while (offset < bytes.length) { const written = writeSync(fd, bytes, offset); if (written < 1) throw workflowError(); offset += written; }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // No catch/finally cleanup: a crash-equivalent exception retains its exact forensic state.
      boundary?.("file-synced");
      linkSync(temporary, target); boundary?.("linked");
      unlinkSync(temporary); boundary?.("temporary-unlinked");
      fsyncSync(directory); boundary?.("directory-synced");
      if (!this.#read(directory, name).equals(bytes)) throw workflowError();
      return "published";
    });
  }
}
function isAbsent(value: unknown): boolean { return value instanceof Error && "code" in value && value.code === "ENOENT"; }

/** Durable intent/result primitives only. There is intentionally no ready/consume/resource API. */
export class PreparationJournal {
  constructor(readonly store: ProtectedWorkflowStore) {}
  intent(scope: PreparedLockScope, contract: PreparationContract, createdAt: string, boundary?: (point: PublicationBoundary) => void): WorkflowIntent {
    const intent = parseIntent({ schemaVersion: "prepared-intent/v1", operationId: preparationIdentity(contract), contract, createdAt });
    this.store.publish(scope, `${intent.operationId}.intent.json`, intent, boundary);
    return intent;
  }
  readIntent(operationId: string): WorkflowIntent { return parseIntent(this.store.read(`${workflowSha(operationId)}.intent.json`)); }
  readEntry(operationId: string, sequence: number): WorkflowJournalEntry {
    return parseEntry(this.store.read(`${workflowSha(operationId)}.${sequence}.json`));
  }
  append(scope: PreparedLockScope, input: WorkflowJournalEntry, boundary?: (point: PublicationBoundary) => void): WorkflowJournalEntry {
    const entry = parseEntry(input); const intent = this.readIntent(entry.operationId);
    // Validate EVERY predecessor, not just the most recent record. No unknown gap is a pass.
    let previous: WorkflowIntent | WorkflowJournalEntry = intent;
    const actions = ["reservation", "allocation", "branch", "ticket-reread"];
    for (let sequence = 1; sequence <= entry.sequence; sequence += 1) {
      const current = sequence === entry.sequence ? entry : this.readEntry(entry.operationId, sequence);
      if (current.sequence !== sequence || current.operationId !== intent.operationId
        || current.previousSha256 !== workflowDigest(JSON.stringify(previous))
        || current.recordedAt < ("createdAt" in previous ? previous.createdAt : previous.recordedAt)
        || ("outcome" in previous && previous.outcome !== "observed")
        || current.action !== actions[sequence - 1]) throw workflowError();
      previous = current;
    }
    this.store.publish(scope, `${entry.operationId}.${entry.sequence}.json`, entry, boundary);
    return entry;
  }
}

/** Native UI capture, persisted by trusted adapter code, never accepted as tool JSON. */
export interface NativePreparationRetry {
  readonly schemaVersion: "native-preparation-retry/v1";
  readonly eventId: string;
  readonly operationId: string;
  readonly bindingIdentity: string;
  readonly callerIdentity: string;
  readonly deploymentId: string;
  readonly toolCallId: string;
  readonly preparationAttempt: number;
  readonly failureSha256: string;
  readonly capturedAt: string;
}
function parseNativePreparationRetry(value: unknown): NativePreparationRetry {
  const row = workflowObject(value, ["schemaVersion", "eventId", "operationId", "bindingIdentity", "callerIdentity", "deploymentId", "toolCallId", "preparationAttempt", "failureSha256", "capturedAt"]);
  const eventId = workflowText(row["eventId"]); const deploymentId = workflowText(row["deploymentId"]);
  if (row["schemaVersion"] !== "native-preparation-retry/v1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)
    || !/^d-[0-9a-f]{6}$/.test(deploymentId) || !Number.isSafeInteger(row["preparationAttempt"])
    || Number(row["preparationAttempt"]) < 1 || Number(row["preparationAttempt"]) > 32) throw workflowError();
  return Object.freeze({ schemaVersion: "native-preparation-retry/v1", eventId, operationId: workflowSha(row["operationId"]),
    bindingIdentity: workflowSha(row["bindingIdentity"]), callerIdentity: workflowSha(row["callerIdentity"]), deploymentId,
    toolCallId: workflowText(row["toolCallId"]), preparationAttempt: Number(row["preparationAttempt"]), failureSha256: workflowSha(row["failureSha256"]), capturedAt: workflowTimestamp(row["capturedAt"]) });
}
/** Caller already holds the existing owners' locks. Returns only a non-secret locator. */
export function publishNativePreparationRetry(store: ProtectedWorkflowStore, scope: PreparedLockScope, value: NativePreparationRetry): SourceVersion {
  const record = parseNativePreparationRetry(value); const sha256 = workflowDigest(`${JSON.stringify(record)}\n`);
  store.publish(scope, `${sha256}.intent.json`, record);
  return Object.freeze({ ref: `native-preparation-retry:${sha256}`, version: "native-preparation-retry/v1", sha256 });
}
/**
 * Verification primitive for host.authorize("retry"). Shape alone is not native
 * authority: resolve this record ONLY from protected adapter-owned storage, and
 * compare against the current authenticated operation/binding/caller. The service
 * separately enforces one-use reference/digest accounting across attempts.
 */
function resolveNativePreparationRetry(store: ProtectedWorkflowStore, input: SourceVersion): NativePreparationRetry {
  const source = parseSourceVersion(input);
  if (source.version !== "native-preparation-retry/v1" || source.ref !== `native-preparation-retry:${source.sha256}`) throw workflowError();
  const record = parseNativePreparationRetry(store.read(`${source.sha256}.intent.json`));
  if (workflowDigest(`${JSON.stringify(record)}\n`) !== source.sha256) throw workflowError();
  return record;
}
export function readNativePreparationRetry(store: ProtectedWorkflowStore, input: SourceVersion, expected: Pick<NativePreparationRetry, "operationId" | "bindingIdentity" | "callerIdentity" | "deploymentId" | "preparationAttempt" | "failureSha256">): NativePreparationRetry {
  const record = resolveNativePreparationRetry(store, input);
  for (const field of ["operationId", "bindingIdentity", "callerIdentity", "deploymentId", "preparationAttempt", "failureSha256"] as const) if (record[field] !== expected[field]) throw workflowError();
  return record;
}

export const PREPARATION_ACTIONS = Object.freeze(["reservation", "allocation", "branch", "ticket-reread", "ready", "consume"] as const);
export type PreparationAction = typeof PREPARATION_ACTIONS[number];
export type PreparationOutcome =
  | { readonly state: "absent" }
  | { readonly state: "observed" | "failed" | "capacity" | "uncertain"; readonly evidence: SourceVersion };
export interface PreparationStepContext {
  readonly contract: PreparationContract;
  readonly operationId: string;
  readonly attempt: number;
  readonly results: Readonly<Partial<Record<PreparationAction, SourceVersion>>>;
  readonly receipt: PreparedReceipt | null;
  readonly consumer: SourceVersion | null;
}
/**
 * TRUSTED HOST interface, never an agent tool schema. Production integration must
 * authenticate native activation, caller incarnation, durable promotion/approvals,
 * exact bases/checkout/ticket reread and evidence identities on EVERY call.
 * No permissive/default implementation is provided. A public projection is not a host.
 *
 * inspect() is mandatory before each effect, including crash resumption. "absent"
 * means positively proven no effect; unknown MUST be "uncertain". Both methods
 * reconcile the stable operationId, not a new allocation on each attempt. ready
 * publishes the exact receipt binding into capacity; consume transfers that SAME
 * capacity to the authenticated consumer and must be idempotent for only that lineage.
 *
 * Locks wrap existing owners, repository -> worktree -> journal; host capacity
 * operations must use the already-held transaction, never reacquire its mutex.
 */
export interface PreparationHost {
  readonly locks: PreparedLockOwners;
  readonly authorize: (operation: "request" | "retry" | "consume", contract: PreparationContract, evidence: SourceVersion | null) => void;
  readonly inspect: (action: PreparationAction, context: PreparationStepContext) => PreparationOutcome;
  readonly perform: (action: PreparationAction, context: PreparationStepContext) => Exclude<PreparationOutcome, { state: "absent" }>;
  /** Resolve protected resource facts; copied JSON/CLI output alone is not authority. */
  readonly resolveReceipt: (context: PreparationStepContext) => PreparedReceipt;
  readonly now: () => string;
}
export interface PreparationStatus {
  readonly schemaVersion: "preparation-status/v1";
  readonly operationId: string;
  readonly state: PreparationState;
  readonly attempt: number;
  readonly completedActions: readonly PreparationAction[];
  readonly receipt: PreparedReceipt | null;
  readonly failure: SourceVersion | null;
}
interface PreparationEvent {
  readonly schemaVersion: "preparation-event/v1";
  readonly operationId: string;
  readonly sequence: number;
  readonly previousSha256: string;
  readonly kind: "started" | "observed" | "failed" | "capacity" | "uncertain" | "retry";
  readonly action: PreparationAction | null;
  readonly evidence: SourceVersion | null;
  readonly receipt: PreparedReceipt | null;
  readonly consumer: SourceVersion | null;
  readonly recordedAt: string;
}
interface PreparationReplay {
  state: PreparationState;
  attempt: number;
  pending: PreparationAction | null;
  results: Partial<Record<PreparationAction, SourceVersion>>;
  receipt: PreparedReceipt | null;
  consumer: SourceVersion | null;
  failure: SourceVersion | null;
  retries: Set<string>;
}
function parsePreparationEvent(value: unknown): PreparationEvent {
  const row = workflowObject(value, ["schemaVersion", "operationId", "sequence", "previousSha256", "kind", "action", "evidence", "receipt", "consumer", "recordedAt"]);
  if (row["schemaVersion"] !== "preparation-event/v1" || !Number.isSafeInteger(row["sequence"]) || Number(row["sequence"]) < 1 || Number(row["sequence"]) > 256
    || typeof row["kind"] !== "string" || !["started", "observed", "failed", "capacity", "uncertain", "retry"].includes(row["kind"])
    || (row["action"] !== null && (typeof row["action"] !== "string" || !PREPARATION_ACTIONS.includes(row["action"] as PreparationAction)))) throw workflowError();
  return Object.freeze({ schemaVersion: "preparation-event/v1", operationId: workflowSha(row["operationId"]), sequence: Number(row["sequence"]),
    previousSha256: workflowSha(row["previousSha256"]), kind: row["kind"] as PreparationEvent["kind"], action: row["action"] as PreparationAction | null,
    evidence: row["evidence"] === null ? null : parseSourceVersion(row["evidence"]), receipt: row["receipt"] === null ? null : parsePreparedReceipt(row["receipt"]),
    consumer: row["consumer"] === null ? null : parseSourceVersion(row["consumer"]), recordedAt: workflowTimestamp(row["recordedAt"]) });
}
function nextPreparationAction(replay: PreparationReplay): PreparationAction | null {
  return PREPARATION_ACTIONS.find((action) => !replay.results[action]) ?? null;
}
function applyPreparationEvent(replay: PreparationReplay, event: PreparationEvent, contract: PreparationContract): void {
  if (event.kind === "retry") {
    if (event.action !== null || !event.evidence || event.receipt || event.consumer || replay.pending
      || !["not-ready-capacity", "not-ready-failed"].includes(replay.state) || replay.attempt >= 32
      || replay.retries.has(event.evidence.ref) || replay.retries.has(event.evidence.sha256)) throw workflowError();
    replay.retries.add(event.evidence.ref); replay.retries.add(event.evidence.sha256);
    replay.attempt += 1; replay.state = "preparing"; // original failure remains in the immutable chain AND status
    return;
  }
  const action = event.action;
  if (!action || action !== nextPreparationAction(replay)) throw workflowError();
  if (event.kind === "started") {
    if (replay.pending || event.evidence || !["preparing", "ready"].includes(replay.state)
      || (action === "consume" ? replay.state !== "ready" || !event.consumer : event.consumer !== null)
      || (action === "ready" ? !event.receipt : event.receipt !== null)) throw workflowError();
    if (event.receipt) {
      if (event.receipt.state !== "ready" || JSON.stringify(event.receipt.contract) !== JSON.stringify(contract)
        || JSON.stringify(event.receipt.ticketReread) !== JSON.stringify(replay.results["ticket-reread"])) throw workflowError();
      replay.receipt = event.receipt;
    }
    replay.consumer = event.consumer;
    replay.pending = action;
    return;
  }
  if (replay.pending !== action || !event.evidence || event.receipt || event.consumer) throw workflowError();
  replay.pending = null;
  if (event.kind === "observed") {
    replay.results[action] = event.evidence;
    replay.state = action === "ready" ? "ready" : action === "consume" ? "consumed" : "preparing";
    if (action === "consume") {
      if (!replay.receipt || !replay.consumer) throw workflowError();
      replay.receipt = parsePreparedReceipt({ ...replay.receipt, state: "consumed" });
    }
  } else {
    if (event.kind === "capacity" && action !== "reservation" && action !== "allocation") throw workflowError();
    replay.failure = event.evidence;
    replay.state = action === "consume" ? "uncertain-blocked" : event.kind === "capacity" ? "not-ready-capacity" : event.kind === "failed" ? "not-ready-failed" : "uncertain-blocked";
  }
}
function parsePreparationOutcome(value: unknown): PreparationOutcome {
  // Do not invoke accessors/coercion while interpreting host observations.
  if (value && typeof value === "object" && Object.getOwnPropertyDescriptor(value, "state")?.value === "absent") {
    workflowObject(value, ["state"]); return Object.freeze({ state: "absent" });
  }
  const row = workflowObject(value, ["state", "evidence"]);
  if (typeof row["state"] !== "string" || !["observed", "failed", "capacity", "uncertain"].includes(row["state"])) throw workflowError();
  return Object.freeze({ state: row["state"] as "observed" | "failed" | "capacity" | "uncertain", evidence: parseSourceVersion(row["evidence"]) });
}

/**
 * Journaled transaction engine, not production registration/activation. Status is a
 * non-authoritative projection. Only a trusted host can resolve resources/approvals;
 * the shipped Pi/launcher still use their unchanged legacy path.
 */
export class PreparedWorkflowService {
  constructor(readonly store: ProtectedWorkflowStore, readonly host: PreparationHost,
    readonly boundary?: (point: PublicationBoundary) => void) {}
  #load(contract: PreparationContract): { intent: WorkflowIntent | null; events: PreparationEvent[]; replay: PreparationReplay } {
    const operationId = preparationIdentity(contract);
    const names = this.store.records().filter((name) => name.startsWith(`${operationId}.`));
    // Phase-1 primitive results are not silently upgraded into service authority.
    // Adoption needs an owning, independently authenticated migration adapter.
    if (names.some((name) => !name.endsWith(".intent.json") && !name.includes(".transaction-"))) throw workflowError();
    const intentName = `${operationId}.intent.json`;
    const intent = names.includes(intentName) ? parseIntent(this.store.read(intentName)) : null;
    const eventNames = names.filter((name) => name.includes(".transaction-"));
    const replay: PreparationReplay = { state: intent ? "preparing" : "not-requested", attempt: intent ? 1 : 0, pending: null, results: {}, receipt: null, consumer: null, failure: null, retries: new Set() };
    if (!intent) { if (eventNames.length) throw workflowError(); return { intent, events: [], replay }; }
    if (intent.operationId !== operationId || JSON.stringify(intent.contract) !== JSON.stringify(contract)) throw workflowError();
    const events = eventNames.map((name) => {
      const event = parsePreparationEvent(this.store.read(name));
      if (name !== `${operationId}.transaction-${event.sequence}.json`) throw workflowError();
      return event;
    }).sort((a, b) => a.sequence - b.sequence);
    let previous: WorkflowIntent | PreparationEvent = intent;
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1 || !eventNames.includes(`${operationId}.transaction-${event.sequence}.json`) || event.operationId !== operationId
        || event.previousSha256 !== workflowDigest(JSON.stringify(previous)) || event.recordedAt < ("createdAt" in previous ? previous.createdAt : previous.recordedAt)) throw workflowError();
      applyPreparationEvent(replay, event, contract); previous = event;
    }
    return { intent, events, replay };
  }
  status(contractInput: PreparationContract): PreparationStatus {
    const contract = parsePreparationContract(contractInput);
    return this.#status(contract, this.#load(contract).replay);
  }
  #status(contract: PreparationContract, replay: PreparationReplay): PreparationStatus {
    // An intent may already have changed resources before the result was journaled.
    // Never advertise readiness or a proven failure while that outcome is pending.
    // Only a trusted inspect() on resumption can resolve it; status never does effects.
    const state = replay.pending !== null ? "uncertain-blocked" : replay.state;
    return Object.freeze({ schemaVersion: "preparation-status/v1", operationId: preparationIdentity(contract), state,
      attempt: replay.attempt, completedActions: Object.freeze(PREPARATION_ACTIONS.filter((action) => Boolean(replay.results[action]))),
      receipt: state === "ready" || state === "consumed" ? replay.receipt : null, failure: replay.failure });
  }
  request(contract: PreparationContract): PreparationStatus { return this.#run("request", contract, null); }
  retry(contract: PreparationContract, nativeRequest: SourceVersion): PreparationStatus { return this.#run("retry", contract, parseSourceVersion(nativeRequest)); }
  consume(contract: PreparationContract, authenticatedLineage: SourceVersion): PreparationStatus { return this.#run("consume", contract, parseSourceVersion(authenticatedLineage)); }
  #run(operation: "request" | "retry" | "consume", contractInput: PreparationContract, evidence: SourceVersion | null): PreparationStatus {
    const contract = parsePreparationContract(contractInput);
    // This resolver is mandatory, even for an idempotent request or consumed retry.
    // Throwing propagates as a bounded error without persisting caller/host secrets.
    try {
      if (workflowSynchronous(this.host.authorize(operation, contract, evidence)) !== undefined) throw workflowError();
    } catch { throw workflowError(); }
    return withPreparedWorkflowLocks(this.host.locks, (scope) => {
      const loaded = this.#load(contract);
      let { intent } = loaded; const { events, replay } = loaded;
      if (intent) this.store.reaffirm(scope);
      if (!intent) {
        if (operation !== "request") throw workflowError();
        intent = new PreparationJournal(this.store).intent(scope, contract, workflowTimestamp(this.host.now()), this.boundary);
        replay.state = "preparing"; replay.attempt = 1;
      }
      const append = (fields: Pick<PreparationEvent, "kind" | "action" | "evidence" | "receipt" | "consumer">): void => {
        const previous = events.at(-1) ?? intent!;
        const event = parsePreparationEvent({ schemaVersion: "preparation-event/v1", operationId: intent!.operationId, sequence: events.length + 1,
          previousSha256: workflowDigest(JSON.stringify(previous)), ...fields, recordedAt: workflowTimestamp(this.host.now()) });
        if (event.recordedAt < ("createdAt" in previous ? previous.createdAt : previous.recordedAt)) throw workflowError();
        // Validate against a reconstructed state BEFORE publication; only mutate the
        // live replay after durable publication returns. Crash exceptions stop effects.
        const probe: PreparationReplay = { ...replay, results: { ...replay.results }, retries: new Set(replay.retries) };
        applyPreparationEvent(probe, event, contract);
        this.store.publish(scope, `${event.operationId}.transaction-${event.sequence}.json`, event, this.boundary);
        applyPreparationEvent(replay, event, contract); events.push(event);
      };
      if (operation === "retry") {
        if (evidence?.version === "native-preparation-retry/v1") {
          // Recheck the exact failed attempt under the repository lock. Two native
          // dialogs opened against one failure cannot silently retry different attempts.
          const native = resolveNativePreparationRetry(this.store, evidence);
          if (native.operationId !== preparationIdentity(contract) || native.preparationAttempt !== replay.attempt
            || native.failureSha256 !== replay.failure?.sha256 || native.capturedAt < (events.at(-1)?.recordedAt ?? intent.createdAt)
            || native.capturedAt > workflowTimestamp(this.host.now())) throw workflowError();
        }
        append({ kind: "retry", action: null, evidence, receipt: null, consumer: null });
      }
      if (operation === "consume") {
        if (replay.state === "consumed") {
          if (JSON.stringify(replay.consumer) !== JSON.stringify(evidence)) throw workflowError();
          return this.#status(contract, replay);
        }
        if (replay.state !== "ready" || (replay.pending === "consume" && JSON.stringify(replay.consumer) !== JSON.stringify(evidence))) throw workflowError();
      } else if (replay.state !== "preparing") return this.#status(contract, replay);
      while (true) {
        const action = nextPreparationAction(replay);
        if (!action || (action === "consume" && operation !== "consume")) return this.#status(contract, replay);
        const context = (): PreparationStepContext => Object.freeze({ contract, operationId: intent!.operationId, attempt: replay.attempt,
          results: Object.freeze({ ...replay.results }), receipt: replay.receipt, consumer: replay.consumer });
        if (!replay.pending) {
          let receipt: PreparedReceipt | null = null;
          if (action === "ready") {
            try { receipt = parsePreparedReceipt(workflowSynchronous(this.host.resolveReceipt(context()))); } catch { throw workflowError(); }
          }
          append({ kind: "started", action, evidence: null, receipt, consumer: action === "consume" ? evidence : null });
        }
        // Intent is now durable. A crash/throw leaves pending, not success/failure.
        // Resumption always observes before deciding whether an effect is absent.
        let outcome: PreparationOutcome;
        try {
          outcome = parsePreparationOutcome(workflowSynchronous(this.host.inspect(action, context())));
          if (outcome.state === "absent") {
            outcome = parsePreparationOutcome(workflowSynchronous(this.host.perform(action, context())));
            if (outcome.state === "absent") throw workflowError();
          }
        } catch { throw workflowError(); }
        append({ kind: outcome.state, action, evidence: outcome.evidence, receipt: null, consumer: null });
        if (outcome.state !== "observed") return this.#status(contract, replay);
      }
    });
  }
}
