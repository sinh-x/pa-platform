import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { AdvisoryFiles } from "../operations/files.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { isCanonicalTicketId } from "./validate.js";
import type { Ticket } from "./types.js";

/** Ticket-owner idempotency data only, not approvals or a parallel permission store. */
export interface TicketCreateIntentIdentity { scope: string; requestId: string }
export interface TicketCreateIntentRecord extends TicketCreateIntentIdentity {
  schemaVersion: "pa-ticket-create-intent/v1";
  key: string;
  payloadSha256: string;
  ticketSha256: string;
  actor: string;
  ticket: Ticket;
}
export interface TicketCreateIntentHooks {
  /** Mandatory owner reauthentication INSIDE the shared ticket mutation mutex. */
  assertCurrent(): void;
  /** Trusted embedding/fault-test observation, never tool request data. */
  afterPersist?(stage: "intent" | "ticket" | "audit"): void;
}
export type TicketCreateIntentCode = "TICKET_CREATE_INPUT" | "TICKET_CREATE_CONFLICT" | "TICKET_CREATE_UNCERTAIN";
export class TicketCreateIntentError extends Error {
  constructor(readonly code: TicketCreateIntentCode) {
    const reason = code === "TICKET_CREATE_INPUT" ? "The native creation identity or synchronous owner binding does not match the supported bounded grammar."
      : code === "TICKET_CREATE_CONFLICT" ? "This original request identity is already bound to different creation content or actor. The existing record is retained."
        : "The original intent, reserved ID, candidate or audit cannot be reconciled. Creation may be partial; neither absence nor completion is proven.";
    super([
      code === "TICKET_CREATE_UNCERTAIN" ? "Ticket creation outcome is uncertain; preserve the original request and records."
        : "This ticket creation request did not start; the supplied identity could not be accepted.",
      "Condition: The requested ticket creation cannot establish a successful result.",
      "Source: Ticket store creation-intent owner.",
      `Reason: ${reason} (${code})`,
      "Correction: Ask the ticket runtime owner to inspect the original intent, ticket and audit. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve the original identity and records; do not delete intent data or use a fresh ID to bypass uncertainty.",
      "Resume Action: Reconcile the same request only after the owner establishes its current effect state. Any resumed mutation must pass current caller admission again.",
    ].join("\n"));
    this.name = "TicketCreateIntentError";
  }
}
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE = /^\.ticket-create-([a-f0-9]{64})\.json(?![\s\S])/;
export function creationDigest(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable((item as Record<string, unknown>)[key])])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function creationKey(identity: TicketCreateIntentIdentity): string {
  if (!identity || Object.keys(identity).length !== 2 || Object.keys(identity).some(key => key !== "scope" && key !== "requestId")
    || typeof identity.scope !== "string" || !SHA.test(identity.scope) || identity.scope.length !== 64
    || typeof identity.requestId !== "string" || !ID.test(identity.requestId) || identity.requestId !== identity.requestId.trim()) throw new TicketCreateIntentError("TICKET_CREATE_INPUT");
  return creationDigest({ scope: identity.scope, requestId: identity.requestId });
}
export function readCreationIntent(dir: string, key: string): TicketCreateIntentRecord | undefined {
  if (!SHA.test(key) || key.length !== 64) throw new TicketCreateIntentError("TICKET_CREATE_INPUT");
  let bytes: Buffer;
  try { bytes = new AdvisoryFiles(dir).file(`.ticket-create-${key}.json`) as Buffer; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
  try {
    const record = parseReviewEvidenceJson(bytes, "ticket-creation-intent") as TicketCreateIntentRecord;
    const fields = ["schemaVersion", "key", "payloadSha256", "ticketSha256", "actor", "scope", "requestId", "ticket"];
    if (!record || typeof record !== "object" || Object.keys(record).length !== fields.length || Object.keys(record).some(field => !fields.includes(field))
      || record.schemaVersion !== "pa-ticket-create-intent/v1" || record.key !== key || creationKey({ scope: record.scope, requestId: record.requestId }) !== key
      || typeof record.payloadSha256 !== "string" || !SHA.test(record.payloadSha256) || record.payloadSha256.length !== 64
      || typeof record.actor !== "string" || !record.actor || record.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(record.actor)
      || !record.ticket || !isCanonicalTicketId(record.ticket.id) || record.ticketSha256 !== creationDigest(record.ticket)) throw new Error();
    // The strict reader deliberately uses null-prototype objects. Reconstruct
    // ordinary data only AFTER duplicate/UTF-8/schema checks, so comparisons with
    // TicketStore's normalized disk records do not fail on prototype alone.
    return JSON.parse(JSON.stringify(record)) as TicketCreateIntentRecord;
  } catch { throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
}
export function creationReservations(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(dir)) {
    const key = FILE.exec(file)?.[1];
    if (!key) continue;
    const record = readCreationIntent(dir, key);
    if (!record || ids.has(record.ticket.id)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    ids.add(record.ticket.id);
  }
  return ids;
}
export function publishCreationIntent(dir: string, record: TicketCreateIntentRecord): void {
  if (readCreationIntent(dir, record.key)) throw new TicketCreateIntentError("TICKET_CREATE_CONFLICT");
  new AdvisoryFiles(dir).file(`.ticket-create-${record.key}.json`, JSON.stringify(record));
  if (creationDigest(readCreationIntent(dir, record.key)) !== creationDigest(record)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
}
