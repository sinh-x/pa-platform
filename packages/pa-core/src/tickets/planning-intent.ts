import { readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AdvisoryFiles } from "../operations/files.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { creationDigest, creationKey, type TicketCreateIntentIdentity } from "./create-intent.js";
import { isCanonicalTicketId } from "./validate.js";
import type { AuditEntry, Ticket } from "./types.js";

/** Finite ticket-owner data primitive. Not role admission, a native port or a permission ledger. */
export type TicketPlanningPatch = Partial<Pick<Ticket, "title" | "summary" | "description" | "priority" | "estimate">>;
export interface TicketPlanningHooks {
  /** Mandatory trusted adapter authentication/ownership check under the shared ticket mutex. */
  assertCurrent(): void;
  /** Trusted adapter verifies the ORIGINAL complete snapshot, including on replay.
   * This binds inspected caller data without treating a hash as authority. */
  assertSnapshot?(ticket: Ticket): void;
  /** Optional digest of a future adapter's raw input before lossy sanitization; idempotency only. */
  requestBinding?: string;
  /** Trusted fault-test seam, never native request data. */
  afterPersist?(stage: "intent" | "ticket" | "audit"): void;
}
export interface TicketPlanningIntentRecord extends TicketCreateIntentIdentity {
  schemaVersion: "pa-ticket-planning-intent/v1"; key: string; payloadSha256: string; actor: string;
  expectedVersion: string; appliedVersion: string; patch: TicketPlanningPatch; before: Ticket; after: Ticket;
}
export type TicketPlanningIntentCode = "TICKET_PLAN_INPUT" | "TICKET_PLAN_CONFLICT" | "TICKET_PLAN_STALE" | "TICKET_PLAN_SCOPE" | "TICKET_PLAN_UNCERTAIN";
export class TicketPlanningIntentError extends Error {
  constructor(readonly code: TicketPlanningIntentCode) {
    const reasons: Record<TicketPlanningIntentCode, string> = {
      TICKET_PLAN_INPUT: "The bounded scalar patch, original identity, version or synchronous owner callback is invalid. Protected fields and full arrays are not accepted.",
      TICKET_PLAN_CONFLICT: "The original identity is bound to different planning content, version, target or actor. Existing intent data is preserved.",
      TICKET_PLAN_STALE: "The complete ticket snapshot differs from the requested version. This request has not published a planning intent.",
      TICKET_PLAN_SCOPE: "The exact ticket is absent, moved, claimed outside requirements, active/terminal or already has primary/Git evidence. This limited primitive cannot change that ownership or lifecycle.",
      TICKET_PLAN_UNCERTAIN: "Intent, ticket or audit evidence cannot establish a settled result. Work may be partial; a new identity must not replace the original request.",
    };
    super([
      "Ticket planning has no proven successful result; preserve the original request.",
      "Condition: The requested scalar planning update cannot be completed through this owner call.",
      "Source: Ticket-store planning-intent and snapshot checks.",
      `Reason: ${reasons[code]} (${code})`,
      "Correction: Inspect the current ticket and original intent/audit with the ticket runtime owner. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve existing work and the original identity; do not delete evidence or bypass uncertainty with a fresh ID.",
      "Resume Action: Reconcile the original result before any effect retry. A new planning decision after a proven stale precondition needs current inspected content; every mutation rechecks actual caller/ownership admission.",
    ].join("\n")); this.name = "TicketPlanningIntentError";
  }
}
const fail = (code: TicketPlanningIntentCode): never => { throw new TicketPlanningIntentError(code); };
export const ticketPlanningVersion = (ticket: Ticket): string => creationDigest(ticket);
export function planningKey(identity: TicketCreateIntentIdentity): string {
  try { creationKey(identity); } catch { return fail("TICKET_PLAN_INPUT"); }
  return creationDigest({ domain: "ticket-planning/v1", ...identity });
}
export function validatePlanningPatch(value: unknown, checkCurrentSensitivity = true): TicketPlanningPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("TICKET_PLAN_INPUT");
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (!keys.length || keys.length > 5 || keys.some(key => typeof key !== "string")) return fail("TICKET_PLAN_INPUT");
  const limits: Record<string, number> = { title: 1024, summary: 8192, description: 32768, priority: 8, estimate: 2 };
  const patch: Record<string, string> = {};
  for (const key of keys as string[]) {
    const field = fields[key];
    if (!Object.hasOwn(limits, key) || !field || !("value" in field) || typeof field.value !== "string") return fail("TICKET_PLAN_INPUT");
    const text = field.value as string;
    if (Buffer.byteLength(text) > limits[key]! || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
      || (key === "title" && !text.trim()) || (key === "priority" && !["critical", "high", "medium", "low"].includes(text))
      || (key === "estimate" && !["XS", "S", "M", "L", "XL"].includes(text))) return fail("TICKET_PLAN_INPUT");
    if (checkCurrentSensitivity) {
      try { assertNoSensitiveMatch("content", text); } catch { return fail("TICKET_PLAN_INPUT"); }
    }
    patch[key] = text;
  }
  return Object.freeze(patch) as TicketPlanningPatch;
}
export function assertPlanningScope(ticket: Ticket | undefined, id: string): asserts ticket is Ticket {
  if (!ticket || ticket.id !== id || !["idea", "requirement-review"].includes(ticket.status)
    || !(ticket.assignee === "sinh" || ticket.assignee === "requirements" || /^requirements\/[a-z][a-z0-9-]*$/.test(ticket.assignee))
    || ticket.doc_refs.some(ref => ref.primary) || ticket.linkedBranches.length || ticket.linkedCommits.length) fail("TICKET_PLAN_SCOPE");
}
const SHA = /^[a-f0-9]{64}(?![\s\S])/;
export function validPlanningDigest(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
export function readPlanningIntent(dir: string, key: string): TicketPlanningIntentRecord | undefined {
  if (!validPlanningDigest(key)) return fail("TICKET_PLAN_INPUT");
  let bytes: Buffer;
  try { bytes = new AdvisoryFiles(dir).file(`.ticket-plan-${key}.json`) as Buffer; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return fail("TICKET_PLAN_UNCERTAIN"); }
  try {
    const row = parseReviewEvidenceJson(bytes, "ticket-planning-intent") as TicketPlanningIntentRecord;
    const fields = ["schemaVersion", "key", "payloadSha256", "actor", "scope", "requestId", "expectedVersion", "appliedVersion", "patch", "before", "after"];
    if (!row || typeof row !== "object" || Object.keys(row).length !== fields.length || Object.keys(row).some(field => !fields.includes(field))
      || row.schemaVersion !== "pa-ticket-planning-intent/v1" || row.key !== key || planningKey({ scope: row.scope, requestId: row.requestId }) !== key
      || !validPlanningDigest(row.payloadSha256) || !validPlanningDigest(row.expectedVersion) || !validPlanningDigest(row.appliedVersion)
      || typeof row.actor !== "string" || !row.actor || row.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(row.actor)
      || !row.before || !row.after || !isCanonicalTicketId(row.before.id) || row.before.id !== row.after.id
      || ticketPlanningVersion(row.before) !== row.expectedVersion || ticketPlanningVersion(row.after) !== row.appliedVersion) throw Error();
    // Reconstruct ordinary data only after strict duplicate-key/UTF-8 checks.
    const record = JSON.parse(JSON.stringify(row)) as TicketPlanningIntentRecord;
    // Historical intent integrity is structural, not current permission. A new
    // sensitivity rule must not render all unrelated completed intents corrupt.
    const patch = validatePlanningPatch(record.patch, false);
    assertPlanningScope(record.before, record.before.id);
    if (typeof record.after.updatedAt !== "string" || !isDeepStrictEqual({ ...record.before, ...patch, updatedAt: record.after.updatedAt }, record.after)) throw Error();
    return record;
  } catch { return fail("TICKET_PLAN_UNCERTAIN"); }
}
export function planningIntents(dir: string): TicketPlanningIntentRecord[] {
  return readdirSync(dir).filter(file => /^\.ticket-plan-[a-f0-9]{64}\.json(?![\s\S])/.test(file)).map(file => {
    const record = readPlanningIntent(dir, file.slice(13, -5));
    if (!record) return fail("TICKET_PLAN_UNCERTAIN");
    return record;
  });
}
export function publishPlanningIntent(dir: string, record: TicketPlanningIntentRecord): void {
  if (readPlanningIntent(dir, record.key)) return fail("TICKET_PLAN_CONFLICT");
  new AdvisoryFiles(dir).file(`.ticket-plan-${record.key}.json`, JSON.stringify(record));
  if (creationDigest(readPlanningIntent(dir, record.key)) !== creationDigest(record)) fail("TICKET_PLAN_UNCERTAIN");
}
export function planningAudit(record: TicketPlanningIntentRecord): AuditEntry {
  const changes: AuditEntry["changes"] = { planningIntent: [null, record.key] };
  for (const key of ["title", "summary", "description", "priority", "estimate", "updatedAt"] as const)
    if (record.before[key] !== record.after[key]) changes[key] = [record.before[key], record.after[key]];
  return { ticket_id: record.before.id, action: "updated", actor: record.actor, timestamp: record.after.updatedAt, changes };
}
export function planningAuditComplete(record: TicketPlanningIntentRecord, audits: AuditEntry[]): boolean {
  const matching = audits.filter(row => row.changes?.planningIntent?.[1] === record.key);
  if (matching.length > 1 || (matching.length === 1 && creationDigest(matching[0]) !== creationDigest(planningAudit(record)))) return fail("TICKET_PLAN_UNCERTAIN");
  return matching.length === 1;
}
