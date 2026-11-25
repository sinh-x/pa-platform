import { isDeepStrictEqual } from "node:util";
import { loadReposYaml } from "../repos.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { sanitizeTextInput } from "../deploy/control.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { creationDigest } from "./create-intent.js";
import { validatePlanningPatch } from "./planning-intent.js";
import { assertTicketAdminOwner } from "./status-service.js";
import { loadTeamConfig } from "../teams/index.js";
import { TICKET_STATUSES, statusVersion } from "./status-intent.js";
import { isCanonicalTicketId, validateAssignee, validateAuthor } from "./validate.js";
import type { TicketStore } from "./store.js";
import type { CreateTicketInput, Ticket, TicketStatus } from "./types.js";

export type TicketAdminFields = Partial<Pick<Ticket, "title" | "summary" | "description" | "priority" | "estimate" | "type" | "assignee" | "tags" | "blockedBy" | "from" | "to">>;
export type TicketAdminRequest =
  | { action: "inspect"; project: string; id: string }
  | { action: "create"; project: string; requestId: string; fields: TicketAdminFields }
  | { action: "update"; project: string; id: string; expectedVersion: string; fields: TicketAdminFields }
  | { action: "set-status"; project: string; id: string; requestId: string; expectedVersion: string; status: TicketStatus }
  | { action: "comment"; project: string; id: string; content: string };
export type TicketAdminInputRequest = TicketAdminRequest | { action: "comment"; id: string; author: string; content: string };
/** Trusted adapter output only. A request cannot choose its actor or privilege. */
export interface TicketAdminCaller { deploymentId: string; repoKey: string; team: string; mode: string; identitySha256: string }
export type TicketAdminCode = "TICKET_ADMIN_INPUT" | "TICKET_ADMIN_SESSION" | "TICKET_ADMIN_STALE" | "TICKET_ADMIN_UNAVAILABLE";
export class TicketAdminError extends Error {
  constructor(readonly code: TicketAdminCode) {
    const reason = code === "TICKET_ADMIN_INPUT" ? "The bounded request, registered project, ticket or non-sensitive field values are invalid."
      : code === "TICKET_ADMIN_SESSION" ? "The native process, session or current deployment identity cannot be authenticated."
      : code === "TICKET_ADMIN_STALE" ? "The complete ticket no longer matches the inspected version; this update did not start."
      : "The owning operation could not establish a successful result; partial effects are possible.";
    super(`Ticket administration has no proven successful result.\nCondition: The requested administration is blocked or unsettled.\nSource: Native ticket administration owner (${code}).\nReason: ${reason}\nCorrection: Ask the ticket runtime owner to inspect the same ticket and original request. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve original content, request ID and expected version where supplied; do not replace uncertain intents.\nResume Action: Reconcile uncertain effects before retrying. After a proven stale precondition, inspect current content before a new update. Every effect rechecks native identity and custody; administration grants no workflow or execution authority.`);
  }
}
export const ticketAdminFail = (code: TicketAdminCode): never => { throw new TicketAdminError(code); };
const fail = (): never => ticketAdminFail("TICKET_ADMIN_INPUT");
const token = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v) && v === v.trim();
function text(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || nonempty && !value.trim()
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail();
  try { assertNoSensitiveMatch("content", value); } catch { return fail(); }
  const clean = sanitizeTextInput(value).sanitized;
  if (nonempty && !clean.trim()) return fail();
  try { assertNoSensitiveMatch("content", clean); } catch { return fail(); }
  return clean;
}
export function validateTicketAdminFields(value: unknown): TicketAdminFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>, keys = Object.keys(row), result: TicketAdminFields = {};
  if (!keys.length || keys.length > 11) return fail();
  for (const key of keys) {
    const v = row[key];
    if (["title", "summary", "description", "priority", "estimate"].includes(key)) {
      const cleaned = text(v, key === "description" ? 32768 : key === "summary" ? 8192 : 1024, key === "title");
      Object.assign(result, validatePlanningPatch({ [key]: cleaned }));
    } else if (key === "type") {
      if (typeof v !== "string" || !["feature", "bug", "task", "review-request", "work-report", "fyi", "idea", "question"].includes(v)) return fail();
      result.type = v as Ticket["type"];
    } else if (key === "assignee") {
      const assignee = text(v, 128, true);
      // Avoid the legacy bare-name warning path and its untrusted stderr output.
      if (assignee !== "sinh" && !/^[a-z][a-z0-9_-]{0,63}(\/[a-z][a-z0-9_-]{0,63})?$/.test(assignee)) return fail();
      try { validateAuthor(assignee); validateAssignee(assignee); } catch { return fail(); }
      result.assignee = assignee;
    } else if (key === "tags" || key === "blockedBy") {
      if (!Array.isArray(v) || v.length > 64) return fail();
      const values = v.map(item => text(item, key === "tags" ? 128 : 64, true));
      if (new Set(values).size !== values.length || key === "blockedBy" && values.some(item => !isCanonicalTicketId(item))) return fail();
      result[key] = values;
    } else if (key === "from" || key === "to") result[key] = text(v, 128);
    else return fail();
  }
  return result;
}
/** Strict duplicate-key/UTF-8 JSON boundary, also used on direct native calls. */
export function parseTicketAdminRequest(raw: string): TicketAdminInputRequest {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) return fail();
    const row = parseReviewEvidenceJson(Buffer.from(raw), "ticket-admin") as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
    const legacyComment = row.action === "comment" && !Object.hasOwn(row, "project");
    const fields = row.action === "inspect" ? ["action", "project", "id"] : row.action === "create" ? ["action", "project", "requestId", "fields"]
      : row.action === "update" ? ["action", "project", "id", "expectedVersion", "fields"]
        : row.action === "set-status" ? ["action", "project", "id", "requestId", "expectedVersion", "status"]
          : row.action === "comment" ? legacyComment ? ["action", "id", "author", "content"] : ["action", "project", "id", "content"] : [];
    if (!fields.length || Object.keys(row).length !== fields.length || Object.keys(row).some(k => !fields.includes(k))
      || (!legacyComment && !token(row.project, /^[a-z][a-z0-9._-]{0,127}$/))
      || legacyComment && !token(row.author, /^[a-z][a-z0-9_-]{0,63}\/[a-z][a-z0-9_-]{0,63}$/) || row.action !== "create" && !isCanonicalTicketId(row.id)
      || fields.includes("requestId") && !token(row.requestId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      || fields.includes("expectedVersion") && !token(row.expectedVersion, /^[a-f0-9]{64}$/)
      || row.action === "set-status" && !TICKET_STATUSES.includes(row.status as TicketStatus)) return fail();
    if (fields.includes("fields")) {
      const checked = validateTicketAdminFields(row.fields);
      if (row.action === "create" && !checked.title) return fail();
    }
    if (row.action === "comment") text(row.content, 32768, true);
    return row as unknown as TicketAdminInputRequest;
  } catch { return fail(); }
}
/** Compatibility attribution is not identity or permission. Only a configured
 * agent in the authenticated caller's own team may be named; audit always uses
 * the native caller. Project lookup uses the existing read owner, never an ID prefix. */
