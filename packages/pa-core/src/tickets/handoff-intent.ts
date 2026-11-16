import { readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AdvisoryFiles } from "../operations/files.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, type HandoffBranchIntent } from "../documents/handoff-contract.js";
import { creationDigest, creationKey, type TicketCreateIntentIdentity } from "./create-intent.js";
import type { AuditEntry, LinkedBranch, Ticket } from "./types.js";

/** Internal ticket-owner seam, NOT a public request, association or Git grant.
 * Selected native adapters must authenticate observations and historical owners
 * under the shared ticket mutex. Retained document/intake owners do not use it. */
export type TicketHandoffChange =
  | { kind: "plan"; intent: HandoffBranchIntent }
  | { kind: "materialize"; planKey: string; operationId: string; headSha: string }
  | { kind: "stage"; stage: "analysis" | "review" | "changes-requested" };
export interface TicketHandoffHooks {
  assertCurrent(): void;
  /** Checks ORIGINAL and current complete snapshots, native association/history,
   * and (for materialize) the correlated actual ref/result. Copies only. */
  assertSnapshot(before: Ticket, current: Ticket): void;
  afterPersist?(stage: "intent" | "ticket" | "audit"): void;
}
export interface TicketHandoffRecord extends TicketCreateIntentIdentity {
  schemaVersion: "pa-ticket-handoff-intent/v1"; key: string; payloadSha256: string;
  actor: string; expectedVersion: string; change: TicketHandoffChange; before: Ticket; after: Ticket;
}
export type TicketHandoffCode = "TICKET_HANDOFF_INPUT" | "TICKET_HANDOFF_STALE" | "TICKET_HANDOFF_CONFLICT" | "TICKET_HANDOFF_SCOPE" | "TICKET_HANDOFF_UNCERTAIN";
export class TicketHandoffError extends Error {
  constructor(readonly code: TicketHandoffCode) {
    const reasons: Record<TicketHandoffCode, string> = {
      TICKET_HANDOFF_INPUT: "The finite change, original identity or synchronous owner check is invalid.",
      TICKET_HANDOFF_STALE: "The complete ticket snapshot changed before intent publication; no new intent was saved by this call.",
      TICKET_HANDOFF_CONFLICT: "The original request, native plan or exact link conflicts; existing history is preserved.",
      TICKET_HANDOFF_SCOPE: "The ticket lifecycle, assignment, primary reference or branch history is outside this finite transition.",
      TICKET_HANDOFF_UNCERTAIN: "The original intent, ticket or audit cannot prove a settled result; work may be partial.",
    };
    super(["Ticket handoff has no proven completed result; preserve the original operation.",
      "Condition: This finite ticket handoff step cannot be completed.", "Source: Ticket-store handoff intent and complete-snapshot checks.",
      `Reason: ${reasons[code]} (${code})`,
      "Correction: Ask the ticket runtime owner to inspect the original intent, ticket and audit. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve original coordinates and history; do not replace the request or delete evidence.",
      "Resume Action: Reconcile the original result before retrying an effect. Every remaining write requires current native caller, ownership and effect admission; ticket linkage is not checkout or launch readiness."].join("\n"));
    this.name = "TicketHandoffError";
  }
}
export const handoffFail = (code: TicketHandoffCode): never => { throw new TicketHandoffError(code); };
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const keys = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === fields.length && Reflect.ownKeys(value).every(key => typeof key === "string" && fields.includes(key) && "value" in Object.getOwnPropertyDescriptor(value, key)!);
export function handoffKey(identity: TicketCreateIntentIdentity): string {
  try { creationKey(identity); } catch { return handoffFail("TICKET_HANDOFF_INPUT"); }
  return creationDigest({ domain: "ticket-handoff/v1", ...identity });
}
export function parseTicketHandoffChange(value: unknown): TicketHandoffChange {
  try {
    if (keys(value, ["kind", "intent"]) && value.kind === "plan") return { kind: "plan", intent: parseHandoffBranchIntent(value.intent) };
    if (keys(value, ["kind", "planKey", "operationId", "headSha"]) && value.kind === "materialize" && sha(value.planKey) && sha(value.operationId)
      && typeof value.headSha === "string" && /^[a-f0-9]{40}(?![\s\S])/.test(value.headSha))
      return { kind: "materialize", planKey: value.planKey, operationId: value.operationId, headSha: value.headSha };
    if (keys(value, ["kind", "stage"]) && value.kind === "stage" && ["analysis", "review", "changes-requested"].includes(value.stage as string))
      return { kind: "stage", stage: value.stage as "analysis" | "review" | "changes-requested" };
  } catch { /* no untrusted diagnostic propagation */ }
  return handoffFail("TICKET_HANDOFF_INPUT");
}
function scope(ticket: Ticket): void {
  if (![["idea", "sinh"], ["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]]
    .some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) handoffFail("TICKET_HANDOFF_SCOPE");
}
/** Pure finite projection. No generic status/assignee/ref dictionaries. The
 * materialized head must ALSO be proved by the native adapter inside the lock. */
export function handoffCandidate(before: Ticket, change: TicketHandoffChange, actor: string, stamp: string, plan?: TicketHandoffRecord): Ticket {
  scope(before);
  if (change.kind === "stage") {
    if (before.doc_refs.some(ref => ref.primary)) handoffFail("TICKET_HANDOFF_SCOPE");
    const review = change.stage === "review";
    if (change.stage === "changes-requested" && before.status !== "pending-approval") handoffFail("TICKET_HANDOFF_SCOPE");
    return { ...before, status: review ? "pending-approval" : "requirement-review", assignee: review ? "sinh" : "requirements/team-manager", updatedAt: stamp };
  }
  const intent = change.kind === "plan" ? change.intent : plan?.change.kind === "plan" ? plan.change.intent : undefined;
  if (!intent || intent.ticket !== before.id || intent.repository.key !== before.project || before.linkedBranches.length > 1) return handoffFail("TICKET_HANDOFF_CONFLICT");
  const existing = before.linkedBranches[0];
  if (existing && (existing.repo !== intent.repository.key || existing.branch !== intent.branch)) handoffFail("TICKET_HANDOFF_CONFLICT");
  if (change.kind === "plan") {
    if (intent.expectedTicketVersion !== creationDigest(before) || intent.plannedLinkSha256 !== creationDigest(existing ?? null)) handoffFail("TICKET_HANDOFF_CONFLICT");
    if (intent.action === "create" && existing) handoffFail("TICKET_HANDOFF_CONFLICT"); // No adoption of legacy planned names.
    if (intent.action === "reuse" && (!existing || existing.state !== "materialized" || existing.baseSha !== intent.base.sha
      || !existing.headSha || !/^[a-f0-9]{40}(?![\s\S])/.test(existing.headSha) || existing.sha !== existing.headSha)) handoffFail("TICKET_HANDOFF_CONFLICT");
    // Planning preserves the complete old materialized link, not today's tip.
    // Native hooks must prove lineage and ancestry to the newly observed HEAD;
    // the post-publication materialize operation alone refreshes head metadata.
    return existing ? before : { ...before, updatedAt: stamp, linkedBranches: [{ repo: intent.repository.key, branch: intent.branch, state: "planned", linkedAt: stamp, linkedBy: actor }] };
  }
  if (!plan || plan.before.id !== before.id || !existing || creationDigest(existing) !== creationDigest(plan.after.linkedBranches[0])
    || change.headSha !== (intent.action === "reuse" ? intent.lineage!.observedHeadSha : intent.base.sha)) return handoffFail("TICKET_HANDOFF_CONFLICT");
  // Never infer original base from today's tip. Keep original link attribution.
  const link: LinkedBranch = { ...existing, state: "materialized", baseSha: intent.base.sha, headSha: change.headSha, sha: change.headSha };
  return { ...before, updatedAt: stamp, linkedBranches: [link] };
}
export function readHandoffIntent(dir: string, key: string, planOnly = false): TicketHandoffRecord | undefined {
  if (!sha(key)) return handoffFail("TICKET_HANDOFF_INPUT");
  let bytes: Buffer;
  try { bytes = new AdvisoryFiles(dir).file(`.ticket-handoff-${key}.json`) as Buffer; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return handoffFail("TICKET_HANDOFF_UNCERTAIN"); }
  try {
    const row = parseReviewEvidenceJson(bytes, "ticket-handoff-intent") as TicketHandoffRecord;
    if (!keys(row, ["schemaVersion", "key", "payloadSha256", "actor", "scope", "requestId", "expectedVersion", "change", "before", "after"])
      || row.schemaVersion !== "pa-ticket-handoff-intent/v1" || row.key !== key || handoffKey({ scope: row.scope, requestId: row.requestId }) !== key
      || !sha(row.payloadSha256) || !sha(row.expectedVersion) || !row.before || !row.after || creationDigest(row.before) !== row.expectedVersion
      || typeof row.actor !== "string" || !row.actor || row.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(row.actor)) throw Error();
    const record = JSON.parse(JSON.stringify(row)) as TicketHandoffRecord;
    const change = parseTicketHandoffChange(record.change);
    if (record.payloadSha256 !== creationDigest({ id: record.before.id, expectedVersion: record.expectedVersion, change, actor: record.actor })) throw Error();
    if (planOnly && change.kind !== "plan") throw Error();
    const plan = change.kind === "materialize" ? readHandoffIntent(dir, change.planKey, true) : undefined;
    // Materialize must refer directly to a plan, never recursively to a result.
    if (change.kind === "materialize" && plan?.change.kind !== "plan") throw Error();
    if (!isDeepStrictEqual(handoffCandidate(record.before, change, record.actor, record.after.updatedAt, plan), record.after)) throw Error();
    if (change.kind === "plan") handoffBranchIntentSha(change.intent);
    return record;
  } catch { return handoffFail("TICKET_HANDOFF_UNCERTAIN"); }
}
export function handoffIntents(dir: string): TicketHandoffRecord[] {
  return readdirSync(dir).filter(name => /^\.ticket-handoff-[a-f0-9]{64}\.json(?![\s\S])/.test(name)).map(name => {
    const row = readHandoffIntent(dir, name.slice(16, -5));
    return row ?? handoffFail("TICKET_HANDOFF_UNCERTAIN");
  });
}
export function publishHandoffIntent(dir: string, record: TicketHandoffRecord): void {
  if (readHandoffIntent(dir, record.key)) handoffFail("TICKET_HANDOFF_CONFLICT");
  new AdvisoryFiles(dir).file(`.ticket-handoff-${record.key}.json`, JSON.stringify(record));
  if (creationDigest(readHandoffIntent(dir, record.key)) !== creationDigest(record)) handoffFail("TICKET_HANDOFF_UNCERTAIN");
}
export function handoffAudit(record: TicketHandoffRecord): AuditEntry {
  const changes: AuditEntry["changes"] = { handoffIntent: [null, record.key] };
  for (const field of ["status", "assignee", "linkedBranches", "updatedAt"] as const)
    if (!isDeepStrictEqual(record.before[field], record.after[field])) changes[field] = [record.before[field], record.after[field]];
  return { ticket_id: record.before.id, action: "updated", actor: record.actor, timestamp: record.after.updatedAt, changes };
}
export function handoffAuditComplete(record: TicketHandoffRecord, audits: AuditEntry[]): boolean {
  const rows = audits.filter(row => row.changes?.handoffIntent?.[1] === record.key);
  if (rows.length > 1 || rows.length === 1 && creationDigest(rows[0]) !== creationDigest(handoffAudit(record))) handoffFail("TICKET_HANDOFF_UNCERTAIN");
  return rows.length === 1;
}
