import { parseRepositoryGitStatus, repositoryGitSnapshotDigest, type ProcessFingerprint, type RepositoryGitSnapshot } from "./repository-admission.js";
import { MAX_REPOSITORY_TICKET_SLOTS } from "./ticket-concurrency.js";
import { parsePreparedReceipt, parseSourceVersion, ProtectedWorkflowStore, withPreparedWorkflowLocks, workflowDigest, executionFailure, workflowError, workflowObject, workflowPath, workflowSha, workflowSynchronous, workflowText, workflowTimestamp, type PreparedLockOwners, type PreparedLockScope, type PreparedReceipt, type SourceVersion } from "./prepared-workflow.js";

/** Optional execution service; existing repository admission remains the lock/authority owner. */
export const EXECUTION_CUSTODY_VERSION = "execution-custody/v1";
export const PREPARED_LOCK_ORDER = Object.freeze(["canonical-repository-capacity", "worktree-admission", "journal-publication"] as const);
export interface ExecutionHolder {
  readonly deploymentId: string;
  readonly process: ProcessFingerprint;
}
export type ExecutionCustody =
  | { readonly state: "idle"; readonly holder: null; readonly inFlightOperation: null }
  | { readonly state: "orchestrator-direct" | "implement-child" | "review-reserved"; readonly holder: ExecutionHolder; readonly inFlightOperation: string | null }
  | { readonly state: "settling" | "uncertain-blocked"; readonly holder: ExecutionHolder | null; readonly inFlightOperation: string | null };
