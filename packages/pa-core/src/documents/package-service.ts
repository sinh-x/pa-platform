import { randomUUID } from "node:crypto";
import { confirmDocument, type NativeDocumentConfirmationRequest, type NativeDocumentConfirmationResult } from "./confirmation-service.js";
import { presentDocumentPackage } from "./presentation.js";
import { closeSync, lstatSync, opendirSync } from "node:fs";
import { dirname } from "node:path";
import { AdvisoryFiles } from "../operations/files.js";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { openArtifactDirectory, readArtifactFile } from "../artifacts/manifest.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { documentDecisionRecords, documentRevokedDecisionIds, documentCompletedOperation, documentPending, type DocumentDecision, type DocumentIntent, type RegistryDocumentJournal } from "../registry/documents.js";
import type { TicketStore } from "../tickets/store.js";
import { TicketPackagePublication } from "../tickets/package-publication.js";
import type { OperationResult } from "../operations/result.js";
import { digest, ID, integer, JsonWorkflowError, object, relativePath, SHA256, text, workflowTicket } from "../workflows/contracts.js";
import { DocumentPackageError, documentGuard, documentPackageSha, documentReject, DOCUMENT_ACTION_FIELDS, DOCUMENT_LIMITS, parseDocumentPackage, parseDocumentRequest, type DocumentPackage } from "./package-contract.js";
import { checkDocumentPackage, compareDocumentPackages, documentText, readDocumentSources, validateDocumentBytes } from "./package-tools.js";

