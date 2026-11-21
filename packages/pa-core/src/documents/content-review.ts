import { randomUUID } from "node:crypto";
import { RegistryHandoffReviewJournal, handoffReviewRequestKey, type HandoffReviewRequest } from "../registry/handoff-reviews.js";
import { documentReject, DocumentPackageError, type DocumentPackage } from "./package-contract.js";
import { inspectFullDocumentReader } from "./reader-publication.js";
import { documentText, validateDocumentBytes } from "./package-tools.js";
import { contentReviewReferenceSha, type ContentReviewOrigin, type ContentReviewSubject } from "./content-review-contract.js";
import type { LocalReviewOutcome } from "./handoff-contract.js";
export { parseContentReviewRequest } from "./content-review-contract.js";

export interface ContentReviewHost {
  artifactRoot: string;
  assertOrigin(subject: ContentReviewSubject, document: DocumentPackage): void;
  assertDocument(document: DocumentPackage): void;
  afterPersist?(stage: "requested" | "issued"): void;
}
export interface ContentReviewView {
  reference: string; subject: ContentReviewSubject; document: DocumentPackage; presentation: Record<string, unknown>;
  documents: { id: string; mediaType: string; sha256: string; content: string | null }[];
  actionable: boolean; trust: "local-unverified"; authentication: "not-provided";
  approval: string; publication: "not-published" | "recorded-partial" | "recorded-complete"; eligibility: "active" | "revoked" | "superseded"; history: ReturnType<RegistryHandoffReviewJournal["events"]>;
}
export function contentReviewGuidance(code: unknown): string {
  const reasons: Record<string, string> = {
    DOCUMENT_INPUT: "Use an exact native-issued review reference, or list a ticket's eligible references. A bare ticket never chooses a revision.",
    DOCUMENT_SOURCE: "The exact source or issued reference could not be verified. No substitute revision was selected.",
    DOCUMENT_STALE: "Bound content or delivery changed. The original reference and decision history are retained.",
    DOCUMENT_AUTHORITY: "The original native selection or associated document is not eligible for this route.",
    DOCUMENT_CONFLICT: "The exact delivery or proposed outcome conflicts with retained evidence. A competing decision cannot overwrite the canonical result.",
    DOCUMENT_UNCERTAIN: "The original decision result is unproven. A saved decision may exist; do not replace the request.",
    DOCUMENT_UNAVAILABLE: "A required native owner or delivery is unavailable; the exact cause is not established here.",
  };
  const reason = typeof code === "string" && Object.hasOwn(reasons, code) ? reasons[code] : reasons.DOCUMENT_UNAVAILABLE;
  return `Content review did not return a verified result.\nCondition: Signing cannot report completion; a prior saved decision may exist.\nSource: Native content-review owner.\nReason: ${reason}\nCorrection: Ask the runtime owner to inspect the original reference and decision history. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve original delivery and native records; repairs require their owner's authority.\nResume Action: Reopen the same reference after its owner establishes the result or resolves the cause. Saved decisions are reused without another prompt; signing never authorizes publication or other downstream effects.`;
}
/** Pure projection of the native owner's saved status; never verifies or invokes publication. */
export function contentReviewOutcomeMessage(result: { outcome?: unknown; publication?: unknown }): string {
  if (result.outcome === "approved" && result.publication === "recorded-complete") {
    return "Approved · Publication recorded complete. The saved publication record is historical evidence, not a fresh physical verification. Signing grants and starts no downstream action. No further signing action is required.";
  }
  if (result.outcome === "approved" && result.publication === "recorded-partial") {
    return "Approved · Publication incomplete. The original publication operation started, but completion is not recorded. Partial effects may remain. Ask the publication owner to inspect the original publication operation before any publication retry. Signing grants and starts no downstream action. No further signing action is required.";
  }
  return result.outcome === "approved" ? "Approved · Not published. The exact content decision is saved; signing grants and starts no downstream action. No further signing action is required."
    : result.outcome === "changes-requested" ? "Changes requested · Not published. The document owner must prepare a revised candidate; this decision is retained."
    : result.outcome === "rejected" ? "Rejected · Not published. The exact decision is saved."
    : result.outcome === "cancelled" ? "Review cancelled · Not published. This deliberate Cancel is the shared saved outcome."
    : "Review detached. The shared request remains pending; reopen the same reference to continue.";
}
export type ContentReviewCapture = (request: HandoffReviewRequest, view: ContentReviewView, signal: AbortSignal) => Promise<LocalReviewOutcome | "detached">;
function synchronous(value: unknown): void {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== undefined) documentReject("DOCUMENT_AUTHORITY");
}
/** Shared native content decision owner. No publication service, Git owner,
 * ticket writer, resources, runner, effect mask or caller-provided provenance. */
