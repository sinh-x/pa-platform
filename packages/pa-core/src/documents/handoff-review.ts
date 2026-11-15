import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryHandoffReviewJournal, handoffReviewRequestKey, type HandoffReviewRequest } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import { ID, integer, text } from "../workflows/contracts.js";
import { documentReject } from "./package-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "./handoff-contract.js";
import { inspectFullDocumentReader } from "./reader-publication.js";
import { documentText, validateDocumentBytes } from "./package-tools.js";

export interface NativeHandoffReviewCaller {
  identitySha256: string; selectionSha256: string; deploymentId: string; sessionId: string;
  repoKey: string; repoRoot: string; ticket: string;
}
export interface NativeHandoffReviewHost {
  artifactRoot: string; tickets: TicketStore;
  authenticate(): NativeHandoffReviewCaller;
  /** Native selection/association, current AND historical ownership/lifecycle. */
  assertAvailable(intent: HandoffBranchIntent): void;
  /** Fixed genuine foreground adapter, default Cancel. No public receipt import.
   * It must display ALL documents + exact native intent/effects in ONE review. */
  capture(request: HandoffReviewRequest, view: { subject: HandoffReviewSubject; intent: HandoffBranchIntent;
    presentation: Record<string, unknown>; documents: { id: string; mediaType: string; sha256: string; content: string | null }[] }): Promise<Uint8Array>;
  afterPersist?(stage: "requested" | "captured" | "issued"): void;
}
function sync(value: unknown): void {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== undefined) documentReject("DOCUMENT_AUTHORITY");
}
/** New native service; never synthesizes a legacy document confirmation. The
 * actual Pi foreground/selection adapter is still a gated integration output. */
