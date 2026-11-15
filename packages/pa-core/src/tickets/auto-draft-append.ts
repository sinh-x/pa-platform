import { readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AdvisoryFiles } from "../operations/files.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { digest, integer, object, oneOf, SHA256, strictJson, text } from "../workflows/contracts.js";
import type { AuditEntry, Ticket } from "./types.js";
import { creationDigest } from "./create-intent.js";

export const AUTO_DRAFT_APPEND_ACTOR = "requirements/auto-draft";
export interface AutoDraftTicketAppend {
  schemaVersion: "pa-auto-draft-ticket-append/v1"; ticket: string; project: "pa-platform" | "pa-platform-config";
  itemId: string; generation: number; deploymentId: string; requestId: string; expectedVersion: string;
  artifacts: Array<{ role: "brief" | "requirements" | "uat"; path: string; sha256: string }>;
  comment: string;
}
export interface AutoDraftTicketAppendHooks {
  /** Mandatory synchronous native caller/item/generation/policy fence. Input
   * data/hashes never replace genuine ownership or an adopted effect grant. */
  assertCurrent(request: Readonly<AutoDraftTicketAppend>): void;
  /** Mandatory own-artifact provenance/hash/source check under the ticket lock. */
  assertArtifacts(request: Readonly<AutoDraftTicketAppend>): void;
  afterPersist?(stage: "intent" | "ticket" | "audit"): void;
}
export class AutoDraftTicketAppendError extends Error {
  constructor(readonly code: "TICKET_APPEND_INPUT" | "TICKET_APPEND_STALE" | "TICKET_APPEND_CONFLICT" | "TICKET_APPEND_UNCERTAIN") { super(code); }
}
const fail = (code: AutoDraftTicketAppendError["code"]): never => { throw new AutoDraftTicketAppendError(code); };
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export const autoDraftTicketVersion = (ticket: Ticket) => creationDigest(ticket);
export function parseAutoDraftTicketAppend(raw: Uint8Array, checkSensitivity = true): AutoDraftTicketAppend {
  try {
    const r = object(strictJson(raw, 65_536), ["schemaVersion", "ticket", "project", "itemId", "generation", "deploymentId", "requestId", "expectedVersion", "artifacts", "comment"]);
    if (r.schemaVersion !== "pa-auto-draft-ticket-append/v1") throw new Error();
    const project = oneOf(r.project, ["pa-platform", "pa-platform-config"]), prefix = project === "pa-platform" ? "PAP" : "PAPC";
    const ticket = text(r.ticket, new RegExp(`^${prefix}-\\d+$`), 64), itemId = text(r.itemId, new RegExp(`^auto-${uuid}$`));
    const generation = integer(r.generation, 1, 1024), deploymentId = text(r.deploymentId, /^d-[a-f0-9]{6}$/), requestId = text(r.requestId, new RegExp(`^operation-${uuid}$`)), expectedVersion = text(r.expectedVersion, SHA256);
    if (!Array.isArray(r.artifacts) || !r.artifacts.length || r.artifacts.length > 3) throw new Error();
    const artifacts = r.artifacts.map(value => {
      const row = object(value, ["role", "path", "sha256"]), role = oneOf(row.role, ["brief", "requirements", "uat"]);
      const path = `agent-teams/requirements/artifacts/drafts/${deploymentId}/${role}.md`;
      if (row.path !== path) throw new Error();
      return { role, path, sha256: text(row.sha256, SHA256) };
    });
    if (new Set(artifacts.map(a => a.role)).size !== artifacts.length) throw new Error();
    const comment = text(r.comment, undefined, 2048);
    if (/[\u2028\u2029]/u.test(comment)) throw new Error();
    if (checkSensitivity) assertNoSensitiveMatch("content", comment);
    return { schemaVersion: "pa-auto-draft-ticket-append/v1", ticket, project, itemId, generation, deploymentId, requestId, expectedVersion, artifacts, comment };
  } catch { return fail("TICKET_APPEND_INPUT"); }
}
export const autoDraftAppendKey = (request: AutoDraftTicketAppend) => digest(JSON.stringify(["auto-draft-ticket-append/v1", request.itemId, request.requestId]));
export interface AutoDraftAppendIntent {
  schemaVersion: "pa-auto-draft-append-intent/v1"; key: string; payloadSha256: string; actor: typeof AUTO_DRAFT_APPEND_ACTOR;
  input: AutoDraftTicketAppend; expectedVersion: string; appliedVersion: string; before: Ticket; after: Ticket;
}
export function assertAutoDraftAppendScope(ticket: Ticket | undefined, request: AutoDraftTicketAppend): asserts ticket is Ticket {
  if (!ticket || ticket.id !== request.ticket || ticket.project !== request.project || !["idea", "requirement-review", "pending-approval", "pending-implementation"].includes(ticket.status)
    || !["", "sinh", "requirements/team-manager", "builder/team-manager"].includes(ticket.assignee)
    || ticket.assignee === "builder/team-manager" && ticket.status !== "pending-implementation") fail("TICKET_APPEND_CONFLICT");
}
export function autoDraftAppendCandidate(before: Ticket, input: AutoDraftTicketAppend, at: string, key: string): Ticket {
  if (before.doc_refs.some(ref => input.artifacts.some(a => a.path === ref.path)) || before.comments.some(comment => comment.id === `c-auto-${key.slice(0, 24)}`)) fail("TICKET_APPEND_CONFLICT");
  return { ...before, updatedAt: at,
    doc_refs: [...before.doc_refs, ...input.artifacts.map(a => ({ type: a.role === "requirements" ? "requirements" : a.role === "uat" ? "uat" : "attachment", path: a.path, primary: false, addedAt: at, addedBy: AUTO_DRAFT_APPEND_ACTOR }))],
    comments: [...before.comments, { id: `c-auto-${key.slice(0, 24)}`, author: AUTO_DRAFT_APPEND_ACTOR, timestamp: at,
      content: `Agent-authored UNAPPROVED draft evidence only; no implementation approval or human UAT. ${input.comment}` }] };
}
export function readAutoDraftAppendIntent(dir: string, key: string): AutoDraftAppendIntent | undefined {
  if (!SHA256.test(key)) return fail("TICKET_APPEND_INPUT");
  let raw: Buffer;
  try { raw = new AdvisoryFiles(dir).file(`.ticket-auto-draft-${key}.json`) as Buffer; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return fail("TICKET_APPEND_UNCERTAIN"); }
  try {
    const r = object(strictJson(raw, 4 * 1_048_576), ["schemaVersion", "key", "payloadSha256", "actor", "input", "expectedVersion", "appliedVersion", "before", "after"]);
    const record = JSON.parse(JSON.stringify(r)) as AutoDraftAppendIntent;
    const input = parseAutoDraftTicketAppend(Buffer.from(JSON.stringify(record.input)), false);
    if (record.schemaVersion !== "pa-auto-draft-append-intent/v1" || record.key !== key || autoDraftAppendKey(input) !== key || record.payloadSha256 !== creationDigest(input) || record.actor !== AUTO_DRAFT_APPEND_ACTOR
      || record.expectedVersion !== input.expectedVersion || autoDraftTicketVersion(record.before) !== record.expectedVersion || autoDraftTicketVersion(record.after) !== record.appliedVersion
      || !isDeepStrictEqual(record.after, autoDraftAppendCandidate(record.before, input, record.after.updatedAt, key))) throw new Error();
    assertAutoDraftAppendScope(record.before, input); return record;
  } catch { return fail("TICKET_APPEND_UNCERTAIN"); }
}
export function autoDraftAppendIntents(dir: string): AutoDraftAppendIntent[] {
  const names = readdirSync(dir); if (names.length > 20_000 || names.some(name => name.startsWith(".ticket-auto-draft-") && !/^\.ticket-auto-draft-[a-f0-9]{64}\.json$(?![\s\S])/.test(name))) return fail("TICKET_APPEND_UNCERTAIN");
  return names.filter(name => /^\.ticket-auto-draft-[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const record = readAutoDraftAppendIntent(dir, name.slice(".ticket-auto-draft-".length, -5)); if (!record) return fail("TICKET_APPEND_UNCERTAIN"); return record;
  });
}
export function autoDraftAppendAudit(record: AutoDraftAppendIntent): AuditEntry {
  return { ticket_id: record.before.id, action: "updated", actor: record.actor, timestamp: record.after.updatedAt,
    changes: { autoDraftAppendIntent: [null, record.key], doc_refs: [record.before.doc_refs, record.after.doc_refs], comments: [record.before.comments.length, record.after.comments.length], updatedAt: [record.before.updatedAt, record.after.updatedAt] } };
}
export function autoDraftAppendAuditComplete(record: AutoDraftAppendIntent, audits: AuditEntry[]): boolean {
  const matching = audits.filter(row => row.changes?.autoDraftAppendIntent?.[1] === record.key);
  if (matching.length > 1 || matching.length === 1 && creationDigest(matching[0]) !== creationDigest(autoDraftAppendAudit(record))) return fail("TICKET_APPEND_UNCERTAIN");
  return matching.length === 1;
}
