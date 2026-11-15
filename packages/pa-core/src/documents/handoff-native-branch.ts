import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { TicketStore } from "../tickets/store.js";
import { creationDigest } from "../tickets/create-intent.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffReviewSubject, type HandoffBranchIntent, type HandoffReviewSubject } from "./handoff-contract.js";
import { completeHandoffBranch, handoffBranchOperationId, RegistryHandoffBranchJournal, type HandoffBranchHost, type HandoffMaterializedLink } from "./handoff-branch.js";
import { RegistryHandoffGitOwner } from "./handoff-git.js";

/** Native authority remains a separate owner. In particular, callers cannot
 * supply legacy receipts/outcomes here. A future selected review/publication
 * adapter must implement these exact new-subject checks before any activation. */
export type NativeHandoffBranchAuthority = Pick<HandoffBranchHost, "authenticate" | "assertAvailable" | "assertDecision" | "assertPublished">;
/** Actual Git + SQLite + TicketStore composition; pinned create or authenticated
 * advanced-descendant reuse. Internal,
 * unregistered and NOT an alternative to the missing selected decision owner. */
export function completeNativeHandoffBranch(db: Database.Database, store: TicketStore, authority: NativeHandoffBranchAuthority,
  rawSubject: HandoffReviewSubject, rawIntent: HandoffBranchIntent, document: DocumentPackage, decisionId: string, planIdentity: { scope: string; requestId: string },
  boundary?: (stage: "intent" | "ticket" | "audit") => void): Record<string, unknown> {
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
    const change = { kind: "materialize", planKey: plan!.record.key, operationId, headSha } as const;
    const authorize = () => {
      const caller = authority.authenticate();
      if (caller.identitySha256 !== subject.callerIdentitySha256 || caller.selectionSha256 !== subject.selectionSha256) documentReject("DOCUMENT_AUTHORITY");
      authority.assertAvailable(intent); authority.assertDecision(subjectSha256, decisionId); authority.assertPublished(subject.documentSubjectSha256);
      const observed = git.observe();
      if (observed.state !== "present" || observed.headSha !== headSha || !(observed.owner.kind === "operation" && observed.owner.id === operationId
        || observed.owner.kind === "lineage" && intent.action === "reuse" && observed.owner.sha256 === intent.lineage!.operationSha256)) documentReject("DOCUMENT_UNCERTAIN");
    };
    const current = () => {
      const ticket = store.get(intent.ticket);
      if (!ticket || ticket.project !== intent.repository.key || ticket.linkedBranches.length !== 1 || ticket.linkedBranches[0]!.repo !== intent.repository.key || ticket.linkedBranches[0]!.branch !== intent.branch) documentReject("DOCUMENT_CONFLICT");
      return ticket!;
    };
    return completeHandoffBranch(journal, {
      ...authority, serialize: run => run(), observeRef: () => git.observe(), createRef: () => git.create(), isAncestor: (base, head) => git.isAncestor(base, head),
      inspectLink() {
        const ticket = current(), original = store.inspectHandoffWithIntent(linkIdentity);
        if (original && !original.complete) {
          if (!isDeepStrictEqual(original.record.change, change) || ![creationDigest(original.record.before), creationDigest(original.record.after)].includes(creationDigest(ticket))) documentReject("DOCUMENT_UNCERTAIN");
          // Missing audit is not complete linkage, even if candidate fields are
          // visible. Re-enter the SAME ticket operation, with its original CAS.
          return { version: original.record.expectedVersion, link: null };
        }
        return { version: creationDigest(ticket), link: ticket.linkedBranches[0]!.state === "materialized" ? ticket.linkedBranches[0] as HandoffMaterializedLink : null };
      },
      materializeLink(_intent, expectedVersion, link) {
        if (link.baseSha !== intent.base.sha || link.headSha !== change.headSha || link.sha !== change.headSha) documentReject("DOCUMENT_CONFLICT");
        store.applyHandoffWithIntent(intent.ticket, expectedVersion, change, "documents/handoff", linkIdentity, {
          assertCurrent: authorize,
          assertSnapshot() { authorize(); current(); },
          afterPersist: boundary,
        });
      },
    }, subject, intent, document, decisionId);
  }));
}