export class HandoffReviewService {
  constructor(readonly journal: RegistryHandoffReviewJournal, readonly host: NativeHandoffReviewHost) {}
  private current(subject: HandoffReviewSubject, intent: HandoffBranchIntent): NativeHandoffReviewCaller {
    const caller = structuredClone(this.host.authenticate());
    if (caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256
      || caller.ticket !== intent.ticket || caller.repoKey !== intent.repository.key || caller.repoRoot !== intent.repository.root
      || !caller.sessionId || !/^d-[a-f0-9]{6}$/.test(caller.deploymentId)) documentReject("DOCUMENT_AUTHORITY");
    sync(this.host.assertAvailable(structuredClone(intent))); return caller;
  }
  private plan(intent: HandoffBranchIntent, identity: { scope: string; requestId: string }): void {
    const plan = this.host.tickets.inspectHandoffWithIntent(identity);
    if (!plan?.complete || plan.record.change.kind !== "plan" || handoffBranchIntentSha(plan.record.change.intent) !== handoffBranchIntentSha(intent)) documentReject("DOCUMENT_AUTHORITY");
    const ticket = this.host.tickets.get(intent.ticket);
    if (!ticket || ticket.project !== intent.repository.key || !isDeepStrictEqual(ticket.linkedBranches, plan.record.after.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
  }
  async freeze(rawSubject: HandoffReviewSubject, rawIntent: HandoffBranchIntent, planIdentity: { scope: string; requestId: string }): Promise<string> {
    const subject = parseHandoffReviewSubject(rawSubject), intent = parseHandoffBranchIntent(rawIntent), caller = this.current(subject, intent);
    const document = this.journal.documents.subject(subject.documentSubjectSha256);
    await inspectFullDocumentReader(document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), subject.deliverySha256);
    return this.host.tickets.withWorkflowTransaction(() => {
      if (!isDeepStrictEqual(caller, this.current(subject, intent))) documentReject("DOCUMENT_STALE");
      this.plan(intent, planIdentity); return this.journal.freeze(subject, intent);
    });
  }
  authorize(subjectSha256: string, decisionId: string, effect: "publish" | "branchRef" | "queue"): void {
    const { subject, intent } = this.journal.subject(subjectSha256); this.current(subject, intent);
    const request = this.journal.approved(subjectSha256, decisionId, effect), caller = this.host.authenticate();
    if (request.deploymentId !== caller.deploymentId || request.sessionId !== caller.sessionId
      || this.journal.evidence(request).principal !== `local-uid:${process.getuid?.()}`) documentReject("DOCUMENT_AUTHORITY");
  }
  async review(subjectSha256: string, expectedRevision: number, operation: "capture" | "revoke" = "capture", targetDecisionId: string | null = null) {
    text(subjectSha256, /^[a-f0-9]{64}$/); integer(expectedRevision, 0, 1021);
    if (operation === "capture" ? targetDecisionId !== null : targetDecisionId === null) documentReject("DOCUMENT_INPUT");
    if (targetDecisionId !== null) text(targetDecisionId, ID);
    const { subject, intent, document } = this.journal.subject(subjectSha256), caller = this.current(subject, intent);
    const requestKey = handoffReviewRequestKey(subjectSha256, expectedRevision, operation, targetDecisionId);
    let events = this.journal.events(subjectSha256);
    const original = events.find(e => e.kind === "requested" && e.request.requestKey === requestKey);
    const same = () => { if (!isDeepStrictEqual(caller, this.current(subject, intent))) documentReject("DOCUMENT_STALE"); };
    const result = (request: HandoffReviewRequest) => {
      same(); const history = this.journal.events(subjectSha256), issued = history.find(e => e.kind === "issued" && e.decision.requestKey === requestKey);
      if (issued?.kind !== "issued") return documentReject("DOCUMENT_UNCERTAIN");
      const latest = history.filter(e => e.kind === "requested" && e.request.operation === "capture").at(-1);
      const revoked = history.some(e => e.kind === "requested" && e.request.operation === "revoke" && e.request.targetDecisionId === request.decisionId
        && history.some(d => d.kind === "issued" && d.decision.requestKey === e.request.requestKey && d.decision.outcome === "approved"));
      return { schemaVersion: "pa-handoff-decision-result/v1", subjectSha256, decisionId: request.decisionId,
        revoked, superseded: request.operation === "capture" && latest?.kind === "requested" && latest.request.decisionId !== request.decisionId,
        pendingReview: history.at(-1)?.kind === "requested",
        originalExpectedRevision: request.expectedRevision, expectedRevision: this.journal.events(subjectSha256).length,
        operation: request.operation, ...issued.decision, effects: subject.effects, authority: "native-handoff-registry-only",
        publication: "not-performed-by-this-operation", branch: "not-performed-by-this-operation", queue: "not-performed-by-this-operation", productUat: "not-asserted" };
    };
    if (original?.kind === "requested" && (original.request.deploymentId !== caller.deploymentId || original.request.sessionId !== caller.sessionId)) documentReject("DOCUMENT_AUTHORITY");
    if (original?.kind === "requested" && events.some(e => e.kind === "issued" && e.decision.requestKey === requestKey)) return result(original.request);
    if (original?.kind === "requested" && !this.journal.capture(requestKey)) documentReject("DOCUMENT_UNCERTAIN");
    if (!original && (events.length !== expectedRevision || events.at(-1)?.kind === "requested")) documentReject("DOCUMENT_CONFLICT");
    const presentation = await inspectFullDocumentReader(document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), subject.deliverySha256);
    same();
    const documents = document.members.map(member => {
      const raw = this.journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      return { id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(raw) : null };
    });
    const brief = documents[document.members.findIndex(m => m.role === "brief")]!.content!;
    if (Buffer.byteLength(brief) > 16384 || brief.trim().split(/\s+/).length > 1000) documentReject("DOCUMENT_INPUT");
    let request: HandoffReviewRequest;
    if (original?.kind === "requested") request = original.request;
    else {
      request = { schemaVersion: "pa-handoff-native-request/v1", requestKey, decisionId: `decision-${randomUUID()}`, subjectSha256,
        expectedRevision, operation, targetDecisionId, callerIdentitySha256: caller.identitySha256, selectionSha256: caller.selectionSha256,
        deploymentId: caller.deploymentId, sessionId: caller.sessionId, requestedAt: new Date().toISOString() };
      this.host.tickets.withWorkflowTransaction(() => { same(); this.journal.appendRequest(request); });
      sync(this.host.afterPersist?.("requested"));
      // No mutation lock spans the live human interaction. A retained request
      // without capture is uncertain; it is NEVER reopened by ordinary replay.
      const raw = await this.host.capture(structuredClone(request), { subject: structuredClone(subject), intent: structuredClone(intent), presentation, documents });
      this.journal.saveCapture(subjectSha256, requestKey, raw); sync(this.host.afterPersist?.("captured"));
    }
    const evidence = this.journal.evidence(request);
    if (evidence.principal !== `local-uid:${process.getuid?.()}`) documentReject("DOCUMENT_AUTHORITY");
    // Reverify actual delivery bytes after interaction/response loss, BEFORE
    // issuing a grant. Static reader approval labels never become authority.
    await inspectFullDocumentReader(document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), subject.deliverySha256);
    this.host.tickets.withWorkflowTransaction(() => {
      same(); events = this.journal.events(subjectSha256);
      if (!events.some(e => e.kind === "issued" && e.decision.requestKey === requestKey)) {
        if (events.at(-1)?.kind !== "requested" || (events.at(-1) as Extract<typeof events[number], { kind: "requested" }>).request.requestKey !== requestKey) documentReject("DOCUMENT_CONFLICT");
        this.journal.issue(subjectSha256, request, new Date().toISOString());
      }
    });
    sync(this.host.afterPersist?.("issued")); return result(request);
  }
}
