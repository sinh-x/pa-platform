# Native ticket comment admission

PAP-345 scopes ordinary **append** admission; it does not relax status, update,
workflow takeover, comment edit/delete or execution admission. Both Pi comment
forms use authenticated caller attribution, not the legacy `author` as identity.

## Recovery-owner inventory (base 360795301936)

All cooperating ticket effects use `TicketStore.withWorkflowTransaction` and the
same filesystem mutex. The comment must check compatibility inside that mutex,
including the final pre-write authentication/privacy fence. Never reconcile
another operation as a side effect of a comment.

| Existing owner / sources | Recovery predicate | Comment classification |
| --- | --- | --- |
| `tickets/store.ts` creation (`create-intent.ts`) | Until the exact creation audit exists, current ticket must equal the reserved candidate | Defer incomplete creation on target; allow audit-complete history and unrelated reservations |
| Status (`status-intent.ts`) | Missing exact keyed audit requires current full snapshot equal to original before/after | Defer at intent-only and ticket-written/audit-pending points, including no-op status intents; allow complete history |
| Planning (`planning-intent.ts`) | Exact before/after and keyed audit | Same defer/permit rule |
| Handoff (`handoff-intent.ts`) | Exact before/after, keyed audit plus original snapshot callbacks | Same defer/permit rule |
| Auto-draft (`auto-draft-append.ts`) | Exact before/after, artifact identity and keyed audit | Same defer/permit rule |
| Workflow `publication.pair@v1` / `ticket.queue@v1` (`workflows/ticket-owner.ts`, `tickets/paired-publication.ts`) | Exact member bytes, refs/primary, status/assignment and specific status/assignment audit history; not complete ticket bytes | Compatible even while pending: comment changes none of these predicates; updates reread current ticket under mutex |
| Workflow `source.local@v1` / `check.matrix@v1` (Pi source/matrix owners) | Protected execution/source/validation evidence, caller and workflow intent coordinates | Compatible: append changes none of those inputs; grants no source/check authority |
| Workflow `decision.package@v1` | Native decision capture; no ticket snapshot write | Compatible; no approval imported |
| Document publish/queue (`documents/package-service.ts`, `tickets/package-publication.ts`) | Member bytes, refs/primary, lifecycle/assignment; result correlates original operation ID | Compatible even while pending; recovery reads latest ticket and preserves comments |
| Ordinary legacy ticket writer | Synchronous read/modify/write and audit under same mutex, no retained full-snapshot intent | Serialize, never overwrite a pre-lock snapshot |
| Registry deployment liveness / retained settled workflow | Not a comment recovery predicate | Do not probe liveness or infer conflict from ownership alone |
| Corrupt/unreadable journal, audit or target-dependent intent; unsupported pending operation/version | Compatibility unproven | Specific no-write comment refusal, preserving original evidence for its owner |

The store's existing settlement check owns full-snapshot intent/audit validation.
Workflow and document journals remain the authorities for replay; no new ledger,
database or shadow writer is introduced. Malformed local evidence whose ticket
cannot be established conservatively defers; valid unrelated pending intents do
not. Completed operations remain historical after later comments.

## Failure and concurrency contract

Append starts from the latest serialized ticket, changes only `comments` and
`updatedAt`, and changes its whole-ticket version. Intervening comments invalidate
an already-inspected status/update precondition; no silent rebasing. Two valid
identical-text comments are distinct requests, not content-deduplicated retries.

A conflicting original intent must be reconciled by its original owner with its
original request ID, expected version and payload. Comments do not settle or
rename it. A refused pre-write append must not alter ticket, audit or intent.
Successful append requires ticket and audit readback. Unknown persistence is not
success or permission to replay: inspect authoritative ticket/audit after a lost
acknowledgement and do not automatically submit another append.

## Qualification boundaries

Core helper tests, Pi native tool tests, built-candidate tests, exact installed
PPA/Pi qualification, independent review and human acceptance are separate
observations. A source test is not an installed qualification. Disposable fixtures
must isolate tickets, registry, process identity and configuration from live data.
