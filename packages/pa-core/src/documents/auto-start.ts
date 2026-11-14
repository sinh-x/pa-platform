import { randomUUID } from "node:crypto";
import { AutoWaitlistError } from "../auto/waitlist.js";
import { RegistryAutoJournal, type AutoItem } from "../auto/coordination.js";
import { autoStartSha256, parseAutoStartIntent, type AutoStartIntent, type AutoTaskBaseline } from "../auto/intent.js";
import { documentPackageSha } from "./package-contract.js";
import { checkDocumentPackage } from "./package-tools.js";
import { RegistryDocumentJournal, documentRevokedDecisionIds, documentPending, type DocumentAutoReview, type DocumentAutoStart } from "../registry/documents.js";
import { digest } from "../workflows/contracts.js";
export interface AutoStartCaptureHost {
  authenticate(): string;
  assertCurrent(item: AutoItem, intent: AutoStartIntent): void;
  withdraw?(item: AutoItem): Promise<{ outcome: "approved" | "cancelled"; principal: string; evidence: Uint8Array; evidenceSha256: string }>;
  capture(item: AutoItem, intent: AutoStartIntent): Promise<{ outcome: DocumentAutoStart["outcome"]; principal: string; interactionId: string; evidence: Uint8Array; evidenceSha256: string }>;
}
/** Additive native document decision owner. Old content/publish/queue receipts
 * never authorize start. The auto journal stores ONLY references to this owner. */
