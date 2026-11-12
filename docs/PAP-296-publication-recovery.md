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

## P3 — continuation, discovery and guidance

Corrected publication stays in the SAME package at a higher authored revision; alternate frozen lineages cannot bypass the retirement. The normal full-read/presentation/fresh native confirmation/publication/queue owners remain mandatory. `status`/`show` expose issued retirement request coordinates and terminal subjects. Diagnosis supports optional member `offset`, eight members per page; the observation digest binds the complete owner observation, not only a page. Metadata reads are bounded; oversized reference inventories block rather than imply absence.

Native policy tool/capability descriptions advertise recovery; retained profiles do not. The source-only interaction catalogue now separately inventories read-only diagnosis and state-changing retirement, with no invented CLI endpoint or installed binding. Changed dispatch snapshots were renewed after this semantic reconciliation (exports, policy-only dispatch, retirement callback and tool description/wrapping).

Changed human message paths/categories: diagnosis information, retirement result, returned recovery blockers and thrown Pi tool wrappers. Before: machine `DOCUMENT_CONFLICT`/unknown without recovery guidance. After blocker: “Publication recovery is not proven settled. Do not retry obsolete publication.” Five unique labels explain typed causes, read-only inspection and original-coordinate replay; raw exceptions are never included. After success: “The obsolete publication was retired. Existing partial files and references were kept; no old requirements were promoted. Next: review the corrected same-package revision for fresh approval.” Formatting is pure; machine codes/streams remain unchanged. Independent human readability acceptance is NOT RUN.

Actual checks:

- Workspace `corepack pnpm typecheck` and `corepack pnpm build`: passed (`/tmp/PAP-296-typecheck.log`, `/tmp/PAP-296-build.log`).
- Updated recovery suite: 24 passed, including corrected same-package fresh native approval and completed-publication observation-only settlement.
- Core package/integrity/confirmation/process plus catalogue focused run: 41 passed, one source-inventory guard failed. After reconciling the two additive operation entries and all four changed tracked dispatch sources, catalogue rerun: 6 passed (`/tmp/PAP-296-focused-core.log`, `/tmp/PAP-296-catalogue.log`).
- Pi native/session/confirmation/default-entry/recovery-entry/branch/policy focused run: 35 passed (`/tmp/PAP-296-focused-pi.log`). Native entry uses real disposable registry/process authentication with synthetic UI, NOT human UAT.
- `corepack pnpm completions`: passed; no generated completion changes.
- Full `corepack pnpm test`: interrupted by the 420-second command timeout; it reached 1,046 core cases and exposed the inventory guard above. It did NOT complete, and the full suite has NOT been rerun after reconciliation (`/tmp/PAP-296-test.log`). Do not treat focused passes as a full-suite pass.
- Staged secrets scan and whitespace checks run before each phase commit.

## P4/P5 — separate gates, not completed

Independent exact-candidate review, current hosted CI, a complete full-suite rerun, authorized compatible installation/current-policy qualification and a genuine foreground operator trial remain required. No installed recovery qualifier extension is claimed delivered. Original-owner replay intentionally rejects changed authenticated caller/session; no automatic takeover/adoption is supplied. Physical observations serialize cooperating ticket owners, not hostile same-UID writers.

P5 remains separately authorized SAME-effect MVM-241 diagnosis/eligible recovery and dual-ticket handback. Current live eligibility, original conflict cause, actual destination/ref state and current MVM journal revision remain unproven. No source check establishes those facts. Do not close PAP-296 or mark MVM-241 implementation-ready from these commits.

No installation, active configuration changes, live MVM journal/ticket mutations, stale publication retry, worker launch, checkout repair/return, push/merge/deployment or ticket closure is performed by this implementation session.
