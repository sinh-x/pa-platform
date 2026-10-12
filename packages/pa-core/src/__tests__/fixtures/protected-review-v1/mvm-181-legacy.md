# Isolated historical-shape copy (not authority)

### Full Validation Matrix

Matrix Source:
- `requirements:agent-teams/requirements/artifacts/fixture-mvm-181-legacy.md` is the sole authoritative full-validation matrix source.

Matrix Authority:
- `Matrix Authority SHA-256` hashes the raw UTF-8 bytes beginning at this unique heading and ending immediately before `## 13. Implementation Plan`, including this heading and internal whitespace, with no normalization.
- `Matrix Approval Evidence` must be a durable Sinh comment on FIX-237 naming the exact Matrix Source and digest. Missing, stale, duplicate, or conflicting authority blocks review before project commands.

Execution Owner:
- One independent `requirements/review-auto` deployment consumes one one-use Review Authorization ID formatted as `review-auth:` plus a lowercase canonical UUIDv4. Before spawn, the trusted orchestrator persists one launch intent binding FIX-237, the exact branch, one 40-lowercase-hex Feature SHA, this Matrix Source and digest, Matrix Approval Evidence, and authorization. `HEAD` must equal Feature SHA. One authorization may be consumed by at most one review deployment, and any active review for this ticket/branch blocks another launch.

Prerequisites:
- Authenticated clean reviewer checkout for `work-andafit-movement` on `feature/FIX-237-reconcile-sqlite-wal-sidecars`; approved base `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` is an ancestor, repository `HEAD` equals the launch-bound Feature SHA, and `git status --porcelain` is empty.
- Node.js `>=22.0.0`, npm, Bash, Python 3, Git, `jq`, GNU-compatible `sha256sum`, `flock`, and Docker with BuildKit are available.
- Backend and frontend dependencies are installed from committed lockfiles; `backend/test-secrets.example` is present.
- Docker can build and run isolated local containers. No live AWS credentials, production EFS mount, production database, or production confirmation value is available or permitted.
- Tests use disposable temporary SQLite databases and external temporary evidence directories only.

Environment:
- `FEATURE_SHA` — exactly one launch-bound 40-lowercase-hex implementation SHA recorded in durable launch intent; it must equal `HEAD`.
- `APPROVED_BASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` — exact approved fresh-route base.
- `NODE_ENV=test`, `TZ=UTC`, and `DOCKER_BUILDKIT=1` — deterministic test and rehearsal settings.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_PROFILE` are unset for all commands.

Commands (run in this exact order):
1. `test "$(git rev-parse HEAD)" = "$FEATURE_SHA" && test "$APPROVED_BASE_SHA" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" && git merge-base --is-ancestor "$APPROVED_BASE_SHA" HEAD && test -z "$(git status --porcelain)"`
2. `command -v node npm bash python3 git jq sha256sum flock docker >/dev/null && npm --prefix backend ls --depth=0 >/dev/null && npm --prefix frontend ls --depth=0 >/dev/null`
3. `git diff --check "$APPROVED_BASE_SHA"...HEAD`
4. `node scripts/version-control.mjs validate`
5. `bash scripts/pre-push-gates.sh`
6. `npm --prefix backend run typecheck`
7. `npm --prefix backend run lint`
8. `npm --prefix backend run build`
9. `cd backend && NODE_ENV=test TZ=UTC node --import tsx --test test/production-database-sqlite-adapter.test.ts test/production-schema-migration-chain.test.ts test/production-database-contract.test.ts`
10. `bash scripts/tests/test_manage-production-db.sh`
11. `bash scripts/tests/test_decoupled_production_workflows.sh`
12. `bash scripts/tests/test_deploy-production-app.sh`
13. `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE DOCKER_BUILDKIT=1 bash scripts/tests/run_decoupled_production_rehearsal.sh`
14. `python3 scripts/tests/audit_decoupled_production_runbooks.py`
15. `npm --prefix backend test`
16. `NODE_ENV=test JWT_SECRET="$(printf 'mvm181-review-%032d' 0)" npm --prefix backend run test:production-startup`
17. `test -z "$(git status --porcelain)" && git diff --check "$APPROVED_BASE_SHA"...HEAD`

Pass Criteria:
- Commands Total: 17; Commands Passed MUST equal 17 (100% completion), in order, with exit status 0 at the pinned Feature SHA.
- Required outputs: version validation names the synchronized release tuple; pre-push gates print `pre-push-gates: all gates green.`; TypeScript, ESLint, focused tests, full backend tests, build, and production startup report zero failures; shell suites print `manage-production-db generalized migration checks passed`, `decoupled production cross-workflow checks passed`, and `deploy-production-app independent workflow checks passed`; Docker rehearsal prints its PASS terminator and a checksummed evidence path; runbook audit prints `decoupled production runbook audit: PASS`.
- Focused evidence proves the exact empty-WAL/32-KiB-SHM incident fixture, committed non-empty WAL preservation, exactly one verified retained backup for schema no-op and nonempty chains, exclusive stopped-writer admission, successful TRUNCATE checkpoint plus temporary DELETE mode, zero direct production-sidecar deletion, equal before/after logical/schema/data identity, sidecar-free receipt publication, interruption-safe refusal, and serving startup restoration to WAL.
- Unsafe writer, checkpoint-busy, unsafe-sidecar, corruption, foreign-key, backup, identity-drift, mode-transition, and interruption cases publish no receipt, invoke zero application operations, and retain bounded next-action evidence.
- Review findings require `Critical = 0` and `Major = 0`; every accepted or deferred Minor finding includes a written rationale in the review report.

Matrix rules:
- Phase checks do not add to or replace this matrix. Project guides may inform implementation but cannot override, append to, delete from, or conflict with these commands.
- Review admission fails before commands if Feature SHA, `HEAD`, ticket, branch, matrix digest, approval evidence, launch intent, authorization format/uniqueness, or active-review exclusion does not match exactly.

## After Matrix

Fixture only. No historical migration or approval.