export interface ExecutionBounds {
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly runtimeMinutes: number;
  readonly consecutiveNoProgress: number;
  readonly replacementsUsed: number;
  readonly reviewCap: number;
  readonly reviewsUsed: number;
  readonly unresolvedFailureRef: string | null;
}
export interface ExecutionContract {
  readonly schemaVersion: typeof EXECUTION_CUSTODY_VERSION;
  readonly operationId: string;
  readonly phaseId: string;
  readonly lineageId: string;
  readonly custody: ExecutionCustody;
  readonly bounds: ExecutionBounds;
  readonly planRef: string;
  readonly rationaleRef: string;
  /** Future owner persists the lossless snapshot; it is not public projection material. */
  readonly launchSnapshot: RepositoryGitSnapshot;
}
/** Durable variants distinct from existing process-live RepositoryTicketSlot. No expiry/reclaim. */
export type ReservationOccupancy = "preparing" | "uncertain-retained" | "idle-ready" | "active" | "settled-retained";
export interface PreparedReservationLaunch {
  readonly slotToken: string;
  readonly deploymentDirectory: string;
  readonly acquiredAt: string;
}
export interface IdlePreparationReservation {
  readonly schemaVersion: "prepared-reservation/v1";
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly ticket: string;
  readonly operationId: string;
  readonly reservationId: string;
  readonly repositoryPermit: 1 | 2 | 3 | 4;
  readonly occupancy: ReservationOccupancy;
  readonly lineageId: string | null;
  readonly custody: ExecutionCustody;
  readonly receiptId: string | null;
  readonly retainedAt: string;
  /** Native consuming launcher only; never included in receipt/status/tool projections. */
  readonly launch?: PreparedReservationLaunch;
}
export const DEFAULT_EXECUTION_BOUNDS = Object.freeze({ runtimeMinutes: 120, noProgressLimit: 3, replacementLimit: 3, reviewCap: 3 });
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw workflowError();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : workflowText(value); }
function parseHolder(value: unknown): ExecutionHolder {
  const row = workflowObject(value, ["deploymentId", "process"]);
  const process = workflowObject(row["process"], ["pid", "startTimeTicks", "bootId"]);
  const deploymentId = workflowText(row["deploymentId"]);
  if (!/^d-[0-9a-f]{6}$/.test(deploymentId) || !/^\d+$/.test(workflowText(process["startTimeTicks"]))) throw workflowError();
  return Object.freeze({ deploymentId, process: Object.freeze({ pid: integer(process["pid"], 1, 2_147_483_647),
    startTimeTicks: workflowText(process["startTimeTicks"]), bootId: workflowText(process["bootId"]) }) });
}
export function parseExecutionCustody(value: unknown): ExecutionCustody {
  const row = workflowObject(value, ["state", "holder", "inFlightOperation"]);
  const operation = nullableText(row["inFlightOperation"]);
  if (row["state"] === "idle") {
    if (row["holder"] !== null || operation !== null) throw workflowError();
    return Object.freeze({ state: "idle", holder: null, inFlightOperation: null });
  }
  if (typeof row["state"] === "string" && ["orchestrator-direct", "implement-child", "review-reserved"].includes(row["state"])) {
    return Object.freeze({ state: row["state"] as "orchestrator-direct" | "implement-child" | "review-reserved",
      holder: parseHolder(row["holder"]), inFlightOperation: operation });
  }
  if (row["state"] === "settling" || row["state"] === "uncertain-blocked") {
    return Object.freeze({ state: row["state"], holder: row["holder"] === null ? null : parseHolder(row["holder"]), inFlightOperation: operation });
  }
  throw workflowError();
}
export function parseExecutionBounds(value: unknown): ExecutionBounds {
  const row = workflowObject(value, ["startedAt", "deadlineAt", "runtimeMinutes", "consecutiveNoProgress", "replacementsUsed", "reviewCap", "reviewsUsed", "unresolvedFailureRef"]);
  // Ordinary launcher bounds may be shorter than optional preparation's
  // separately enforced 60-minute minimum. Never inflate their deadline.
  const runtimeMinutes = integer(row["runtimeMinutes"], 1, 240);
  const startedAt = workflowTimestamp(row["startedAt"]); const deadlineAt = workflowTimestamp(row["deadlineAt"]);
  const consecutiveNoProgress = integer(row["consecutiveNoProgress"], 0, 3);
  const unresolvedFailureRef = nullableText(row["unresolvedFailureRef"]);
  if (Date.parse(deadlineAt) - Date.parse(startedAt) !== runtimeMinutes * 60_000 || (consecutiveNoProgress > 0 && !unresolvedFailureRef)) throw workflowError();
  const reviewCap = integer(row["reviewCap"], 1, 3);
  return Object.freeze({ startedAt, deadlineAt, runtimeMinutes, consecutiveNoProgress,
    replacementsUsed: integer(row["replacementsUsed"], 0, 3), reviewCap,
    reviewsUsed: integer(row["reviewsUsed"], 0, reviewCap), unresolvedFailureRef });
}
/** Comparison primitive, NOT a recovery authorization or semantic progress classifier. */
export function assertUnresetExecutionBounds(previous: ExecutionBounds, next: ExecutionBounds): void {
  const before = parseExecutionBounds(previous); const after = parseExecutionBounds(next);
  if (before.startedAt !== after.startedAt || before.deadlineAt !== after.deadlineAt || before.runtimeMinutes !== after.runtimeMinutes
    || before.reviewCap !== after.reviewCap || after.replacementsUsed < before.replacementsUsed || after.reviewsUsed < before.reviewsUsed
    || before.unresolvedFailureRef !== after.unresolvedFailureRef || after.consecutiveNoProgress < before.consecutiveNoProgress) throw workflowError();
  // Evidence-qualified progress/reset is deliberately unavailable until the Phase 3 owner exists.
}
export function executionBoundStop(value: ExecutionBounds, now: string): boolean {
  const bounds = parseExecutionBounds(value);
  return Date.parse(workflowTimestamp(now)) >= Date.parse(bounds.deadlineAt) || bounds.consecutiveNoProgress >= 3
    || bounds.replacementsUsed >= 3 || bounds.reviewsUsed >= bounds.reviewCap;
}
export function parseIdlePreparationReservation(value: unknown): IdlePreparationReservation {
  const hasLaunch = value !== null && typeof value === "object" && Object.hasOwn(value, "launch");
  const row = workflowObject(value, ["schemaVersion", "repoKey", "repoRoot", "ticket", "operationId", "reservationId", "repositoryPermit", "occupancy", "lineageId", "custody", "receiptId", "retainedAt", ...(hasLaunch ? ["launch"] : [])]);
  const repoKey = workflowText(row["repoKey"]); const ticket = workflowText(row["ticket"]);
  const occupancy = row["occupancy"];
  if (row["schemaVersion"] !== "prepared-reservation/v1" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoKey)
    || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || typeof occupancy !== "string" || !["preparing", "uncertain-retained", "idle-ready", "active", "settled-retained"].includes(occupancy)) throw workflowError();
  const custody = parseExecutionCustody(row["custody"]); const lineageId = nullableText(row["lineageId"]);
  const receiptId = row["receiptId"] === null ? null : workflowSha(row["receiptId"]);
  if ((occupancy === "active" && (!lineageId || !custody.holder))
    || (occupancy === "idle-ready" && (lineageId !== null || custody.state !== "idle" || receiptId === null))
    || (occupancy === "preparing" && (lineageId !== null || custody.state !== "idle" || receiptId !== null))
    || (occupancy === "uncertain-retained" && custody.state !== "uncertain-blocked")
    || (occupancy === "settled-retained" && (!lineageId || !receiptId || custody.state !== "idle"))) throw workflowError();
  let launch: PreparedReservationLaunch | undefined;
  if (hasLaunch) {
    const raw = workflowObject(row.launch, ["slotToken", "deploymentDirectory", "acquiredAt"]);
    if (!["active", "settled-retained", "uncertain-retained"].includes(occupancy)) throw workflowError();
    launch = Object.freeze({ slotToken: workflowText(raw.slotToken), deploymentDirectory: workflowPath(raw.deploymentDirectory), acquiredAt: workflowTimestamp(raw.acquiredAt) });
  }
  return Object.freeze({ schemaVersion: "prepared-reservation/v1", repoKey, repoRoot: workflowPath(row["repoRoot"]), ticket,
    operationId: workflowSha(row["operationId"]), reservationId: workflowSha(row["reservationId"]),
    repositoryPermit: integer(row["repositoryPermit"], 1, MAX_REPOSITORY_TICKET_SLOTS) as 1 | 2 | 3 | 4,
    occupancy: occupancy as ReservationOccupancy, lineageId, custody, receiptId, retainedAt: workflowTimestamp(row["retainedAt"]), ...(launch ? { launch } : {}) });
}
/** Pure capacity validator: does not acquire, transfer or reclaim any existing permit. */
export function assertReservationInventory(values: readonly unknown[]): readonly IdlePreparationReservation[] {
  if (!Array.isArray(values) || values.length > MAX_REPOSITORY_TICKET_SLOTS) throw workflowError();
  const reservations = values.map(parseIdlePreparationReservation);
  const first = reservations[0];
  for (const row of reservations) {
    if (first && (row.repoKey !== first.repoKey || row.repoRoot !== first.repoRoot)) throw workflowError();
  }
  for (const field of ["ticket", "operationId", "reservationId", "repositoryPermit"] as const) {
    if (new Set(reservations.map((row) => row[field])).size !== reservations.length) throw workflowError();
  }
  const lineages = reservations.flatMap((row) => row.lineageId === null ? [] : [row.lineageId]);
  if (new Set(lineages).size !== lineages.length) throw workflowError();
  return Object.freeze(reservations);
}
/** Binding validation only. A service-resolved protected receipt is still required in Phase 2. */
export function assertReceiptReservationBinding(receiptInput: PreparedReceipt, reservationInput: IdlePreparationReservation): void {
  const receipt = parsePreparedReceipt(receiptInput); const reservation = parseIdlePreparationReservation(reservationInput);
  if (receipt.operationId !== reservation.operationId || receipt.receiptId !== reservation.receiptId
    || receipt.contract.repoKey !== reservation.repoKey || receipt.contract.repoRoot !== reservation.repoRoot
    || receipt.contract.ticket !== reservation.ticket || reservation.occupancy !== "idle-ready" || receipt.state !== "ready") throw workflowError();
}
/** No protected fingerprints, capability tokens, free-form evidence or private paths in this status. */
export function projectReservation(value: IdlePreparationReservation): Readonly<{
  schemaVersion: "prepared-reservation-status/v1"; occupancy: ReservationOccupancy; occupied: true; holderPresent: boolean; automatedUseAvailable: false;
}> {
  const reservation = parseIdlePreparationReservation(value);
  return Object.freeze({ schemaVersion: "prepared-reservation-status/v1", occupancy: reservation.occupancy,
    occupied: true, holderPresent: reservation.custody.holder !== null, automatedUseAvailable: false });
}

