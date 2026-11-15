import type Database from "better-sqlite3";
import { join } from "node:path";
import { readArtifactFile } from "../artifacts/manifest.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import { digest } from "../workflows/contracts.js";
import { RegistryHandoffBranchJournal, handoffBranchOperationId } from "./handoff-branch.js";
import { completeNativeHandoffBranch } from "./handoff-native-branch.js";
import { HandoffReviewService } from "./handoff-review.js";
import { immutableFile } from "./confirmation-record.js";
import { documentReject } from "./package-contract.js";
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
  private assertPublished(sha: string, decisionId: string): void {
    this.caller(sha); const { document } = this.review.journal.subject(sha);
    if (!this.review.journal.effect(sha, decisionId, "publish").completed || this.publication.observe(document) !== "complete") documentReject("DOCUMENT_AUTHORITY");
    this.assertTracking(sha, decisionId);
  }
  async publish(sha: string, decisionId: string) {
    this.caller(sha); const { subject, document } = this.review.journal.subject(sha);
    // Successor provenance needs a separately completed native predecessor
    // consumer. Do not adopt arbitrary old physical destinations as that proof.
    if (document.predecessor !== null) documentReject("DOCUMENT_UNAVAILABLE");
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
      let effect = this.review.journal.effect(sha, decisionId, "publish");
      const state = this.publication.observe(document);
      if (effect.started && state === "complete") {
        this.assertTracking(sha, decisionId); this.review.journal.completeEffect(sha, decisionId, "publish");
        return { publication: "verified", operationId: effect.operationId, branch: "not-performed", queue: "not-performed", productUat: "not-asserted" };
      }
      if (effect.completed || state === "unknown" || state === "conflict" || !effect.started && state !== "absent") documentReject("DOCUMENT_CONFLICT");
      const ticket = this.review.host.tickets.get(document.ticket);
      if (!ticket || ![["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"]].some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) documentReject("DOCUMENT_CONFLICT");
      const authorize = () => { this.review.authorize(sha, decisionId, "publish"); verifyDelivery(); };
      authorize(); effect = this.review.journal.effect(sha, decisionId, "publish", true); this.afterPersist?.("intent");
      const t = this.tracking(sha, decisionId);
      authorize(); immutableFile(this.review.host.artifactRoot, t.folder, t.name, t.bytes);
      for (const path of t.paths) {
        const refs = this.review.host.tickets.get(document.ticket)!.doc_refs.filter(r => r.path === path);
        if (refs.length > 1 || refs.some(r => r.type !== "attachment" || r.primary)) documentReject("DOCUMENT_CONFLICT");
        if (!refs.length) { authorize(); this.review.host.tickets.update(document.ticket, { add_doc_ref: { type: "attachment", path, primary: false } }, "documents/handoff"); }
      }
      this.assertTracking(sha, decisionId); this.afterPersist?.("tracking");
      this.publication.publish(document, hash => this.review.journal.documents.snapshot(hash), () => { authorize(); this.assertTracking(sha, decisionId); });
      this.afterPersist?.("publication");
      if (this.publication.observe(document) !== "complete") documentReject("DOCUMENT_UNCERTAIN");
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
      this.publication.queue(document, authorize); this.afterPersist?.("queue");
      if (!this.publication.queued(document)) documentReject("DOCUMENT_UNCERTAIN");
      this.review.journal.completeEffect(sha, decisionId, "queue");
      result = { operationId: effect.operationId, queue: "verified", launchReady: false, productUat: "not-asserted" };
    });
    return result ?? documentReject("DOCUMENT_UNCERTAIN");
  }
}
