# PAP-296 — publication recovery implementation

Source checkout: `feature/PAP-296-document-publication-recovery` (ticket worktree).
Requirements/UAT: published PAP-296 package `pap-296-obsolete-publication-recovery/r001` in the external requirements artifact store.

## P1 — read-only diagnosis

`publication-diagnose(sha256,expectedRevision,operationId,decisionId)` resolves the exact retained intent and approval, observes derived destinations and ticket references under the common ticket mutex, and returns owner-derived observation coordinates/digest. Draft sources are not required. It neither retries publication nor prompts, appends, creates directories or changes ticket state. Original internal conflict cause remains explicitly unproven.

Only the native policy-profile caller with `document.package` selected is eligible for the additive recovery surface. Retained document profiles do not gain it. Physical observations reject aliases, unreadable/unsupported files, unsafe ownership, inconsistent/duplicate refs and all primaries. A safe nonprimary partial is evidence to preserve, not permission to publish obsolete bytes.

Checks: `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/document-publication-recovery.test.ts` — 12 passed; core typecheck passed. Initial test run exposed invalid fixture timestamps and a TypeScript stat-overload type; both corrected, then rerun. Source tests are disposable, not installed or live incident evidence.

## P2 — exact native retirement and terminal fence

`publication-retire` adds the original diagnosis coordinates plus `requestId`, `originalRequestSha256` and `observationSha256`. These hashes are comparisons, not authority. One native policy-only custom TUI decision defaults to Cancel and explains retained partials, permanent old-subject fencing and fresh corrected-content approval. No mutex spans operator input. The owner reauthenticates/reobserves under the common ticket mutex before consent issuance and settlement.

New append-only `retirement-consent` and `retired` event kinds keep original history unchanged. Consent/native observation snapshots are durable and discoverable through the journal; only terminal retirement releases its pending intent and permanently fences all publish/queue operation IDs for that subject. Exact issued requests replay with their ORIGINAL revision/coordinates; drift or changed caller/coordinates blocks. A pre-issuance crash is not a durable decision. A post-issuance crash leaves pending until exact owner rechecks succeed. There is no takeover/adoption or new-lineage bypass. Older parsers reject the additive kinds, rather than silently losing the fence; do not downgrade settled journals.

Checks: recovery suite 21 passed; actual-process retirement fault/race suite plus existing publication/service/process suites 23 passed; Pi native confirmation/retirement UI suite 11 passed. Core build/typecheck and Pi typecheck passed. Source process fixtures use synthetic caller/consent evidence, not authenticated installed human evidence. Pi SDK documentation reads were unavailable through the local content check; no bypass/copy was attempted. UI integration reuses the existing native dialog/custom-UI path without introducing a new SDK call.

## Remaining phase gates

P3: continuation/discovery/messages/compatibility and broader source validation. P4: independent candidate review/hosted CI plus separately authorized compatible installed qualification and genuine foreground trial. P5: separately authorized SAME-effect MVM-241 diagnosis/eligible recovery and dual-ticket handback. No source check establishes any of the latter observations.

No installation, active configuration changes, live MVM journal/ticket mutations, stale publication retry, worker launch, checkout repair/return, push/merge/deployment or ticket closure is performed by this implementation session.