export class AutoStartDecisionService {
  constructor(readonly documents: RegistryDocumentJournal, readonly coordination: RegistryAutoJournal) {}
  propose(item: AutoItem, input: AutoStartIntent, host: AutoStartCaptureHost): AutoItem {
    const intent = parseAutoStartIntent(Buffer.from(JSON.stringify(input))), sha = autoStartSha256(intent);
    const identity = host.authenticate(); host.assertCurrent(item, intent);
    if (item.startSha256) {
      if (item.startSha256 !== sha) throw new AutoWaitlistError("AUTO_SOURCE");
      return item;
    }
    const subject = this.documents.subject(intent.subjectSha256);
    if (intent.itemId !== item.itemId || intent.ticket !== item.ticket || intent.repository.key !== item.project || intent.repository.root !== item.repoRoot
      || subject.ticket !== item.ticket || subject.repository.key !== intent.repository.key || subject.repository.root !== intent.repository.root || subject.revision !== intent.documentRevision || documentPackageSha(subject) !== item.subjectSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    return this.coordination.db.transaction(() => {
      if (host.authenticate() !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); host.assertCurrent(item, intent);
      const events = this.documents.events(item.project, item.ticket);
      this.documents.append(item.project, item.ticket, events.length, { kind: "auto-proposal", itemId: item.itemId, subjectSha256: intent.subjectSha256, startSha256: sha }, [Buffer.from(JSON.stringify(intent))]);
      return this.coordination.change(item.itemId, item.revision, b => ({ ...b, startSha256: sha }), () => { if (host.authenticate() !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); });
    }).immediate();
  }
  intent(item: AutoItem): AutoStartIntent {
    if (!item.startSha256) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const intent = parseAutoStartIntent(this.documents.snapshot(item.startSha256));
    if (autoStartSha256(intent) !== item.startSha256 || intent.itemId !== item.itemId || intent.subjectSha256 !== item.subjectSha256 || intent.ticket !== item.ticket
      || intent.repository.key !== item.project || intent.repository.root !== item.repoRoot) throw new AutoWaitlistError("AUTO_STORE");
    return intent;
  }
  decision(item: AutoItem): DocumentAutoStart | null {
    if (!item.startSha256) return null;
    return this.documents.events(item.project, item.ticket).flatMap(e => e.data.kind === "auto-start" && e.data.itemId === item.itemId && e.data.startSha256 === item.startSha256 ? [e.data] : []).at(-1) ?? null;
  }
  async review(item: AutoItem, host: AutoStartCaptureHost): Promise<AutoItem> {
    const identity = host.authenticate(), intent = this.intent(item), existing = this.decision(item);
    if (existing) return this.reflect(this.coordination.item(item.itemId), existing, host);
    host.assertCurrent(item, intent);
    const subject = this.documents.subject(intent.subjectSha256), bytes = subject.members.map(m => this.documents.snapshot(m.sha256));
    if (!checkDocumentPackage(subject, bytes).structuralPass) throw new AutoWaitlistError("AUTO_SOURCE");
    const claim = this.coordination.db.transaction(() => {
      if (host.authenticate() !== identity || this.coordination.item(item.itemId).revision !== item.revision) throw new AutoWaitlistError("AUTO_BUSY");
      const events = this.documents.events(item.project, item.ticket);
      const prior = events.flatMap(e => e.data.kind === "auto-review" && e.data.itemId === item.itemId && e.data.startSha256 === item.startSha256 ? [e.data] : []);
      if (prior.some(e => e.phase === "withdrawn")) throw new AutoWaitlistError("AUTO_BUSY");
      const observed = prior.find(e => e.phase === "observed");
      if (observed) return observed;
      if (prior.length) throw new AutoWaitlistError("AUTO_BUSY");
      const requested: DocumentAutoReview = { subjectSha256: item.subjectSha256!, itemId: item.itemId, startSha256: item.startSha256!, reviewId: `review-${randomUUID()}`,
        phase: "requested", callerIdentity: identity, evidenceSha256: null, outcome: null, principal: null, interactionId: null };
      this.documents.append(item.project, item.ticket, events.length, { kind: "auto-review", ...requested });
      return requested;
    }).immediate();
    let observed = claim;
    if (claim.phase === "requested") {
      const captured = await host.capture(item, intent);
      if (host.authenticate() !== identity || digest(captured.evidence) !== captured.evidenceSha256) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      observed = { ...claim, phase: "observed", outcome: captured.outcome, principal: captured.principal, interactionId: captured.interactionId, evidenceSha256: captured.evidenceSha256 };
      // Persist the actual interaction before mutable admission checks/CAS. A
      // stale subject or lost decision reply must not erase/duplicate a prompt.
      this.documents.append(item.project, item.ticket, this.documents.events(item.project, item.ticket).length, { kind: "auto-review", ...observed }, [captured.evidence]);
    }
    host.assertCurrent(item, intent);
    return this.coordination.db.transaction(() => {
      if (host.authenticate() !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const current = this.coordination.item(item.itemId), same = this.decision(current);
      if (same) return this.reflect(current, same, host);
      if (current.revision !== item.revision) throw new AutoWaitlistError("AUTO_BUSY");
      host.assertCurrent(current, intent);
      const decision: DocumentAutoStart = { autoStartVersion: "pa-auto-start/v1", method: "ppa-auto-foreground", decisionId: `decision-${randomUUID()}`,
        subjectSha256: intent.subjectSha256, itemId: item.itemId, startSha256: item.startSha256!, documentScope: intent.documentScope,
        outcome: observed.outcome!, principal: observed.principal!, interactionId: observed.interactionId!, evidenceSha256: observed.evidenceSha256!,
        callerIdentity: observed.callerIdentity, recordedAt: new Date().toISOString(), requestKey: digest(JSON.stringify([item.itemId, intent.subjectSha256, item.startSha256, intent.documentScope])) };
      const events = this.documents.events(item.project, item.ticket);
      this.documents.append(item.project, item.ticket, events.length, { kind: "auto-start", ...decision });
      return this.reflect(current, decision, host);
    }).immediate();
  }
  private reflect(item: AutoItem, decision: DocumentAutoStart, host: AutoStartCaptureHost): AutoItem {
    host.authenticate(); this.documents.snapshot(decision.evidenceSha256);
    if (["closed", "declined"].includes(item.state)) return item;
    if (item.startSha256 !== decision.startSha256 || item.subjectSha256 !== decision.subjectSha256) throw new AutoWaitlistError("AUTO_BUSY");
    if (documentRevokedDecisionIds(this.documents.events(item.project, item.ticket)).has(decision.decisionId)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    if (item.decisionId === decision.decisionId) return item;
    const unsettled = [item.draft, item.dispatch].some(e => e && !["completed", "failed"].includes(e.state));
    return this.coordination.change(item.itemId, item.revision, b => ({ ...b, decisionId: decision.decisionId,
      state: decision.outcome === "approved" ? "approved-pending-dispatch" : decision.outcome === "rejected" && !unsettled ? "declined" : decision.outcome === "changes-requested" ? "blocked" : "awaiting-review",
      reason: decision.outcome === "changes-requested" ? "question" : "none" }), () => { host.authenticate(); });
  }
  async requestChanges(item: AutoItem, host: AutoStartCaptureHost): Promise<AutoItem> {
    const identity = host.authenticate();
    if (!host.withdraw || item.dispatch || documentPending(this.documents.events(item.project, item.ticket)).length) throw new AutoWaitlistError("AUTO_BUSY");
    const consent = await host.withdraw(item);
    if (consent.outcome !== "approved") return item;
    if (host.authenticate() !== identity || digest(consent.evidence) !== consent.evidenceSha256) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return this.coordination.db.transaction(() => {
      const current = this.coordination.item(item.itemId);
      if (current.revision !== item.revision || current.dispatch) throw new AutoWaitlistError("AUTO_BUSY");
      const reviews = this.documents.events(item.project, item.ticket).flatMap(e => e.data.kind === "auto-review" && e.data.phase === "requested" && e.data.itemId === item.itemId && e.data.startSha256 === current.startSha256 ? [e.data] : []);
      for (const review of reviews) {
        if (!this.documents.events(item.project, item.ticket).some(e => e.data.kind === "auto-review" && e.data.reviewId === review.reviewId && e.data.phase === "withdrawn"))
          this.documents.append(item.project, item.ticket, this.documents.events(item.project, item.ticket).length, { ...review, phase: "withdrawn", callerIdentity: identity, evidenceSha256: consent.evidenceSha256, outcome: "cancelled", principal: consent.principal, interactionId: null }, [consent.evidence]);
      }
      if (current.decisionId && current.subjectSha256) this.documents.append(item.project, item.ticket, this.documents.events(item.project, item.ticket).length,
        { kind: "revoked", subjectSha256: current.subjectSha256, decisionId: current.decisionId, evidenceSha256: consent.evidenceSha256 }, [consent.evidence]);
      return this.coordination.change(item.itemId, item.revision, b => ({ ...b, state: "awaiting-review", startSha256: null, decisionId: null, reason: "question" }), () => { if (host.authenticate() !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); });
    }).immediate();
  }
  authorize(item: AutoItem, host: Pick<AutoStartCaptureHost, "authenticate" | "assertCurrent">): AutoStartIntent {
    host.authenticate();
    const current = this.coordination.active();
    if (current?.itemId !== item.itemId || current.startSha256 !== item.startSha256 || current.decisionId !== item.decisionId || ["closed", "declined"].includes(item.state)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const intent = this.intent(item), decision = this.decision(item), events = this.documents.events(item.project, item.ticket);
    if (!decision || decision.decisionId !== item.decisionId || decision.outcome !== "approved" || documentRevokedDecisionIds(events).has(decision.decisionId)
      || Date.parse(intent.deadlineAt) <= Date.now()) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    this.documents.snapshot(decision.evidenceSha256); host.assertCurrent(item, intent); return intent;
  }
  baseline(item: AutoItem, host: Pick<AutoStartCaptureHost, "authenticate" | "assertCurrent">): AutoTaskBaseline {
    const intent = this.authorize(item, host);
    return { schemaVersion: "auto-task-baseline/v1", repoKey: item.project, repoRoot: item.repoRoot, ticket: item.ticket, branch: intent.branch.name,
      baseSha: intent.branch.baseSha, subjectSha256: intent.subjectSha256, decisionId: item.decisionId!, startSha256: item.startSha256! };
  }
}
