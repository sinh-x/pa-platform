import type Database from "better-sqlite3";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MODE_CAPABILITY_SESSION, modeCapabilityRouteMatches, modeCapabilityActor, parseModeCapabilityBinding } from "../mode-capabilities.js";
import { getAiUsageDir, getTicketsDir } from "../paths.js";
import { openDurableRegistryDatabase, openReadonlyRegistryDatabase } from "../registry/db.js";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { TicketStore } from "../tickets/store.js";
import { digest, object, strictJson, text } from "../workflows/contracts.js";
import { handoffBranchIntentSha, parseLocalReviewRequest, type HandoffBranchIntent, type LocalHandoffReviewSubject } from "./handoff-contract.js";
import { nativeHandoffPlanIdentity } from "./handoff-planning.js";
import { LocalHandoffReviewService, type LocalHandoffReviewHooks, type LocalReviewBoundaryResult } from "./handoff-review.js";
import { assertLocalHandoffCaller, inspectLocalHandoffEffects, inspectLocalHandoffEligibility, localHandoffEligibility, observeLocalHandoffDevelop, withLocalHandoffRepository } from "./handoff-preflight.js";
import { handoffReviewSubjectSha } from "./handoff-contract.js";
import { DocumentPackageError, documentReject } from "./package-contract.js";

/** Saved native provenance only. It neither authenticates a local process nor
 * represents an ended origin as a running caller. Never consult caller actor,
 * deployment environment, current session or newly edited configuration. */
export function verifyLocalReviewOrigin(db: Database.Database, tickets: TicketStore, subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): void {
  const fields = ["event", "note", "runtime", "binary", "team", "mode", "repo", "repo_root", "worktree_root", "rogue_one", "builder_authority", "treehouse_path", "ticket_slot_id", "repository_permit", "parent_deployment_id", "resumed_from_deployment_id", "fallback", "review_checkout", "ticket_worktree_selection", "mode_capability_binding", "ticket_id", "previous_ticket_id", "actor"];
  const rows = db.prepare(`SELECT ${fields.join(",")} FROM registry_events WHERE deployment_id=? ORDER BY id LIMIT 1025`).all(subject.origin.deploymentId);
  if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
  const events = rows.map(value => object(value, fields));
  const starts = events.filter(e => e.event === "started"), start = starts[0];
  if (starts.length !== 1 || !start || start.note !== MODE_CAPABILITY_SESSION || start.runtime !== "pi" || start.binary !== "ppa"
    || !["requirements", "analyst"].includes(String(start.team)) || start.mode !== "analyze" || start.repo !== intent.repository.root
    || start.repo_root !== intent.repository.root || start.worktree_root !== intent.repository.root
    || start.rogue_one || start.builder_authority || start.treehouse_path || start.ticket_slot_id || start.repository_permit
    || start.parent_deployment_id || start.resumed_from_deployment_id || start.fallback || start.review_checkout || start.ticket_worktree_selection) documentReject("DOCUMENT_AUTHORITY");
  let raw: string, binding: ReturnType<typeof parseModeCapabilityBinding>;
  try {
    raw = text(start.mode_capability_binding, undefined, 65536);
    binding = parseModeCapabilityBinding(strictJson(Buffer.from(raw), 65536));
  } catch { return documentReject("DOCUMENT_AUTHORITY"); }
  if (JSON.stringify(binding) !== raw || !modeCapabilityRouteMatches(binding, start.team, start.mode)
    || binding.schemaVersion === "pa-mode-capability-binding/v2" && binding.repoKey !== intent.repository.key || digest(raw) !== subject.selectionSha256
    || !["document.local-review", "document.handoff", "document.package"].every(id => binding.policy.allow.includes(id))) documentReject("DOCUMENT_AUTHORITY");
  // Original association may be retained after completion. Subsequent current
  // custody is deliberately NOT inferred from this historical proof.
  let associated = start.ticket_id || null;
  const edges = events.filter(e => e.event === "ticket-associated");
  if (edges.length > 1) documentReject("DOCUMENT_AUTHORITY");
  for (const edge of edges) {
    if (associated !== null || edge.previous_ticket_id || edge.actor !== modeCapabilityActor(binding) || edge.ticket_id !== intent.ticket) documentReject("DOCUMENT_AUTHORITY");
    associated = edge.ticket_id;
  }
  if (associated !== intent.ticket) documentReject("DOCUMENT_AUTHORITY");
  const originCoordinates = { identitySha256: subject.callerIdentitySha256, selectionSha256: subject.selectionSha256,
    deploymentId: subject.origin.deploymentId, sessionId: subject.origin.sessionId, repoKey: intent.repository.key, repoRoot: intent.repository.root, ticket: intent.ticket };
  if (!isDeepStrictEqual(nativeHandoffPlanIdentity(originCoordinates, intent.requestId), subject.origin.planIdentity)) documentReject("DOCUMENT_AUTHORITY");
  const plan = tickets.inspectHandoffWithIntent(subject.origin.planIdentity);
  if (!plan?.complete || plan.record.actor !== modeCapabilityActor(binding) || plan.record.change.kind !== "plan"
    || handoffBranchIntentSha(plan.record.change.intent) !== handoffBranchIntentSha(intent)
    || plan.record.after.id !== intent.ticket || plan.record.after.project !== intent.repository.key
    || subject.callerIdentitySha256 !== intent.callerIdentitySha256) documentReject("DOCUMENT_AUTHORITY");
}