export interface DocumentCaller { deploymentId: string; repoKey: string; repoRoot: string; ticket: string | null; identitySha256: string; sessionId?: string }
export interface DocumentPackageHost {
  artifactRoot: string; tickets: TicketStore;
  /** Native launch dispatch only, not imported package/request metadata. */
  workspaceProfile?: boolean;
  confirmationProfile?: boolean;
  confirm?(request: NativeDocumentConfirmationRequest): Promise<NativeDocumentConfirmationResult>;
  authenticate(): DocumentCaller;
  /** Actual retained workflow/resource owners, rechecked inside ticket mutex. */
  assertEffectAvailable(subject: DocumentPackage): void;
  /** Trusted native foreground adapter only. No public JSON outcome/principal port. */
  capture(request: { subject: DocumentPackage; sha256: string; brief: string; action: "capture" | "revoke"; decisionId?: string }): Promise<{ outcome: DocumentDecision["outcome"]; principal: string; evidenceSha256: string; nativeEvidence: Uint8Array }>;
}
/** Supporting operations, not a workflow controller: no next-step selection. */
export class DocumentPackageService {
  private readonly publication: TicketPackagePublication;
  constructor(private readonly journal: RegistryDocumentJournal, private readonly host: DocumentPackageHost) { this.publication = new TicketPackagePublication(host.tickets, host.artifactRoot); }
  private caller(subject?: DocumentPackage): DocumentCaller {
    const caller = this.host.authenticate();
    if (subject && (caller.repoKey !== subject.repository.key || caller.repoRoot !== subject.repository.root || (caller.ticket !== null && caller.ticket !== subject.ticket))) documentReject("DOCUMENT_AUTHORITY");
    if (subject && this.host.tickets.get(subject.ticket)?.project !== subject.repository.key) documentReject("DOCUMENT_AUTHORITY");
    return caller;
  }
  private subject(sha: unknown): DocumentPackage { const subject = this.journal.subject(text(sha, SHA256)); this.caller(subject); return subject; }
  private events(subject: DocumentPackage) { return this.journal.events(subject.repository.key, subject.ticket); }
  private revision(subject: DocumentPackage, expected: unknown): number {
    const revision = integer(expected, 0, 1023); if (this.events(subject).length !== revision) documentReject("DOCUMENT_CONFLICT"); return revision;
  }
  private approved(subject: DocumentPackage, decisionId: string, operation?: "publish" | "queue"): DocumentDecision {
    const events = this.events(subject), sha256 = documentPackageSha(subject);
    const latest = documentDecisionRecords(events, sha256).at(-1);
    const decision = latest?.decisionId === decisionId && !documentRevokedDecisionIds(events).has(decisionId) ? latest : undefined;
    if (!decision || decision.outcome !== "approved") documentReject("DOCUMENT_AUTHORITY");
    if ("confirmationVersion" in decision) {
      if (decision.confirmationVersion !== "pa-document-confirmation/v1" || operation && (decision.scope === "content" || operation === "queue" && decision.scope !== "publish-and-queue")) documentReject("DOCUMENT_AUTHORITY");
      this.journal.snapshot(decision.evidenceSha256);
    }
    return decision;
  }
  private predecessor(subject: DocumentPackage): DocumentPackage | undefined {
    if (!subject.predecessor) return undefined;
    const previous = this.journal.subject(subject.predecessor);
    if (previous.repository.key !== subject.repository.key || previous.repository.root !== subject.repository.root || previous.ticket !== subject.ticket || documentPackageSha(previous) === documentPackageSha(subject)) documentReject("DOCUMENT_AUTHORITY");
    if (!documentCompletedOperation(this.events(subject), subject.predecessor, "publish")) documentReject("DOCUMENT_AUTHORITY");
    return previous;
  }
  private view(subject: DocumentPackage): Record<string, unknown> {
    const events = this.events(subject), sha256 = documentPackageSha(subject);
    const revoked = documentRevokedDecisionIds(events);
    return { sha256, expectedRevision: events.length, package: subject, decisions: documentDecisionRecords(events, sha256).map(d => ({ decisionId: d.decisionId, outcome: d.outcome, evidenceSha256: d.evidenceSha256, revoked: revoked.has(d.decisionId), ...("confirmationVersion" in d ? { confirmationVersion: d.confirmationVersion, scope: d.scope } : {}) })).slice(-32),
      ...(this.host.confirmationProfile ? { confirmations: this.confirmations(events).filter(c => c.sha256 === sha256) } : {}),
      pending: documentPending(events), results: events.flatMap(e => e.data.kind === "result" && e.data.subjectSha256 === sha256 ? [{ revision: e.revision, ...e.data }] : []).slice(-16),
      snapshotRef: `registry-document-package:${sha256}`, approvalIsAcceptance: false };
  }
  private confirmations(events: ReturnType<RegistryDocumentJournal["events"]>) {
    return events.flatMap(e => e.data.kind === "confirmation" ? [{ decisionId: e.data.decisionId, sha256: e.data.subjectSha256, outcome: e.data.outcome, operation: e.data.operation, scope: e.data.scope, expectedRevision: e.revision - 1, revokes: e.data.revokes, linkage: "inspect-or-reconcile-same-request" }] : []).slice(-32);
  }
  async execute(raw: string): Promise<Record<string, unknown>> {
    let requestedAction: string | undefined;
    try {
      const r = parseDocumentRequest(raw), action = text(r.action); requestedAction = action;
      // Validate exact action shape before any operation. No extra keys or imported grants.
      const fields = DOCUMENT_ACTION_FIELDS;
      if (!Object.hasOwn(fields, action)) documentReject();
      documentGuard(() => object(r, ["action", ...fields[action]!]));
      try { assertNoSensitiveMatch("content", raw); } catch { documentReject("DOCUMENT_INPUT"); }
      const caller = this.caller(); let result: unknown;
      if (action === "capabilities") result = { snapshot: "available", check: "structural-only", compare: "available", context: "selected-file-or-directory-only",  template: "use-pa-template-unsigned", capture: this.host.confirmationProfile && this.host.confirm ? "pi-native-confirmation/v1-use-confirm" : this.host.workspaceProfile ? "unavailable-host-attestation-required" : "native-foreground", publish: "owner-checked-per-call", queue: "owner-checked-per-call", preview: this.host.workspaceProfile ? "safe-static-html-companion" : "unavailable-use-markdown", workflowRequired: false, sourceWriting: false };
      else if (action === "status") {
        const ticket = workflowTicket(r.ticket);
        if ((caller.ticket !== null && caller.ticket !== ticket) || this.host.tickets.get(ticket)?.project !== caller.repoKey) documentReject("DOCUMENT_AUTHORITY");
        const events = this.journal.events(caller.repoKey, ticket);
        const record = this.host.tickets.get(ticket)!;
        const handoff = this.host.workspaceProfile ? { handoff: {
          association: caller.ticket === null ? "caller-unassociated" : "caller-associated",
          queue: record.status === "pending-implementation" && record.assignee === "builder/team-manager" ? "recorded-pending-implementation" : "not-recorded-pending-implementation",
          branchEvidence: !record.linkedBranches?.length ? "absent" : record.linkedBranches.length === 1 ? "recorded-unverified" : "multiple-recorded-unverified",
          branchBridge: "unsupported-ticket-launcher-owner-required", custody: "not-observed", launchReady: false,
        } } : {};
        result = { ticket, ...handoff, ...(this.host.confirmationProfile ? { confirmations: this.confirmations(events) } : {}), expectedRevision: events.length, snapshots: events.flatMap(e => e.data.kind === "frozen" ? [{ sha256: e.data.subjectSha256, registryRevision: e.revision }] : []).slice(-64), pending: documentPending(events), historyIsBounded: true };
      } else if (action === "ticket-create") {
        const title = text(r.title, undefined, 256), tag = `document-intake-${text(r.intakeId, ID)}`;
        if (typeof r.content !== "string" || !r.content.trim() || Buffer.byteLength(r.content) > 32768 || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(r.content)) documentReject();
        const description = r.content;
        result = this.host.tickets.withWorkflowTransaction(() => {
          if (!isDeepStrictEqual(caller, this.caller())) documentReject("DOCUMENT_STALE");
          const existing = this.host.tickets.list({ project: caller.repoKey, tags: [tag] });
          if (existing.length > 1) documentReject("DOCUMENT_UNCERTAIN");
          if (existing.length === 1) {
            if (existing[0]!.title !== title || existing[0]!.description !== description) documentReject("DOCUMENT_CONFLICT");
            return { ticket: existing[0], reused: true, packageApproval: "not-issued" };
          }
          if (caller.ticket !== null) documentReject("DOCUMENT_AUTHORITY");
          const ticket = this.host.tickets.create({ project: caller.repoKey, title, description, type: "feature", priority: "medium", status: "requirement-review", assignee: "requirements/team-manager", tags: [tag], summary: "", estimate: "M", from: "", to: "", blockedBy: [], doc_refs: [], comments: [] }, "documents/tickets");
          return { ticket, reused: false, packageApproval: "not-issued" };
        });
      } else if (action === "draft") {
        const path = relativePath(r.path);
        if (!path.startsWith(`agent-teams/requirements/artifacts/drafts/${caller.deploymentId}/`) || !/\.(?:md|txt)$/.test(path) || typeof r.content !== "string" || !r.content.length || /[\p{Cs}]/u.test(r.content)) documentReject();
        const expected = r.expectedSha256 === null ? null : text(r.expectedSha256, SHA256), bytes = Buffer.from(r.content), sha256 = digest(bytes);
        validateDocumentBytes({ id: "draft", role: "specification", mediaType: "text/plain", source: path, description: "unsigned draft", bytes: bytes.length, sha256 }, bytes);
        result = this.host.tickets.withWorkflowTransaction(() => {
          if (!isDeepStrictEqual(caller, this.caller())) documentReject("DOCUMENT_STALE");
          const files = new AdvisoryFiles(this.host.artifactRoot);
          let current: string | null = null;
          try { lstatSync(join(this.host.artifactRoot, path)); current = digest(readArtifactFile(join(this.host.artifactRoot, path), DOCUMENT_LIMITS.textBytes, "ARTIFACT_STALE")); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") documentReject("DOCUMENT_SOURCE"); }
          if (current !== expected) documentReject("DOCUMENT_CONFLICT");
          files.file(dirname(path), undefined, true); files.file(path, r.content as string);
          return { path, sha256, bytes: bytes.length, state: "unsigned-agent-authored-draft" };
        });
      } else if (action === "discover") {
        const path = r.path === "." ? "." : relativePath(r.path);
        if (path !== ".") { try { assertNoSensitiveMatch("path", path); } catch { documentReject("DOCUMENT_INPUT"); } }
        const fd = openArtifactDirectory(join(caller.repoRoot, path), "ARTIFACT_STALE"), entries: { name: string; kind: string }[] = [];
        let scanned = 0;
        try {
          const dir = opendirSync(`/proc/self/fd/${fd}`);
          try {
            for (let entry = dir.readSync(); entry && scanned < 256; entry = dir.readSync()) {
              scanned++;
              if (entry.name.toLowerCase() === ".git" || (!entry.isFile() && !entry.isDirectory())) continue;
              try { assertNoSensitiveMatch("filename", entry.name); assertNoSensitiveMatch("path", join(path, entry.name)); } catch { continue; }
              entries.push({ name: entry.name, kind: entry.isFile() ? "file" : "directory" });
              if (entries.length >= 128) break;
            }
          } finally { dir.closeSync(); }
        } finally { closeSync(fd); }
        result = { path, entries, bounded: true, possiblyMore: entries.length >= 128 || scanned >= 256, remoteFetch: false };
      } else if (action === "context") {
        const path = relativePath(r.path); if (path.split("/").some(p => p.toLowerCase() === ".git")) documentReject();
        try { assertNoSensitiveMatch("path", path); assertNoSensitiveMatch("filename", path.split("/").at(-1)!); } catch { documentReject("DOCUMENT_INPUT"); }
        const bytes = readArtifactFile(join(caller.repoRoot, path), DOCUMENT_LIMITS.textBytes, "ARTIFACT_STALE"), content = documentText(bytes);
        try { assertNoSensitiveMatch("content", content); } catch { documentReject("DOCUMENT_SOURCE"); }
        this.caller(); result = { path, sha256: digest(bytes), bytes: bytes.length, content: content.slice(0, 16000), excerpt: content.length > 16000, source: "selected-local-file", fetched: false };
      } else if (action === "check" || action === "freeze") {
        const subject = parseDocumentPackage(r.package); this.caller(subject);
        const bytes = readDocumentSources(subject, this.host.artifactRoot), checks = checkDocumentPackage(subject, bytes);
        if (action === "check") result = checks;
        else { const expected = this.revision(subject, r.expectedRevision); this.caller(subject); this.journal.freeze(subject, expected, bytes); result = { ...this.view(subject), checks, state: "unapproved-snapshot" }; }
      } else {
        const subject = this.subject(r.sha256), sha256 = documentPackageSha(subject);
        if (action === "show") result = this.view(subject);
        else if (action === "present") {
          if (!this.host.workspaceProfile) documentReject("DOCUMENT_UNAVAILABLE");
          result = presentDocumentPackage(subject, this.host.artifactRoot, hash => this.journal.snapshot(hash));
        } else if (action === "read") {
          const member = subject.members.find(m => m.id === text(r.path, ID)); if (!member) documentReject();
          const bytes = this.journal.snapshot(member.sha256), offset = integer(r.offset, 0, DOCUMENT_LIMITS.textBytes);
          const content = member.mediaType.startsWith("text/") ? documentText(bytes) : "";
          result = { member, ...(member.mediaType.startsWith("text/") ? { content: content.slice(offset, offset + 8000), nextOffset: offset + 8000 < content.length ? offset + 8000 : null } : { content: "opaque image; no execution or automatic preview" }) };
        } else if (action === "compare") {
          const previous = this.subject(r.previousSha256);
          if (previous.ticket !== subject.ticket) documentReject("DOCUMENT_AUTHORITY");
          result = compareDocumentPackages(previous, subject, hash => this.journal.snapshot(hash));
        } else if (action === "confirm" || action === "confirm-revoke") {
          result = await confirmDocument(this.journal, this.host, subject, () => this.caller(subject), r);
        } else if (action === "capture" || action === "revoke") {
          // No source label, model narrative or caller event ID is an attested
          // human input. Do not silently fall back to v1 select dialogs in v2.
          if (this.host.workspaceProfile) documentReject("DOCUMENT_UNAVAILABLE");
          const expectedRevision = this.revision(subject, r.expectedRevision), before = this.caller(subject);
          if (action === "revoke") this.approved(subject, text(r.decisionId, ID));
          const bytes = readDocumentSources(subject, this.host.artifactRoot);
          const briefIndex = subject.members.findIndex(m => m.role === "brief"), brief = documentText(bytes[briefIndex]!);
          if (Buffer.byteLength(brief) > 16384 || brief.trim().split(/\s+/).length > 1000) documentReject("DOCUMENT_INPUT");
          const capture = await this.host.capture({ subject, sha256, brief, action, ...(action === "revoke" ? { decisionId: text(r.decisionId, ID) } : {}) });
          if (digest(capture.nativeEvidence) !== capture.evidenceSha256) documentReject("DOCUMENT_AUTHORITY");
          if (!isDeepStrictEqual(before, this.caller(subject))) documentReject("DOCUMENT_STALE");
          readDocumentSources(subject, this.host.artifactRoot); this.revision(subject, expectedRevision);
          this.host.tickets.withWorkflowTransaction(() => {
            if (!isDeepStrictEqual(before, this.caller(subject))) documentReject("DOCUMENT_STALE");
            readDocumentSources(subject, this.host.artifactRoot); this.revision(subject, expectedRevision);
            if (action === "revoke") {
              if (capture.outcome === "approved") this.journal.append(subject.repository.key, subject.ticket, expectedRevision, { kind: "revoked", subjectSha256: sha256, decisionId: text(r.decisionId, ID), evidenceSha256: capture.evidenceSha256 }, [capture.nativeEvidence]);
            } else {
              this.journal.append(subject.repository.key, subject.ticket, expectedRevision, { kind: "decision", subjectSha256: sha256, decisionId: `decision-${randomUUID()}`, outcome: capture.outcome, principal: capture.principal, evidenceSha256: capture.evidenceSha256, callerIdentity: before.identitySha256 }, [capture.nativeEvidence]);
            }
          });
          result = { ...this.view(subject), outcome: capture.outcome };
        } else {
          const expectedRevision = this.revision(subject, r.expectedRevision), decisionId = text(r.decisionId, ID);
          if (action !== "publish" && action !== "queue") documentReject();
          if (action === "queue" && !subject.effects.queue) documentReject("DOCUMENT_AUTHORITY");
          const operationId = `effect-${digest(JSON.stringify([sha256, decisionId, action]))}`;
          // Serialize intent, external effects and completion with ALL ticket writers.
          result = this.host.tickets.withWorkflowTransaction(() => {
            this.revision(subject, expectedRevision); this.caller(subject); this.host.assertEffectAvailable(subject);
            let events = this.events(subject), pending = documentPending(events);
            if (pending.some(i => i.operationId !== operationId)) documentReject("DOCUMENT_UNCERTAIN");
            const predecessor = this.predecessor(subject);
            const authorize = () => { this.caller(subject); this.host.assertEffectAvailable(subject); this.approved(subject, decisionId, action); readDocumentSources(subject, this.host.artifactRoot); };
            const completed = events.some(e => e.data.kind === "result" && e.data.operationId === operationId && e.data.outcome === "completed");
            const proven = action === "publish" ? this.publication.observe(subject, predecessor) === "complete" : this.publication.queued(subject, predecessor);
            if (completed || (pending.some(i => i.operationId === operationId) && proven)) {
              if (!proven) documentReject("DOCUMENT_CONFLICT");
              // Observation-only settlement of an already-issued intent is not
              // a new permission grant; revocation cannot erase completed facts.
              if (!completed) this.journal.append(subject.repository.key, subject.ticket, events.length, { kind: "result", subjectSha256: sha256, operationId, outcome: "completed", code: "OBSERVED_COMPLETE" });
              return { ...this.view(subject), operationId, outcome: "completed", reused: true };
            }
            authorize();
            if (action === "queue" && (!documentCompletedOperation(events, sha256, "publish") || this.publication.observe(subject, predecessor) !== "complete")) documentReject("DOCUMENT_AUTHORITY");
            if (!pending.length) {
              const intent: DocumentIntent = { operationId, operation: action, subjectSha256: sha256, decisionId };
              this.journal.append(subject.repository.key, subject.ticket, events.length, { kind: "intent", ...intent });
            }
            try {
              if (action === "publish") this.publication.publish(subject, hash => this.journal.snapshot(hash), authorize, predecessor);
              else this.publication.queue(subject, authorize, predecessor);
              events = this.events(subject);
              this.journal.append(subject.repository.key, subject.ticket, events.length, { kind: "result", subjectSha256: sha256, operationId, outcome: "completed", code: "COMPLETED" });
              return { ...this.view(subject), operationId, outcome: "completed", reused: false };
            } catch (error) {
              events = this.events(subject);
              const code = error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNCERTAIN";
              this.journal.append(subject.repository.key, subject.ticket, events.length, { kind: "result", subjectSha256: sha256, operationId, outcome: "unknown", code });
              throw error;
            }
          });
        }
      }
      const facts: Pick<OperationResult, "completion" | "outcome" | "enforcement" | "capability" | "required"> = {
        completion: "completed", outcome: (result as { structuralPass?: boolean } | undefined)?.structuralPass === false ? "failed" : "unknown", enforcement: "allowed", capability: "available", required: false,
      };
      return { schemaVersion: "pa-document-result/v1", ok: true, action, result, facts, executionAdmitted: false };
    } catch (error) {
      const code = error instanceof DocumentPackageError ? error.code : error instanceof JsonWorkflowError ? "DOCUMENT_INPUT" : error instanceof Error && error.name === "ArtifactPolicyError" ? "DOCUMENT_SOURCE" : "DOCUMENT_UNCERTAIN";
      const facts: Pick<OperationResult, "completion" | "outcome" | "enforcement" | "capability" | "required"> = {
        completion: "error", outcome: "unknown", enforcement: ["DOCUMENT_AUTHORITY", "DOCUMENT_CONFLICT"].includes(code) ? "denied" : "allowed", capability: code === "DOCUMENT_UNAVAILABLE" ? "unavailable" : "available", required: false,
      };
      const unattestedCapture = this.host.workspaceProfile && code === "DOCUMENT_UNAVAILABLE" && (requestedAction === "capture" || requestedAction === "revoke");
      const guidance = unattestedCapture ? { guidance: "Package decision not started; safe authoring and presentation remain available.\nCondition: This new-profile decision request cannot issue authority.\nSource: Native human-input provenance check (DOCUMENT_UNAVAILABLE).\nReason: The Pi host does not supply the required attested original human-event identity. Chat text or another approval dialog cannot repair this capability gap.\nCorrection: Ask the Pi host/runtime maintainer to provide supported attested-event capture. Impact: none for this request. Actor: agent or operator. New approval: not required to ask; implementation and activation need their own authority. Prerequisite: preserve the current package and prior decisions.\nResume Action: Request capture only after supported host capability and exact-package checks are available; admission is rechecked. Do not substitute a tool-supplied outcome or upgrade retained sessions." } : {};
      return { schemaVersion: "pa-document-result/v1", ok: false, code, facts, ...guidance, correctionOwner: unattestedCapture ? "pi-human-input-host-owner" : code === "DOCUMENT_AUTHORITY" ? "native-owner" : "document-operation-owner", scope: "this-operation-only", executionAdmitted: false };
    }
  }
}
