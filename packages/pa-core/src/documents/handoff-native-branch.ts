import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { TicketStore } from "../tickets/store.js";
import { creationDigest } from "../tickets/create-intent.js";
import { handoffMaterializedLink } from "../tickets/handoff-intent.js";
import type { RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "./handoff-contract.js";
import { completeHandoffBranch, handoffBranchOperationId, RegistryHandoffBranchJournal, type HandoffBranchHost } from "./handoff-branch.js";
import { RegistryHandoffGitOwner } from "./handoff-git.js";

/** Native authority remains a separate owner. In particular, callers cannot
 * supply legacy receipts/outcomes here. A future selected review/publication
 * adapter must implement these exact new-subject checks before any activation. */
export type NativeHandoffBranchAuthority = Pick<HandoffBranchHost, "authenticate" | "assertAvailable" | "assertDecision" | "assertPublished" | "assertLocalCaller">;
/** Actual Git + SQLite + TicketStore composition; pinned create or authenticated
 * advanced-descendant reuse. Internal,
 * unregistered and NOT an alternative to the missing selected decision owner. */
export function completeNativeHandoffBranch(db: Database.Database, store: TicketStore, authority: NativeHandoffBranchAuthority,
  rawSubject: HandoffReviewSubject, rawIntent: HandoffBranchIntent, document: DocumentPackage, decisionId: string, planIdentity: { scope: string; requestId: string },
  boundary?: (stage: "intent" | "ticket" | "audit") => void,
  /** Trusted finite successor owner only; executes while the SAME repository ->
   * ticket exclusions still hold. Never exposed as tool/request callback data. */
  afterVerified?: () => void, admission?: RepositoryRefAdmission): Record<string, unknown> {
  const subject = parseHandoffReviewSubject(rawSubject), intent = parseHandoffBranchIntent(rawIntent), subjectSha256 = handoffReviewSubjectSha(subject);
  const operationId = handoffBranchOperationId(subjectSha256, decisionId), gitOwner = new RegistryHandoffGitOwner(db), journal = new RegistryHandoffBranchJournal(db);
  return gitOwner.withRepository(intent, operationId, git => store.withWorkflowTransaction(() => {
    const plan = store.inspectHandoffWithIntent(planIdentity);
    if (!plan?.complete || plan.record.change.kind !== "plan" || handoffBranchIntentSha(plan.record.change.intent) !== handoffBranchIntentSha(intent)) documentReject("DOCUMENT_AUTHORITY");
    const linkIdentity = { scope: subjectSha256, requestId: `branch-link-${operationId}` };
    const headSha = intent.action === "reuse" ? intent.lineage!.observedHeadSha : intent.base.sha;
    if (intent.action === "reuse") {
      const previous = plan.record.before.linkedBranches[0];
      if (!previous || previous.state !== "materialized" || previous.baseSha !== intent.base.sha || !previous.headSha || previous.sha !== previous.headSha
        || !git.isAncestor(previous.headSha, headSha)) documentReject("DOCUMENT_CONFLICT");
    }
    const change = { kind: "materialize", planKey: plan.record.key, operationId, headSha } as const;
    const expectedLink = handoffMaterializedLink(plan.record, intent, headSha);
    const current = () => {
      const ticket = store.get(intent.ticket);
      if (!ticket || ticket.project !== intent.repository.key || ticket.linkedBranches.length !== 1) documentReject("DOCUMENT_CONFLICT");
      return ticket;
    };
    const inspectLink = () => {
      const ticket = current(), original = store.inspectHandoffWithIntent(linkIdentity);
      if (original) {
        if (original.record.actor !== "documents/handoff" || !isDeepStrictEqual(original.record.change, change)
          || !isDeepStrictEqual(original.record.before.linkedBranches, plan.record.after.linkedBranches)
          || !isDeepStrictEqual(original.record.after.linkedBranches, [expectedLink])) documentReject("DOCUMENT_CONFLICT");
        if (!original.complete) {
          if (![creationDigest(original.record.before), creationDigest(original.record.after)].includes(creationDigest(ticket))) documentReject("DOCUMENT_UNCERTAIN");
          // Visible fields without the original audit are not completed linkage.
          return { version: original.record.expectedVersion, link: null };
        }
        if (!isDeepStrictEqual(ticket.linkedBranches, [expectedLink])) documentReject("DOCUMENT_CONFLICT");
      } else if (!isDeepStrictEqual(ticket.linkedBranches, plan.record.after.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
      return { version: creationDigest(ticket), link: isDeepStrictEqual(ticket.linkedBranches, [expectedLink]) ? expectedLink : null };
    };
    const assertWritable = () => {
      const ticket = current();
      const scope = [["requirement-review", "requirements/team-manager"], ["pending-approval", "sinh"],
        ...(subject.schemaVersion === "pa-handoff-review/v1" ? [["idea", "sinh"]] : [])];
      if (!scope.some(([status, assignee]) => ticket.status === status && ticket.assignee === assignee)) documentReject("DOCUMENT_CONFLICT");
      store.assertHandoffMaterializationSettled(intent.ticket, subjectSha256, operationId);
      inspectLink();
    };
    const authorize = () => {
      const caller = authority.authenticate();
      if (subject.schemaVersion === "pa-handoff-review/v2") {
        if (!authority.assertLocalCaller) documentReject("DOCUMENT_AUTHORITY");
        authority.assertLocalCaller(subject, intent);
      } else if (caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256) documentReject("DOCUMENT_AUTHORITY");
      assertWritable();
      authority.assertAvailable(intent); authority.assertDecision(subjectSha256, decisionId); authority.assertPublished(subject.documentSubjectSha256);
      const observed = git.observe();
      if (observed.state !== "present" || observed.headSha !== headSha || !(observed.owner.kind === "operation" && observed.owner.id === operationId
        || observed.owner.kind === "lineage" && intent.action === "reuse" && observed.owner.sha256 === intent.lineage!.operationSha256)) documentReject("DOCUMENT_UNCERTAIN");
    };
    const result = completeHandoffBranch(journal, {
      ...authority, serialize: run => run(), observeRef: () => git.observe(), createRef: () => git.create(), isAncestor: (base, head) => git.isAncestor(base, head),
      // These preconditions run before intent/ref-intent and again before every
      // remaining write. Completed observation deliberately skips write scope.
      assertAvailable(value) { assertWritable(); authority.assertAvailable(value); },
      inspectLink,
      materializeLink(_intent, expectedVersion, link) {
        if (link.baseSha !== intent.base.sha || link.headSha !== change.headSha || link.sha !== change.headSha) documentReject("DOCUMENT_CONFLICT");
        store.applyHandoffWithIntent(intent.ticket, expectedVersion, change, "documents/handoff", linkIdentity, {
          assertCurrent: authorize,
          assertSnapshot() { authorize(); current(); },
          afterPersist: boundary,
        });
      },
    }, subject, intent, document, decisionId);
    const successor: unknown = afterVerified?.();
    if (successor instanceof Promise) void successor.catch(() => {});
    if (successor !== undefined) documentReject("DOCUMENT_AUTHORITY");
    return result;
  }), undefined, admission);
}
