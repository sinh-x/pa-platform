import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readArtifactFile } from "../artifacts/manifest.js";
import { readProcessFingerprint, withActiveRepositoryRefAdmission, withRepositoryRefAdmission, type RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { MAX_REPOSITORY_TICKET_SLOT_BYTES, preparedRepositoryTicketReservationPath, withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { assertReservationInventory } from "../deploy/execution-custody.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { parseModeCapabilityBinding, modeCapabilityRouteMatches, isModeCapabilitySession, hasModeResources, modeCapabilitySessionMatches } from "../mode-capabilities.js";
import { loadRepoEntry, getBranchPattern } from "../repos.js";
import { readTicketWorkflow } from "../workflows/public.js";
import type { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import { handoffMaterializedLink } from "../tickets/handoff-intent.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest, integer, object, strictJson, text } from "../workflows/contracts.js";
import type { HandoffBranchIntent, LocalHandoffReviewSubject } from "./handoff-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha } from "./handoff-contract.js";
import type { LocalEffectState, LocalReviewEligibility, NativeHandoffReviewCaller } from "./handoff-review.js";
import { RegistryHandoffGitOwner } from "./handoff-git.js";
import { assertHandoffTracking } from "./handoff-publication.js";
import { documentDestination, documentReject } from "./package-contract.js";
import { validateDocumentBytes } from "./package-tools.js";
import { documentCompletedOperation, documentDecisionRecords, documentPending, documentRetiredSubjects, documentRevokedDecisionIds } from "../registry/documents.js";

/** Fixed local Git observation, never fetch, checkout or dirt/index mutation. */
function git(root: string, args: string[], absent?: number): string | null {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
      { cwd: root, env: { PATH: process.env.PATH, HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 65536 }).trim();
  } catch (error) { if (absent !== undefined && (error as { status?: number }).status === absent) return null; return documentReject("DOCUMENT_UNCERTAIN"); }
}
function storage(root: string, relative: string): void {
  let path = join(root, ".git");
  for (const [i, part] of relative.split("/").entries()) {
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || realpathSync(path) !== path || (i < relative.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) documentReject("DOCUMENT_SOURCE");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
export function observeLocalHandoffDevelop(intent: HandoffBranchIntent): string {
  const root = intent.repository.root, repo = loadRepoEntry(intent.repository.key);
  if (!repo || repo.path !== root || getBranchPattern(repo) !== "feature/<ticket>-<topic>" || (repo.developBranch ?? "develop") !== "develop") documentReject("DOCUMENT_AUTHORITY");
  storage(root, "refs/heads/develop"); storage(root, "packed-refs");
  if (git(root, ["rev-parse", "--show-ref-format"]) !== "files" || git(root, ["rev-parse", "--show-object-format"]) !== "sha1"
    || git(root, ["symbolic-ref", "--quiet", "refs/heads/develop"], 1) !== null) documentReject("DOCUMENT_SOURCE");
  const sha = git(root, ["show-ref", "--verify", "--hash", "refs/heads/develop"]);
  if (!sha || !/^[a-f0-9]{40}$/.test(sha) || git(root, ["cat-file", "-t", sha]) !== "commit") documentReject("DOCUMENT_SOURCE");
  return sha;
}
/** Strengthen the existing opaque exclusion for local handoff only. Inventory
 * observation never reserves, reconciles, fsyncs or reacquires capacity locks. */
export function assertLocalHandoffRepository(intent: HandoffBranchIntent, admission: RepositoryRefAdmission): void {
  withActiveRepositoryRefAdmission(admission, intent.repository.root, identity => {
    if (identity !== intent.repository.physicalIdentitySha256) documentReject("DOCUMENT_STALE");
    const directory = dirname(preparedRepositoryTicketReservationPath(intent.repository.root, intent.ticket));
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || realpathSync(directory) !== directory || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700) documentReject("DOCUMENT_SOURCE");
    const paths = readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => join(directory, name));
    const reservations = assertReservationInventory(paths.map(path => {
      const stat = lstatSync(path);
      if (stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) documentReject("DOCUMENT_SOURCE");
      return strictJson(readReviewEvidenceFile(path, MAX_REPOSITORY_TICKET_SLOT_BYTES, "local handoff custody"), MAX_REPOSITORY_TICKET_SLOT_BYTES);
    }));
    reservations.forEach((row, index) => {
      if (row.repoKey !== intent.repository.key || row.repoRoot !== intent.repository.root || paths[index] !== preparedRepositoryTicketReservationPath(intent.repository.root, row.ticket)
        || row.ticket === intent.ticket || !["idle-ready", "settled-retained"].includes(row.occupancy)
        || row.custody.state !== "idle" || row.custody.holder !== null || row.custody.inFlightOperation !== null) documentReject("DOCUMENT_CONFLICT");
    });
  });
}
export function withLocalHandoffRepository<T>(intent: HandoffBranchIntent, run: (admission: RepositoryRefAdmission) => T): T {
  return withRepositoryRefTicketExclusion(intent.repository.key, intent.repository.root, exclusion =>
    withRepositoryRefAdmission(intent.repository.root, exclusion, (_identity, admission) => {
      assertLocalHandoffRepository(intent, admission);
      const result = run(admission);
      assertLocalHandoffRepository(intent, admission);
      return result;
    }));
}
export function assertLocalHandoffPlan(tickets: TicketStore, subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): void {
  const plan = tickets.inspectHandoffWithIntent(subject.origin.planIdentity), ticket = tickets.get(intent.ticket);
  if (!plan?.complete || plan.record.change.kind !== "plan" || handoffBranchIntentSha(plan.record.change.intent) !== handoffBranchIntentSha(intent)) documentReject("DOCUMENT_AUTHORITY");
  if (!ticket || ticket.project !== intent.repository.key || !isDeepStrictEqual(ticket.linkedBranches, plan.record.after.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
}
/** Recheck bytes against the worker-verified presentation at the serialized
 * boundary. Rendering stays outside locks; no synchronous renderer substitute. */
export function assertLocalHandoffDelivery(journal: RegistryHandoffReviewJournal, root: string, subject: LocalHandoffReviewSubject, presentation: Record<string, unknown>): void {
  const { document } = journal.subject(handoffReviewSubjectSha(subject));
  document.members.forEach(member => validateDocumentBytes(member, journal.documents.snapshot(member.sha256)));
  if (presentation.deliverySha256 !== subject.deliverySha256 || presentation.subjectSha256 !== subject.documentSubjectSha256 || !Array.isArray(presentation.outputs)) documentReject("DOCUMENT_SOURCE");
  const folder = join(root, "agent-teams/requirements/artifacts/presentations", subject.documentSubjectSha256, subject.deliverySha256);
  for (const value of presentation.outputs) {
    const out = object(value, ["path", "sha256", "bytes"]);
    if (typeof out.path !== "string" || !/^(?:index\.html|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(out.path)) documentReject("DOCUMENT_SOURCE");
    const bytes = readArtifactFile(join(folder, out.path), 64 * 1024 * 1024, "ARTIFACT_STALE");
    if (digest(bytes) !== out.sha256 || bytes.length !== out.bytes) documentReject("DOCUMENT_STALE");
  }
  if (digest(readArtifactFile(join(folder, "manifest.json"), 64 * 1024 * 1024, "ARTIFACT_STALE")) !== presentation.manifestSha256) documentReject("DOCUMENT_STALE");
}
function deploymentState(db: Database.Database, id: string) {
  const raw = db.prepare("SELECT status,pid,mode_capability_binding FROM deployments WHERE deployment_id=?").get(id);
  if (!raw) return null;
  const row = object(raw, ["status", "pid", "mode_capability_binding"]);
  return { status: text(row.status, undefined, 32), pid: row.pid === null ? null : integer(row.pid, 1, 2147483647),
    binding: row.mode_capability_binding === null ? null : text(row.mode_capability_binding, undefined, 65536) };
}
function assertOriginEnded(db: Database.Database, subject: LocalHandoffReviewSubject): void {
  const origin = deploymentState(db, subject.origin.deploymentId);
  const terminals = db.prepare("SELECT event,status,fallback FROM registry_events WHERE deployment_id=? AND event IN ('completed','crashed') LIMIT 3").all(subject.origin.deploymentId).map(raw => {
    const row = object(raw, ["event", "status", "fallback"]);
    return { event: text(row.event, /^(?:completed|crashed)$/), status: row.status === null ? null : text(row.status, undefined, 32), fallback: row.fallback === null ? null : integer(row.fallback, 0, 1) };
  });
  if (!origin || !["success", "failed", "partial", "crashed"].includes(origin.status) || terminals.length !== 1 || terminals[0]!.fallback
    || (terminals[0]!.event === "completed" ? (terminals[0]!.status ?? "success") !== origin.status : origin.status !== "crashed")
    || !origin.pid || readProcessFingerprint(origin.pid)) documentReject("DOCUMENT_UNCERTAIN");
  let dead = false;
  try { process.kill(origin.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!dead) documentReject("DOCUMENT_UNCERTAIN");
}
function ticketAssociations(db: Database.Database, ticket: string): string[] {
  const rows = db.prepare("SELECT deployment_id FROM deployments WHERE ticket_id=? UNION SELECT deployment_id FROM registry_events WHERE ticket_id=? LIMIT 1025").all(ticket, ticket);
  if (rows.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
  return rows.map(row => text(object(row, ["deployment_id"]).deployment_id, /^d-[a-f0-9]{6}$/));
}
/** Historical selection proof for the sole possible fresh continuation, not
 * authentication of that process and never an effect grant. */
function assertReviewOwners(db: Database.Database, subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): void {
  const others = ticketAssociations(db, intent.ticket).filter(id => id !== subject.origin.deploymentId);
  if (!others.length) return;
  if (others.length !== 1) documentReject("DOCUMENT_CONFLICT");
  assertOriginEnded(db, subject);
  const fields = ["event", "team", "mode", "runtime", "binary", "note", "repo", "repo_root", "worktree_root", "ticket_id", "mode_capability_binding", "rogue_one", "builder_authority", "treehouse_path", "ticket_slot_id", "repository_permit", "parent_deployment_id", "resumed_from_deployment_id", "fallback", "review_checkout", "ticket_worktree_selection"];
  const rows = db.prepare(`SELECT ${fields.join(",")} FROM registry_events WHERE deployment_id=? AND event IN ('started','ticket-associated') LIMIT 3`).all(others[0]);
  if (rows.length !== 1) documentReject("DOCUMENT_CONFLICT");
  const start = object(rows[0], fields), current = deploymentState(db, others[0]!);
  if (start.event !== "started" || !isModeCapabilitySession(start.note) || start.runtime !== "pi" || start.binary !== "ppa"
    || start.repo !== intent.repository.root || start.repo_root !== intent.repository.root || start.worktree_root !== intent.repository.root || start.ticket_id !== intent.ticket
    || fields.slice(11).some(field => start[field]) || current?.status !== "running" || typeof start.mode_capability_binding !== "string" || start.mode_capability_binding !== current.binding) documentReject("DOCUMENT_CONFLICT");
  const selected = parseModeCapabilityBinding(strictJson(Buffer.from(start.mode_capability_binding), 65536));
  if (JSON.stringify(selected) !== start.mode_capability_binding || !modeCapabilitySessionMatches(selected, start.note) || !modeCapabilityRouteMatches(selected, start.team, start.mode)
    || hasModeResources(selected) && selected.repoKey !== intent.repository.key
    || !["document.handoff", "document.package", "document.local-review"].every(id => selected.policy.allow.includes(id))) documentReject("DOCUMENT_AUTHORITY");
  const originalRow = db.prepare("SELECT mode_capability_binding FROM registry_events WHERE deployment_id=? AND event='started'").get(subject.origin.deploymentId);
  const originalRaw = text(object(originalRow, ["mode_capability_binding"]).mode_capability_binding, undefined, 65536);
  const original = parseModeCapabilityBinding(strictJson(Buffer.from(originalRaw), 65536));
  // A fresh continuation does not silently migrate a historical/public route.
  if (selected.schemaVersion !== original.schemaVersion) documentReject("DOCUMENT_AUTHORITY");
}

/** Exact exception for ONE saved origin, not a relaxation of intake/v1 guards.
 * Called under repository -> ticket exclusion for every remaining finite write.
 * The native host still authenticates the CURRENT process/session independently. */
export function assertLocalHandoffCaller(db: Database.Database, subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, caller: NativeHandoffReviewCaller): void {
  if (caller.ticket !== intent.ticket || caller.repoKey !== intent.repository.key || caller.repoRoot !== intent.repository.root) documentReject("DOCUMENT_AUTHORITY");
  const same = caller.deploymentId === subject.origin.deploymentId;
  if (same && (caller.sessionId !== subject.origin.sessionId || caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256)) documentReject("DOCUMENT_AUTHORITY");
  const associations = ticketAssociations(db, intent.ticket);
  if (associations.some(id => id !== caller.deploymentId && id !== subject.origin.deploymentId)) documentReject("DOCUMENT_CONFLICT");
  if (!same) {
    assertReviewOwners(db, subject, intent);
    assertOriginEnded(db, subject);
    const current = deploymentState(db, caller.deploymentId);
    if (current?.status !== "running" || !current.binding || digest(current.binding) !== caller.selectionSha256) documentReject("DOCUMENT_AUTHORITY");
    const binding = parseModeCapabilityBinding(strictJson(Buffer.from(current.binding), 65536));
    if (JSON.stringify(binding) !== current.binding || !["document.handoff", "document.package", "document.local-review"].every(id => binding.policy.allow.includes(id))) documentReject("DOCUMENT_AUTHORITY");
  }
  if (readTicketWorkflow(intent.ticket)) documentReject("DOCUMENT_CONFLICT");
}

export function inspectLocalHandoffEffects(db: Database.Database, tickets: TicketStore, journal: RegistryHandoffReviewJournal, root: string,
  subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, decisionId: string, presentation: Record<string, unknown>) {
  const sha = handoffReviewSubjectSha(subject), { document } = journal.subject(sha);
  const publish: LocalEffectState = { ...journal.effect(sha, decisionId, "publish"), verified: false };
  const branchRef: LocalEffectState = { ...journal.branchEffect(sha, decisionId), verified: false };
  const queue: LocalEffectState = { ...journal.effect(sha, decisionId, "queue"), verified: false };
  try {
    const previous = document.predecessor ? journal.documents.subject(document.predecessor) : undefined;
    if (publish.completed && new TicketPackagePublication(tickets, root).observe(document, previous) === "complete") {
      assertLocalHandoffDelivery(journal, root, subject, presentation);
      assertHandoffTracking(journal, tickets, root, sha, decisionId); publish.verified = true;
    }
  } catch { /* Observation failure is explicit conflict-or-unknown, never absence. */ }
  if (branchRef.completed) {
    try { withLocalHandoffRepository(intent, admission => new RegistryHandoffGitOwner(db, false).withRepository(intent, branchRef.operationId, port => tickets.withWorkflowTransaction(() => {
      const physical = port.observe(), ticket = tickets.get(intent.ticket), link = ticket?.linkedBranches[0];
      const head = intent.action === "reuse" ? intent.lineage!.observedHeadSha : intent.base.sha;
      if (physical.state !== "present" || physical.headSha !== head || !port.isAncestor(intent.base.sha, head)
        || !(physical.owner.kind === "operation" && physical.owner.id === branchRef.operationId || physical.owner.kind === "lineage" && intent.action === "reuse" && physical.owner.sha256 === intent.lineage!.operationSha256)
        || ticket?.linkedBranches.length !== 1 || !link || link.repo !== intent.repository.key || link.branch !== intent.branch || link.state !== "materialized" || link.baseSha !== intent.base.sha || link.headSha !== head || link.sha !== head) documentReject("DOCUMENT_CONFLICT");
      const plan = tickets.inspectHandoffWithIntent(subject.origin.planIdentity);
      if (!plan?.complete || !isDeepStrictEqual(ticket.linkedBranches, [handoffMaterializedLink(plan.record, intent, head)])) documentReject("DOCUMENT_CONFLICT");
      const materialization = tickets.inspectHandoffWithIntent({ scope: sha, requestId: `branch-link-${branchRef.operationId}` });
      if (materialization ? !materialization.complete || materialization.record.actor !== "documents/handoff" || !isDeepStrictEqual(materialization.record.change, { kind: "materialize", planKey: plan.record.key, operationId: branchRef.operationId, headSha: head })
        || !isDeepStrictEqual(materialization.record.before.linkedBranches, plan.record.after.linkedBranches) || !isDeepStrictEqual(materialization.record.after.linkedBranches, ticket.linkedBranches)
        : !isDeepStrictEqual(plan.record.after.linkedBranches, ticket.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
      branchRef.verified = true;
    }), undefined, admission)); }
    catch { /* Retained custody or changed physical evidence is not completion. */ }
  }
  const ticket = tickets.get(intent.ticket);
  queue.verified = queue.completed && publish.verified && branchRef.verified && ticket?.status === "pending-implementation" && ticket.assignee === "builder/team-manager";
  for (const effect of [publish, branchRef, queue]) effect.state = effect.verified ? "verified" : effect.completed ? "conflict-or-unknown" : effect.started ? "partial" : "not-started";
  return { publish, branchRef, queue };
}

export function assertLocalHandoffBranchTarget(db: Database.Database, intent: HandoffBranchIntent, admission?: RepositoryRefAdmission): void {
  if (intent.action === "reuse") {
    if (!admission) documentReject("DOCUMENT_UNCERTAIN");
    return new RegistryHandoffGitOwner(db, false).withRepository(intent, intent.lineage!.operationSha256, port => {
      const value = port.observe();
      if (value.state !== "present" || value.owner.kind !== "lineage" || !port.isAncestor(intent.base.sha, value.headSha)) documentReject("DOCUMENT_CONFLICT");
    }, undefined, admission);
  }
  const ref = `refs/heads/${intent.branch}`; storage(intent.repository.root, ref); storage(intent.repository.root, `logs/${ref}`); storage(intent.repository.root, "packed-refs");
  if (git(intent.repository.root, ["show-ref", "--exists", ref], 2) !== null) documentReject("DOCUMENT_CONFLICT");
  try { lstatSync(join(intent.repository.root, ".git", "logs", ref)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  documentReject("DOCUMENT_CONFLICT");
}

export function localHandoffEligibility(causes: readonly string[]): LocalReviewEligibility {
  const owners: Readonly<Record<string, string>> = { "lifecycle-assignment": "ticket-lifecycle", "primary-predecessor": "ticket-document-references",
    "source-delivery-integrity": "reader-publication", "publication-target": "publication", "plan-link": "native-planning",
    "pending-native-effects": "native-operation-owner", "branch-target": "repository-ref", "repository-custody": "repository-custody",
    "local-develop": "repository-ref", "local-develop-drift": "native-refresh" };
  return { status: causes.length ? "blocked" : "eligible", causes, owners: causes.map(cause => ({ cause, owner: owners[cause] ?? "native-owner" })) };
}

/** All independent causes survive one failed check. Point-in-time observation,
 * never lifecycle/ref repair or authority. Call inside repository/ticket locks. */
export function inspectLocalHandoffEligibility(db: Database.Database, tickets: TicketStore, journal: RegistryHandoffReviewJournal, root: string,
  subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, presentation: Record<string, unknown>, admission?: RepositoryRefAdmission): LocalReviewEligibility {
  const sha = handoffReviewSubjectSha(subject), { document } = journal.subject(sha), ticket = tickets.get(intent.ticket), causes: string[] = [];
  const check = (cause: string, run: () => void) => { try { run(); } catch { causes.push(cause); } };
  if (!ticket || ![["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]].some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) causes.push("lifecycle-assignment");
  let predecessor: typeof document | undefined;
  check("primary-predecessor", () => {
    const primaries = ticket?.doc_refs.filter(ref => ref.primary) ?? [];
    if (!ticket) documentReject("DOCUMENT_SOURCE");
    if (document.predecessor) {
      predecessor = journal.documents.subject(document.predecessor);
      if (predecessor.ticket !== document.ticket || !isDeepStrictEqual(predecessor.repository, document.repository) || predecessor.packageId !== document.packageId || predecessor.revision >= document.revision) documentReject("DOCUMENT_AUTHORITY");
      const events = journal.documents.events(document.repository.key, document.ticket), native = journal.completedPublication(document.predecessor), latest = documentDecisionRecords(events, document.predecessor).at(-1);
      if (documentPending(events).length || documentRetiredSubjects(events).has(document.predecessor) || !native && (!documentCompletedOperation(events, document.predecessor, "publish") || !latest || latest.outcome !== "approved" || documentRevokedDecisionIds(events).has(latest.decisionId)
        || "scope" in latest && latest.scope === "content" || "documentScope" in latest && latest.documentScope !== "publish-and-queue")) documentReject("DOCUMENT_AUTHORITY");
      for (const member of predecessor.members) {
        const path = documentDestination(predecessor, member), refs = ticket.doc_refs.filter(ref => ref.path === path), raw = journal.documents.snapshot(member.sha256);
        validateDocumentBytes(member, raw);
        if (refs.length !== 1 || refs[0]!.type !== (member.role === "requirements" ? "requirements" : member.role === "uat" ? "uat" : "attachment") || member.role !== "requirements" && refs[0]!.primary
          || !readArtifactFile(join(root, path), 8 * 1024 * 1024, "ARTIFACT_STALE").equals(raw)) documentReject("DOCUMENT_CONFLICT");
      }
      if (native) assertHandoffTracking(journal, tickets, root, native.subjectSha256, native.decisionId);
      const oldPath = documentDestination(predecessor, predecessor.members.find(member => member.role === "requirements")!);
      if (primaries.length !== 1 || primaries[0]!.type !== "requirements" || primaries[0]!.path !== oldPath) documentReject("DOCUMENT_CONFLICT");
    } else if (primaries.length) documentReject("DOCUMENT_CONFLICT");
  });
  check("source-delivery-integrity", () => assertLocalHandoffDelivery(journal, root, subject, presentation));
  check("publication-target", () => {
    const state = new TicketPackagePublication(tickets, root).observe(document, predecessor);
    if (state !== "absent") documentReject("DOCUMENT_CONFLICT");
  });
  check("plan-link", () => assertLocalHandoffPlan(tickets, subject, intent));
  check("pending-native-effects", () => {
    journal.assertSettled(sha); tickets.assertHandoffSettled(intent.ticket); assertReviewOwners(db, subject, intent);
    for (const event of journal.events(sha)) if (event.kind === "requested" && event.request.operation === "capture") {
      for (const operation of ["publish", "queue"] as const) if (journal.effect(sha, event.request.decisionId, operation).started) documentReject("DOCUMENT_CONFLICT");
      if (journal.branchEffect(sha, event.request.decisionId).started) documentReject("DOCUMENT_CONFLICT");
    }
    if (readTicketWorkflow(intent.ticket)) documentReject("DOCUMENT_CONFLICT");
  });
  check("branch-target", () => assertLocalHandoffBranchTarget(db, intent, admission));
  if (!admission) causes.push("repository-custody");
  return localHandoffEligibility(causes);
}
