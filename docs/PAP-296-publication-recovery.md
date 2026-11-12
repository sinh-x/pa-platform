# PAP-296 — publication recovery implementation

Source checkout: `feature/PAP-296-document-publication-recovery` (ticket worktree).
Requirements/UAT: published PAP-296 package `pap-296-obsolete-publication-recovery/r001` in the external requirements artifact store.

## P1 — read-only diagnosis

`publication-diagnose(sha256,expectedRevision,operationId,decisionId)` resolves the exact retained intent and approval, observes derived destinations and ticket references under the common ticket mutex, and returns owner-derived observation coordinates/digest. Draft sources are not required. It neither retries publication nor prompts, appends, creates directories or changes ticket state. Original internal conflict cause remains explicitly unproven.

Only the native policy-profile caller with `document.package` selected is eligible for the additive recovery surface. Retained document profiles do not gain it. Physical observations reject aliases, unreadable/unsupported files, unsafe ownership, inconsistent/duplicate refs and all primaries. A safe nonprimary partial is evidence to preserve, not permission to publish obsolete bytes.

Checks: `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/document-publication-recovery.test.ts` — 12 passed; core typecheck passed. Initial test run exposed invalid fixture timestamps and a TypeScript stat-overload type; both corrected, then rerun. Source tests are disposable, not installed or live incident evidence.

## Remaining phase gates

P2: native exact retirement consent, durable original-request replay, terminal journal event and permanent subject fence. P3: continuation/discovery/messages/compatibility and broader source validation. P4: independent candidate review/hosted CI plus separately authorized compatible installed qualification and genuine foreground trial. P5: separately authorized SAME-effect MVM-241 diagnosis/eligible recovery and dual-ticket handback. No source check establishes any of the latter observations.

No installation, active configuration changes, live MVM journal/ticket mutations, stale publication retry, worker launch, checkout repair/return, push/merge/deployment or ticket closure is performed by this implementation session.