/** Native runtime binding, never accepted from tool arguments or environment. */
export interface ExecutionBinding {
  readonly schemaVersion: "execution-binding/v1";
  readonly operationId: string;
  readonly lineageId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly ticket: string;
  readonly branch: string;
  readonly initialHeadSha: string;
  readonly owner: ExecutionHolder;
  readonly bounds: ExecutionBounds;
}
export interface PhaseExecutionPlan {
  readonly phaseId: string;
  readonly scope: string;
  readonly paths: readonly string[];
  readonly requirements: readonly string[];
  readonly prerequisites: readonly SourceVersion[];
  readonly checks: readonly string[];
  readonly size: string;
  readonly complexity: string;
  readonly rationale: string;
}
export interface ExecutionFailure {
  readonly check: string;
  readonly command: string;
  readonly exitCode: number;
  readonly candidateSha: string;
  readonly output: SourceVersion;
}
export interface ExecutionRecovery {
  readonly originalFailure: SourceVersion;
  readonly diagnostic: SourceVersion | null;
  readonly remedy: SourceVersion | null;
  readonly rationale: string | null;
  readonly recheck: ExecutionFailure;
}
export interface ExecutionRecoveryInventory {
  readonly branch: string;
  readonly headSha: string;
  readonly porcelainV2Base64: string;
  readonly snapshotSha256: string;
  /** Both rename endpoints, including deleted paths. Unknown/unrelated is never an allowed label. */
  readonly paths: readonly { readonly path: string; readonly classification: "ticket-produced" | "ticket-preserved" }[];
  /** Host resolves binary/untracked metadata and accepted commits from this exact evidence. */
  readonly evidence: SourceVersion;
}
export type ExecutionOperationKind = "write" | "edit" | "shell" | "check" | "feature-update" | "launch";
export interface ExecutionOperation {
  readonly id: string;
  readonly kind: ExecutionOperationKind;
  readonly check: string | null;
  readonly intent: SourceVersion | null;
}
export type ExecutionCommand =
  | { readonly action: "plan"; readonly plan: PhaseExecutionPlan }
  | { readonly action: "advance"; readonly plan: PhaseExecutionPlan; readonly evidence: SourceVersion }
  | { readonly action: "select"; readonly executor: "orchestrator-direct" | "implement-child" | "review-reserved"; readonly holder: ExecutionHolder; readonly handover: SourceVersion }
  | { readonly action: "begin"; readonly operation: ExecutionOperation }
  | { readonly action: "finish"; readonly operationId: string; readonly evidence: SourceVersion; readonly failure: ExecutionFailure | null; readonly candidateSha?: string }
  | { readonly action: "settle"; readonly evidence: SourceVersion; readonly inventory: ExecutionRecoveryInventory }
  | { readonly action: "attempt"; readonly recovery: ExecutionRecovery }
  | { readonly action: "resolve"; readonly evidence: SourceVersion }
  | { readonly action: "candidate"; readonly candidateSha: string; readonly mapping: SourceVersion }
  | { readonly action: "accept"; readonly kind: "review" | "ci" | "uat" | "integration"; readonly evidence: SourceVersion };
