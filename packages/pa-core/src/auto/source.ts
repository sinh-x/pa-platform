import type Database from "better-sqlite3";
import { closeSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openArtifactDirectory, readArtifactFile, readArtifactFileAt } from "../artifacts/manifest.js";
import { parseBulletin } from "../bulletins/types.js";
import { documentDestination } from "../documents/package-contract.js";
import { checkDocumentPackage } from "../documents/package-tools.js";
import { getAiUsageDir, getBulletinsDir, getTicketsDir } from "../paths.js";
import { openReadonlyRegistryDatabase } from "../registry/db.js";
import { documentCompletedOperation, documentDecisionRecords, documentPending, documentRetiredSubjects, documentRevokedDecisionIds, RegistryDocumentJournal } from "../registry/documents.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { loadReposYaml } from "../repos.js";
import { findSensitiveMatch, loadSensitivePatterns, type SensitivePatternSet } from "../sensitive-patterns.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type DocRef, type TicketPriority, type TicketStatus } from "../tickets/types.js";
import { isCanonicalTicketId } from "../tickets/validate.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { digest } from "../workflows/contracts.js";
import { AUTO_PROJECTS, AutoWaitlistError, autoPlainText, buildAutoWaitlist, type AutoDocumentObservation, type AutoProject, type AutoTicketObservation, type AutoWaitlistSnapshot } from "./waitlist.js";

export const AUTO_SCAN_LIMITS = Object.freeze({ wallMs: 120_000, files: 20_000, ticketBytes: 1_048_576, bulletinBytes: 1_048_576 });
interface ReadTicket {
  id: string; project: string; title: string; priority: TicketPriority; status: TicketStatus; createdAt: string;
  tags: string[]; blockedBy: string[]; doc_refs: DocRef[]; sha256: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutoWaitlistError("AUTO_SOURCE");
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new AutoWaitlistError("AUTO_SOURCE");
  return value as string[];
}
function parseTicket(bytes: Buffer, id: string, aliases?: Map<string, string>): ReadTicket | null {
  const r = record(parseReviewEvidenceJson(bytes, "auto.ticket"));
  // TicketStore alias files are not candidates. Their canonical target is separately enumerated.
  if (r._alias === true) {
    if (!isCanonicalTicketId(r.movedTo)) throw new AutoWaitlistError("AUTO_SOURCE");
    aliases?.set(id, r.movedTo);
    return null;
  }
  if (!isCanonicalTicketId(id) || r.id !== id || typeof r.project !== "string" || typeof r.title !== "string"
    || ![...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(r.status as TicketStatus)
    || !["critical", "high", "medium", "low"].includes(r.priority as string)
    || typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt)) || !Array.isArray(r.doc_refs)) throw new AutoWaitlistError("AUTO_SOURCE");
  const refs = r.doc_refs.map(value => {
    const ref = record(value);
    if (typeof ref.type !== "string" || typeof ref.path !== "string" || typeof ref.primary !== "boolean") throw new AutoWaitlistError("AUTO_SOURCE");
    return ref as unknown as DocRef;
  });
  return { id, project: r.project, title: r.title, priority: r.priority as TicketPriority, status: r.status as TicketStatus,
    createdAt: r.createdAt, tags: strings(r.tags), blockedBy: strings(r.blockedBy), doc_refs: refs, sha256: digest(bytes) };
}
function namesAt(fd: number, check: () => void): string[] {
  const dir = opendirSync(`/proc/self/fd/${fd}`), names: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      check(); names.push(entry.name);
      if (names.length > AUTO_SCAN_LIMITS.files) throw new AutoWaitlistError("AUTO_LIMIT");
    }
  } finally { dir.closeSync(); }
  return names.sort();
}
function requirementsRefs(ticket: ReadTicket): boolean {
  return ticket.doc_refs.some(r => ["req", "requirements", "uat", "workflow"].includes(r.type));
}
function observeDocuments(db: Database.Database, ticket: ReadTicket, root: string, artifactRoot: string, check: () => void): AutoDocumentObservation {
  const journal = new RegistryDocumentJournal(db), events = journal.events(ticket.project, ticket.id);
  if (documentPending(events).length) return { state: "blocked", reason: "pending-effect" };
  const frozen = events.filter(e => e.data.kind === "frozen").at(-1);
  if (!frozen) return { state: requirementsRefs(ticket) ? "unverified" : "missing" };
  const sha = frozen.data.subjectSha256, subject = journal.subject(sha);
  const identity = { subjectSha256: sha, packageId: subject.packageId, revision: subject.revision };
  if (documentRetiredSubjects(events).has(sha)) return { ...identity, state: "blocked", reason: "retired-package" };
  if (subject.repository.key !== ticket.project || subject.repository.root !== root || subject.ticket !== ticket.id) return { ...identity, state: "blocked", reason: "document-conflict" };
  const snapshots = subject.members.map(member => { check(); return journal.snapshot(member.sha256); });
  if (!checkDocumentPackage(subject, snapshots).structuralPass) return { ...identity, state: "blocked", reason: "document-conflict" };
  const latest = documentDecisionRecords(events, sha).at(-1);
  if (!latest) return { ...identity, state: "pending" };
  journal.snapshot(latest.evidenceSha256);
  if (latest.outcome !== "approved" || documentRevokedDecisionIds(events).has(latest.decisionId)) {
    return { ...identity, state: "blocked", reason: "document-conflict", decisionId: latest.decisionId };
  }
  // Content approval is not publication; partial publication is not ready work.
  if (!documentCompletedOperation(events, sha, "publish")) {
    const partial = subject.members.some(m => ticket.doc_refs.some(r => r.path === documentDestination(subject, m)));
    return { ...identity, state: partial ? "blocked" : "pending", ...(partial ? { reason: "document-conflict" as const } : {}), decisionId: latest.decisionId };
  }
  try {
    for (const member of subject.members) {
      check();
      const destination = documentDestination(subject, member), refs = ticket.doc_refs.filter(r => r.path === destination);
      if (refs.length !== 1 || (member.role === "requirements" ? !refs[0]!.primary || !["req", "requirements"].includes(refs[0]!.type) : refs[0]!.primary)) throw new Error();
      const bytes = readArtifactFile(join(artifactRoot, destination), member.bytes, "ARTIFACT_STALE");
      if (bytes.length !== member.bytes || digest(bytes) !== member.sha256) throw new Error();
    }
    if (ticket.doc_refs.filter(r => r.primary && ["req", "requirements"].includes(r.type)).length !== 1) throw new Error();
  } catch { return { ...identity, state: "blocked", reason: "document-conflict", decisionId: latest.decisionId }; }
  return { ...identity, state: "approved", decisionId: latest.decisionId };
}

