import { isDeepStrictEqual } from "node:util";
import { commentFail } from "./comment-admission.js";
import { workflowCommentCompatible } from "../workflows/ticket-owner.js";
import type { TicketOwnershipCause } from "./ownership-diagnostic.js";
import { WorkflowMarkerError, type WorkflowMarkerCause } from "../workflows/marker-diagnostic.js";
import { lstatSync } from "node:fs";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { modeCapabilitySessionMatches, capabilityToolSelected, parseModeCapabilityBinding, type ModeCapabilityBinding } from "../mode-capabilities.js";
import { getDeploymentsByTicketId } from "../registry/index.js";
import { openReadonlyRegistryDatabase } from "../registry/db.js";
import { RegistryDocumentJournal, documentPending } from "../registry/documents.js";
import { getRegistryDbPath } from "../paths.js";
import { assertWorkflowMarkerAvailable } from "../workflows/catalog.js";
import { readTicketWorkflow } from "../workflows/public.js";
import { loadReposYaml } from "../repos.js";
import { creationDigest } from "./create-intent.js";
import { isCanonicalTicketId } from "./validate.js";
import { statusFail, statusVersion, TICKET_STATUSES, type TicketStatusHooks } from "./status-intent.js";
import type { TicketStore } from "./store.js";
import type { TicketStatus } from "./types.js";
export interface TicketStatusCaller { deploymentId: string; repoKey: string; profile?: string; capabilities?: ModeCapabilityBinding }
export type TicketStatusRequest = { schemaVersion: "pa-ticket-status/v1"; action: "inspect"; project: string; ticket: string }
  | { schemaVersion: "pa-ticket-status/v1"; action: "set"; project: string; ticket: string; requestId: string; expectedVersion: string; status: TicketStatus };
export function parseTicketStatusRequest(raw: string): TicketStatusRequest {
  let row: Record<string, unknown>;
  try { if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) return statusFail("TICKET_STATUS_INPUT"); row = parseReviewEvidenceJson(Buffer.from(raw), "ticket-status") as Record<string, unknown>; }
  catch { return statusFail("TICKET_STATUS_INPUT"); }
  const fields = row?.action === "inspect" ? ["schemaVersion", "action", "project", "ticket"] : ["schemaVersion", "action", "project", "ticket", "requestId", "expectedVersion", "status"];
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== fields.length || Object.keys(row).some(k => !fields.includes(k))
    || row.schemaVersion !== "pa-ticket-status/v1" || !["inspect", "set"].includes(String(row.action)) || typeof row.project !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(row.project)
    || !isCanonicalTicketId(row.ticket) || (row.action === "set" && (typeof row.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.requestId)
      || typeof row.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedVersion) || !TICKET_STATUSES.includes(row.status as TicketStatus)))) return statusFail("TICKET_STATUS_INPUT");
  return row as unknown as TicketStatusRequest;
}
const markerCauses: Record<WorkflowMarkerCause, TicketOwnershipCause> = {
  "record-read": "ticket-read", "registry-read": "marker-registry-read", "document-intent": "marker-document-intent",
  "marker-shape": "marker-shape", "marker-unpaired": "marker-unpaired", "marker-conflict": "marker-conflict", "project-mismatch": "marker-project",
};
function ownerFailure(error: unknown, fallback: TicketOwnershipCause): never {
  let cause = fallback;
  try { if (error instanceof WorkflowMarkerError) cause = markerCauses[error.markerCause] ?? fallback; } catch { /* Untrusted faults cannot supply facts. */ }
  return statusFail("TICKET_STATUS_OWNER", cause);
}
function missingEntry(error: unknown): boolean {
  try { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; } catch { return false; }
}
/** Live or unknown competing ownership blocks mutation, never safe inspection.
 * A terminal label alone does not release a live/reused/unreadable PID. */
export function assertTicketStatusOwner(store: TicketStore, ticket: string, caller: TicketStatusCaller): void {
  let cause: TicketOwnershipCause = "workflow-read";
  try {
    if (readTicketWorkflow(ticket)) { cause = "workflow-retained"; return statusFail("TICKET_STATUS_OWNER", cause); }
    cause = "marker-unproven";
    assertWorkflowMarkerAvailable(caller.repoKey, ticket, false, store);
  } catch (error) { return ownerFailure(error, cause); }
  assertTicketCompetingDeployments(ticket, caller);
}
/** Generic administration is stage/role independent. Retained workflow records,
 * decisions and completed publications are history, not live custody. Reuse the
 * owning journal replayers so corrupt/unknown and unsettled effects still fail
 * closed; never import their approvals as administrative authority. */
export function assertTicketAdminOwner(store: TicketStore, ticket: string, caller: TicketStatusCaller): void {
  let cause: TicketOwnershipCause = "ticket-read";
  try {
    const record = store.get(ticket);
    if (!record || record.project !== caller.repoKey) { cause = "ticket-scope"; return statusFail("TICKET_STATUS_OWNER", cause); }
    cause = "workflow-read";
    const workflow = readTicketWorkflow(ticket);
    if (workflow?.pending.length) { cause = "workflow-pending"; return statusFail("TICKET_STATUS_OWNER", cause); }
    cause = "document-read";
    let present = false;
    try { lstatSync(getRegistryDbPath()); present = true; }
    catch (error) { if (!missingEntry(error)) throw error; }
    if (present) {
      const db = openReadonlyRegistryDatabase(true);
      try {
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_events'").get();
        if (table && documentPending(new RegistryDocumentJournal(db).events(caller.repoKey, ticket)).length) {
          cause = "document-pending"; return statusFail("TICKET_STATUS_OWNER", cause);
        }
      } finally { db.close(); }
    }
  } catch (error) { return ownerFailure(error, cause); }
  assertTicketCompetingDeployments(ticket, caller);
}
/** Append safety is not status custody. Read the existing journals to establish
 * compatibility, but do not require a competing deployment to release ownership.
 * The caller holds the shared ticket mutex and authenticates independently. */
