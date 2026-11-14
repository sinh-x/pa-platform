import { randomUUID } from "node:crypto";
import type { TicketPriority, TicketStatus } from "../tickets/types.js";

export const AUTO_WAITLIST_VERSION = "pa-auto-waitlist/v1" as const;
export const AUTO_PROJECTS = Object.freeze({ "pa-platform": "PAP", "pa-platform-config": "PAPC" } as const);
export type AutoProject = keyof typeof AUTO_PROJECTS;
export type AutoRoute = "draft" | "review-package" | "review-start" | "observe";
export type AutoReason = "missing-requirements" | "unverified-requirements" | "pending-package" | "approved-package"
  | "terminal" | "archived" | "advanced-work" | "dependency" | "bulletin" | "foreign-owner"
  | "pending-effect" | "retired-package" | "document-conflict" | "original-workflow";
export interface AutoDocumentObservation {
  state: "missing" | "unverified" | "pending" | "approved" | "blocked";
  subjectSha256?: string;
  packageId?: string;
  revision?: number;
  decisionId?: string;
  reason?: Extract<AutoReason, "pending-effect" | "retired-package" | "document-conflict">;
}
export interface AutoTicketObservation {
  id: string; project: AutoProject; title: string; priority: TicketPriority; status: TicketStatus;
  createdAt: string; ticketSha256: string; archived: boolean;
  unresolvedDependencies: string[]; blockingBulletins: string[]; competingDeployments: string[];
  originalWorkflow: boolean; documents: AutoDocumentObservation;
}
export interface AutoWaitlistEntry extends AutoTicketObservation {
  route: AutoRoute; reasons: AutoReason[];
}
export interface AutoWaitlistSnapshot {
  schemaVersion: typeof AUTO_WAITLIST_VERSION;
  version: string; observedAt: string; completedAt: string;
  projects: Array<{ key: AutoProject; prefix: string; canonicalRoot: string }>;
  entries: AutoWaitlistEntry[];
  recommendation: string | null;
  executionAdmitted: false;
}
export class AutoWaitlistError extends Error {
  constructor(readonly code: "AUTO_SOURCE" | "AUTO_LIMIT" | "AUTO_STORE" | "AUTO_INPUT" | "AUTO_BUSY" | "AUTO_UNAVAILABLE") { super(code); }
}

/** Pure coordination projection. Even review-start is NOT launch eligibility. */
export function routeAutoTicket(ticket: AutoTicketObservation): AutoWaitlistEntry {
  const reasons: AutoReason[] = [];
  if (["done", "rejected", "cancelled"].includes(ticket.status)) reasons.push("terminal");
  if (ticket.archived) reasons.push("archived");
  if (["implementing", "review-uat"].includes(ticket.status)) reasons.push("advanced-work");
  if (ticket.unresolvedDependencies.length) reasons.push("dependency");
  if (ticket.blockingBulletins.length) reasons.push("bulletin");
  if (ticket.competingDeployments.length) reasons.push("foreign-owner");
  if (ticket.originalWorkflow) reasons.push("original-workflow");
  if (ticket.documents.state === "blocked") reasons.push(ticket.documents.reason ?? "document-conflict");
  let route: AutoRoute = "observe";
  if (!reasons.length) {
    switch (ticket.documents.state) {
      case "missing": route = "draft"; reasons.push("missing-requirements"); break;
      // Existing refs are not permission to discard or duplicate a retained package.
      case "unverified": reasons.push("unverified-requirements"); break;
      case "pending": route = "review-package"; reasons.push("pending-package"); break;
      case "approved": route = "review-start"; reasons.push("approved-package"); break;
    }
  }
  return { ...ticket, route, reasons };
}
const priorities: Record<TicketPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export function buildAutoWaitlist(input: {
  observedAt: string; completedAt: string; projects: AutoWaitlistSnapshot["projects"]; tickets: AutoTicketObservation[];
}): AutoWaitlistSnapshot {
  const entries = input.tickets.map(routeAutoTicket).sort((a, b) => priorities[a.priority] - priorities[b.priority]
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new AutoWaitlistError("AUTO_SOURCE");
  return { schemaVersion: AUTO_WAITLIST_VERSION, version: randomUUID(), observedAt: input.observedAt,
    completedAt: input.completedAt, projects: input.projects, entries,
    recommendation: entries.find(e => e.route !== "observe")?.id ?? null, executionAdmitted: false };
}

/** Display context is bounded at the observation boundary, never raw error text. */
export function autoPlainText(value: string, max = 160): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export const AUTO_REASON_TEXT: Readonly<Record<AutoReason, string>> = Object.freeze({
  "missing-requirements": "No requirements package observed; drafting only is the proposed next step.",
  "unverified-requirements": "Existing document references need their original owner's verification; no replacement draft is inferred.",
  "pending-package": "Reuse the exact frozen package for review; no implementation is authorized.",
  "approved-package": "Approved published bytes observed; a separate exact implementation-start review is still required.",
  terminal: "Ticket is done, rejected or cancelled.", archived: "Ticket is archived.",
  "advanced-work": "Implementation or UAT is already in progress; continue through its original owner.",
  dependency: "A dependency is unresolved or unavailable.", bulletin: "An active bulletin blocks a required team.",
  "foreign-owner": "A deployment has live or uncertain ownership of this ticket.",
  "pending-effect": "An original document effect is unsettled; preserve it for owner reconciliation.",
  "retired-package": "The latest package is retired; the original document owner must establish continuation.",
  "document-conflict": "Package identity, publication or decision evidence is incomplete or conflicting.",
  "original-workflow": "An existing workflow owns this ticket; no new automatic lineage is proposed.",
});
