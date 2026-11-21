import type Database from "better-sqlite3";
import type { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import type { RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { join } from "node:path";
import { readArtifactFile } from "../artifacts/manifest.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest, object, strictJson } from "../workflows/contracts.js";
import { assertLocalHandoffPlan, assertLocalHandoffRepository } from "./handoff-preflight.js";
import { documentCompletedOperation, documentDecisionRecords, documentPending, documentRetiredSubjects, documentRevokedDecisionIds } from "../registry/documents.js";
import { RegistryHandoffBranchJournal, handoffBranchOperationId } from "./handoff-branch.js";
import { completeNativeHandoffBranch } from "./handoff-native-branch.js";
import { HandoffReviewService } from "./handoff-review.js";
import { immutableFile } from "./confirmation-record.js";
import { documentDestination, documentReject, type DocumentPackage } from "./package-contract.js";
import { readDocumentSources, validateDocumentBytes } from "./package-tools.js";
import type { ContentPublicationHost } from "./content-publication.js";
import { DOCUMENT_READER_LIMITS } from "./reader.js";
import { inspectFullDocumentReader } from "./reader-publication.js";

export function handoffApprovalTracking(journal: RegistryHandoffReviewJournal, root: string, sha: string, decisionId: string) {
  const { subject, intent, document } = journal.publicationSubject(sha), events = journal.events(sha);
  const request = events.find(e => e.kind === "requested" && e.request.decisionId === decisionId);
  const decision = request?.kind === "requested" ? events.find(e => e.kind === "issued" && e.decision.requestKey === request.request.requestKey) : undefined;
  if (request?.kind !== "requested" || request.request.operation !== "capture" || decision?.kind !== "issued" || decision.decision.outcome !== "approved") documentReject("DOCUMENT_AUTHORITY");
  const folder = `agent-teams/requirements/artifacts/handoff-approvals/${document.ticket}`, name = `${decisionId}.json`;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: subject.schemaVersion === "pa-content-review-subject/v1" ? "pa-content-publication-tracking/v1" : "pa-handoff-approval/v1", subjectSha256: sha, subject, intent, request: request.request,
    ...(subject.schemaVersion === "pa-content-review-subject/v1" ? { publicationAuthority: events.find(e => e.kind === "publication-authorized") } : {}),
    decision: decision.decision, authority: "derived-tracking-only-native-handoff-registry-required", productAcceptance: false }, null, 2) + "\n");
  const deliveryFolder = `agent-teams/requirements/artifacts/presentations/${subject.documentSubjectSha256}/${subject.deliverySha256}`;
  const paths = [`${folder}/${name}`, `${deliveryFolder}/manifest.json`, `${deliveryFolder}/index.html`];
  if (subject.schemaVersion !== "pa-handoff-review/v1") {
    const manifest = strictJson(readArtifactFile(join(root, deliveryFolder, "manifest.json"), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE"), DOCUMENT_READER_LIMITS.outputBytes);
    const outputs = object(manifest, ["schemaVersion", "deliverySha256", "subjectSha256", "revision", "effects", "renderer", "members", "outputs", "generationState", "observation"]).outputs;
    if (!Array.isArray(outputs) || outputs.length !== document.members.length * 2 + 1) documentReject("DOCUMENT_SOURCE");
    for (const output of outputs) {
      const out = object(output, ["path", "sha256", "bytes"]);
      if (typeof out.path !== "string" || !/^(?:index\.html|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(out.path)) documentReject("DOCUMENT_SOURCE");
      const path = `${deliveryFolder}/${out.path}`; if (!paths.includes(path)) paths.push(path);
    }
  }
  return { folder, name, bytes, paths };
}
export function assertHandoffTracking(journal: RegistryHandoffReviewJournal, tickets: TicketStore, root: string, sha: string, decisionId: string): void {
  const { document } = journal.publicationSubject(sha), tracking = handoffApprovalTracking(journal, root, sha, decisionId);
  if (!readArtifactFile(join(root, tracking.paths[0]!), 65536, "ARTIFACT_STALE").equals(tracking.bytes)) documentReject("DOCUMENT_CONFLICT");
  const ticket = tickets.get(document.ticket);
  if (!ticket || ticket.project !== document.repository.key || tracking.paths.some(path => {
    const refs = ticket.doc_refs.filter(ref => ref.path === path); return refs.length !== 1 || refs[0]!.type !== "attachment" || refs[0]!.primary;
  })) documentReject("DOCUMENT_CONFLICT");
}

/** Explicit NEW-provenance consumer. Old document receipts/scopes/intents stay
 * untouched. Internal source integration, not a selected production capability.
 * No private legacy approved() bypass or forged confirmation event is used. */
export class HandoffPublicationService {
  private readonly publication: TicketPackagePublication;
  constructor(private readonly db: Database.Database, readonly review: HandoffReviewService,
    private readonly planIdentity: { scope: string; requestId: string }, private readonly afterPersist?: (stage: "intent" | "tracking" | "publication" | "complete" | "queue") => void) {
    this.publication = new TicketPackagePublication(review.host.tickets, review.host.artifactRoot);
  }
  private caller(sha: string, admission?: RepositoryRefAdmission): void {
    const { subject, intent } = this.review.journal.subject(sha), caller = this.review.host.authenticate();
    if (subject.schemaVersion === "pa-handoff-review/v2") {
      if (admission) assertLocalHandoffRepository(intent, admission);
      this.review.assertEffectCaller(sha); return;
    }
    if (caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256 || caller.ticket !== intent.ticket
      || caller.repoKey !== intent.repository.key || caller.repoRoot !== intent.repository.root) documentReject("DOCUMENT_AUTHORITY");
  }
  private tracking(sha: string, decisionId: string) { return handoffApprovalTracking(this.review.journal, this.review.host.artifactRoot, sha, decisionId); }
  private assertTracking(sha: string, decisionId: string): void { assertHandoffTracking(this.review.journal, this.review.host.tickets, this.review.host.artifactRoot, sha, decisionId); }
  private predecessor(document: DocumentPackage): DocumentPackage | undefined {
    return HandoffPublicationService.predecessor(this.review.journal, this.review.host.tickets, this.review.host.artifactRoot, document);
  }
  private static predecessor(journal: RegistryHandoffReviewJournal, tickets: TicketStore, root: string, document: DocumentPackage): DocumentPackage | undefined {
    if (document.predecessor === null) return undefined;
    const previous = journal.documents.subject(document.predecessor);
    if (previous.ticket !== document.ticket || previous.repository.key !== document.repository.key || previous.repository.root !== document.repository.root
      || previous.packageId !== document.packageId || previous.revision >= document.revision) documentReject("DOCUMENT_AUTHORITY");
    const events = journal.documents.events(document.repository.key, document.ticket);
    if (documentPending(events).length || documentRetiredSubjects(events).has(document.predecessor)) documentReject("DOCUMENT_AUTHORITY");
    const native = journal.completedPublication(document.predecessor);
    if (native) assertHandoffTracking(journal, tickets, root, native.subjectSha256, native.decisionId);
    else {
      // Explicitly verify the retained document owner's provenance, never project
      // its old scope into this successor's publication/ref/queue authority.
      const latest = documentDecisionRecords(events, document.predecessor).at(-1);
      if (!documentCompletedOperation(events, document.predecessor, "publish") || !latest || latest.outcome !== "approved"
        || documentRevokedDecisionIds(events).has(latest.decisionId)
        || "scope" in latest && latest.scope === "content"
        || "documentScope" in latest && latest.documentScope !== "publish-and-queue") documentReject("DOCUMENT_AUTHORITY");
      journal.documents.snapshot(latest.evidenceSha256);
    }
    const ticket = tickets.get(document.ticket);
    for (const member of previous.members) {
      const raw = journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      const path = documentDestination(previous, member), refs = ticket?.doc_refs.filter(ref => ref.path === path);
      if (!refs || refs.length !== 1 || refs[0]!.type !== (member.role === "requirements" ? "requirements" : member.role === "uat" ? "uat" : "attachment")
        || member.role !== "requirements" && refs[0]!.primary
        || !readArtifactFile(join(root, path), 8 * 1024 * 1024, "ARTIFACT_STALE").equals(raw)) documentReject("DOCUMENT_CONFLICT");
    }
    return previous;
  }
  /** Separate finite content-publication path in the SAME publication owner and
   * effect registry. It never calls combined approved(), branch or queue. */
  static async publishContent(journal: RegistryHandoffReviewJournal, host: ContentPublicationHost, sha: string) {
    const { subject, document } = journal.contentSubject(sha), authority = journal.contentAuthority(sha, false);
    const decisionId = authority.contentDecisionId, publication = new TicketPackagePublication(host.tickets, host.artifactRoot);
    const presentation = await inspectFullDocumentReader(document, host.artifactRoot, hash => journal.documents.snapshot(hash), subject.deliverySha256);
    const folder = `agent-teams/requirements/artifacts/presentations/${subject.documentSubjectSha256}/${subject.deliverySha256}`;
    const verifyDelivery = () => {
      if (!Array.isArray(presentation.outputs) || presentation.outputs.length !== document.members.length * 2 + 1) documentReject("DOCUMENT_SOURCE");
      for (const value of presentation.outputs) {
        const out = object(value, ["path", "sha256", "bytes"]);
        if (typeof out.path !== "string" || !/^(?:index\.html|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(out.path)) documentReject("DOCUMENT_SOURCE");
        const bytes = readArtifactFile(join(host.artifactRoot, folder, out.path), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE");
        if (digest(bytes) !== out.sha256 || bytes.length !== out.bytes) documentReject("DOCUMENT_STALE");
      }
      if (digest(readArtifactFile(join(host.artifactRoot, folder, "manifest.json"), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE")) !== presentation.manifestSha256) documentReject("DOCUMENT_STALE");
      // Physical source remains a fresh admission check, not a replacement for
      // the immutable signed snapshot. Neither source nor delivery is regenerated.
      const sources = readDocumentSources(document, host.artifactRoot);
      sources.forEach((bytes, index) => { if (!Buffer.from(bytes).equals(journal.documents.snapshot(document.members[index]!.sha256))) documentReject("DOCUMENT_STALE"); });
    };
    return host.withPublicationBoundary(document, check => host.tickets.withWorkflowTransaction(() => {
      const predecessor = () => HandoffPublicationService.predecessor(journal, host.tickets, host.artifactRoot, document);
      const authenticate = () => {
        check(); host.assertDocument(document); host.assertOrigin(subject, document); host.assertCaller(subject, document, authority);
        host.tickets.assertHandoffSettled(document.ticket); verifyDelivery(); predecessor();
      };
      const authorize = () => {
        authenticate(); journal.contentAuthority(sha); journal.assertSettled(sha);
        const ticket = host.tickets.get(document.ticket);
        if (!ticket || ![["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]].some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) documentReject("DOCUMENT_CONFLICT");
        if (documentRetiredSubjects(journal.documents.events(document.repository.key, document.ticket)).has(subject.documentSubjectSha256)) documentReject("DOCUMENT_AUTHORITY");
      };
      authenticate();
      let effect = journal.effect(sha, decisionId, "publish");
      const state = publication.observe(document, predecessor());
      const result = () => ({ publication: "verified", operationId: effect.operationId, contentDecisionId: decisionId,
        branch: "not-performed", queue: "not-performed", launchReady: false, productUat: "not-asserted" });
      // Observational settlement of proven completion never authorizes missing
      // writes, even if content was fenced after the final primary write.
      if (effect.started && state === "complete") {
        assertHandoffTracking(journal, host.tickets, host.artifactRoot, sha, decisionId);
        journal.completeEffect(sha, decisionId, "publish"); return result();
      }
      if (effect.completed || state === "unknown" || state === "conflict" || !effect.started && state !== "absent") documentReject("DOCUMENT_CONFLICT");
      const tracking = handoffApprovalTracking(journal, host.artifactRoot, sha, decisionId);
      // Preflight the ENTIRE structured attachment set before writing any part.
      for (const path of tracking.paths) {
        const refs = host.tickets.get(document.ticket)!.doc_refs.filter(ref => ref.path === path);
        if (refs.length > 1 || refs.some(ref => ref.type !== "attachment" || ref.primary)) documentReject("DOCUMENT_CONFLICT");
      }
      authorize(); effect = journal.beginContentPublication(sha); host.afterPublicationPersist?.("intent");
      authorize(); immutableFile(host.artifactRoot, tracking.folder, tracking.name, tracking.bytes);
      for (const path of tracking.paths) {
        const refs = host.tickets.get(document.ticket)!.doc_refs.filter(ref => ref.path === path);
        if (refs.length > 1 || refs.some(ref => ref.type !== "attachment" || ref.primary)) documentReject("DOCUMENT_CONFLICT");
        if (!refs.length) { authorize(); host.tickets.update(document.ticket, { add_doc_ref: { type: "attachment", path, primary: false } }, "documents/handoff"); }
      }
      const verifyTracking = () => { verifyDelivery(); assertHandoffTracking(journal, host.tickets, host.artifactRoot, sha, decisionId); };
      verifyTracking(); host.afterPublicationPersist?.("tracking");
      publication.publish(document, hash => journal.documents.snapshot(hash), () => { authorize(); verifyTracking(); }, predecessor());
      host.afterPublicationPersist?.("publication");
      if (publication.observe(document, predecessor()) !== "complete") documentReject("DOCUMENT_UNCERTAIN");
      verifyTracking(); journal.completeEffect(sha, decisionId, "publish"); host.afterPublicationPersist?.("complete");
      return result();
    }));
  }
  private assertPublished(sha: string, decisionId: string): void {
    this.caller(sha); const { document } = this.review.journal.subject(sha);
    if (!this.review.journal.effect(sha, decisionId, "publish").completed || this.publication.observe(document, this.predecessor(document)) !== "complete") documentReject("DOCUMENT_AUTHORITY");
    this.assertTracking(sha, decisionId);
  }
  async publish(sha: string, decisionId: string) {
    this.caller(sha); const { subject, document } = this.review.journal.subject(sha);
    // Predecessor provenance is native-derived below, under TicketStore. No
    // caller proof, copied receipt or physical destination alone is accepted.
    const delivery = await inspectFullDocumentReader(document, this.review.host.artifactRoot, hash => this.review.journal.documents.snapshot(hash), subject.deliverySha256);
    const folder = `agent-teams/requirements/artifacts/presentations/${subject.documentSubjectSha256}/${subject.deliverySha256}`;
    const verifyDelivery = () => {
      // These are native-derived bounded outputs, never caller-supplied paths.
      const outputs = delivery.outputs as { path: string; sha256: string; bytes: number }[];
      for (const out of [...outputs, { path: "manifest.json", sha256: delivery.manifestSha256 as string, bytes: 0 }]) {
        if (!/^(?:index\.html|manifest\.json|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(out.path)) documentReject("DOCUMENT_SOURCE");
        const raw = readArtifactFile(join(this.review.host.artifactRoot, folder, out.path), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE");
        if (digest(raw) !== out.sha256 || out.path !== "manifest.json" && raw.length !== out.bytes) documentReject("DOCUMENT_STALE");
      }
    };
    return this.review.withEffectBoundary(sha, admission => this.review.host.tickets.withWorkflowTransaction(() => {
      this.caller(sha, admission); verifyDelivery();
      const predecessor = this.predecessor(document);
      let effect = this.review.journal.effect(sha, decisionId, "publish");
      const state = this.publication.observe(document, predecessor);
      if (effect.started && state === "complete") {
        this.assertTracking(sha, decisionId); this.review.journal.completeEffect(sha, decisionId, "publish");
        return { publication: "verified", operationId: effect.operationId, branch: "not-performed", queue: "not-performed", productUat: "not-asserted" };
      }
      if (effect.completed || state === "unknown" || state === "conflict" || !effect.started && state !== "absent") documentReject("DOCUMENT_CONFLICT");
      const ticket = this.review.host.tickets.get(document.ticket);
      if (!ticket || ![["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]].some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) documentReject("DOCUMENT_CONFLICT");
      const authorize = () => {
        this.caller(sha, admission); this.review.authorize(sha, decisionId, "publish"); verifyDelivery(); this.predecessor(document);
        if (subject.schemaVersion === "pa-handoff-review/v2") {
          assertLocalHandoffPlan(this.review.host.tickets, subject, this.review.journal.subject(sha).intent);
          const current = this.review.host.tickets.get(document.ticket);
          if (!current || ![["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]].some(([status, assignee]) => current.status === status && current.assignee === assignee)) documentReject("DOCUMENT_CONFLICT");
        }
      };
      authorize(); effect = this.review.journal.effect(sha, decisionId, "publish", true); this.afterPersist?.("intent");
      const t = this.tracking(sha, decisionId);
      authorize(); immutableFile(this.review.host.artifactRoot, t.folder, t.name, t.bytes);
      for (const path of t.paths) {
        const refs = this.review.host.tickets.get(document.ticket)!.doc_refs.filter(r => r.path === path);
        if (refs.length > 1 || refs.some(r => r.type !== "attachment" || r.primary)) documentReject("DOCUMENT_CONFLICT");
        if (!refs.length) { authorize(); this.review.host.tickets.update(document.ticket, { add_doc_ref: { type: "attachment", path, primary: false } }, "documents/handoff"); }
      }
      this.assertTracking(sha, decisionId); this.afterPersist?.("tracking");
      this.publication.publish(document, hash => this.review.journal.documents.snapshot(hash), () => { authorize(); this.assertTracking(sha, decisionId); }, predecessor);
      this.afterPersist?.("publication");
      if (this.publication.observe(document, predecessor) !== "complete") documentReject("DOCUMENT_UNCERTAIN");
      this.assertTracking(sha, decisionId); this.review.journal.completeEffect(sha, decisionId, "publish"); this.afterPersist?.("complete");
      return { publication: "verified", operationId: effect.operationId, branch: "not-performed", queue: "not-performed", productUat: "not-asserted" };
    }));
  }
  completeBranch(sha: string, decisionId: string) { return this.withBranchVerified(sha, decisionId); }
  private withBranchVerified(sha: string, decisionId: string, successor?: (admission?: RepositoryRefAdmission) => void) {
    this.assertPublished(sha, decisionId);
    const { subject, intent, document } = this.review.journal.subject(sha);
    return this.review.withEffectBoundary(sha, admission => completeNativeHandoffBranch(this.db, this.review.host.tickets, {
      authenticate: () => this.review.host.authenticate(),
      assertLocalCaller: () => this.caller(sha, admission),
      assertAvailable: value => { if (subject.schemaVersion === "pa-handoff-review/v2") this.caller(sha, admission); else this.review.host.assertAvailable(value); },
      assertDecision: (subjectSha, id) => this.review.authorize(subjectSha, id, "branchRef"),
      assertPublished: documentSha => { if (documentSha !== subject.documentSubjectSha256) documentReject("DOCUMENT_AUTHORITY"); this.assertPublished(sha, decisionId); },
    }, subject, intent, document, decisionId, this.planIdentity, undefined, () => { this.caller(sha, admission); successor?.(admission); }, admission));
  }
  queue(sha: string, decisionId: string) {
    const { subject } = this.review.journal.subject(sha);
    // Retained v1 still requires a live grant even for completed queue replay.
    if (subject.schemaVersion === "pa-handoff-review/v1") this.review.authorize(sha, decisionId, "queue");
    this.assertPublished(sha, decisionId);
    // No caller result/passed flag. Require the actual completed branch journal,
    // then reverify physical Git/ref and complete structured link via its owner.
    if (new RegistryHandoffBranchJournal(this.db).events(handoffBranchOperationId(sha, decisionId)).at(-1)?.kind !== "complete") documentReject("DOCUMENT_AUTHORITY");
    let result: { operationId: string; queue: string; launchReady: boolean; productUat: string } | undefined;
    // Keep shared repository/ref -> TicketStore exclusion through the queue
    // write. Releasing branch verification first would leave a drift/race gap;
    // taking repository locks from inside TicketStore would reverse lock order.
    this.withBranchVerified(sha, decisionId, admission => {
      const { document } = this.review.journal.subject(sha);
      const authorize = () => {
        this.caller(sha, admission); this.review.host.tickets.assertHandoffSettled(document.ticket);
        this.review.authorize(sha, decisionId, "queue"); this.assertPublished(sha, decisionId);
      };
      let effect = this.review.journal.effect(sha, decisionId, "queue");
      const predecessor = this.predecessor(document);
      if (!(subject.schemaVersion === "pa-handoff-review/v2" && subject.effects.queue && effect.started && this.publication.queued(document, predecessor))) {
        authorize(); effect = this.review.journal.effect(sha, decisionId, "queue", true);
        this.publication.queue(document, authorize, predecessor); this.afterPersist?.("queue");
        if (!this.publication.queued(document, predecessor)) documentReject("DOCUMENT_UNCERTAIN");
      }
      // v2 settlement observes the original started effect, exact publication,
      // completed correlated branch/link and already-applied queue. Revocation
      // cannot authorize any missing external write; only this record is settled.
      this.review.journal.completeEffect(sha, decisionId, "queue");
      result = { operationId: effect.operationId, queue: "verified", launchReady: false, productUat: "not-asserted" };
    });
    return result ?? documentReject("DOCUMENT_UNCERTAIN");
  }
}