export function assertTicketCommentOwner(store: TicketStore, ticket: string, project: string): void {
  try {
    const record = store.get(ticket);
    if (!record || record.id !== ticket || record.project !== project) return commentFail("TICKET_COMMENT_UNPROVEN");
    const workflow = readTicketWorkflow(ticket);
    if (workflow && !workflowCommentCompatible(workflow)) return commentFail("TICKET_COMMENT_UNPROVEN");
    let present = false;
    try { lstatSync(getRegistryDbPath()); present = true; }
    catch (error) { if (!missingEntry(error)) throw error; }
    if (present) {
      const db = openReadonlyRegistryDatabase(true);
      try {
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_events'").get();
        // Existing replay validates pending publish/queue coordinates. Those
        // owners use member/ref/lifecycle predicates, not full ticket bytes.
        if (table) documentPending(new RegistryDocumentJournal(db).events(project, ticket));
      } finally { db.close(); }
    }
  } catch { return commentFail("TICKET_COMMENT_UNPROVEN"); }
  store.assertCommentAppendCompatible(ticket);
}

function assertTicketCompetingDeployments(ticket: string, caller: TicketStatusCaller): void {
  let others: ReturnType<typeof getDeploymentsByTicketId>;
  try { others = getDeploymentsByTicketId(ticket).filter(s => s.deploy_id !== caller.deploymentId); }
  catch { return statusFail("TICKET_STATUS_OWNER", "deployment-read"); }
  if (others.length > 256) return statusFail("TICKET_STATUS_OWNER", "deployment-limit");
  for (const other of others) {
    if (!["success", "partial", "failed", "crashed", "dead"].includes(other.status)) return statusFail("TICKET_STATUS_OWNER", "deployment-active", other.deploy_id);
    if (!other.pid) return statusFail("TICKET_STATUS_OWNER", "process-missing", other.deploy_id);
    try { lstatSync(`/proc/${other.pid}`); }
    catch (error) {
      if (!missingEntry(error)) return statusFail("TICKET_STATUS_OWNER", "process-unreadable", other.deploy_id);
      continue;
    }
    return statusFail("TICKET_STATUS_OWNER", "process-present", other.deploy_id);
  }
}
/** Trusted adapters authenticate under the actual shared ticket mutex. This
 * request cannot supply caller identity, an actor, decisions or callbacks. */
export function ticketStatusService(raw: string, owner: { store: TicketStore; authenticate(): TicketStatusCaller; afterPersist?: TicketStatusHooks["afterPersist"] }): Record<string, unknown> {
  const request = parseTicketStatusRequest(raw), caller = structuredClone(owner.authenticate());
  const check = () => {
    const current = owner.authenticate();
    try {
      if (!isDeepStrictEqual(current, caller) || !current.capabilities || !modeCapabilitySessionMatches(parseModeCapabilityBinding(current.capabilities), current.profile)
        || !/^d-[a-f0-9]{6}$/.test(current.deploymentId) || !capabilityToolSelected(parseModeCapabilityBinding(current.capabilities).policy, "pa_ticket_status")) return statusFail("TICKET_STATUS_SESSION");
    } catch { return statusFail("TICKET_STATUS_SESSION"); }
    const repos = loadReposYaml(), ticket = owner.store.get(request.ticket);
    if (!Object.hasOwn(repos, request.project) || !ticket || ticket.id !== request.ticket || ticket.project !== request.project) return statusFail("TICKET_STATUS_INPUT");
    if (request.action === "set") assertTicketStatusOwner(owner.store, request.ticket, { ...caller, repoKey: request.project });
  };
  check();
  if (request.action === "inspect") {
    const ticket = owner.store.get(request.ticket)!; check();
    return { schemaVersion: "pa-ticket-status-result/v1", action: "inspect", ticket: ticket.id, project: ticket.project, status: ticket.status, version: statusVersion(ticket), statuses: TICKET_STATUSES, effect: "read-only" };
  }
  const result = owner.store.setStatusWithIntent(request.ticket, request.expectedVersion, request.status, "requirements/analyze", {
    scope: creationDigest({ domain: "requirements-status/v1", deploymentId: caller.deploymentId, project: request.project }), requestId: request.requestId,
  }, { assertCurrent: check, afterPersist: owner.afterPersist });
  return { schemaVersion: "pa-ticket-status-result/v1", action: "set", ticket: result.ticket.id, project: result.ticket.project,
    status: result.ticket.status, version: statusVersion(result.ticket), appliedVersion: result.appliedVersion, requestId: request.requestId,
    reusedIntent: result.reused, effect: "administrative-status-only", executionAdmitted: false };
}