/** Existing sources only. No TicketStore/BulletinStore constructors, migrations,
 * writable SQLite pragmas, Git commands, process probes, ticket claims or launches.
 * A failed/incomplete observation throws: callers retain the last complete list. */
export function scanAutoWaitlist(): AutoWaitlistSnapshot {
  const started = performance.now(), observedAt = new Date().toISOString();
  const check = () => { if (performance.now() - started >= AUTO_SCAN_LIMITS.wallMs) throw new AutoWaitlistError("AUTO_LIMIT"); };
  let db: Database.Database | undefined;
  let ticketsFd: number | undefined;
  let bulletinsFd: number | undefined;
  try {
    const repos = loadReposYaml(), patterns: SensitivePatternSet = loadSensitivePatterns();
    const projects = (Object.keys(AUTO_PROJECTS) as AutoProject[]).map(key => {
      const repo = repos[key];
      if (!repo || repo.prefix !== AUTO_PROJECTS[key]) throw new AutoWaitlistError("AUTO_SOURCE");
      const fd = openArtifactDirectory(repo.path, "ARTIFACT_STALE"); closeSync(fd);
      return { key, prefix: AUTO_PROJECTS[key], canonicalRoot: repo.path };
    });
    if (projects[0]!.canonicalRoot === projects[1]!.canonicalRoot) throw new AutoWaitlistError("AUTO_SOURCE");
    ticketsFd = openArtifactDirectory(getTicketsDir(), "ARTIFACT_STALE");
    bulletinsFd = openArtifactDirectory(join(getBulletinsDir(), "active"), "ARTIFACT_STALE");
    const ticketNames = namesAt(ticketsFd, check).filter(n => /^(?:PAP|PAPC)-\d+\.json$/.test(n));
    const tickets: ReadTicket[] = [], ticketBytes = new Map<string, string>(), aliases = new Map<string, string>();
    for (const name of ticketNames) {
      check(); const bytes = readArtifactFileAt(ticketsFd, name, AUTO_SCAN_LIMITS.ticketBytes, "ARTIFACT_STALE");
      ticketBytes.set(name, digest(bytes));
      const ticket = parseTicket(bytes, name.slice(0, -5), aliases);
      if (ticket) {
        if (!Object.hasOwn(AUTO_PROJECTS, ticket.project) || !ticket.id.startsWith(`${AUTO_PROJECTS[ticket.project as AutoProject]}-`)) throw new AutoWaitlistError("AUTO_SOURCE");
        tickets.push(ticket);
      }
    }
    for (const id of aliases.keys()) {
      const seen = new Set<string>(); let target = id;
      while (aliases.has(target)) {
        if (seen.has(target)) throw new AutoWaitlistError("AUTO_SOURCE");
        seen.add(target); target = aliases.get(target)!;
      }
      if (/^(?:PAP|PAPC)-/.test(target) && !tickets.some(t => t.id === target)) throw new AutoWaitlistError("AUTO_SOURCE");
    }
    const bulletinNames = namesAt(bulletinsFd, check).filter(n => n.endsWith(".md"));
    const bulletinBytes = new Map<string, string>(), blockingBulletins: string[] = [];
    for (const name of bulletinNames) {
      check(); const bytes = readArtifactFileAt(bulletinsFd, name, AUTO_SCAN_LIMITS.bulletinBytes, "ARTIFACT_STALE");
      bulletinBytes.set(name, digest(bytes));
      const bulletin = parseBulletin(new TextDecoder("utf-8", { fatal: true }).decode(bytes), name);
      if (!bulletin || !["active", "resolved"].includes(bulletin.status) || !Array.isArray(bulletin.except)
        || bulletin.except.some(v => typeof v !== "string") || !(bulletin.block === "all" || Array.isArray(bulletin.block) && bulletin.block.every(v => typeof v === "string"))) throw new AutoWaitlistError("AUTO_SOURCE");
      if (bulletin.status === "active" && ["requirements", "builder"].some(team => !bulletin.except.includes(team) && (bulletin.block === "all" || bulletin.block.includes(team)))) {
        if (!/^B-\d+$/.test(bulletin.id)) throw new AutoWaitlistError("AUTO_SOURCE");
        blockingBulletins.push(bulletin.id);
      }
    }
    db = openReadonlyRegistryDatabase(true);
    const registry = db;
    const observations = registry.transaction(() => {
      const workflow = new RegistryWorkflowJournal(registry), output: AutoTicketObservation[] = [];
      for (const ticket of tickets) {
        check();
        const unresolvedDependencies = ticket.blockedBy.filter(id => {
          if (!isCanonicalTicketId(id)) throw new AutoWaitlistError("AUTO_SOURCE");
          const known = tickets.find(t => t.id === id);
          if (known) return known.status !== "done";
          // Cross-project dependencies are observations, not new scan domains.
          try {
            const bytes = readArtifactFileAt(ticketsFd!, `${id}.json`, AUTO_SCAN_LIMITS.ticketBytes, "ARTIFACT_STALE");
            const row = parseTicket(bytes, id);
            ticketBytes.set(`${id}.json`, digest(bytes));
            return row?.status !== "done";
          } catch { return true; }
        });
        // A terminal row without terminal time is still uncertain. PID absence
        // is deliberately not used as proof of release.
        const owners = registry.prepare("SELECT deployment_id FROM deployments WHERE ticket_id = ? AND (status NOT IN ('success', 'failed') OR completed_at IS NULL) ORDER BY deployment_id LIMIT 1001").all(ticket.id) as { deployment_id: string }[];
        if (owners.length > 1000 || owners.some(o => !/^d-[0-9a-f]{6}$/.test(o.deployment_id))) throw new AutoWaitlistError("AUTO_SOURCE");
        let documents: AutoDocumentObservation;
        try { documents = observeDocuments(registry, ticket, repos[ticket.project]!.path, getAiUsageDir(), check); }
        catch (error) { if (error instanceof AutoWaitlistError) throw error; documents = { state: "blocked", reason: "document-conflict" }; }
        const rawTitle = autoPlainText(ticket.title);
        const title = findSensitiveMatch("content", ticket.title, patterns) ? "[title withheld]" : rawTitle;
        output.push({ id: ticket.id, project: ticket.project as AutoProject, title, priority: ticket.priority, status: ticket.status,
          createdAt: ticket.createdAt, ticketSha256: ticket.sha256, archived: ticket.tags.includes("archived"), unresolvedDependencies,
          blockingBulletins: [...blockingBulletins], competingDeployments: owners.map(o => o.deployment_id),
          originalWorkflow: workflow.runs(ticket.project, ticket.id).length > 0 || ticket.doc_refs.some(r => r.type === "workflow"), documents });
      }
      return output;
    })();
    // Detect cooperating writers during the observation. This is not a cross-
    // owner transaction or any substitute for dispatch-time freshness checks.
    if (JSON.stringify(ticketNames) !== JSON.stringify(namesAt(ticketsFd, check).filter(n => /^(?:PAP|PAPC)-\d+\.json$/.test(n)))
      || JSON.stringify(bulletinNames) !== JSON.stringify(namesAt(bulletinsFd, check).filter(n => n.endsWith(".md")))) throw new AutoWaitlistError("AUTO_SOURCE");
    for (const [name, sha] of ticketBytes) { check(); if (digest(readArtifactFileAt(ticketsFd, name, AUTO_SCAN_LIMITS.ticketBytes, "ARTIFACT_STALE")) !== sha) throw new AutoWaitlistError("AUTO_SOURCE"); }
    for (const [name, sha] of bulletinBytes) { check(); if (digest(readArtifactFileAt(bulletinsFd, name, AUTO_SCAN_LIMITS.bulletinBytes, "ARTIFACT_STALE")) !== sha) throw new AutoWaitlistError("AUTO_SOURCE"); }
    check();
    return buildAutoWaitlist({ observedAt, completedAt: new Date().toISOString(), projects, tickets: observations });
  } catch (error) { throw error instanceof AutoWaitlistError ? error : new AutoWaitlistError("AUTO_SOURCE"); }
  finally { db?.close(); if (ticketsFd !== undefined) closeSync(ticketsFd); if (bulletinsFd !== undefined) closeSync(bulletinsFd); }
}
