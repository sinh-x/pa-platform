import { isDeepStrictEqual } from "node:util";
import { lstatSync } from "node:fs";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { MODE_CAPABILITY_SESSION, capabilityToolSelected, parseModeCapabilityBinding, type ModeCapabilityBinding } from "../mode-capabilities.js";
import { getDeploymentsByTicketId } from "../registry/index.js";
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
/** Live or unknown competing ownership blocks mutation, never safe inspection.
 * A terminal label alone does not release a live/reused/unreadable PID. */
export function assertTicketStatusOwner(store: TicketStore, ticket: string, caller: TicketStatusCaller): void {
  try {
    if (readTicketWorkflow(ticket)) return statusFail("TICKET_STATUS_OWNER");
    assertWorkflowMarkerAvailable(caller.repoKey, ticket, false, store);
    const others = getDeploymentsByTicketId(ticket).filter(s => s.deploy_id !== caller.deploymentId);
    if (others.length > 256) return statusFail("TICKET_STATUS_OWNER");
    for (const other of others) {
      if (!["success", "partial", "failed", "crashed", "dead"].includes(other.status) || !other.pid) return statusFail("TICKET_STATUS_OWNER");
      try { lstatSync(`/proc/${other.pid}`); return statusFail("TICKET_STATUS_OWNER"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return statusFail("TICKET_STATUS_OWNER"); }
    }
  } catch { return statusFail("TICKET_STATUS_OWNER"); }
}
/** Trusted adapters authenticate under the actual shared ticket mutex. This
 * request cannot supply caller identity, an actor, decisions or callbacks. */
export function ticketStatusService(raw: string, owner: { store: TicketStore; authenticate(): TicketStatusCaller; afterPersist?: TicketStatusHooks["afterPersist"] }): Record<string, unknown> {
  const request = parseTicketStatusRequest(raw), caller = structuredClone(owner.authenticate());
  const check = () => {
    const current = owner.authenticate();
    try {
      if (!isDeepStrictEqual(current, caller) || current.profile !== MODE_CAPABILITY_SESSION || !current.capabilities
        || !/^d-[a-f0-9]{6}$/.test(current.deploymentId) || !capabilityToolSelected(parseModeCapabilityBinding(current.capabilities).policy, "pa_ticket_status")) return statusFail("TICKET_STATUS_SESSION");
    } catch { return statusFail("TICKET_STATUS_SESSION"); }
    const repos = loadReposYaml(), ticket = owner.store.get(request.ticket);
    if (!Object.hasOwn(repos, request.project) || current.repoKey !== request.project || !ticket || ticket.id !== request.ticket || ticket.project !== request.project) return statusFail("TICKET_STATUS_INPUT");
    if (request.action === "set") assertTicketStatusOwner(owner.store, request.ticket, caller);
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
