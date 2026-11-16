import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryHandoffReviewJournal, handoffReviewRequestKey, type HandoffReviewRequest, type HandoffStaleDisposition } from "../registry/handoff-reviews.js";
import type { TicketStore } from "../tickets/store.js";
import type { RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { ID, integer, text } from "../workflows/contracts.js";
import { documentReject } from "./package-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject, type LocalHandoffReviewSubject, type LocalReviewOutcome, type LocalReviewRequest } from "./handoff-contract.js";
import { nativeHandoffPlanIdentity, nativeHandoffTicketVersion } from "./handoff-planning.js";
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
  owners?: readonly { cause: string; owner: string }[];
}
export interface LocalEffectState { operationId: string; started: boolean; completed: boolean; verified?: boolean; state?: "not-started" | "partial" | "verified" | "conflict-or-unknown" }
export type LocalReviewBoundaryResult<T> = { status: "current"; value: T; developObservation?: { ref: "refs/heads/develop"; sha: string; observedAt: string; remoteFreshness: "not-established" } }
  | ({ status: "stale" } & HandoffStaleDisposition) | { status: "blocked"; eligibility: LocalReviewEligibility };
export interface LocalHandoffReviewHooks {
  /** Validate saved ORIGINAL native selection, association and plan. This is not
   * authentication of a local caller or adoption of writer custody. */
  assertOrigin(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent): void;
  inspectEligibility?(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, presentation: Record<string, unknown>): LocalReviewEligibility;
  inspectEffects?(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, decisionId: string, presentation: Record<string, unknown>): { publish: LocalEffectState; branchRef: LocalEffectState; queue: LocalEffectState };
  assertEffectCaller?(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, caller: NativeHandoffReviewCaller): void;
  withEffectBoundary?<T>(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, run: (admission: RepositoryRefAdmission) => T): T;
  /** P3 owner seam: repository -> ticket -> journal serialization. No lock may
   * span reading/UI. The owner reobserves eligibility/develop before run(). */
  withApprovalBoundary?<T>(subject: LocalHandoffReviewSubject, intent: HandoffBranchIntent, run: () => T, presentation: Record<string, unknown>, disposition?: "observe" | "settle"): LocalReviewBoundaryResult<T>;
}
export interface LocalHandoffReviewHost extends LocalHandoffReviewHooks {
  artifactRoot: string; tickets: TicketStore;
  afterPersist?(stage: "requested" | "issued"): void;
}
function localReviewGuidance(stale = false): string {
  return `${stale ? "Approval was not issued because local develop changed." : "Final review is blocked; no approval was issued."}\nCondition: The exact finite handoff cannot receive a usable grant yet.\nSource: Serialized local review eligibility and develop checks.\nReason: ${stale ? "The saved and newly observed full SHAs differ; the old review is retained without a human outcome." : "The independent typed eligibility causes identify the unproven prerequisites; no lifecycle, reference or custody repair was performed."}\nCorrection: Ask the named native owner to inspect the original subject and causes${stale ? ", then use the selected native refresh with its exact predecessor revision and complete-ticket version" : " before requesting an effect"}. Impact: ${stale ? "read-only for inspection; state-changing for refresh" : "read-only for inspection"}. Actor: agent or operator. New approval: ${stale ? "required on the successor subject, not for inspection" : "not required for inspection; approval cannot repair blocked prerequisites"}. Prerequisite: preserve original plans, requests, audit, links and partial effects.\nResume Action: ${stale ? "Review and deliberately approve the successor only after native refresh succeeds; retained refresh coordinates recover reply loss." : "Recheck the same subject after its owning prerequisites are resolved."} Every remaining effect rechecks admission; do not delete history or reset custody.`;
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
    if (subject.schemaVersion === "pa-handoff-review/v2") {
      this.assertEffectCaller(subjectSha256);
      const request = this.journal.approved(subjectSha256, decisionId, effect);
      if (request.schemaVersion !== "pa-handoff-local-request/v2" || request.deploymentId !== subject.origin.deploymentId
        || request.sessionId !== subject.origin.sessionId || this.journal.evidence(request).principal !== "local-unverified") documentReject("DOCUMENT_AUTHORITY");
      return;
    }
    this.current(subject, intent);
    const request = this.journal.approved(subjectSha256, decisionId, effect), caller = this.host.authenticate();
    if (request.deploymentId !== caller.deploymentId || request.sessionId !== caller.sessionId
      || this.journal.evidence(request).principal !== `local-uid:${process.getuid?.()}`) documentReject("DOCUMENT_AUTHORITY");
  }
  assertEffectCaller(sha: string): void {
    const { subject, intent } = this.journal.subject(sha);
    if (subject.schemaVersion === "pa-handoff-review/v1") { this.current(subject, intent); return; }
    const hooks = this.host.localReview;
    if (!hooks?.assertEffectCaller) documentReject("DOCUMENT_UNAVAILABLE");
    sync(hooks.assertOrigin(subject, intent));
    sync(hooks.assertEffectCaller(subject, intent, structuredClone(this.host.authenticate())));
  }
  withEffectBoundary<T>(sha: string, run: (admission?: RepositoryRefAdmission) => T): T {
    const { subject, intent } = this.journal.subject(sha);
    if (subject.schemaVersion === "pa-handoff-review/v1") return run();
    const hooks = this.host.localReview;
    if (!hooks?.withEffectBoundary) documentReject("DOCUMENT_UNAVAILABLE");
    return hooks.withEffectBoundary(subject, intent, run);
  }
  async review(subjectSha256: string, expectedRevision: number, operation: "capture" | "revoke" = "capture", targetDecisionId: string | null = null) {
    text(subjectSha256, /^[a-f0-9]{64}$/); integer(expectedRevision, 0, 1021);
    if (operation === "capture" ? targetDecisionId !== null : targetDecisionId === null) documentReject("DOCUMENT_INPUT");
    if (targetDecisionId !== null) text(targetDecisionId, ID);
    const { subject, intent, document } = this.journal.subject(subjectSha256);
    const caller = subject.schemaVersion === "pa-handoff-review/v2" ? this.host.authenticate() : this.current(subject, intent);
    if (subject.schemaVersion === "pa-handoff-review/v2") {
      const hooks = this.host.localReview;
      if (!hooks) documentReject("DOCUMENT_AUTHORITY");
      // Foreground continuation still uses the actual current Pi caller. The
      // request/decision itself remains attributable to the immutable origin.
      if (caller.deploymentId !== subject.origin.deploymentId) this.assertEffectCaller(subjectSha256);
      else this.current(subject, intent);
      const local = new LocalHandoffReviewService(this.journal, { ...hooks, artifactRoot: this.host.artifactRoot, tickets: this.host.tickets });
      const pending = operation === "revoke" ? await local.revoke(subjectSha256, expectedRevision, targetDecisionId!) : await local.request(subjectSha256, expectedRevision);
      const events = this.journal.events(subjectSha256), original = events.find(e => e.kind === "requested" && e.request.requestKey === pending.requestKey);
      if (original?.kind !== "requested") return pending;
      const issued = events.find(e => e.kind === "issued" && e.decision.requestKey === original.request.requestKey);
      if (issued?.kind === "issued") return local.decide(subjectSha256, expectedRevision, original.request.requestKey, issued.decision.outcome);
      const stale = events.find(e => e.kind === "stale");
      if (stale?.kind === "stale") return local.staleResult(subjectSha256, stale.stale);
      const view = await local.view(subjectSha256);
      const outcome = await hooks.capture(original.request, view);
      if (caller.deploymentId !== subject.origin.deploymentId) this.assertEffectCaller(subjectSha256); else this.current(subject, intent);
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
  async view(sha: string, tolerateUnavailableDelivery = false): Promise<HandoffReviewView & { subject: LocalHandoffReviewSubject }> {
    const { subject, intent, document } = this.selected(sha);
    let presentation: Record<string, unknown>;
    try { presentation = await inspectFullDocumentReader(document, this.host.artifactRoot, hash => this.journal.documents.snapshot(hash), subject.deliverySha256); }
    catch (error) {
      if (!tolerateUnavailableDelivery) throw error;
      // Status still exposes independently verified snapshot content/history.
      // Missing/tampered delivery is explicit, never repaired or called exact.
      presentation = { status: "unverified", subjectSha256: subject.documentSubjectSha256, deliverySha256: subject.deliverySha256,
        nextOwner: "reader-publication", guidance: "The bound reader delivery could not be verified. Saved document snapshots and decision history remain independently checked. Ask the reader owner to inspect the original delivery; no repair was attempted." };
    }
    const documents = document.members.map(member => {
      const raw = this.journal.documents.snapshot(member.sha256); validateDocumentBytes(member, raw);
      return { id: member.id, mediaType: member.mediaType, sha256: member.sha256, content: member.mediaType.startsWith("text/") ? documentText(raw) : null };
    });
    this.selected(sha);
    return { subject, intent, presentation, documents };
  }
  async show(sha: string): Promise<Record<string, unknown>> {
    const view = await this.view(sha, true), { document, subject } = this.selected(sha), history = this.journal.events(sha);
    const effects: { decisionId: string; publish: LocalEffectState; branchRef: LocalEffectState; queue: LocalEffectState }[] = history.flatMap(event => event.kind === "requested" && event.request.operation === "capture"
      ? [{ decisionId: event.request.decisionId, ...(this.host.inspectEffects?.(subject, view.intent, event.request.decisionId, view.presentation) ?? {
        publish: this.journal.effect(sha, event.request.decisionId, "publish"), branchRef: this.journal.branchEffect(sha, event.request.decisionId),
        queue: this.journal.effect(sha, event.request.decisionId, "queue") }) }] : []);
    const documents = view.documents.map(member => ({ ...member,
      encoding: member.content === null ? "base64" : "utf-8",
      content: member.content ?? this.journal.documents.snapshot(member.sha256).toString("base64") }));
    const eligibility = this.host.inspectEligibility?.(subject, view.intent, view.presentation)
      ?? { status: "not-assessed", causes: ["eligibility-owner-unavailable"] };
    const latest = effects.at(-1), capture = history.filter(event => event.kind === "requested" && event.request.operation === "capture").at(-1);
    const issued = capture?.kind === "requested" ? history.find(event => event.kind === "issued" && event.decision.requestKey === capture.request.requestKey) : undefined;
    const revoked = capture?.kind === "requested" && history.some(event => event.kind === "requested" && event.request.operation === "revoke" && event.request.targetDecisionId === capture.request.decisionId
      && history.some(decision => decision.kind === "issued" && decision.decision.requestKey === event.request.requestKey && decision.decision.outcome === "approved"));
    const approval = history.at(-1)?.kind === "stale" ? "stale" : history.at(-1)?.kind === "requested" ? "pending" : revoked ? "revoked" : issued?.kind === "issued" ? issued.decision.outcome : "not-requested";
    const firstUnprovenEffect = !latest ? (subject.effects.publish ? "publication" : "none") : !(latest.publish.verified ?? latest.publish.completed) && subject.effects.publish ? "publication"
      : !(latest.branchRef.verified ?? latest.branchRef.completed) && subject.effects.branchRef ? "repository-ref-link" : !(latest.queue.verified ?? latest.queue.completed) && subject.effects.queue ? "ticket-queue" : "none";
    const nextOwner = approval === "stale" ? "native-refresh" : approval === "revoked" ? "finite-effect-owner-reconciliation" : approval === "changes-requested" ? "requirements-analysis" : approval !== "approved" ? "local-review" : firstUnprovenEffect;
    const currentTicket = this.host.tickets.get(view.intent.ticket);
    return { schemaVersion: "pa-local-review-show/v1", subjectSha256: sha, ...view, documents, document, inventory: document.members,
      ticketVersion: currentTicket ? nativeHandoffTicketVersion(currentTicket) : null, reviewRevision: history.length, pendingReview: history.at(-1)?.kind === "requested",
      latestRequest: history.filter(event => event.kind === "requested").at(-1)?.request ?? null,
      latestDecision: history.filter(event => event.kind === "issued").at(-1)?.decision ?? null, history, effects,
      eligibility, approval, revoked, firstUnprovenEffect, nextOwner, trust: "local-unverified", authentication: "not-provided", effectAdmission: "checked-at-each-remaining-write", launchReady: false, productUat: "not-asserted" };
  }
  staleResult(sha: string, value: HandoffStaleDisposition): Record<string, unknown> {
    return { schemaVersion: "pa-local-review-stale/v1", subjectSha256: sha, status: "stale", ...value,
      approval: "not-issued", effects: "not-performed", nextOwner: "native-refresh", guidance: localReviewGuidance(true), trust: "local-unverified", authentication: "not-provided" };
  }
  async preflight(sha: string, settle = false): Promise<Record<string, unknown>> {
    const selected = this.selected(sha), hooks = this.host;
    let presentation: Record<string, unknown>;
    try { presentation = (await this.view(sha)).presentation; }
    catch {
      const eligibility = hooks.inspectEligibility?.(selected.subject, selected.intent, {}) ?? { status: "blocked", causes: ["source-delivery-integrity"] };
      return { schemaVersion: "pa-local-review-preflight/v1", subjectSha256: sha, status: "blocked", eligibility, approval: "not-issued", nextOwner: "eligibility-owner", guidance: localReviewGuidance() };
    }
    if (!hooks.withApprovalBoundary) return { status: "blocked", eligibility: { status: "blocked", causes: ["approval-boundary-unavailable"] } };
    const history = this.journal.events(sha);
    if (history.at(-1)?.kind === "issued") return { schemaVersion: "pa-local-review-preflight/v1", subjectSha256: sha, status: "decision-recorded",
      eligibility: hooks.inspectEligibility?.(selected.subject, selected.intent, presentation), nextOwner: "same-operation-status", approval: "preserved-in-history", effects: "not-performed" };
    const result = hooks.withApprovalBoundary(selected.subject, selected.intent, () => true, presentation, settle ? "settle" : "observe");
    return result.status === "stale" ? this.staleResult(sha, result) : { schemaVersion: "pa-local-review-preflight/v1", subjectSha256: sha,
      status: result.status === "blocked" ? "blocked" : "eligible", eligibility: result.status === "blocked" ? result.eligibility : { status: "eligible", causes: [] }, effects: "not-performed", nextOwner: result.status === "blocked" ? "eligibility-owner" : "local-review",
      ...(result.status === "blocked" ? { guidance: localReviewGuidance() } : { developObservation: result.developObservation }) };
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
    const existingHistory = this.journal.events(sha), previous = existingHistory.find(e => e.kind === "requested" && e.request.requestKey === requestKey);
    if (previous?.kind === "requested") return response(previous.request);
    if (operation === "capture" && Object.values(subject.effects).some(Boolean) && existingHistory.some(event => event.kind === "issued" && event.decision.outcome === "approved")) documentReject("DOCUMENT_CONFLICT");
    // Verification-only: never create/repair a delivery. Original request replay
    // above retains its saved coordinates even after later delivery changes.
    const view = await this.view(sha);
    if (operation === "capture" && Object.values(subject.effects).some(Boolean)) {
      if (!this.host.withApprovalBoundary) documentReject("DOCUMENT_UNAVAILABLE");
      const checked = this.host.withApprovalBoundary(subject, view.intent, () => true, view.presentation);
      if (checked.status !== "current") return { ...(checked.status === "stale" ? this.staleResult(sha, checked) : { status: "blocked", eligibility: checked.eligibility, approval: "not-issued", nextOwner: "eligibility-owner", guidance: localReviewGuidance() }), requestKey };
    }
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
    const disposition = this.journal.events(sha).find(e => e.kind === "stale");
    if (!before.issued && disposition?.kind === "stale") return this.staleResult(sha, disposition.stale);
    const view = !before.issued ? await this.view(sha) : null;
    const issue = () => this.host.tickets.withWorkflowTransaction(() => this.journal.transaction(() => {
      const { request } = original(); return this.journal.issueLocal(sha, request, outcome);
    }));
    const requiresBoundary = !before.issued && outcome === "approved" && before.request.operation === "capture" && Object.values(subject.effects).some(Boolean);
    if (requiresBoundary && !this.host.withApprovalBoundary) documentReject("DOCUMENT_UNAVAILABLE");
    const boundary = requiresBoundary && this.host.withApprovalBoundary
      ? this.host.withApprovalBoundary(subject, intent, issue, view!.presentation) : { status: "current" as const, value: issue() };
    if (boundary.status === "stale") return this.staleResult(sha, boundary);
    if (boundary.status === "blocked") return { schemaVersion: "pa-local-review-blocked/v1", subjectSha256: sha, ...boundary, approval: "not-issued", nextOwner: "eligibility-owner", guidance: localReviewGuidance() };
    const decision = boundary.value;
    sync(this.host.afterPersist?.("issued"));
    return { schemaVersion: "pa-local-review-decision-result/v1", subjectSha256: sha, decisionId: before.request.decisionId,
      expectedRevision, operation: before.request.operation, targetDecisionId: before.request.targetDecisionId,
      ...decision, trust: "local-unverified", authentication: "not-provided", method: "unauthenticated-local-confirmation",
      approvalBoundary: before.request.operation === "capture" && decision.outcome === "approved" && Object.values(subject.effects).some(Boolean)
        ? { ref: intent.base.ref, sha: intent.base.observedDevelopSha, recordedAt: decision.recordedAt, remoteFreshness: "not-established" } : null,
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
