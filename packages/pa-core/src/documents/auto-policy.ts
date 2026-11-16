import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { documentAutoPolicyAdoption, documentAutoPolicyEpoch, documentAutoPolicyPending, type DocumentAutoPolicyReview } from "../registry/document-auto-policy.js";
import { AutoWaitlistError, type AutoProject } from "../auto/waitlist.js";
import { digest, object, SHA256, strictJson, text } from "../workflows/contracts.js";
import { autoPolicyTime, parseAutoDelegationPolicy, type AutoDelegationPolicy } from "./auto-policy-contract.js";

export interface NativeAutoPolicyHost {
  readonly domain: string;
  authenticate(): string;
  now(): string;
  clock(): { bootId: string; nowNs: string };
  propose(): AutoDelegationPolicy;
  /** Native current source/config/model/resource/repository/check owners. Not a
   * caller-supplied passed flag. Must be synchronous and rechecked on use. */
  assertCurrent(policy: AutoDelegationPolicy): void;
  /** Actual unmanaged foreground UI, default Cancel. No receipt import port. */
  capture(request: DocumentAutoPolicyReview, policy: AutoDelegationPolicy): Promise<Uint8Array>;
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function sync<T>(value: T): T { if (value instanceof Promise) { void value.catch(() => {}); throw new AutoWaitlistError("AUTO_UNAVAILABLE"); } return value; }
/** R003 extension of the existing native document-decision owner. This scope is
 * NOT a content/publication/queue/manual start receipt, activation, selection or
 * resource/custody/worker grant. Effect owners must admit every later boundary. */
export class AutoDelegationPolicyService {
  constructor(readonly documents: RegistryDocumentJournal, private readonly afterStage?: (stage: "requested" | "captured" | "observed" | "issued") => void) {}
  private identity(host: NativeAutoPolicyHost): string { text(host.domain, SHA256); return text(sync(host.authenticate()), SHA256); }
  private events(host: Pick<NativeAutoPolicyHost, "domain">) { return this.documents.autoPolicyEvents(host.domain); }
  policy(sha: string): AutoDelegationPolicy { return parseAutoDelegationPolicy(this.documents.snapshot(sha)); }
  private current(policy: AutoDelegationPolicy, host: NativeAutoPolicyHost): void {
    this.identity(host);
    if (digest(JSON.stringify(policy.domain)) !== host.domain || sync(host.assertCurrent(structuredClone(policy))) !== undefined) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    this.time(policy, host);
  }
  private time(policy: AutoDelegationPolicy, host: NativeAutoPolicyHost): void {
    const clock = sync(host.clock()), now = autoPolicyTime(sync(host.now()));
    if (now < autoPolicyTime(policy.createdAt) || now >= autoPolicyTime(policy.expiresAt) || clock.bootId !== policy.clock.bootId || !/^\d{1,30}$/.test(clock.nowNs)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const elapsed = BigInt(clock.nowNs) - BigInt(policy.clock.startedNs);
    if (elapsed < 0n || elapsed >= BigInt(autoPolicyTime(policy.expiresAt) - autoPolicyTime(policy.createdAt)) * 1000000n) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  }
  status(domain: string) {
    const events = this.documents.autoPolicyEvents(domain), adoption = documentAutoPolicyAdoption(events), pending = documentAutoPolicyPending(events);
    return { schemaVersion: "pa-auto-policy-status/v1", observed: true, eligibility: "not-rechecked", revision: events.length,
      lastDecision: events.filter(e => e.data.phase === "issued").at(-1)?.data ?? null,
      issuedAdoption: adoption, policy: adoption ? this.policy(adoption.policySha256) : null, pendingReviews: pending,
      executionRequested: false, executionAdmitted: false, activationRequested: false };
  }
  /** Resolve the original actual native adoption afresh. The result is NOT a
   * substitute for the later document/lifecycle/source/check/launcher owners. */
  authorize(host: NativeAutoPolicyHost, expected?: { decisionId: string; policySha256: string; expiresAt: string }, project?: AutoProject) {
    this.identity(host); const events = this.events(host), adoption = documentAutoPolicyAdoption(events);
    if (!adoption || documentAutoPolicyPending(events).length) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const policy = this.policy(adoption.policySha256), reference = { decisionId: adoption.decisionId, policySha256: adoption.policySha256, expiresAt: policy.expiresAt };
    if (expected && !isDeepStrictEqual(reference, expected) || project && !policy.repositories.some(repo => repo.key === project)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    // Re-resolve the actual issued/observed/capture lineage. Public JSON records
    // and old per-ticket receipts cannot provide any of these native records.
    const observed = events.find(e => e.data.reviewId === adoption.reviewId && e.data.phase === "observed")?.data;
    const requested = events.find(e => e.data.reviewId === adoption.reviewId && e.data.phase === "requested")?.data;
    if (!requested || !observed || requested.operation !== "adopt" || requested.policySha256 !== adoption.policySha256 || !observed.evidenceSha256
      || this.documents.autoPolicyCapture(host.domain, adoption.reviewId) !== observed.evidenceSha256 || !isDeepStrictEqual({ ...observed, phase: "issued", recordedAt: adoption.recordedAt }, adoption)) throw new AutoWaitlistError("AUTO_SOURCE");
    this.documents.snapshot(observed.evidenceSha256); this.current(policy, host);
    if (documentAutoPolicyEpoch(this.events(host)) !== documentAutoPolicyEpoch(events) || documentAutoPolicyPending(this.events(host)).length) throw new AutoWaitlistError("AUTO_BUSY");
    this.time(policy, host); return { reference, policy };
  }
  async adopt(host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    this.identity(host); const pending = documentAutoPolicyPending(this.events(host));
    if (pending.length) {
      if (pending.length !== 1 || pending[0]!.operation !== "adopt") throw new AutoWaitlistError("AUTO_BUSY");
      return this.resume(pending[0]!, host);
    }
    const active = documentAutoPolicyAdoption(this.events(host));
    if (active) {
      try { this.authorize(host); return active; }
      catch (error) { if (!(error instanceof AutoWaitlistError)) throw error; }
    }
    const policy = parseAutoDelegationPolicy(bytes(sync(host.propose()))); this.current(policy, host);
    return this.request("adopt", policy, null, host);
  }
  async revoke(host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    this.identity(host); const pending = documentAutoPolicyPending(this.events(host));
    if (pending.length) {
      if (pending.length !== 1 || pending[0]!.operation !== "revoke") throw new AutoWaitlistError("AUTO_BUSY");
      return this.resume(pending[0]!, host);
    }
    const active = documentAutoPolicyAdoption(this.events(host)); if (!active) {
      const prior = this.events(host).filter(e => e.data.phase === "issued").at(-1)?.data;
      if (prior?.operation === "revoke" && prior.outcome === "approved") return prior;
      throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    }
    // Permission removal remains available after configuration drift/expiry.
    return this.request("revoke", this.policy(active.policySha256), active.decisionId, host);
  }
  async withdraw(host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    this.identity(host); const pending = documentAutoPolicyPending(this.events(host));
    if (!pending.length) {
      const prior = this.events(host).filter(e => e.data.phase === "issued").at(-1)?.data;
      if (prior?.operation === "withdraw" && prior.outcome === "approved") return prior;
    }
    if (pending.length !== 1) throw new AutoWaitlistError("AUTO_BUSY");
    // Each EXPLICIT operator withdrawal is distinct. It cannot issue the unknown
    // original adoption/revocation. Unknown withdrawal attempts remain history.
    return this.request("withdraw", this.policy(pending[0]!.policySha256), pending[0]!.reviewId, host);
  }
  private request(operation: DocumentAutoPolicyReview["operation"], policy: AutoDelegationPolicy, target: string | null, host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    const identity = this.identity(host), sha = digest(bytes(policy));
    if (digest(JSON.stringify(policy.domain)) !== host.domain) throw new AutoWaitlistError("AUTO_SOURCE");
    const record = this.documents.autoPolicyTransaction(() => {
      if (this.identity(host) !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); if (operation === "adopt") this.current(policy, host);
      const events = this.events(host), requested: DocumentAutoPolicyReview = { schemaVersion: "pa-auto-policy-review-record/v1", reviewId: `review-${randomUUID()}`, decisionId: `decision-${randomUUID()}`,
        operation, policySha256: sha, target, baselineSha256: documentAutoPolicyEpoch(events), phase: "requested", callerIdentity: identity, recordedAt: host.now(), evidenceSha256: null, outcome: null, principal: null, interactionId: null };
      this.documents.appendAutoPolicy(host.domain, events.length, requested, [bytes(policy)]); return requested;
    });
    this.afterStage?.("requested"); return this.capture(record, host);
  }
  private async capture(request: DocumentAutoPolicyReview, host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    const identity = this.identity(host); if (identity !== request.callerIdentity) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const raw = await host.capture(structuredClone(request), this.policy(request.policySha256));
    // Actual ORIGINAL native UI bytes are saved before mutable checks/issuance.
    // Invalid capture cannot grant; its immutable bytes and request remain held.
    this.documents.captureAutoPolicy(host.domain, request.reviewId, raw); this.afterStage?.("captured");
    if (this.identity(host) !== identity) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return this.resume(request, host);
  }
  private async resume(input: DocumentAutoPolicyReview, host: NativeAutoPolicyHost): Promise<DocumentAutoPolicyReview> {
    this.identity(host); let record = this.events(host).filter(e => e.data.reviewId === input.reviewId).at(-1)!.data;
    if (record.phase === "requested") {
      const sha = this.documents.autoPolicyCapture(host.domain, record.reviewId); if (!sha) throw new AutoWaitlistError("AUTO_BUSY");
      let e: Record<string, unknown>;
      try { e = object(structuredClone(strictJson(this.documents.snapshot(sha), 65536)), ["schemaVersion", "method", "reviewId", "decisionId", "operation", "policySha256", "target", "principal", "interactionId", "outcome", "boundary"]); }
      catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
      // The registry owner verifies every binding and exact evidence schema.
      const observed = { ...record, phase: "observed" as const, evidenceSha256: sha, outcome: e.outcome as "approved" | "cancelled", principal: e.principal as string, interactionId: e.interactionId as string, recordedAt: host.now() };
      this.documents.appendAutoPolicy(host.domain, this.events(host).length, observed); record = observed; this.afterStage?.("observed");
    }
    if (record.phase === "issued") return record;
    if (record.operation === "adopt" && record.outcome === "approved") this.current(this.policy(record.policySha256), host);
    const issued = this.documents.autoPolicyTransaction(() => {
      this.identity(host); const same = this.events(host).filter(e => e.data.reviewId === record.reviewId).at(-1)!.data;
      if (same.phase === "issued") return same;
      if (record.operation === "adopt" && record.outcome === "approved") this.current(this.policy(record.policySha256), host);
      const next = { ...same, phase: "issued" as const, recordedAt: host.now() };
      this.documents.appendAutoPolicy(host.domain, this.events(host).length, next); return next;
    });
    this.afterStage?.("issued"); return issued;
  }
}