export function normalizeTicketAdminRequest(request: TicketAdminInputRequest, caller: TicketAdminCaller, store: Pick<TicketStore, "get">): TicketAdminRequest {
  if (request.action !== "comment" || !("author" in request)) return request;
  const actor = `${caller.team}/${caller.mode}`;
  if (request.author !== actor) {
    try {
      const config = loadTeamConfig(caller.team), name = request.author.slice(caller.team.length + 1);
      if (!request.author.startsWith(`${caller.team}/`) || !config.agents.some(agent => agent.name === name)
        && !(name === "team-manager" && config.hierarchy?.["team-manager"])) return fail();
    } catch { return fail(); }
  }
  const ticket = store.get(request.id);
  if (!ticket) return fail();
  return { action: "comment", project: ticket.project, id: request.id, content: request.content };
}
/** Read-only semantic boundary, safe before writable store/context construction.
 * This is an early rejection only; the owner repeats these checks under lock. */
export function assertTicketAdminPreflight(request: TicketAdminRequest, store: Pick<TicketStore, "get">): void {
  if (!Object.hasOwn(loadReposYaml(), request.project)) return fail();
  if (request.action === "create") assertTicketAdminCandidate(ticketAdminCreateInput(request));
  else {
    const ticket = store.get(request.id);
    if (!ticket || ticket.id !== request.id || ticket.project !== request.project) return fail();
  }
}
function ticketAdminCreateInput(request: Extract<TicketAdminRequest, { action: "create" }>): CreateTicketInput {
  const fields = validateTicketAdminFields({ assignee: "sinh", ...request.fields });
  return { summary: "", description: "", status: "idea", priority: "medium", type: "task", assignee: "sinh", estimate: "M",
    from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [], ...fields, title: fields.title!, project: request.project };
}
/** Recheck exact serialized candidate AND individual strings without transforming
 * it. The current sensitive-input policy is loaded at each effect fence. */
