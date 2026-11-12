import { readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AdvisoryFiles } from "../operations/files.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { creationDigest, creationKey, type TicketCreateIntentIdentity } from "./create-intent.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type AuditEntry, type Ticket, type TicketStatus } from "./types.js";
import { isCanonicalTicketId } from "./validate.js";
export const TICKET_STATUSES: readonly TicketStatus[] = Object.freeze([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
export type TicketStatusCode = "TICKET_STATUS_INPUT" | "TICKET_STATUS_SESSION" | "TICKET_STATUS_OWNER" | "TICKET_STATUS_STALE" | "TICKET_STATUS_CONFLICT" | "TICKET_STATUS_UNCERTAIN";
export class TicketStatusError extends Error {
  constructor(readonly code: TicketStatusCode) {
    const reasons: Record<TicketStatusCode, string> = {
      TICKET_STATUS_INPUT: "The bounded status-only request or lifecycle precondition is invalid. No actor, approval or unrelated field is accepted.",
      TICKET_STATUS_SESSION: "The selected native caller, immutable status capability or current process identity cannot be authenticated.",
      TICKET_STATUS_OWNER: "A retained workflow or another deployment has live or unproven ownership. Status maintenance cannot take it over.",
      TICKET_STATUS_STALE: "The complete ticket differs from the inspected version; no new status intent was published.",
      TICKET_STATUS_CONFLICT: "The original request identity is already bound to different content. Existing evidence is preserved.",
      TICKET_STATUS_UNCERTAIN: "The ticket, original intent or audit cannot establish a settled result. A partial effect is possible.",
    };
    super(`Ticket status has no proven successful result; preserve the original request.\nCondition: The administrative status request is blocked or unsettled.\nSource: Ticket status owner (${code}).\nReason: ${reasons[code]}\nCorrection: Inspect the same ticket and original request with its runtime owner. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve the original request ID, expected version and content; do not delete evidence or create a replacement intent.\nResume Action: Reconcile uncertain work through the original owner before retrying. After a proven stale precondition, inspect current content before a new status decision. Every effect rechecks caller, lifecycle and ownership; status is not publication, queue or acceptance.`);
  }
}
export const statusFail = (code: TicketStatusCode): never => { throw new TicketStatusError(code); };
export const statusVersion = (ticket: Ticket): string => creationDigest(ticket);
export interface TicketStatusHooks { assertCurrent(): void; afterPersist?(stage: "intent" | "ticket" | "audit"): void }
export interface TicketStatusIntent extends TicketCreateIntentIdentity {
  schemaVersion: "pa-ticket-status-intent/v1"; key: string; actor: string; payloadSha256: string;
  expectedVersion: string; status: TicketStatus; before: Ticket; after: Ticket;
}
export function statusKey(identity: TicketCreateIntentIdentity): string {
  try { creationKey(identity); } catch { return statusFail("TICKET_STATUS_INPUT"); }
  return creationDigest({ domain: "ticket-status/v1", scope: identity.scope, requestId: identity.requestId });
}
export function statusCandidate(before: Ticket, status: TicketStatus, timestamp: string): Ticket {
  if (before.status === status) return before;
  return { ...before, status, updatedAt: timestamp,
    resolvedAt: TERMINAL_STATUSES.includes(status) ? before.resolvedAt ?? timestamp : null };
}
export function readStatusIntent(dir: string, key: string): TicketStatusIntent | undefined {
  try {
    const parsed = parseReviewEvidenceJson(new AdvisoryFiles(dir).file(`.ticket-status-${key}.json`) as Buffer, "ticket-status");
    const row = JSON.parse(JSON.stringify(parsed)) as TicketStatusIntent;
    if (!row || Object.keys(row).sort().join(",") !== "actor,after,before,expectedVersion,key,payloadSha256,requestId,schemaVersion,scope,status"
      || row.schemaVersion !== "pa-ticket-status-intent/v1" || row.key !== key || statusKey({ scope: row.scope, requestId: row.requestId }) !== key
      || !/^[a-f0-9]{64}$/.test(row.payloadSha256) || !isCanonicalTicketId(row.before.id) || row.after.id !== row.before.id
      || typeof row.actor !== "string" || !row.actor || row.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(row.actor)
      || statusVersion(row.before) !== row.expectedVersion || !TICKET_STATUSES.includes(row.status)
      || creationDigest({ id: row.before.id, expectedVersion: row.expectedVersion, status: row.status, actor: row.actor }) !== row.payloadSha256
      || !isDeepStrictEqual(statusCandidate(row.before, row.status, row.after.updatedAt), row.after)) return statusFail("TICKET_STATUS_UNCERTAIN");
    return row;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return statusFail("TICKET_STATUS_UNCERTAIN"); }
}
export function statusIntents(dir: string): TicketStatusIntent[] {
  return readdirSync(dir).filter(file => /^\.ticket-status-[a-f0-9]{64}\.json$/.test(file)).map(file => readStatusIntent(dir, file.slice(15, -5))!);
}
export function publishStatusIntent(dir: string, record: TicketStatusIntent): void {
  if (readStatusIntent(dir, record.key)) return statusFail("TICKET_STATUS_CONFLICT");
  new AdvisoryFiles(dir).file(`.ticket-status-${record.key}.json`, JSON.stringify(record));
  if (!isDeepStrictEqual(readStatusIntent(dir, record.key), record)) statusFail("TICKET_STATUS_UNCERTAIN");
}
export function statusAudit(record: TicketStatusIntent): AuditEntry {
  return { ticket_id: record.before.id, action: "updated", actor: record.actor, timestamp: record.after.updatedAt,
    changes: { statusIntent: [null, record.key], status: [record.before.status, record.status],
      resolvedAt: [record.before.resolvedAt, record.after.resolvedAt], updatedAt: [record.before.updatedAt, record.after.updatedAt] } };
}
export function statusAuditComplete(record: TicketStatusIntent, audits: AuditEntry[]): boolean {
  const matching = audits.filter(row => row.changes?.statusIntent?.[1] === record.key);
  if (matching.length > 1 || (matching.length === 1 && creationDigest(matching[0]) !== creationDigest(statusAudit(record)))) statusFail("TICKET_STATUS_UNCERTAIN");
  return matching.length === 1;
}
