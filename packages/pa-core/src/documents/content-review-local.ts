import type Database from "better-sqlite3";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { hasModeResources, isModeCapabilitySession, modeCapabilityActor, modeCapabilityRouteMatches, modeCapabilitySessionMatches, parseModeCapabilityBinding } from "../mode-capabilities.js";
import { getAiUsageDir, getTicketsDir } from "../paths.js";
import { listRepos } from "../repos.js";
import { openDurableRegistryDatabase, openReadonlyRegistryDatabase } from "../registry/db.js";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { TicketStore } from "../tickets/store.js";
import { digest, object, strictJson, text } from "../workflows/contracts.js";
import { DocumentPackageError, documentReject, type DocumentPackage } from "./package-contract.js";
import { ContentReviewService, type ContentReviewHost } from "./content-review.js";
import { parseContentReviewRequest, type ContentReviewSubject } from "./content-review-contract.js";

/** Saved native origin, NOT authentication of a local process or permission for
 * any effect. Unlike combined handoff, there is no branch/plan/develop binding. */
export function verifyContentReviewOrigin(db: Database.Database, journal: RegistryHandoffReviewJournal, subject: ContentReviewSubject, document: DocumentPackage): void {
  const fields = ["event", "note", "runtime", "binary", "team", "mode", "repo", "repo_root", "worktree_root", "rogue_one", "builder_authority", "treehouse_path", "ticket_slot_id", "repository_permit", "parent_deployment_id", "resumed_from_deployment_id", "fallback", "review_checkout", "ticket_worktree_selection", "mode_capability_binding", "ticket_id", "previous_ticket_id", "actor"];
  const rows = db.prepare(`SELECT ${fields.join(",")} FROM registry_events WHERE deployment_id=? ORDER BY id LIMIT 1025`).all(subject.deploymentId);
  if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
  const events = rows.map(row => object(row, fields)), starts = events.filter(row => row.event === "started"), start = starts[0];
  if (starts.length !== 1 || !start || !isModeCapabilitySession(start.note) || start.runtime !== "pi" || start.binary !== "ppa"
    || start.repo !== document.repository.root || start.repo_root !== document.repository.root || start.worktree_root !== document.repository.root
    || start.rogue_one || start.builder_authority || start.treehouse_path || start.ticket_slot_id || start.repository_permit
    || start.parent_deployment_id || start.resumed_from_deployment_id || start.fallback || start.review_checkout || start.ticket_worktree_selection) documentReject("DOCUMENT_AUTHORITY");
  const raw = text(start.mode_capability_binding, undefined, 65536), binding = parseModeCapabilityBinding(strictJson(Buffer.from(raw), 65536));
  if (JSON.stringify(binding) !== raw || digest(raw) !== subject.selectionSha256 || !modeCapabilitySessionMatches(binding, start.note)
    || !modeCapabilityRouteMatches(binding, start.team, start.mode) || hasModeResources(binding) && binding.repoKey !== document.repository.key
    || !["document.local-review", "document.handoff", "document.package"].every(id => binding.policy.allow.includes(id))) documentReject("DOCUMENT_AUTHORITY");
  let associated = start.ticket_id || null;
  const edges = events.filter(row => row.event === "ticket-associated");
  if (edges.length > 1) documentReject("DOCUMENT_AUTHORITY");
  for (const edge of edges) {
    if (associated !== null || edge.previous_ticket_id || edge.actor !== modeCapabilityActor(binding) || edge.ticket_id !== document.ticket) documentReject("DOCUMENT_AUTHORITY");
    associated = edge.ticket_id;
  }
  if (associated !== document.ticket || !journal.documents.events(document.repository.key, document.ticket).some(e => e.data.kind === "frozen" && e.data.subjectSha256 === subject.documentSubjectSha256)) documentReject("DOCUMENT_AUTHORITY");
}
function existingDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) documentReject("DOCUMENT_SOURCE");
}
export function contentReviewLocalHost(db: Database.Database, tickets: TicketStore, journal: RegistryHandoffReviewJournal, artifactRoot: string): ContentReviewHost {
  return { artifactRoot,
    assertDocument(document) {
      const ticket = tickets.get(document.ticket);
      if (!ticket || ticket.project !== document.repository.key || listRepos().filter(repo => repo.name === document.repository.key && repo.path === document.repository.root).length !== 1) documentReject("DOCUMENT_AUTHORITY");
      const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
      if (inside(document.repository.root, artifactRoot) || inside(join(artifactRoot, "agent-teams/requirements/artifacts"), document.repository.root)) documentReject("DOCUMENT_AUTHORITY");
    },
    assertOrigin(subject, document) { verifyContentReviewOrigin(db, journal, subject, document); },
  };
}
/** Existing-only local dispatcher. Public callers can select only a ticket for
 * discovery or a native-issued reference; never paths, roots or authority. */
export async function executeContentReview(raw: string): Promise<Record<string, unknown>> {
  const request = parseContentReviewRequest(raw);
  try {
    const db = request.action === "list" || request.action === "show" ? openReadonlyRegistryDatabase(true) : openDurableRegistryDatabase();
    try {
      const artifactRoot = getAiUsageDir(), ticketRoot = getTicketsDir(); existingDirectory(artifactRoot); existingDirectory(ticketRoot);
      const tickets = new TicketStore(ticketRoot), journal = new RegistryHandoffReviewJournal(db, false);
      const service = new ContentReviewService(journal, contentReviewLocalHost(db, tickets, journal, artifactRoot));
      let result: Record<string, unknown>;
      if (request.action === "list") {
        const ticket = tickets.get(request.ticket); if (!ticket) documentReject("DOCUMENT_SOURCE");
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_review_subjects'").get();
        result = { schemaVersion: "pa-content-review-list/v1", ticket: request.ticket, reviews: table ? await service.list(ticket.project, request.ticket) : [],
          selection: "explicit-reference-required", trust: "local-unverified", authentication: "not-provided" };
      } else if (request.action === "show") result = { ...await service.show(request.reference) };
      else if (request.action === "request") result = await service.request(request.reference);
      else result = await service.decide(request.reference, request.outcome);
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) documentReject("DOCUMENT_UNAVAILABLE");
      return result;
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof DocumentPackageError) throw error;
    throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
  }
}
