# Separately authorized content publication

PAP-327 P2 publishes an exact, already signed content-only document package.
Signing still stops at **Approved · Not published**. Publishing requires a
separate native foreground confirmation and does not ask for the unchanged
content signature again. There is no automatic follow-on effect.

## Native entry points

A fresh Pi session must have `document.local-review`, `document.handoff` and
`document.package` in its immutable selection. Native process/session and ticket
association are authenticated independently of the saved content decision.
Neither chat approval nor a JSON boolean, outcome, identity, path, root, effect
mask or tracking receipt is publication authority.

Send `pa_handoff` a strict request, using the complete issued `review:…` value:

```json
{"schemaVersion":"pa-content-publication/v1","action":"authorize","reference":"review:…"}
```

The example reference is a placeholder, not a runnable reference. `authorize`
displays the exact ticket, package revision and destination, with **Cancel**
first/default. The separate confirmation authorizes only that publication.
This remains local confirmation; authenticated human identity is not provided.
It does not publish by itself. Repeating an issued authorization reuses it.

Then explicitly request `publish` with the same schema and reference. There
are no decision IDs, request keys or authority fields for the caller to assemble.
A verified result contains the original `contentDecisionId` and `operationId`;
branch and queue are `not-performed`, launch readiness is false, and product UAT
is not asserted.

`status(reference)` reads saved authority, content eligibility and original
operation state. A saved completed record is historical evidence, not fresh
physical verification. `publish(reference)` rechecks physical evidence even for
completed replay. All these actions also have `pa_document` aliases:

| `pa_handoff` action | `pa_document` action and fields |
|---|---|
| `authorize` | `content-publication-authorize(reference)` |
| `publish` | `content-publish(reference)` |
| `status` | `content-publication-status(reference)` |
| `revoke` | `content-revoke(reference)` |
| `supersede` | `content-supersede(reference, successorReference)` |

PPA remains the existing guided signing/discovery client; this change adds no
PPA publication command or HTTP effect endpoint. Retained combined handoff,
document confirmation, CLI JSON and API contracts remain separate. A content
reference still cannot satisfy their combined-scope `approved()` checks.

## Admission and write order

The original `RegistryHandoffReviewJournal.contentSubject()` and canonical
requested/issued events remain unchanged. Separate publication authority and
monotonic eligibility fences are appended to that same native event chain.
Publication intent/completion use the existing `handoff_review_effects` owner
and deterministic original operation identity. There is no second ledger,
workflow controller or broad effect endpoint.

Before any remaining effect, admission rechecks the native caller and immutable
selection, saved origin, repository/ticket custody, ticket lifecycle/assignee,
exact target and predecessor provenance, physical sources, immutable snapshots,
and full worker-verified reader delivery. Repository exclusion precedes the
TicketStore mutex; no UI is held under those locks. A fresh selected continuation
requires ended origin/authority processes with native registry and process
identity evidence. Live or uncertain origins, other live ticket owners and
retained repository custody block continuation rather than being reclaimed.

The existing `HandoffPublicationService` and `TicketPackagePublication` perform:

1. Full source/delivery and target observation, including the complete structured
   tracking-ref conflict check, before attachment writes.
2. Durable original publication intent before publication files or ticket refs.
3. Absent-only derived tracking JSON and all entry, member HTML, raw and manifest
   attachment refs. Readback must match exact bytes and typed nonprimary refs.
4. Exact package files and all typed member refs, initially nonprimary.
5. Fresh admission plus complete file/ref readback before promoting the sole
   requirements primary. Unrelated refs and predecessor historical files/refs
   remain; only the old primary flag is demoted.
6. Exact final observation and completion of the original operation.

No branch/ref creation, ticket link, queue, status/assignee change, resource
allocation, runner invocation, checkout or implementation launch is performed.
A runner is not required for Publish.

## Interruption and eligibility

After lost replies or partial work, preserve the same reference, authority,
operation and existing files/refs. Reopening `status` does not repair them.
The original owner must establish unknown/conflicting state and arrange any
separately authorized correction before continuation. Do not replace an intent,
blindly retry, delete evidence or repeat the unchanged content signature.

A re-admitted `publish` observes and reuses exact existing partials without
rewriting them. Conflicting or unknown files/refs block; they are not overwritten.
After the primary is already proven complete, a lost completion reply settles
only the original native record and does not repeat ticket writes.

`revoke` and `supersede` require their own native foreground lifecycle
confirmation, not an imported outcome. Supersession names an exact active
approved higher revision of the same repository/ticket/package; no “latest” is
selected. These operations fence **unperformed** publication effects, including
partial continuations, and preserve completed effects and original decisions.
A successor cannot evade an unresolved predecessor operation. Completed truth
may be observed/settled after a fence, but cannot authorize any missing write.
Fenced reviews remain inspectable and are omitted from eligible discovery.

## Verification limits

Disposable source tests cover separate native authority, canonical decision
reuse, strict grammar and bounded plain-text blockers; authority/intent/tracking/
primary/completion reply loss; partial attachments and pre-primary interruption;
source/delivery/ref/lifecycle/caller/custody failures; mid-partial revocation,
supersession, predecessor/unrelated history, and fresh selected continuation.
Retained publication/recovery and registered Pi/CLI routes are tested separately.

These are source and synthetic native-UI tests, not installed runtime
qualification, actual foreground operator acceptance, independent review,
browser/screen-reader evidence, hosted CI or human UAT. No live ticket or database
repair, installation, managed policy selection or rollout is authorized here.
