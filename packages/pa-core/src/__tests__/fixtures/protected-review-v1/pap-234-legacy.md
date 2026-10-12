# Isolated historical-shape copy (not authority)

### Full Validation Matrix

Matrix Source:
- `requirements:agent-teams/requirements/artifacts/fixture-pap-234-legacy.md`

Matrix Authority:
- Hash raw UTF-8 bytes from this unique heading through immediately before `## 13. Implementation Plan`, including this heading and all internal whitespace, with no normalization.
- A missing, duplicate, stale, or conflicting boundary, digest, or approval blocks review before project commands.

Execution Owner:
- One independent `requirements/review-auto` deployment consumes one one-use Review Authorization ID formatted as `review-auth:` plus a lowercase canonical UUIDv4.
- Before spawn, the builder orchestrator persists one durable launch intent binding ticket `FIX-237`, branch `feature/FIX-237-ticket-worktree-selection`, one 40-lowercase-hex Feature SHA, this Matrix Source, this matrix digest, durable Matrix Approval Evidence, and the authorization.
- Objective, report, and registry evidence must agree exactly. One authorization may match at most one review deployment, and any active review for this ticket and branch blocks another launch across all Feature SHAs, matrix revisions, and authorizations.

Prerequisites:
- Linux x86_64 execution host with Node.js `>=22`, Corepack, pnpm `10.28.0`, Git, Bash, and the repository's locked dependencies installed from `pnpm-lock.yaml`.
- Authenticated builder ticket checkout for `pa-platform`, on `feature/FIX-237-ticket-worktree-selection`, with `HEAD` equal to the launch-intent Feature SHA and no unrelated changes.
- Candidate implementation and generated completion files committed before independent review.
- Treehouse integration tests use bounded test doubles; no external credentials or network access are required.

Environment:
- `CI=1` — select non-interactive command behavior.
- `TZ=UTC` — make time-sensitive test output deterministic.
- Working directory: authenticated FIX-237 checkout root.
- Existing protected `PA_*` deployment values remain unchanged; the commands do not require additional secrets.

Commands (run in this exact order):
1. `env CI=1 TZ=UTC corepack pnpm --filter @pa-platform/pa-core build`
2. `env CI=1 TZ=UTC corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/deploy-cli-repository.test.ts src/__tests__/execution-plan.test.ts src/__tests__/registry.test.ts src/__tests__/primer.test.ts`
3. `env CI=1 TZ=UTC corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-treehouse.test.ts src/__tests__/pi-deploy.test.ts`
4. `env CI=1 TZ=UTC corepack pnpm typecheck`
5. `env CI=1 TZ=UTC corepack pnpm build`
6. `env CI=1 TZ=UTC corepack pnpm test`
7. `env CI=1 TZ=UTC corepack pnpm completions && git diff --exit-code -- completions/pa-core.fish completions/ppa.fish completions/opa.fish completions/cpa.fish completions/dpa.fish`
8. `git diff --check`
9. `corepack pnpm secrets:scan`

Pass Criteria:
- Commands Total: 9; Commands Passed MUST equal 9 (100% completion), in the listed order, at the pinned candidate Feature SHA.
- Every command exits with status 0. The targeted and full test outputs report zero failed tests; typecheck and build report no errors; completion generation leaves the five listed tracked files byte-identical; `git diff --check` emits no defect; the secrets scan reports zero findings.
- Required outputs are updated package build artifacts from the build commands, TAP results for targeted and full suites, generated Fish completions, and the independent review report bound to the launch intent. No additional artifact may substitute for a failed command.
- Independent review requires `HEAD == Feature SHA`, unresolved `Critical = 0`, and unresolved `Major = 0`. Every accepted or deferred Minor finding includes a ticket-linked rationale and owner.
- Project guides may inform defaults but cannot override, append to, delete from, or conflict with this matrix.

## After Matrix

Fixture only. No historical migration or approval.
