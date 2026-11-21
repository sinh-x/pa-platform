import { isDeepStrictEqual } from "node:util";
import type { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import { contentReviewReferenceSha, type ContentReviewSubject } from "./content-review-contract.js";
import type { ContentReviewHost } from "./content-review.js";
import type { ContentPublicationAuthority, ContentPublicationCaller } from "./content-publication-contract.js";
import { HandoffPublicationService } from "./handoff-publication.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import { inspectFullDocumentReader } from "./reader-publication.js";

export interface ContentPublicationHost extends ContentReviewHost {
  tickets: TicketStore;
  authenticate(): ContentPublicationCaller;
  /** Independently authenticates current native caller and any ended origins. */
  assertCaller(subject: ContentReviewSubject, document: DocumentPackage, authority?: ContentPublicationAuthority): void;
  withPublicationBoundary<T>(document: DocumentPackage, run: (assertCustody: () => void) => T): T;
  confirm(action: "authorize" | "revoke" | "supersede", view: { reference: string; document: DocumentPackage; successorReference?: string }): Promise<"confirmed" | "cancelled">;
  afterPublicationPersist?(stage: "authority" | "intent" | "tracking" | "publication" | "complete"): void;
}
/** Finite authority/lifecycle facade; the existing handoff publisher owns every
 * file, ref, primary and original effect operation. No content prompt or grant conversion. */
export class ContentPublicationService {
  constructor(readonly journal: RegistryHandoffReviewJournal, readonly host: ContentPublicationHost) {}
  private selected(reference: string) {
    const sha = contentReviewReferenceSha(reference), binding = this.journal.contentSubject(sha);
    this.host.assertDocument(binding.document); this.host.assertOrigin(binding.subject, binding.document);
    this.host.assertCaller(binding.subject, binding.document);
    return { sha, ...binding };
  }
  async status(reference: string) {
    const { sha } = this.selected(reference), events = this.journal.events(sha), request = events.find(e => e.kind === "requested"), fence = events.find(e => e.kind === "content-ineligible");
    const authority = events.find(e => e.kind === "publication-authorized");
    return { schemaVersion: "pa-content-publication-status/v1", reference,
      contentDecisionId: request?.kind === "requested" ? request.request.decisionId : null,
      eligibility: fence?.kind === "content-ineligible" ? fence.fence.reason : "active",
      authority: authority?.kind === "publication-authorized" ? authority.authority : null,
      operation: request?.kind === "requested" ? this.journal.effect(sha, request.request.decisionId, "publish") : null,
      branch: "not-performed", queue: "not-performed", launchReady: false, productUat: "not-asserted" };
  }
  async authorize(reference: string): Promise<Record<string, unknown>> {
    const { sha, subject, document } = this.selected(reference), decision = this.journal.contentDecision(sha);
    const existing = this.host.withPublicationBoundary(document, check => this.host.tickets.withWorkflowTransaction(() => {
      check(); this.selected(reference); this.host.tickets.assertHandoffSettled(document.ticket);
      const event = this.journal.events(sha).find(e => e.kind === "publication-authorized");
      if (event?.kind !== "publication-authorized") return null;
      this.host.assertCaller(subject, document, event.authority); return event.authority;
    }));
    if (existing) return { ...existing };
    await inspectFullDocumentReader(document, this.host.artifactRoot, hash => this.journal.documents.snapshot(hash), subject.deliverySha256);
    const caller = this.host.authenticate();
    if (await this.host.confirm("authorize", { reference, document }) !== "confirmed") return { authority: "not-issued", publication: "not-performed" };
    if (!isDeepStrictEqual(caller, this.host.authenticate())) documentReject("DOCUMENT_STALE");
    this.selected(reference);
    const authority: ContentPublicationAuthority = { schemaVersion: "pa-content-publication-authority/v1", contentDecisionId: decision.decisionId,
      caller, scope: "publish-exact-content-only", method: "native-foreground-publication-confirmation", authorizedAt: new Date().toISOString() };
    this.host.withPublicationBoundary(document, check => this.host.tickets.withWorkflowTransaction(() => {
      check(); this.selected(reference); this.host.tickets.assertHandoffSettled(document.ticket);
      this.journal.authorizeContentPublication(sha, authority);
    }));
    this.host.afterPublicationPersist?.("authority"); return { ...authority };
  }
  async publish(reference: string) {
    const { sha } = this.selected(reference);
    return HandoffPublicationService.publishContent(this.journal, this.host, sha);
  }
  async revoke(reference: string) { return this.fence(reference); }
  async supersede(reference: string, successorReference: string) { return this.fence(reference, successorReference); }
  private async fence(reference: string, successorReference?: string) {
    const { sha, document } = this.selected(reference);
    const reason = successorReference ? "superseded" : "revoked", successor = successorReference ? this.selected(successorReference) : null;
    const existing = this.journal.events(sha).find(e => e.kind === "content-ineligible");
    if (existing?.kind === "content-ineligible") {
      if (existing.fence.reason !== reason || existing.fence.successor !== (successor?.sha ?? null)) documentReject("DOCUMENT_CONFLICT");
      return this.status(reference);
    }
    this.journal.contentDecision(sha);
    if (successor) {
      this.journal.contentDecision(successor.sha);
      if (document.ticket !== successor.document.ticket || !isDeepStrictEqual(document.repository, successor.document.repository)
        || document.packageId !== successor.document.packageId || document.revision >= successor.document.revision) documentReject("DOCUMENT_AUTHORITY");
    }
    const caller = this.host.authenticate();
    if (await this.host.confirm(successor ? "supersede" : "revoke", { reference, document, ...(successorReference ? { successorReference } : {}) }) !== "confirmed") return { eligibility: "unchanged" };
    if (!isDeepStrictEqual(caller, this.host.authenticate())) documentReject("DOCUMENT_STALE");
    // Fencing grants no external effect and must remain possible during partial
    // publication/custody. SQLite serializes it with intent/authority records.
    this.journal.transaction(() => {
      this.selected(reference); if (successor) this.journal.contentDecision(successor.sha);
      this.journal.fenceContent(sha, reason, successor?.sha ?? null);
    });
    return this.status(reference);
  }
}