export interface ExecutionState {
  readonly binding: ExecutionBinding;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly plan: PhaseExecutionPlan | null;
  readonly custody: ExecutionCustody;
  readonly bounds: ExecutionBounds;
  readonly candidateSha: string;
  readonly operation: ExecutionOperation | null;
  readonly usedOperationIds: readonly string[];
  readonly originalFailure: ExecutionFailure | null;
  readonly recoveryPending: boolean;
  readonly diagnosticDigests: readonly string[];
  readonly remedyDigests: readonly string[];
  readonly passedChecks: Readonly<Record<string, SourceVersion>>;
  readonly actionPasses: Readonly<Record<string, SourceVersion>>;
  readonly acceptance: Readonly<Partial<Record<"review" | "ci" | "uat" | "integration", SourceVersion>>>;
}
export interface ExecutionHost {
  /** Bind EXISTING capacity -> admission mutex owners, never a separate admission database. */
  readonly locks: PreparedLockOwners;
  /** Resolve current native policy, scope, caller/registry identity and existing admission. */
  authorize(binding: ExecutionBinding, actor: ExecutionHolder, command: ExecutionCommand | "initialize" | "status"): void;
  assertLive(holder: ExecutionHolder): void;
  /** Exact reference bytes/identity/candidate and result facts, not a Boolean supplied by the model. */
  verifyEvidence(evidence: SourceVersion, purpose: string, state: ExecutionState, command: ExecutionCommand): void;
  /** Process death + terminal registry + Git + matching existing authority finalization. */
  assertHandover(state: ExecutionState, command: Extract<ExecutionCommand, { action: "select" | "settle" }>): void;
  /** Existing repository owner projects exclusion before acquisition and only
   * relinquishes it after durable journal publication, under the same locks. */
  projectCustody?(state: ExecutionState, command: ExecutionCommand, stage: "before" | "after"): void;
  now(): string;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function nativeCheck(action: () => void): void { if (workflowSynchronous(action()) !== undefined) throw workflowError(); }
function strings(value: unknown, minimum = 1): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) throw workflowError();
  const result = value.map(workflowText);
  if (new Set(result).size !== result.length) throw workflowError();
  return Object.freeze(result);
}
function ticketPath(value: unknown): string {
  const path = workflowText(value);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
    || /[*?\[\]{}]/.test(path)) throw workflowError();
  return path;
}
export function parseExecutionBinding(value: unknown): ExecutionBinding {
  const row = workflowObject(value, ["schemaVersion", "operationId", "lineageId", "repoKey", "repoRoot", "worktreeRoot", "ticket", "branch", "initialHeadSha", "owner", "bounds"]);
  const ticket = workflowText(row.ticket); const branch = workflowText(row.branch);
  const repoRoot = workflowPath(row.repoRoot); const worktreeRoot = workflowPath(row.worktreeRoot);
  if (row.schemaVersion !== "execution-binding/v1" || repoRoot === worktreeRoot || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)
    || !branch.startsWith(`feature/${ticket}-`) || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.lock$/.test(branch)) throw workflowError();
  return Object.freeze({ schemaVersion: "execution-binding/v1", operationId: workflowSha(row.operationId), lineageId: workflowText(row.lineageId),
    repoKey: workflowText(row.repoKey), repoRoot, worktreeRoot, ticket, branch, initialHeadSha: workflowSha(row.initialHeadSha, 40), owner: parseHolder(row.owner), bounds: parseExecutionBounds(row.bounds) });
}
export function parseExecutionPlan(value: unknown): PhaseExecutionPlan {
  const row = workflowObject(value, ["phaseId", "scope", "paths", "requirements", "prerequisites", "checks", "size", "complexity", "rationale"]);
  const paths = strings(row.paths).map(ticketPath);
  if (!Array.isArray(row.prerequisites) || row.prerequisites.length > 64) throw workflowError();
  return Object.freeze({ phaseId: workflowText(row.phaseId), scope: workflowText(row.scope), paths: Object.freeze(paths), requirements: strings(row.requirements),
    prerequisites: Object.freeze(row.prerequisites.map(parseSourceVersion)), checks: (() => { const checks = strings(row.checks); if (checks.some((check) => check.startsWith("@operation:"))) throw workflowError(); return checks; })(), size: workflowText(row.size), complexity: workflowText(row.complexity), rationale: workflowText(row.rationale) });
}
export function parseExecutionCommandText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw workflowError();
  return value;
}
function parseFailure(value: unknown): ExecutionFailure {
  const row = workflowObject(value, ["check", "command", "exitCode", "candidateSha", "output"]);
  if (!Number.isSafeInteger(row.exitCode) || row.exitCode === 0 || Number(row.exitCode) < -1 || Number(row.exitCode) > 255) throw workflowError();
  return Object.freeze({ check: workflowText(row.check), command: parseExecutionCommandText(row.command), exitCode: Number(row.exitCode), candidateSha: workflowSha(row.candidateSha, 40), output: parseSourceVersion(row.output) });
}
export function parseExecutionRecoveryInventory(value: unknown): ExecutionRecoveryInventory {
  const row = workflowObject(value, ["branch", "headSha", "porcelainV2Base64", "snapshotSha256", "paths", "evidence"]);
  if (typeof row.porcelainV2Base64 !== "string" || row.porcelainV2Base64.length > 32_768 || !Array.isArray(row.paths) || row.paths.length > 128) throw workflowError();
  const branch = workflowText(row.branch); const headSha = workflowSha(row.headSha, 40);
  const raw = Buffer.from(row.porcelainV2Base64, "base64");
  if (raw.toString("base64") !== row.porcelainV2Base64 || repositoryGitSnapshotDigest(branch, headSha, raw) !== workflowSha(row.snapshotSha256)) throw workflowError();
  const entries = parseRepositoryGitStatus(raw);
  const expected = [...new Set(entries.flatMap((entry) => {
    if (entry.kind === "ignored" || entry.kind === "unmerged") throw workflowError();
    return [ticketPath(entry.path), ...(entry.sourcePath ? [ticketPath(entry.sourcePath)] : [])];
  }))].sort();
  const paths = row.paths.map((item) => {
    const path = workflowObject(item, ["path", "classification"]);
    if (path.classification !== "ticket-produced" && path.classification !== "ticket-preserved") throw workflowError();
    return Object.freeze({ path: ticketPath(path.path), classification: path.classification });
  });
  if (!same(paths.map((item) => item.path).sort(), expected)) throw workflowError();
  return Object.freeze({ branch, headSha, porcelainV2Base64: row.porcelainV2Base64, snapshotSha256: workflowSha(row.snapshotSha256), paths: Object.freeze(paths), evidence: parseSourceVersion(row.evidence) });
}
function parseOperation(value: unknown): ExecutionOperation {
  const row = workflowObject(value, ["id", "kind", "check", "intent"]);
  if (typeof row.kind !== "string" || !["write", "edit", "shell", "check", "feature-update", "launch"].includes(row.kind)) throw workflowError();
  const check = nullableText(row.check);
  const intent = row.intent === null ? null : parseSourceVersion(row.intent);
  if ((row.kind === "check") !== (check !== null) || (row.kind === "feature-update" && intent === null)) throw workflowError();
  return Object.freeze({ id: workflowText(row.id), kind: row.kind as ExecutionOperationKind, check, intent });
}
function parseCommand(value: unknown): ExecutionCommand {
  if (!value || typeof value !== "object" || !Object.getOwnPropertyDescriptor(value, "action")?.value) throw workflowError();
  const action = (value as { action: unknown }).action;
  switch (action) {
    case "plan": { const row = workflowObject(value, ["action", "plan"]); return { action, plan: parseExecutionPlan(row.plan) }; }
    case "advance": { const row = workflowObject(value, ["action", "plan", "evidence"]); return { action, plan: parseExecutionPlan(row.plan), evidence: parseSourceVersion(row.evidence) }; }
    case "select": {
      const row = workflowObject(value, ["action", "executor", "holder", "handover"]);
      if (row.executor !== "orchestrator-direct" && row.executor !== "implement-child" && row.executor !== "review-reserved") throw workflowError();
      return { action, executor: row.executor, holder: parseHolder(row.holder), handover: parseSourceVersion(row.handover) };
    }
    case "begin": { const row = workflowObject(value, ["action", "operation"]); return { action, operation: parseOperation(row.operation) }; }
    case "finish": { const hasCandidate = Object.hasOwn(value, "candidateSha"); const row = workflowObject(value, ["action", "operationId", "evidence", "failure", ...(hasCandidate ? ["candidateSha"] : [])]); return { action, operationId: workflowText(row.operationId), evidence: parseSourceVersion(row.evidence), failure: row.failure === null ? null : parseFailure(row.failure), ...(hasCandidate ? { candidateSha: workflowSha(row.candidateSha, 40) } : {}) }; }
    case "settle": { const row = workflowObject(value, ["action", "evidence", "inventory"]); return { action, evidence: parseSourceVersion(row.evidence), inventory: parseExecutionRecoveryInventory(row.inventory) }; }
    case "attempt": {
      const row = workflowObject(value, ["action", "recovery"]); const recovery = workflowObject(row.recovery, ["originalFailure", "diagnostic", "remedy", "rationale", "recheck"]);
      return { action, recovery: { originalFailure: parseSourceVersion(recovery.originalFailure), diagnostic: recovery.diagnostic === null ? null : parseSourceVersion(recovery.diagnostic),
        remedy: recovery.remedy === null ? null : parseSourceVersion(recovery.remedy), rationale: nullableText(recovery.rationale), recheck: parseFailure(recovery.recheck) } };
    }
    case "resolve": { const row = workflowObject(value, ["action", "evidence"]); return { action, evidence: parseSourceVersion(row.evidence) }; }
    case "candidate": { const row = workflowObject(value, ["action", "candidateSha", "mapping"]); return { action, candidateSha: workflowSha(row.candidateSha, 40), mapping: parseSourceVersion(row.mapping) }; }
    case "accept": {
      const row = workflowObject(value, ["action", "kind", "evidence"]);
      if (row.kind !== "review" && row.kind !== "ci" && row.kind !== "uat" && row.kind !== "integration") throw workflowError();
      return { action, kind: row.kind, evidence: parseSourceVersion(row.evidence) };
    }
    default: throw workflowError();
  }
}
function sources(command: ExecutionCommand): readonly SourceVersion[] {
  switch (command.action) {
    case "plan": return command.plan.prerequisites;
    case "advance": return [command.evidence, ...command.plan.prerequisites];
    case "select": return [command.handover];
    case "begin": return command.operation.intent ? [command.operation.intent] : [];
    case "finish": return [command.evidence, ...(command.failure ? [command.failure.output] : [])];
    case "settle": return [command.evidence, command.inventory.evidence];
    case "attempt": return [command.recovery.originalFailure, command.recovery.recheck.output, ...[command.recovery.diagnostic, command.recovery.remedy].filter((s): s is SourceVersion => s !== null)];
    case "candidate": return [command.mapping];
    case "resolve": case "accept": return [command.evidence];
  }
}
function initialState(binding: ExecutionBinding, recordedAt: string): ExecutionState {
  return Object.freeze({ binding, recordedAt, sequence: 0, plan: null, custody: parseExecutionCustody({ state: "idle", holder: null, inFlightOperation: null }), bounds: binding.bounds,
    candidateSha: binding.initialHeadSha, operation: null, usedOperationIds: [], originalFailure: null, recoveryPending: false, diagnosticDigests: [], remedyDigests: [], passedChecks: {}, actionPasses: {}, acceptance: {} });
}
function runnable(state: ExecutionState, now: string): void {
  if (Date.parse(now) >= Date.parse(state.bounds.deadlineAt) || state.bounds.consecutiveNoProgress >= 3) throw workflowError();
}
function owner(state: ExecutionState, actor: ExecutionHolder): void { if (!same(state.binding.owner, actor)) throw workflowError(); }
function writer(state: ExecutionState, actor: ExecutionHolder): void {
  if ((state.custody.state !== "orchestrator-direct" && state.custody.state !== "implement-child") || !same(state.custody.holder, actor)) throw workflowError();
}
function sourceMutation(kind: ExecutionOperationKind): boolean { return kind !== "check" && kind !== "feature-update"; }
/** Pure replay: persisted commands must satisfy the same transitions as fresh calls. */
function transition(state: ExecutionState, actor: ExecutionHolder, command: ExecutionCommand, now: string): ExecutionState {
  if (Date.parse(now) < Date.parse(state.recordedAt)) throw workflowError();
  let next = { ...state, sequence: state.sequence + 1, recordedAt: now };
  const idle = () => { if (state.custody.state !== "idle" || state.operation) throw workflowError(); };
  switch (command.action) {
    case "plan":
      owner(state, actor); idle(); runnable(state, now);
      // Replanning cannot remove an unresolved check or launder it into a new phase.
      if (state.originalFailure && (!command.plan.checks.includes(state.originalFailure.check) || command.plan.phaseId !== state.plan?.phaseId)) throw workflowError();
      // A new phase uses the separately validated advance command, never a plan edit.
      if (state.plan && command.plan.phaseId !== state.plan.phaseId) throw workflowError();
      next = { ...next, plan: command.plan, passedChecks: {}, actionPasses: {}, acceptance: {} }; break;
    case "advance":
      owner(state, actor); idle(); runnable(state, now);
      if (!state.plan || state.originalFailure || state.recoveryPending || state.bounds.unresolvedFailureRef
        || command.plan.phaseId === state.plan.phaseId || state.usedOperationIds.includes(`phase:${command.plan.phaseId}`)) throw executionFailure("EXECUTION_PHASE_PREREQUISITE");
      if (!same(command.plan.paths, state.plan.paths) || !same(command.plan.checks, state.plan.checks)) throw executionFailure("EXECUTION_SCOPE_ESCALATION");
      // Native evidence proves settled current-content checks and local commit.
      // This transition preserves every bound/failure event and actual holder;
      // it is not independent acceptance or a machine-certified rich report.
      next = { ...next, plan: command.plan, usedOperationIds: [...state.usedOperationIds, `phase:${state.plan.phaseId}`], passedChecks: {}, actionPasses: {}, acceptance: {} }; break;
    case "select": {
      owner(state, actor); idle(); runnable(state, now);
      if (!state.plan || state.recoveryPending || (command.executor === "orchestrator-direct" && !same(command.holder, state.binding.owner))
        || (command.executor !== "orchestrator-direct" && same(command.holder, state.binding.owner))) throw workflowError();
      let bounds = state.bounds;
      if (command.executor === "implement-child") {
        const priorChildren = state.usedOperationIds.filter((id) => id.startsWith("custody-child:")).length;
        if (priorChildren > 0) {
          if (bounds.replacementsUsed >= 3) throw workflowError();
          bounds = { ...bounds, replacementsUsed: bounds.replacementsUsed + 1 };
        }
        next = { ...next, usedOperationIds: [...state.usedOperationIds, `custody-child:${state.sequence + 1}`] };
      }
      if (command.executor === "review-reserved") {
        if (bounds.reviewsUsed >= bounds.reviewCap || state.originalFailure || !state.plan.checks.every((check) => Object.hasOwn(state.passedChecks, check))) throw workflowError();
        bounds = { ...bounds, reviewsUsed: bounds.reviewsUsed + 1 };
      }
      next = { ...next, bounds, custody: parseExecutionCustody({ state: command.executor, holder: command.holder, inFlightOperation: null }) }; break;
    }
    case "begin":
      writer(state, actor); runnable(state, now);
      if (!state.plan || state.recoveryPending || state.operation || state.custody.inFlightOperation || state.usedOperationIds.includes(command.operation.id) || command.operation.id.startsWith("custody-child:")
        || (command.operation.check !== null && !state.plan.checks.includes(command.operation.check))) throw workflowError();
      next = { ...next, operation: command.operation, usedOperationIds: [...state.usedOperationIds, command.operation.id], custody: parseExecutionCustody({ ...state.custody, inFlightOperation: command.operation.id }),
        passedChecks: sourceMutation(command.operation.kind) ? {} : state.passedChecks,
        actionPasses: sourceMutation(command.operation.kind) ? {} : state.actionPasses, acceptance: sourceMutation(command.operation.kind) ? {} : state.acceptance }; break;
    case "finish": {
      writer(state, actor);
      if (!state.operation || state.operation.id !== command.operationId || state.custody.inFlightOperation !== command.operationId) throw workflowError();
      const check = state.operation.check ?? `@operation:${state.operation.kind}`;
      if (command.failure && (command.failure.candidateSha !== state.candidateSha || command.failure.check !== check)) throw workflowError();
      // Invalidate before/after any source effect. Native completion can bind an
      // observed new HEAD; it never carries checks/acceptance across candidates.
      const mayMutate = sourceMutation(state.operation.kind);
      const candidateSha = command.candidateSha ?? state.candidateSha;
      const passedChecks = mayMutate || candidateSha !== state.candidateSha ? {} : { ...state.passedChecks };
      const actionPasses = mayMutate || candidateSha !== state.candidateSha ? {} : { ...state.actionPasses };
      const results = state.operation.check === null ? actionPasses : passedChecks;
      if (command.failure) delete results[check]; else results[check] = command.evidence;
      next = { ...next, candidateSha, actionPasses, operation: null, custody: parseExecutionCustody({ ...state.custody, inFlightOperation: null }),
        originalFailure: state.originalFailure ?? command.failure, recoveryPending: state.recoveryPending || command.failure !== null, passedChecks, acceptance: command.failure || mayMutate || candidateSha !== state.candidateSha ? {} : state.acceptance,
        bounds: command.failure && !state.originalFailure ? { ...state.bounds, unresolvedFailureRef: command.failure.output.ref } : state.bounds }; break;
    }
    case "settle":
      owner(state, actor);
      if (state.custody.state === "idle" || state.operation || state.custody.inFlightOperation || command.inventory.branch !== state.binding.branch || command.inventory.headSha !== state.candidateSha) throw workflowError();
      next = { ...next, custody: parseExecutionCustody({ state: "idle", holder: null, inFlightOperation: null }) }; break;
    case "attempt": {
      owner(state, actor); idle(); runnable(state, now);
      const recovery = command.recovery; const failure = state.originalFailure;
      if (!failure || !same(recovery.originalFailure, failure.output) || recovery.recheck.check !== failure.check || recovery.recheck.candidateSha !== state.candidateSha) throw workflowError();
      const newDiagnostic = recovery.diagnostic && !state.diagnosticDigests.includes(recovery.diagnostic.sha256) && recovery.diagnostic.sha256 !== failure.output.sha256;
      const newRemedy = recovery.remedy && !state.remedyDigests.includes(recovery.remedy.sha256);
      const progress = Boolean((newDiagnostic || newRemedy) && recovery.rationale);
      next = { ...next, recoveryPending: false, bounds: { ...state.bounds, consecutiveNoProgress: progress ? 0 : state.bounds.consecutiveNoProgress + 1 },
        diagnosticDigests: [...state.diagnosticDigests, ...(recovery.diagnostic ? [recovery.diagnostic.sha256] : [])], remedyDigests: [...state.remedyDigests, ...(recovery.remedy ? [recovery.remedy.sha256] : [])] }; break;
    }
    case "resolve":
      owner(state, actor); idle();
      if (!state.originalFailure || !same(command.evidence, state.passedChecks[state.originalFailure.check] ?? state.actionPasses[state.originalFailure.check])) throw workflowError();
      next = { ...next, originalFailure: null, recoveryPending: false, bounds: { ...state.bounds, consecutiveNoProgress: 0, unresolvedFailureRef: null } }; break;
    case "candidate":
      owner(state, actor); idle(); runnable(state, now);
      if (command.candidateSha === state.candidateSha) throw workflowError();
      next = { ...next, candidateSha: command.candidateSha, passedChecks: {}, actionPasses: {}, acceptance: {} }; break;
    case "accept":
      owner(state, actor); idle(); runnable(state, now);
      if (!state.plan || state.originalFailure || !state.plan.checks.every((check) => Object.hasOwn(state.passedChecks, check)) || Object.hasOwn(state.acceptance, command.kind)) throw workflowError();
      if ((command.kind === "uat" || command.kind === "integration") && (!state.acceptance.review || !state.acceptance.ci)) throw workflowError();
      if (command.kind === "integration" && !state.acceptance.uat) throw workflowError();
      next = { ...next, acceptance: { ...state.acceptance, [command.kind]: command.evidence } }; break;
  }
  // Prevent callbacks/tool callers from changing nested authority through returned state.
  return freezeExecution(next);
}
function freezeExecution<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeExecution(child); Object.freeze(value); }
  return value;
}
interface ExecutionEvent { schemaVersion: "execution-event/v1"; executionId: string; sequence: number; previousSha256: string; actor: ExecutionHolder; command: ExecutionCommand; recordedAt: string }
/**
 * Append-only journal under the existing protected storage and mutex composition.
 * Crash after begin is deliberately retained as in-flight; neither quiet logs,
 * tool errors, agent shutdown nor a copied completion flag clears the barrier.
 * No production native binding/activation is installed by this constructor.
 */