export function assertTicketAdminCandidate(ticket: Ticket | CreateTicketInput): void {
  const check = (value: unknown): void => {
    if (typeof value === "string") assertNoSensitiveMatch("content", value);
    else if (Array.isArray(value)) value.forEach(check);
    else if (value && typeof value === "object") Object.values(value).forEach(check);
  };
  try { check(ticket); assertNoSensitiveMatch("content", JSON.stringify(ticket)); } catch { return fail(); }
}
/** Runtime-neutral infrastructure, not a selectable profile/policy or raw writer.
 * Authentication is synchronous and repeated INSIDE the shared store mutex.
 * Field updates use full-snapshot CAS; response-loss recovery is inspect-only,
 * not replay authority. Create/status reuse their existing durable intents. */
export function ticketAdminService(raw: string, owner: { store: TicketStore; authenticate(): TicketAdminCaller }): Record<string, unknown> {
  const parsed = parseTicketAdminRequest(raw), caller = structuredClone(owner.authenticate());
  const request = normalizeTicketAdminRequest(parsed, caller, owner.store);
  const check = () => {
    const current = owner.authenticate();
    if (!isDeepStrictEqual(current, caller) || !token(current.deploymentId, /^d-[a-f0-9]{6}$/)
      || !token(current.identitySha256, /^[a-f0-9]{64}$/) || !token(current.team, /^[a-z][a-z0-9_-]{0,63}$/)
      || !token(current.mode, /^[a-z][a-z0-9_-]{0,63}$/)) ticketAdminFail("TICKET_ADMIN_SESSION");
    assertTicketAdminPreflight(request, owner.store);
    if (request.action !== "create" && request.action !== "inspect") assertTicketAdminOwner(owner.store, request.id, { ...caller, repoKey: request.project });
  };
  return owner.store.withWorkflowTransaction(() => {
    check();
    const actor = `${caller.team}/${caller.mode}`;
    const candidateCheck = (ticket: Ticket) => { check(); assertTicketAdminCandidate(ticket); };
    const scope = creationDigest({ domain: "native-ticket-admin/v1", deploymentId: caller.deploymentId, project: request.project });
    const result = (ticket: Ticket, extra: Record<string, unknown> = {}) => ({ action: request.action, id: ticket.id, project: ticket.project,
      status: ticket.status, version: statusVersion(ticket), executionAdmitted: false, ...extra });
    if (request.action === "create") {
      const created = owner.store.createWithIntent(ticketAdminCreateInput(request), actor,
      { scope, requestId: request.requestId }, { requestBinding: creationDigest(request), assertCurrent: check, assertCandidate: candidateCheck });
      return result(created.ticket, { requestId: request.requestId, reusedIntent: created.reused });
    }
    const ticket = owner.store.get(request.id)!;
    if (request.action === "inspect") { check(); return result(ticket, { ticket, statuses: TICKET_STATUSES, effect: "read-only" }); }
    if (request.action === "set-status") {
      const changed = owner.store.setStatusWithIntent(request.id, request.expectedVersion, request.status, actor,
        { scope, requestId: request.requestId }, { assertCurrent: check, assertCandidate: candidateCheck });
      return result(changed.ticket, { requestId: request.requestId, reusedIntent: changed.reused, appliedVersion: changed.appliedVersion });
    }
    owner.store.assertHandoffSettled(request.id);
    if (request.action === "comment") {
      const content = text(request.content, 32768, true); check();
      const comment = owner.store.comment(request.id, actor, content, candidateCheck);
      return result(owner.store.get(request.id)!, { comment });
    }
    if (statusVersion(ticket) !== request.expectedVersion) ticketAdminFail("TICKET_ADMIN_STALE");
    const patch = validateTicketAdminFields(request.fields); check();
    return result(owner.store.updateAdministrativeFields(request.id, request.expectedVersion, patch, actor, check), { effect: "administrative-fields-only" });
  });
}
