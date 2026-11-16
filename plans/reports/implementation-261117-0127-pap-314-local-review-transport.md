## Phase Implementation Report

The P1 CLI/local HTTP transport slice is implemented and its 27 focused tests pass. Core, Pi handoff/tool, PAPC and installed qualification remain outside this slice.

### Executed Phase
- Phase: PAP-314 P1, CLI/local HTTP transport only.
- Plan: `plans/261117-PAP-314-requirements-review-approval/plan.md`.
- Status: completed for the assigned transport ownership; the shared P1 checklist is not marked complete on behalf of other owners.

### Files Modified
- `packages/pi-pa/src/local-review-cli.ts`: new, 200 lines.
- `packages/pi-pa/src/local-review-server.ts`: new, 178 lines.
- `packages/pi-pa/src/__tests__/local-review-cli.test.ts`: new, 224 lines.
- `packages/pi-pa/src/__tests__/local-review-server.test.ts`: new, 199 lines.
- `packages/pi-pa/src/cli.ts`: +4/-3 lines.
- `packages/pi-pa/src/document-cli.ts`: +11/-1 lines.
- This report is the only additional Markdown artifact. No other owned phase files were changed.

### Tasks Completed
- [x] Added `ppa document review --request-stdin`, `review serve --port N`, and help routing; retained existing synchronous description API.
- [x] Added a dedicated `node:http` listener bound only to numeric IPv4 loopback, with no agent API, file, shell, publication/ref/queue or authentication routes.
- [x] Enforced exact/unique Host and port, all-Origin rejection, exact paths/methods, JSON-only uncompressed bodies, strict UTF-8 and byte/header/socket/concurrency/deadline/response limits.
- [x] Added no-store JSON replies and typed, non-reflective five-label diagnostics bounded below 2,000 characters, including hostile exception tests.
- [x] Preserved pending core admission after timeout/disconnect until settlement; rejected pipelining rather than queueing it.
- [x] Tested source CLI propagation, explicit server startup/health/shutdown and negative cases without actual review decisions or store creation.

### Actual Interfaces
- `LocalReviewHandler = (raw: string) => Promise<Record<string, unknown>>`; inject through the command/server options' `handler` property.
- Production lazily loads and invokes the actual `executeLocalReview(raw)` export from `@pa-platform/pa-core`. Missing exports fail safely; there is no replacement owner or local approval ledger.
- `runLocalReviewCommand(args, io, { stdin?, handler? })` returns `Promise<number>`; `runDocumentCommand` dispatches it asynchronously. CLI machine replies contain one JSON document with no added prose. Exit is 1 for a transport failure or an owner result with `ok === false`; otherwise 0.
- `startLocalReviewServer({ port, handler?, deadlines? })` returns `Promise<http.Server>`. Port zero and shortened deadlines support disposable tests; the public CLI accepts only canonical decimal ports 1–65535 and has no limit overrides.
- POST `/v1/review` forwards decoded text unchanged, including JSON duplicates, to the shared strict-schema owner. JSON field/duplicate/depth-64 validation and version/capability/subject/decision admission remain core responsibilities, not a second transport parser.
- Completed owner records pass through with HTTP 200, including owner-domain failures. Transport rejection uses appropriate 4xx/5xx statuses and `{ ok: false, code: "LOCAL_REVIEW_…", message }`. Excess sockets are closed without admission.
- GET `/v1/health` returns exactly `{ schemaVersion: "pa-local-review/v1", trust: "local-unverified" }`, without invoking the handler or opening stores.
- Limits are 64 KiB input, 8 KiB headers, 16 sockets, one in-flight request/no queue, 5-second header/body/write deadlines, 30-second overall deadline and 32 MiB serialized output. Replies close the connection. An expired or disconnected core operation is not cancelled or rolled back.

### Tests Status
All commands ran in the assigned checkout with `TZ=Asia/Saigon` and `LANG=en_US.UTF-8`; focused tests additionally used `NO_COLOR=1`.

- **Pass, 27/27:** `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts`.
- **Pass, package typecheck:** `corepack pnpm --filter @pa-platform/pi-pa exec tsc -p tsconfig.json --noEmit`.
- **Pass, tests and transport strict typecheck:** `corepack pnpm --filter @pa-platform/pi-pa exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck src/local-review-cli.ts src/local-review-server.ts src/document-cli.ts src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts`.
- **Pass, package compiler build:** `corepack pnpm --filter @pa-platform/pi-pa exec tsc -p tsconfig.json --outDir "$build_dir"`, using a disposable `/tmp` directory removed afterward.
- **Pass:** scoped `git diff --check`, new-file trailing-whitespace checks, and production-source TODO/FIXME/type-suppression checks.
- Source subprocess tests verify help/error stdout and exit propagation, numeric loopback startup, store-free health, and graceful SIGTERM shutdown. All disposable listeners/children are closed. The isolated CLI fixture directories remain empty.
- Full workspace tests, installed verification, browser/UAT and actual core decision integration were not run. Package wrapper scripts were not run because the bundler rewrites non-owned `src/pi-extension` generated files. No separate lint command is defined in the inspected package scripts.

### Message Review
Affected categories are review/document discovery help, explicit listener-start information and transport blockers. Owner success/failure records are not rewritten.

- Before: document help advertised only `ppa document describe --format json` and no CLI approval.
- After: help also advertises `ppa document review --help`, explicitly states local decisions are unauthenticated and not human identity evidence, and excludes publication/ref/queue effects.
- Before: review arguments fell through to the generic unsupported-document prose on stderr.
- After: invalid review arguments return JSON on stdout with code `LOCAL_REVIEW_ARGUMENTS`; its decoded diagnostic starts “Local review did not return a complete result.” and contains exactly one Condition, Source, Reason, Correction and Resume Action.
- Inline plain-text review confirmed the exposure warning and uncertain-outcome guidance. Structural tests cover every typed cause, character bounds, ANSI/multiline/oversized synthetic private exceptions and hostile getters/proxies. This is not independent human readability or installed acceptance evidence.

### Issues Encountered
- The first package compiler check reported missing core-export/type errors outside ownership, alongside transport type errors that were fixed locally. The final package typecheck and compiler build both pass; no external source was changed to obtain those results.
- Node reports its expected experimental MockTimers warning for the deterministic CLI deadline test; all tests pass.
- No live delegation/team tool was exposed, so review was inline rather than an independent agent review.
- No dependencies, installs, PAPC changes, real approvals, live database mutations, staging or commits were performed. No ownership conflicts were observed.

### Next Steps
The core/Pi owners can integrate against the raw-string handler seam and the explicit `ok: false` CLI exit convention. Core remains responsible for strict JSON/schema validation and all review eligibility/decision provenance. PAPC-090 owns eventual external default selection; broader P1 and installed qualification are not claimed here.

Status: DONE
Summary: Implemented the assigned CLI and dedicated loopback HTTP transport with 27 passing focused tests, passing strict/package typechecks and a passing package compiler build.
Concerns/Blockers: No transport blocker remains. Actual core decisions, independent review and installed/default qualification remain separate owner evidence.