export class ExecutionCustodyService {
  readonly binding: ExecutionBinding;
  readonly executionId: string;
  constructor(readonly store: ProtectedWorkflowStore, binding: ExecutionBinding, readonly host: ExecutionHost) {
    this.binding = parseExecutionBinding(binding);
    // Stable lineage identity: changing candidate, plan, executor or bounds cannot start a fresh journal.
    this.executionId = workflowDigest(JSON.stringify(["execution/v1", this.binding.operationId, this.binding.lineageId]));
  }
  #locked<T>(run: (scope: PreparedLockScope) => T): T { return withPreparedWorkflowLocks(this.host.locks, run); }
  #load(): { state: ExecutionState; previous: unknown } {
    const id = this.executionId; const names = this.store.records().filter((name) => name.startsWith(`${id}.`));
    if (!names.includes(`${id}.intent.json`)) throw workflowError();
    const intent = workflowObject(this.store.read(`${id}.intent.json`), ["schemaVersion", "binding", "recordedAt"]);
    if (intent.schemaVersion !== "execution-intent/v1" || !same(parseExecutionBinding(intent.binding), this.binding)) throw workflowError();
    let state = initialState(this.binding, workflowTimestamp(intent.recordedAt)); let previous: unknown = intent;
    const entries = names.filter((name) => name !== `${id}.intent.json`);
    if (entries.length > 256) throw workflowError();
    for (let sequence = 1; sequence <= entries.length; sequence++) {
      const name = `${id}.transaction-${sequence}.json`;
      if (!entries.includes(name)) throw workflowError();
      const row = workflowObject(this.store.read(name), ["schemaVersion", "executionId", "sequence", "previousSha256", "actor", "command", "recordedAt"]);
      if (row.schemaVersion !== "execution-event/v1" || row.executionId !== id || row.sequence !== sequence || row.previousSha256 !== workflowDigest(JSON.stringify(previous))) throw workflowError();
      const event: ExecutionEvent = { schemaVersion: "execution-event/v1", executionId: id, sequence, previousSha256: workflowSha(row.previousSha256), actor: parseHolder(row.actor), command: parseCommand(row.command), recordedAt: workflowTimestamp(row.recordedAt) };
      state = transition(state, event.actor, event.command, event.recordedAt); previous = event;
    }
    return { state: freezeExecution(state), previous };
  }
  initialize(actorInput: ExecutionHolder): ExecutionState {
    const actor = parseHolder(actorInput);
    return this.#locked((scope) => {
      nativeCheck(() => this.host.authorize(this.binding, actor, "initialize")); nativeCheck(() => this.host.assertLive(actor));
      if (!same(actor, this.binding.owner)) throw workflowError();
      const name = `${this.executionId}.intent.json`;
      if (!this.store.records().some((entry) => entry.startsWith(`${this.executionId}.`))) {
        const recordedAt = workflowTimestamp(this.host.now());
        if (Date.parse(recordedAt) < Date.parse(this.binding.bounds.startedAt)) throw workflowError();
        this.store.publish(scope, name, { schemaVersion: "execution-intent/v1", binding: this.binding, recordedAt });
      }
      const state = this.#load().state; this.store.reaffirm(scope); return state;
    });
  }
  status(actorInput: ExecutionHolder): ExecutionState {
    const actor = parseHolder(actorInput);
    return this.#locked((scope) => {
      nativeCheck(() => this.host.authorize(this.binding, actor, "status")); nativeCheck(() => this.host.assertLive(actor));
      const state = this.#load().state; this.store.reaffirm(scope); return state;
    });
  }
  apply(actorInput: ExecutionHolder, input: ExecutionCommand): ExecutionState {
    const actor = parseHolder(actorInput); const command = freezeExecution(parseCommand(input));
    return this.#locked((scope) => {
      nativeCheck(() => this.host.authorize(this.binding, actor, command)); nativeCheck(() => this.host.assertLive(actor));
      const { state, previous } = this.#load();
      if (state.sequence >= 256) throw workflowError();
      // Apply the stricter named-check contract to new plans, not historical
      // journal replay: old valid records remain readable without migration.
      if ((command.action === "plan" || command.action === "advance") && state.plan && !same(command.plan.checks, state.plan.checks)) throw workflowError();
      const now = workflowTimestamp(this.host.now()); const next = transition(state, actor, command, now);
      for (const source of sources(command)) nativeCheck(() => this.host.verifyEvidence(source, command.action, state, command));
      if (command.action === "select") nativeCheck(() => this.host.assertLive(command.holder));
      if (command.action === "select" || command.action === "settle") nativeCheck(() => this.host.assertHandover(state, command));
      const event: ExecutionEvent = { schemaVersion: "execution-event/v1", executionId: this.executionId, sequence: next.sequence,
        previousSha256: workflowDigest(JSON.stringify(previous)), actor, command, recordedAt: now };
      this.store.reaffirm(scope);
      if (this.host.projectCustody) nativeCheck(() => this.host.projectCustody!(next, command, "before"));
      this.store.publish(scope, `${this.executionId}.transaction-${next.sequence}.json`, event);
      if (this.host.projectCustody) nativeCheck(() => this.host.projectCustody!(next, command, "after"));
      return next;
    });
  }
}
/** Allowlisted public projection: no fingerprints, arbitrary refs, private paths or commands. */
export function projectExecution(state: ExecutionState): Readonly<Record<string, unknown>> {
  return Object.freeze({ schemaVersion: "execution-status/v1", sequence: state.sequence, phaseId: state.plan?.phaseId ?? null,
    state: state.custody.state, inFlight: state.operation !== null, candidateSha: state.candidateSha,
    consecutiveNoProgress: state.bounds.consecutiveNoProgress, replacementsUsed: state.bounds.replacementsUsed,
    reviewsUsed: state.bounds.reviewsUsed, reviewCap: state.bounds.reviewCap, failureRecorded: state.originalFailure !== null, recoveryPending: state.recoveryPending,
    checkCount: Object.keys(state.passedChecks).filter((check) => state.plan?.checks.includes(check)).length, integrationVerified: state.custody.state === "idle" && state.operation === null && Boolean(state.acceptance.integration) });
}