export class ContentReviewService {
  constructor(readonly journal: RegistryHandoffReviewJournal, readonly host: ContentReviewHost) {}
  private selected(reference: string) {
    const sha = contentReviewReferenceSha(reference), value = this.journal.contentSubject(sha);
    synchronous(this.host.assertDocument(structuredClone(value.document)));
    synchronous(this.host.assertOrigin(structuredClone(value.subject), structuredClone(value.document)));
    return { sha, ...value };
  }
  async prepare(documentSubjectSha256: string, deliverySha256: string, origin: ContentReviewOrigin): Promise<string> {
    const document = this.journal.documents.subject(documentSubjectSha256);
    synchronous(this.host.assertDocument(structuredClone(document)));
    await inspectFullDocumentReader(document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), deliverySha256);
    const subject: ContentReviewSubject = { schemaVersion: "pa-content-review-subject/v1", documentSubjectSha256, deliverySha256, purpose: "sign-content-only", ...origin };
    synchronous(this.host.assertOrigin(structuredClone(subject), structuredClone(document)));
    const reference = `review:${this.journal.freezeContent(subject)}`;
    this.selected(reference); return reference;
  }
  async list(repoKey: string, ticket: string): Promise<{ reference: string; packageId: string; revision: number; purpose: "sign-content-only" }[]> {
    const found: { reference: string; packageId: string; revision: number; purpose: "sign-content-only" }[] = [];
    for (const entry of this.journal.contentSubjects()) {
      if (entry.document.ticket !== ticket || entry.document.repository.key !== repoKey) continue;
      const reference = `review:${entry.sha256}`;
      try {
        this.selected(reference);
        if (this.journal.events(entry.sha256).some(event => event.kind === "content-ineligible")) continue;
        await this.verified(reference);
        found.push({ reference, packageId: entry.document.packageId, revision: entry.document.revision, purpose: "sign-content-only" });
      } catch (error) {
        // Ineligible subjects disclose no content or actionable reference. Other
        // owner failures are not silently converted into an empty success.
        if (!(error instanceof DocumentPackageError)) throw error;
        if (!["DOCUMENT_AUTHORITY", "DOCUMENT_SOURCE", "DOCUMENT_STALE", "DOCUMENT_UNCERTAIN", "DOCUMENT_CONFLICT"].includes(error.code)) throw error;
      }
    }
    return found;
  }
  private async verified(reference: string) {
    const selected = this.selected(reference);
    const presentation = await inspectFullDocumentReader(selected.document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), selected.subject.deliverySha256);
    this.selected(reference); return { ...selected, presentation };
  }
  private publicationStatus(sha: string, decisionId: string): ContentReviewView["publication"] {
    const effect = this.journal.effect(sha, decisionId, "publish");
    return effect.completed ? "recorded-complete" : effect.started ? "recorded-partial" : "not-published";
  }
  async show(reference: string): Promise<ContentReviewView> {
    const { sha, subject, document } = this.selected(reference);
    let presentation: Record<string, unknown>, verified = false;
    try { presentation = (await this.verified(reference)).presentation; verified = true; }
    catch (error) {
      if (!(error instanceof DocumentPackageError) || error.code === "DOCUMENT_AUTHORITY") throw error;
      presentation = { status: "unverified", nextOwner: "reader-publication", guidance: contentReviewGuidance(error.code) };
    }
    const documents = document.members.map(member => {
      const raw = this.journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      return { id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(raw) : null };
    });
    const history = this.journal.events(sha), saved = history.find(e => e.kind === "issued");
    this.selected(reference);
    const fence = history.find(e => e.kind === "content-ineligible"), request = history.find(e => e.kind === "requested");
    return { reference, subject, document, presentation, documents, history, actionable: verified && !saved && !fence,
      eligibility: fence?.kind === "content-ineligible" ? fence.fence.reason : "active",
      approval: saved?.kind === "issued" ? saved.decision.outcome : history.length ? "pending" : "not-requested",
      publication: request?.kind === "requested" ? this.publicationStatus(sha, request.request.decisionId) : "not-published", trust: "local-unverified", authentication: "not-provided" };
  }
  private recorded(reference: string): Record<string, unknown> | null {
    const { sha } = this.selected(reference), events = this.journal.events(sha), request = events.find(e => e.kind === "requested"), issued = events.find(e => e.kind === "issued");
    if (request?.kind !== "requested" || issued?.kind !== "issued") return null;
    return { schemaVersion: "pa-content-review-decision/v1", reference, documentSubjectSha256: this.journal.contentSubject(sha).subject.documentSubjectSha256,
      decisionId: request.request.decisionId, ...issued.decision, scope: "content",
      publication: this.publicationStatus(sha, request.request.decisionId), authority: "content-decision-only",
      trust: "local-unverified", authentication: "not-provided", launchReady: false, productUat: "not-asserted" };
  }
  async request(reference: string): Promise<Record<string, unknown>> {
    const saved = this.recorded(reference); if (saved) return saved;
    await this.verified(reference);
    const request = this.journal.transaction(() => {
      const { sha, subject } = this.selected(reference), history = this.journal.events(sha), original = history.find(e => e.kind === "requested");
      if (original?.kind === "requested") return original.request;
      const value: HandoffReviewRequest = { schemaVersion: "pa-content-review-request/v1", requestKey: handoffReviewRequestKey(sha, 0, "capture", null),
        decisionId: `decision-${randomUUID()}`, subjectSha256: sha, expectedRevision: 0, operation: "capture", targetDecisionId: null,
        callerIdentitySha256: subject.callerIdentitySha256, selectionSha256: subject.selectionSha256, deploymentId: subject.deploymentId, sessionId: subject.sessionId, requestedAt: new Date().toISOString() };
      this.journal.appendRequest(value); return value;
    });
    synchronous(this.host.afterPersist?.("requested"));
    return this.recorded(reference) ?? { schemaVersion: "pa-content-review-pending/v1", reference, status: "pending", requestKey: request.requestKey,
      expectedRevision: request.expectedRevision, trust: "local-unverified", authentication: "not-provided", publication: "not-published" };
  }
  async decide(reference: string, outcome: LocalReviewOutcome): Promise<Record<string, unknown>> {
    if (!["approved", "changes-requested", "rejected", "cancelled"].includes(outcome)) documentReject();
    const saved = this.recorded(reference);
    if (saved) { if (saved.outcome !== outcome) documentReject("DOCUMENT_CONFLICT"); return saved; }
    await this.verified(reference);
    this.journal.transaction(() => {
      const { sha } = this.selected(reference), original = this.journal.events(sha).find(e => e.kind === "requested");
      if (original?.kind !== "requested") return documentReject("DOCUMENT_CONFLICT");
      this.journal.issueLocal(sha, original.request, outcome);
    });
    synchronous(this.host.afterPersist?.("issued"));
    return this.recorded(reference) ?? documentReject("DOCUMENT_UNCERTAIN");
  }
  async review(reference: string, capture: ContentReviewCapture, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const pending = await this.request(reference), saved = this.recorded(reference); if (saved) return saved;
    const controller = new AbortController();
    const detach = () => controller.abort(); signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) controller.abort();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const external = new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setInterval(() => { try { const result = this.recorded(reference); if (result) resolve(result); } catch (error) { reject(error); } }, 100);
      });
      const foreground = async () => {
        const view = await this.show(reference), saved = this.recorded(reference); if (saved) return saved;
        if (controller.signal.aborted) return pending;
        if (!view.actionable) return documentReject("DOCUMENT_SOURCE");
        const original = this.journal.events(contentReviewReferenceSha(reference)).find(e => e.kind === "requested");
        if (original?.kind !== "requested") return documentReject("DOCUMENT_UNCERTAIN");
        const outcome = await capture(original.request, view, controller.signal);
        const issued = this.recorded(reference); if (issued) return issued;
        return outcome === "detached" || controller.signal.aborted ? pending : this.decide(reference, outcome);
      };
      return await Promise.race([foreground(), external]);
    } catch (error) { const result = this.recorded(reference); if (result) return result; throw error; }
    finally { if (timer) clearInterval(timer); controller.abort(); signal?.removeEventListener("abort", detach); }
  }
}