export function localHandoffReviewHooks(db: Database.Database, tickets: TicketStore, journal: RegistryHandoffReviewJournal, artifactRoot: string): LocalHandoffReviewHooks {
  const assertOrigin = (subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent) => verifyLocalReviewOrigin(db, tickets, subject, intent);
  const inspect: NonNullable<LocalHandoffReviewHooks["inspectEligibility"]> = (subject, intent, presentation) => {
    let entered = false;
    try { return withLocalHandoffRepository(intent, admission => { entered = true; return tickets.withWorkflowTransaction(() => {
      assertOrigin(subject, intent);
      const eligibility = inspectLocalHandoffEligibility(db, tickets, journal, artifactRoot, subject, intent, presentation, admission), causes = [...eligibility.causes];
      if (!journal.events(handoffReviewSubjectSha(subject)).some(event => event.kind === "issued" && event.decision.outcome === "approved")) {
        try { if (observeLocalHandoffDevelop(intent) !== intent.base.observedDevelopSha) causes.push("local-develop-drift"); }
        catch { causes.push("local-develop"); }
      }
      return localHandoffEligibility(causes);
    }); }); }
    catch (error) {
      if (entered) throw error;
      return tickets.withWorkflowTransaction(() => inspectLocalHandoffEligibility(db, tickets, journal, artifactRoot, subject, intent, presentation));
    }
  };
  return { assertOrigin, inspectEligibility: inspect,
    inspectEffects: (subject, intent, decisionId, presentation) => inspectLocalHandoffEffects(db, tickets, journal, artifactRoot, subject, intent, decisionId, presentation),
    assertEffectCaller(subject, intent, caller) { assertOrigin(subject, intent); assertLocalHandoffCaller(db, subject, intent, caller); },
    withEffectBoundary(subject, intent, run) { return withLocalHandoffRepository(intent, admission => tickets.withWorkflowTransaction(() => { assertOrigin(subject, intent); return run(admission); })); },
    withApprovalBoundary<T>(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, run: () => T, presentation: Record<string, unknown>, disposition: "observe" | "settle" = "settle"): LocalReviewBoundaryResult<T> {
      let entered = false;
      try { return withLocalHandoffRepository(intent, admission => { entered = true; return tickets.withWorkflowTransaction(() => journal.transaction(() => {
        assertOrigin(subject, intent);
        const sha = handoffReviewSubjectSha(subject), events = journal.events(sha), previous = events.find(e => e.kind === "stale");
        if (previous?.kind === "stale") return { status: "stale", ...previous.stale };
        let current: string;
        try { current = observeLocalHandoffDevelop(intent); }
        catch {
          const eligibility = inspectLocalHandoffEligibility(db, tickets, journal, artifactRoot, subject, intent, presentation, admission);
          return { status: "blocked", eligibility: localHandoffEligibility([...eligibility.causes, "local-develop"]) };
        }
        if (current !== intent.base.observedDevelopSha) {
          const last = events.at(-1);
          return { status: "stale", ...(disposition === "settle" ? journal.markStale(sha, current) : {
            requestKey: last?.kind === "requested" ? last.request.requestKey : null, oldDevelopSha: intent.base.observedDevelopSha, newDevelopSha: current, observedAt: new Date().toISOString(),
          }) };
        }
        const eligibility = inspectLocalHandoffEligibility(db, tickets, journal, artifactRoot, subject, intent, presentation, admission);
        if (eligibility.status !== "eligible") return { status: "blocked", eligibility };
        return { status: "current", value: run(), developObservation: { ref: "refs/heads/develop", sha: current, observedAt: new Date().toISOString(), remoteFreshness: "not-established" } };
      })); }); }
      catch (error) {
        if (entered) throw error;
        return { status: "blocked", eligibility: tickets.withWorkflowTransaction(() =>
          inspectLocalHandoffEligibility(db, tickets, journal, artifactRoot, subject, intent, presentation)) };
      }
    },
  };
}

function existingDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) documentReject("DOCUMENT_SOURCE");
}
/** Production CLI/loopback dispatcher. No transport, store initialization,
 * arbitrary file route, native-session impersonation or dependent effects. */
export async function executeLocalReview(raw: string): Promise<Record<string, unknown>> {
  // Parse before any I/O. Strict JSON rejects duplicate decoded keys/UTF-8/depth.
  const request = parseLocalReviewRequest(raw);
  try {
    const db = request.action === "show" ? openReadonlyRegistryDatabase(true) : openDurableRegistryDatabase();
    try {
      const journal = new RegistryHandoffReviewJournal(db, false);
      const { subject, intent } = journal.subject(request.subjectSha256);
      if (subject.schemaVersion !== "pa-handoff-review/v2") documentReject("DOCUMENT_AUTHORITY");
      const artifactRoot = getAiUsageDir(), ticketRoot = getTicketsDir();
      existingDirectory(artifactRoot); existingDirectory(ticketRoot);
      const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
      if (inside(intent.repository.root, artifactRoot) || inside(join(artifactRoot, "agent-teams/requirements/artifacts"), intent.repository.root)) documentReject("DOCUMENT_AUTHORITY");
      // Constructor sees an existing-only directory. Review writes only its
      // journal; TicketStore is used for original intent verification/mutexes.
      const tickets = new TicketStore(ticketRoot);
      const service = new LocalHandoffReviewService(journal, { artifactRoot, tickets, ...localHandoffReviewHooks(db, tickets, journal, artifactRoot) });
      const result = await service.execute(request);
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) documentReject("DOCUMENT_UNAVAILABLE");
      return result;
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof DocumentPackageError) throw error;
    // SQLite/filesystem/plan parser details are private, never public prose.
    throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
  }
}