export interface ExpectedHeadFeatureUpdate {
  readonly binding: ExecutionBinding;
  readonly candidateSha: string;
  readonly expectedRemoteSha: string;
}
/**
 * Only invoke INSIDE an authenticated feature-update operation. Native host must
 * authenticate configured origin and source custody; this fixed argv primitive
 * grants no authority by itself. Generic force-push shell denials are unchanged.
 * Runner owns private command/output evidence; throws preserve the started barrier.
 */
export function updateFeatureWithExpectedHead(input: ExpectedHeadFeatureUpdate, runGit: (args: readonly string[], cwd: string) => Buffer): void {
  const binding = parseExecutionBinding(input.binding); const candidate = workflowSha(input.candidateSha, 40); const expected = workflowSha(input.expectedRemoteSha, 40);
  const ref = `refs/heads/${binding.branch}`;
  const git = (args: readonly string[]) => {
    const result = workflowSynchronous(runGit(args, binding.worktreeRoot)); if (!Buffer.isBuffer(result)) throw workflowError(); return result.toString("utf8");
  };
  if (git(["branch", "--show-current"]).trim() !== binding.branch || git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== candidate) throw workflowError();
  const remote = git(["ls-remote", "--exit-code", "--refs", "origin", ref]);
  if (remote !== `${expected}\t${ref}\n`) throw workflowError();
  git(["-c", "push.followTags=false", "push", "--porcelain", "--no-follow-tags", "--no-mirror", "--recurse-submodules=no", `--force-with-lease=${ref}:${expected}`, "origin", `${candidate}:${ref}`]);
  if (git(["ls-remote", "--exit-code", "--refs", "origin", ref]) !== `${candidate}\t${ref}\n`
    || git(["branch", "--show-current"]).trim() !== binding.branch || git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== candidate) throw workflowError();
}
