import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryHandoffReviewJournal, handoffReviewRequestKey, type HandoffReviewRequest } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import { ID, integer, text } from "../workflows/contracts.js";
import { documentReject } from "./package-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject, type LocalHandoffReviewSubject, type LocalReviewOutcome, type LocalReviewRequest } from "./handoff-contract.js";
import { nativeHandoffPlanIdentity } from "./handoff-planning.js";
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
  localReview?: LocalHandoffReviewHooks & {
    capture(request: HandoffReviewRequest, view: HandoffReviewView): Promise<LocalReviewOutcome>;
  };
}
export interface HandoffReviewView {
  subject: HandoffReviewSubject; intent: HandoffBranchIntent; presentation: Record<string, unknown>;
  documents: { id: string; mediaType: string; sha256: string; content: string | null }[];
}
export interface LocalReviewEligibility {
  status: "eligible" | "blocked" | "not-assessed";
  causes: readonly string[];
}
export interface LocalHandoffReviewHooks {
  /** Validate saved ORIGINAL native selection, association and plan. This is not
   * authentication of a local caller or adoption of writer custody. */
  assertOrigin(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): void;
  inspectEligibility?(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): LocalReviewEligibility;
  /** P3 owner seam: repository -> ticket -> journal serialization. No lock may
   * span reading/UI. The owner reobserves eligibility/develop before run(). */
  withApprovalBoundary?<T>(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, run: () => T): T;
}
export interface LocalHandoffReviewHost extends LocalHandoffReviewHooks {
  artifactRoot: string; tickets: TicketStore;
  afterPersist?(stage: "requested" | "issued"): void;
}
function sync(value: unknown): void {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== undefined) documentReject("DOCUMENT_AUTHORITY");
}
/** Native review/freeze owner. v1 keeps genuine foreground evidence; selected
 * v2 foreground delegates to the same unauthenticated local issue owner. */
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
    if (subject.schemaVersion === "pa-handoff-review/v2") {
      if (!this.host.localReview || subject.origin.deploymentId !== caller.deploymentId || subject.origin.sessionId !== caller.sessionId
        || !isDeepStrictEqual(subject.origin.planIdentity, planIdentity) || !isDeepStrictEqual(planIdentity, nativeHandoffPlanIdentity(caller, intent.requestId))) documentReject("DOCUMENT_AUTHORITY");
      sync(this.host.localReview.assertOrigin(subject, intent));
    }
    const document = this.journal.documents.subject(subject.documentSubjectSha256);
    await inspectFullDocumentReader(document, this.host.artifactRoot, sha => this.journal.documents.snapshot(sha), subject.deliverySha256);
    return this.host.tickets.withWorkflowTransaction(() => {
      if (!isDeepStrictEqual(caller, this.current(subject, intent))) documentReject("DOCUMENT_STALE");
      this.plan(intent, planIdentity); return this.journal.freeze(subject, intent);
    });
  }
  authorize(subjectSha256: string, decisionId: string, effect: "publish" | "branchRef" | "queue"): void {
    const { subject, intent } = this.journal.subject(subjectSha256);
    // Local confirmation is not P3 effect admission. Keep v2 fail-closed until
    // its finite-effect/continuation owners are explicitly integrated.
    if (subject.schemaVersion === "pa-handoff-review/v2") documentReject("DOCUMENT_UNAVAILABLE");
    this.current(subject, intent);
    const request = this.journal.approved(subjectSha256, decisionId, effect), caller = this.host.authenticate();
    if (request.deploymentId !== caller.deploymentId || request.sessionId !== caller.sessionId
      || this.journal.evidence(request).principal !== `local-uid:${process.getuid?.()}`) documentReject("DOCUMENT_AUTHORITY");
  }
  async review(subjectSha256: string, expectedRevision: number, operation: "capture" | "revoke" = "capture", targetDecisionId: string | null = null) {
    text(subjectSha256, /^[a-f0-9]{64}$/); integer(expectedRevision, 0, 1021);
    if (operation === "capture" ? targetDecisionId !== null : targetDecisionId === null) documentReject("DOCUMENT_INPUT");
    if (targetDecisionId !== null) text(targetDecisionId, ID);
    const { subject, intent, document } = this.journal.subject(subjectSha256), caller = this.current(subject, intent);
    if (subject.schemaVersion === "pa-handoff-review/v2") {
      const hooks = this.host.localReview;
      if (!hooks || subject.origin.deploymentId !== caller.deploymentId || subject.origin.sessionId !== caller.sessionId) documentReject("DOCUMENT_AUTHORITY");
      const local = new LocalHandoffReviewService(this.journal, { ...hooks, artifactRoot: this.host.artifactRoot, tickets: this.host.tickets });
      const pending = operation === "revoke" ? await local.revoke(subjectSha256, expectedRevision, targetDecisionId!) : await local.request(subjectSha256, expectedRevision);
      const events = this.journal.events(subjectSha256), original = events.find(e => e.kind === "requested" && e.request.requestKey === pending.requestKey);
      if (original?.kind !== "requested") return documentReject("DOCUMENT_UNCERTAIN");
      const issued = events.find(e => e.kind === "issued" && e.decision.requestKey === original.request.requestKey);
      if (issued?.kind === "issued") return local.decide(subjectSha256, expectedRevision, original.request.requestKey, issued.decision.outcome);
      const view = await local.view(subjectSha256);
      const outcome = await hooks.capture(original.request, view);
      this.current(subject, intent);
      return local.decide(subjectSha256, expectedRevision, original.request.requestKey, outcome);
    }
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

/** The v2 request/issue surface shares the native journal, not its caller or
 * foreground evidence. Every action verifies the persisted native origin. */
export class LocalHandoffReviewService {
  constructor(readonly journal: RegistryHandoffReviewJournal, readonly host: LocalHandoffReviewHost) {}
  private selected(sha: string) {
    const value = this.journal.subject(sha);
    if (value.subject.schemaVersion !== "pa-handoff-review/v2") return documentReject("DOCUMENT_AUTHORITY");
    sync(this.host.assertOrigin(structuredClone(value.subject), structuredClone(value.intent)));
    return { ...value, subject: value.subject };
  }
  async view(sha: string): Promise<HandoffReviewView> {
    const { subject, intent, document } = this.selected(sha);
    const presentation = await inspectFullDocumentReader(document, this.host.artifactRoot, hash => this.journal.documents.snapshot(hash), subject.deliverySha256);
    const documents = document.members.map(member => {
      const raw = this.journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      return { id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(raw) : null };
    });
    this.selected(sha);
    return { subject, intent, presentation, documents };
  }
  async show(sha: string): Promise<Record<string, unknown>> {
    const view = await this.view(sha), { document, subject } = this.selected(sha), history = this.journal.events(sha);
    const effects = history.flatMap(event => event.kind === "requested" && event.request.operation === "capture"
      ? [{ decisionId: event.request.decisionId, publish: this.journal.effect(sha, event.request.decisionId, "publish"),
        branchRef: { state: "not-assessed", reason: "P3-effect-admission-not-integrated" },
        queue: this.journal.effect(sha, event.request.decisionId, "queue") }] : []);
    const documents = view.documents.map(member => ({ ...member,
      encoding: member.content === null ? "base64" : "utf-8",
      content: member.content ?? this.journal.documents.snapshot(member.sha256).toString("base64") }));
    const eligibility = this.host.inspectEligibility?.(subject, view.intent)
      ?? { status: "not-assessed", causes: ["P3-effect-eligibility-not-integrated"] };
    return { schemaVersion: "pa-local-review-show/v1", subjectSha256: sha, ...view, documents, document, inventory: document.members,
      reviewRevision: history.length, pendingReview: history.at(-1)?.kind === "requested",
      latestRequest: history.filter(event => event.kind === "requested").at(-1)?.request ?? null,
      latestDecision: history.filter(event => event.kind === "issued").at(-1)?.decision ?? null, history, effects,
      eligibility, trust: "local-unverified", authentication: "not-provided", effectAdmission: "not-established", productUat: "not-asserted" };
  }
  request(sha: string, expectedRevision: number): Promise<Record<string, unknown> & { requestKey: string }> {
    return this.requestOperation(sha, expectedRevision, "capture", null);
  }
  revoke(sha: string, expectedRevision: number, decisionId: string): Promise<Record<string, unknown> & { requestKey: string }> {
    return this.requestOperation(sha, expectedRevision, "revoke", decisionId);
  }
  private async requestOperation(sha: string, expectedRevision: number, operation: "capture" | "revoke", targetDecisionId: string | null): Promise<Record<string, unknown> & { requestKey: string }> {
    integer(expectedRevision, 0, 1021);
    if (operation !== "capture" && operation !== "revoke" || (operation === "capture" ? targetDecisionId !== null : targetDecisionId === null)) documentReject("DOCUMENT_INPUT");
    if (targetDecisionId !== null) text(targetDecisionId, ID);
    const { subject } = this.selected(sha), requestKey = handoffReviewRequestKey(sha, expectedRevision, operation, targetDecisionId);
    const response = (request: HandoffReviewRequest) => ({ schemaVersion: "pa-local-review-request-result/v1", subjectSha256: sha, requestKey,
      expectedRevision: request.expectedRevision, request, trust: "local-unverified", authentication: "not-provided",
      approval: "not-issued-by-this-operation", effects: "not-performed" });
    const previous = this.journal.events(sha).find(e => e.kind === "requested" && e.request.requestKey === requestKey);
    if (previous?.kind === "requested") return response(previous.request);
    // Verification-only: never create/repair a delivery. Original request replay
    // above retains its saved coordinates even after later delivery changes.
    await this.view(sha);
    const request = this.host.tickets.withWorkflowTransaction(() => this.journal.transaction(() => {
      this.selected(sha);
      const history = this.journal.events(sha), original = history.find(e => e.kind === "requested" && e.request.requestKey === requestKey);
      if (original?.kind === "requested") return original.request;
      if (history.length !== expectedRevision || history.at(-1)?.kind === "requested") return documentReject("DOCUMENT_CONFLICT");
      const value: HandoffReviewRequest = { schemaVersion: "pa-handoff-local-request/v2", requestKey, decisionId: `decision-${randomUUID()}`,
        subjectSha256: sha, expectedRevision, operation, targetDecisionId, callerIdentitySha256: subject.callerIdentitySha256,
        selectionSha256: subject.selectionSha256, deploymentId: subject.origin.deploymentId, sessionId: subject.origin.sessionId, requestedAt: new Date().toISOString() };
      this.journal.appendRequest(value); return value;
    }));
    sync(this.host.afterPersist?.("requested"));
    return response(request);
  }
  async decide(sha: string, expectedRevision: number, requestKey: string, outcome: LocalReviewOutcome): Promise<Record<string, unknown>> {
    integer(expectedRevision, 0, 1021); text(requestKey, /^[a-f0-9]{64}$/);
    if (!["approved", "changes-requested", "rejected", "cancelled"].includes(outcome)) documentReject("DOCUMENT_INPUT");
    const { subject, intent } = this.selected(sha);
    const original = () => {
      this.selected(sha);
      const history = this.journal.events(sha), entry = history.find(e => e.kind === "requested" && e.request.requestKey === requestKey);
      if (entry?.kind !== "requested" || entry.request.expectedRevision !== expectedRevision) return documentReject("DOCUMENT_CONFLICT");
      const issued = history.find(e => e.kind === "issued" && e.decision.requestKey === requestKey);
      if (issued?.kind === "issued" && issued.decision.outcome !== outcome) documentReject("DOCUMENT_CONFLICT");
      return { request: entry.request, issued };
    };
    const before = original();
    // Issued replay must return its exact historical result even if delivery or
    // develop moved later. Only an unissued decision revalidates the delivery.
    if (!before.issued) await this.view(sha);
    const issue = () => this.host.tickets.withWorkflowTransaction(() => this.journal.transaction(() => {
      const { request } = original(); return this.journal.issueLocal(sha, request, outcome);
    }));
    const decision = !before.issued && outcome === "approved" && before.request.operation === "capture" && this.host.withApprovalBoundary
      ? this.host.withApprovalBoundary(subject, intent, issue) : issue();
    sync(this.host.afterPersist?.("issued"));
    return { schemaVersion: "pa-local-review-decision-result/v1", subjectSha256: sha, decisionId: before.request.decisionId,
      expectedRevision, operation: before.request.operation, targetDecisionId: before.request.targetDecisionId,
      ...decision, trust: "local-unverified", authentication: "not-provided", method: "unauthenticated-local-confirmation",
      effects: subject.effects, publication: "not-performed-by-this-operation", branch: "not-performed-by-this-operation",
      queue: "not-performed-by-this-operation", productUat: "not-asserted" };
  }
  async execute(request: LocalReviewRequest): Promise<Record<string, unknown>> {
    if (request.action === "show") return this.show(request.subjectSha256);
    if (request.action === "decide") return this.decide(request.subjectSha256, request.expectedRevision, request.requestKey, request.outcome);
    return request.action === "revoke" ? this.revoke(request.subjectSha256, request.expectedRevision, request.decisionId)
      : this.request(request.subjectSha256, request.expectedRevision);
  }
}
