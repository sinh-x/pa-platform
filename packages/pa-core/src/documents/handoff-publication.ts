import type Database from "better-sqlite3";
import { join } from "node:path";
import { readArtifactFile } from "../artifacts/manifest.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest } from "../workflows/contracts.js";
import { documentCompletedOperation, documentDecisionRecords, documentPending, documentRetiredSubjects, documentRevokedDecisionIds } from "../registry/documents.js";
import { RegistryHandoffBranchJournal, handoffBranchOperationId } from "./handoff-branch.js";
import { completeNativeHandoffBranch } from "./handoff-native-branch.js";
import { HandoffReviewService } from "./handoff-review.js";
import { immutableFile } from "./confirmation-record.js";
import { documentDestination, documentReject, type DocumentPackage } from "./package-contract.js";
import { validateDocumentBytes } from "./package-tools.js";
import { DOCUMENT_READER_LIMITS } from "./reader.js";
import { inspectFullDocumentReader } from "./reader-publication.js";

/** Explicit NEW-provenance consumer. Old document receipts/scopes/intents stay
 * untouched. Internal source integration, not a selected production capability.
 * No private legacy approved() bypass or forged confirmation event is used. */
export class HandoffPublicationService {
  private readonly publication: TicketPackagePublication;
  constructor(private readonly db: Database.Database, readonly review: HandoffReviewService,
    private readonly planIdentity: { scope: string; requestId: string }, private readonly afterPersist?: (stage: "intent" | "tracking" | "publication" | "complete" | "queue") => void) {
    this.publication = new TicketPackagePublication(review.host.tickets, review.host.artifactRoot);
  }
  private caller(sha: string): void {
    const { subject, intent } = this.review.journal.subject(sha), caller = this.review.host.authenticate();
    if (caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256 || caller.ticket !== intent.ticket
      || caller.repoKey !== intent.repository.key || caller.repoRoot !== intent.repository.root) documentReject("DOCUMENT_AUTHORITY");
  }
  private tracking(sha: string, decisionId: string) {
    const { subject, intent, document } = this.review.journal.subject(sha), events = this.review.journal.events(sha);
    const request = events.find(e => e.kind === "requested" && e.request.decisionId === decisionId);
    const decision = request?.kind === "requested" ? events.find(e => e.kind === "issued" && e.decision.requestKey === request.request.requestKey) : undefined;
    if (request?.kind !== "requested" || request.request.operation !== "capture" || decision?.kind !== "issued" || decision.decision.outcome !== "approved") documentReject("DOCUMENT_AUTHORITY");
    const folder = `agent-teams/requirements/artifacts/handoff-approvals/${document.ticket}`, name = `${decisionId}.json`;
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "pa-handoff-approval/v1", subjectSha256: sha, subject, intent, request: request.request,
      decision: decision.decision, authority: "derived-tracking-only-native-handoff-registry-required", productAcceptance: false }, null, 2) + "\n");
    const deliveryFolder = `agent-teams/requirements/artifacts/presentations/${subject.documentSubjectSha256}/${subject.deliverySha256}`;
    return { folder, name, bytes, paths: [`${folder}/${name}`, `${deliveryFolder}/manifest.json`, `${deliveryFolder}/index.html`] };
  }
  private assertTracking(sha: string, decisionId: string): void {
    const { document } = this.review.journal.subject(sha), t = this.tracking(sha, decisionId);
    if (!readArtifactFile(join(this.review.host.artifactRoot, t.paths[0]!), 65536, "ARTIFACT_STALE").equals(t.bytes)) documentReject("DOCUMENT_CONFLICT");
    const ticket = this.review.host.tickets.get(document.ticket);
    if (!ticket || ticket.project !== document.repository.key || t.paths.some(path => {
      const refs = ticket.doc_refs.filter(r => r.path === path); return refs.length !== 1 || refs[0]!.type !== "attachment" || refs[0]!.primary;
    })) documentReject("DOCUMENT_CONFLICT");
  }
  private predecessor(document: DocumentPackage): DocumentPackage | undefined {
    if (document.predecessor === null) return undefined;
    const previous = this.review.journal.documents.subject(document.predecessor);
    if (previous.ticket !== document.ticket || previous.repository.key !== document.repository.key || previous.repository.root !== document.repository.root
      || previous.packageId !== document.packageId || previous.revision >= document.revision) documentReject("DOCUMENT_AUTHORITY");
    const events = this.review.journal.documents.events(document.repository.key, document.ticket);
    if (documentPending(events).length || documentRetiredSubjects(events).has(document.predecessor)) documentReject("DOCUMENT_AUTHORITY");
    const native = this.review.journal.completedPublication(document.predecessor);
    if (native) this.assertTracking(native.subjectSha256, native.decisionId);
    else {
      // Explicitly verify the retained document owner's provenance, never project
      // its old scope into this successor's publication/ref/queue authority.
      const latest = documentDecisionRecords(events, document.predecessor).at(-1);
      if (!documentCompletedOperation(events, document.predecessor, "publish") || !latest || latest.outcome !== "approved"
        || documentRevokedDecisionIds(events).has(latest.decisionId)
        || "scope" in latest && latest.scope === "content"
        || "documentScope" in latest && latest.documentScope !== "publish-and-queue") documentReject("DOCUMENT_AUTHORITY");
      this.review.journal.documents.snapshot(latest.evidenceSha256);
    }
    const ticket = this.review.host.tickets.get(document.ticket);
    for (const member of previous.members) {
      const raw = this.review.journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      const path = documentDestination(previous, member), refs = ticket?.doc_refs.filter(ref => ref.path === path);
      if (!refs || refs.length !== 1 || refs[0]!.type !== (member.role === "requirements" ? "requirements" : member.role === "uat" ? "uat" : "attachment")
        || member.role !== "requirements" && refs[0]!.primary
        || !readArtifactFile(join(this.review.host.artifactRoot, path), 8 * 1024 * 1024, "ARTIFACT_STALE").equals(raw)) documentReject("DOCUMENT_CONFLICT");
    }
    return previous;
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
    return this.review.host.tickets.withWorkflowTransaction(() => {
      this.caller(sha); verifyDelivery();
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
      const authorize = () => { this.review.authorize(sha, decisionId, "publish"); verifyDelivery(); this.predecessor(document); };
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
    });
  }
  completeBranch(sha: string, decisionId: string) { return this.withBranchVerified(sha, decisionId); }
  private withBranchVerified(sha: string, decisionId: string, successor?: () => void) {
    this.assertPublished(sha, decisionId);
    const { subject, intent, document } = this.review.journal.subject(sha);
    return completeNativeHandoffBranch(this.db, this.review.host.tickets, {
      authenticate: () => this.review.host.authenticate(), assertAvailable: value => this.review.host.assertAvailable(value),
      assertDecision: (subjectSha, id) => this.review.authorize(subjectSha, id, "branchRef"),
      assertPublished: documentSha => { if (documentSha !== subject.documentSubjectSha256) documentReject("DOCUMENT_AUTHORITY"); this.assertPublished(sha, decisionId); },
    }, subject, intent, document, decisionId, this.planIdentity, undefined, successor);
  }
  queue(sha: string, decisionId: string) {
    this.review.authorize(sha, decisionId, "queue"); this.assertPublished(sha, decisionId);
    // No caller result/passed flag. Require the actual completed branch journal,
    // then reverify physical Git/ref and complete structured link via its owner.
    if (new RegistryHandoffBranchJournal(this.db).events(handoffBranchOperationId(sha, decisionId)).at(-1)?.kind !== "complete") documentReject("DOCUMENT_AUTHORITY");
    let result: { operationId: string; queue: string; launchReady: boolean; productUat: string } | undefined;
    // Keep shared repository/ref -> TicketStore exclusion through the queue
    // write. Releasing branch verification first would leave a drift/race gap;
    // taking repository locks from inside TicketStore would reverse lock order.
    this.withBranchVerified(sha, decisionId, () => {
      const { document } = this.review.journal.subject(sha);
      const authorize = () => { this.review.authorize(sha, decisionId, "queue"); this.assertPublished(sha, decisionId); };
      authorize(); const effect = this.review.journal.effect(sha, decisionId, "queue", true);
      const predecessor = this.predecessor(document);
      this.publication.queue(document, authorize, predecessor); this.afterPersist?.("queue");
      if (!this.publication.queued(document, predecessor)) documentReject("DOCUMENT_UNCERTAIN");
      this.review.journal.completeEffect(sha, decisionId, "queue");
      result = { operationId: effect.operationId, queue: "verified", launchReady: false, productUat: "not-asserted" };
    });
    return result ?? documentReject("DOCUMENT_UNCERTAIN");
  }
}
