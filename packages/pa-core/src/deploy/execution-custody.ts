import type { ProcessFingerprint, RepositoryGitSnapshot } from "./repository-admission.js";
import { MAX_REPOSITORY_TICKET_SLOTS } from "./ticket-concurrency.js";
import { parsePreparedReceipt, workflowError, workflowObject, workflowPath, workflowSha, workflowText, workflowTimestamp, type PreparedReceipt } from "./prepared-workflow.js";

/** Schema only: current repository admission remains the owner; no Pi enforcement here. */
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
export type ReservationOccupancy = "preparing" | "uncertain-retained" | "idle-ready" | "active";
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
  const runtimeMinutes = integer(row["runtimeMinutes"], 60, 240);
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
  const row = workflowObject(value, ["schemaVersion", "repoKey", "repoRoot", "ticket", "operationId", "reservationId", "repositoryPermit", "occupancy", "lineageId", "custody", "receiptId", "retainedAt"]);
  const repoKey = workflowText(row["repoKey"]); const ticket = workflowText(row["ticket"]);
  const occupancy = row["occupancy"];
  if (row["schemaVersion"] !== "prepared-reservation/v1" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoKey)
    || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || typeof occupancy !== "string" || !["preparing", "uncertain-retained", "idle-ready", "active"].includes(occupancy)) throw workflowError();
  const custody = parseExecutionCustody(row["custody"]); const lineageId = nullableText(row["lineageId"]);
  const receiptId = row["receiptId"] === null ? null : workflowSha(row["receiptId"]);
  if ((occupancy === "active" && (!lineageId || !custody.holder))
    || (occupancy === "idle-ready" && (lineageId !== null || custody.state !== "idle" || receiptId === null))
    || (occupancy === "preparing" && (lineageId !== null || custody.state !== "idle" || receiptId !== null))
    || (occupancy === "uncertain-retained" && custody.state !== "uncertain-blocked")) throw workflowError();
  return Object.freeze({ schemaVersion: "prepared-reservation/v1", repoKey, repoRoot: workflowPath(row["repoRoot"]), ticket,
    operationId: workflowSha(row["operationId"]), reservationId: workflowSha(row["reservationId"]),
    repositoryPermit: integer(row["repositoryPermit"], 1, MAX_REPOSITORY_TICKET_SLOTS) as 1 | 2 | 3 | 4,
    occupancy: occupancy as ReservationOccupancy, lineageId, custody, receiptId, retainedAt: workflowTimestamp(row["retainedAt"]) });
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
