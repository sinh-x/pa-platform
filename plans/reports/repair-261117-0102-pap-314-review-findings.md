# PAP-314 transport/reader repair evidence

Both independently reproduced P2 findings are repaired. Workspace typecheck/build and all 65 focused tests pass.

## Executed phase

- Scope: only the two findings in `plans/reports/code-review-261117-0102-pap-314-transport-reader.md`; bounded P1/P2 repair, not P3 acceptance.
- Checkout: `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`, branch `feature/PAP-314-requirements-review-approval`, HEAD `f5b47f58ef81c38f9f28e4775109a0e575e8fbe1` plus owned unstaged repairs.
- Evidence recorded: 2026-11-17, Asia/Saigon. Commands used `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`.
- Read `AGENTS.md`, `docs/cli-message-standard.md`, the P0 contract `docs/PAP-314-local-review-contract.md`, and the review report. Local-unverified confirmation remains deliberately unauthenticated; PAPC-090 remains separate.
- Moving P3 owner source/tests and plan state were not inspected or edited. Existing unrelated changes were left alone. No commits, staging or live database mutations occurred.

## Files modified

Paths below are relative to the checkout above. Counts are additions/deletions against HEAD; all six files were clean at task start.

| Path | Added / removed |
| --- | --- |
| `packages/pi-pa/src/local-review-cli.ts` | +47 / -3 |
| `packages/pi-pa/src/local-review-server.ts` | +4 / -1 |
| `packages/pi-pa/src/__tests__/local-review-cli.test.ts` | +76 / -0 |
| `packages/pi-pa/src/__tests__/local-review-server.test.ts` | +27 / -2 |
| `packages/pa-core/src/documents/reader.ts` | +13 / -3 |
| `packages/pa-core/src/__tests__/document-reader-summary.test.ts` | +54 / -0 |

This new Markdown evidence file is the only additional authored path. No other plan/report was updated.

## Tasks completed

- [x] Reproduced the transport regression before editing production code: actual source CLI returned `LOCAL_REVIEW_INTERNAL` instead of `DOCUMENT_INPUT`; default HTTP returned 500 instead of 400. Isolated actual typed-error propagation also failed.
- [x] Registered only verified, allowlisted actual imported `DocumentPackageError` causes at `executeCoreLocalReview`'s trusted import boundary. Native-error detection, exact prototype identity and an own data descriptor avoid traversing proxies or evaluating exception getters/prose. Public formatting uses private WeakMap registrations and fixed bounded text.
- [x] Preserved `DOCUMENT_INPUT`, `DOCUMENT_SOURCE`, `DOCUMENT_CONFLICT`, `DOCUMENT_STALE`, `DOCUMENT_AUTHORITY`, `DOCUMENT_UNCERTAIN` and `DOCUMENT_UNAVAILABLE`. CLI failures retain exit 1, one stdout JSON result and empty stderr. HTTP uses 400 for input, 403 for authority, 409 for source/conflict/stale/uncertainty and 503 for unavailability. Arbitrary exceptions, lookalikes, proxies, accessor codes and unknown codes remain sanitized `LOCAL_REVIEW_INTERNAL` / HTTP 500.
- [x] Used the default actual dispatcher, not an injected successful owner, for malformed JSON, duplicate fields and unknown `actor` fields in both source CLI and HTTP tests. Disposable roots remained empty. Separate module-isolated tests retain the real exported error constructor and throw all seven typed causes through both transports; hostile getter/proxy trap count is zero.
- [x] Kept genuinely unknown/possible partial results unknown. Uncertainty guidance preserves original coordinates and evidence, forbids blind replay/replacement intents and delegates reconciliation to the existing owner. No effect, approval or admission owner changed.
- [x] Reproduced the reader collision before editing production code: the canonical requirements link targeted the wrong member.
- [x] Reserved all canonical full source paths before relative/short aliases. Canonical entries cannot be overwritten; conflicting noncanonical aliases become inert, and duplicate basenames do not acquire short aliases.
- [x] Added the repeated-base collision fixture in four inventory orders. Assertions verify the intended member ID and raw source bytes in executive, complete and standalone views, not merely destination existence. Three additional orders verify ambiguous short names remain literal while intended relative/canonical links remain correct.

## Message review

Affected category/path: thrown document-owner blockers through `executeCoreLocalReview`, `runLocalReviewCommand` and `POST /v1/review`. Help, listener information, returned owner records, transport-only failures and stdout/stderr contracts were not rewritten.

- **Before:** forbidden input produced `LOCAL_REVIEW_INTERNAL`, “The operation did not return a usable result. Its outcome is unproven,” and HTTP 500.
- **After:** it produces `DOCUMENT_INPUT`, “Local review request was rejected,” followed by the fixed schema/fields/values cause and HTTP 400. Correction asks the operator to inspect the original request; this has no effect, requires no new approval to ask and preserves evidence. Resumption requires correction and owner-verified current state, with admission checked again.
- **Uncertain after:** `DOCUMENT_UNCERTAIN` says “Local review outcome remains unknown. Do not repeat the request yet.” It never claims nothing changed or that rollback occurred. Arbitrary possible-partial errors retain the original generic unproven-outcome path.

Structural tests cover all seven new causes: one each of Condition/Source/Reason/Correction/Resume Action, complete message length at most 2,000 JavaScript characters, no arbitrary exception details, and zero hostile traps. Agent plain-text inspection is not human readability acceptance.

## Verification

All commands below exited 0 after repair. The same selected regression commands failed before repair as described above.

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='source public CLI\|trusted core throws\|default dispatcher' src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts` | Before: 0/3 passed, exit 1. After: 3/3 passed. |
| `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 --test-name-pattern='canonical full source\|ambiguous short aliases' src/__tests__/document-reader-summary.test.ts` | Before: canonical collision failed; ambiguous-name check passed, exit 1. After: 2/2 passed. |
| `corepack pnpm --filter @pa-platform/pa-core typecheck` | Passed. |
| `corepack pnpm typecheck` | Passed across the workspace. |
| `corepack pnpm build` | Passed across the workspace; built workers were refreshed before reader suites. |
| `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts` | 29 passed; none failed/skipped. |
| `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-reader-summary.test.ts src/__tests__/document-reader.test.ts` | 21 passed; none failed/skipped. |
| `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-reader-worker.test.ts src/__tests__/document-reader-opening.test.ts` | 15 passed; none failed/skipped. |
| `git diff --check -- <the six owned source/test paths above>` | Passed. |

Builds reported the expected dirty-tree warning. Tests use Node's experimental module mocks for isolated typed throws and existing experimental mock timers; these emitted no failing results. No standalone lint script is defined in the root or affected package manifests. No TODO/FIXME remains in the owned files.

## Limits and next steps

Full workspace tests, coverage measurement, installed qualification, hosted CI, browser/accessibility checks and actual human readability/UAT were not run or claimed. Focused reader publication/opening tests use their existing disposable fixtures; the collision fixture is entirely in memory. P3/P4/P5 acceptance and PAPC-090 activation remain with their owners. No unresolved implementation question or ownership conflict remains for these two repairs.

Status: DONE
Summary: Fixed only the verified transport cause-loss and reader alias-redirection defects, with red/green regression evidence and 65 passing focused tests. Workspace typecheck and build pass.
