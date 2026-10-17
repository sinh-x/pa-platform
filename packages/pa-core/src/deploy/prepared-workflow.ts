import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { formatBoundedFiveFieldDiagnostic } from "../repos.js";
import { MAX_REPOSITORY_TICKET_SLOT_BYTES } from "./ticket-concurrency.js";

/** Phase 1 only: no admission/export/tool/config wiring, resource actions or ready publisher. */
export const PREPARED_WORKFLOW_VERSION = "prepared-workflow/v1";
export const PREPARED_POLICY_VERSION = "prepared-autonomy/v1";
export const MAX_PROTECTED_WORKFLOW_BYTES = MAX_REPOSITORY_TICKET_SLOT_BYTES;
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
    resumeAction: "resume only with matching supported authority; Phase 1 grants none",
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
 * A caller must not begin resource effects until intent() has RETURNED; no
 * resource execution/ready-publication routine is implemented in this phase.
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
    if (!/^[0-9a-f]{64}\.(intent|[1-9][0-9]?)\.json$/.test(name)) throw workflowError();
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
