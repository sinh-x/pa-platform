# Isolated historical-shape copy (not authority)

### Full Validation Matrix

Matrix Source:
- `requirements:agent-teams/requirements/artifacts/fixture-mvm-179-legacy.md` is the one authoritative full-validation matrix source.

Matrix Authority:
- `Matrix Authority SHA-256` hashes the raw UTF-8 bytes beginning at this unique heading and ending immediately before `## 13. Implementation Plan`, including internal whitespace and without normalization.
- `Matrix Approval Evidence` must be a durable Sinh comment on FIX-237 naming the exact Matrix Source and digest. Missing, duplicate, stale, or conflicting evidence blocks review before project commands.

Execution Owner:
- One independent `requirements/review-auto` deployment consumes one one-use Review Authorization ID. Before spawn, the orchestrator must persist a durable launch intent binding FIX-237, `feature/FIX-237-remove-equipment-catalogue`, one 40-lowercase-hex Feature SHA, the Matrix Source, this digest, Matrix Approval Evidence, and `review-auth:` plus a lowercase canonical UUIDv4. Objective, report, and registry evidence must agree; one authorization may be consumed by at most one review deployment, and another active review for this ticket/branch blocks launch across all Feature SHAs, matrix revisions, and authorizations.

Prerequisites:
- A trusted builder/orchestrator-authenticated FIX-237 checkout whose `HEAD` equals the launch intent Feature SHA and whose branch is exactly `feature/FIX-237-remove-equipment-catalogue`.
- Node.js 22 or newer, npm, Docker with Compose, and executable Chromium at `/home/sinh/.nix-profile/bin/google-chrome`.
- Host port 3002 available; Docker daemon running; repository default disposable admin credentials unchanged; no production database or production service targeted.
- Run from the authenticated checkout repository root. Command 2 installs the exact `frontend/package-lock.json` dependency graph. Command 7 must leave the disposable Caddy/backend stack healthy before Command 8.

Environment:
- `CI=1` — disables focused-test exceptions.
- `SMOKE_BASE_URL=http://localhost:3002` — exact disposable Caddy endpoint.
- `SMOKE_USERNAME=admin` and `SMOKE_PASSWORD=admin-change-me` — repository default disposable-stack credentials only.
- `ROW16_CHROMIUM_PATH=/home/sinh/.nix-profile/bin/google-chrome` — exact Chromium executable.

Commands (run in this exact order):
1. `node scripts/version-control.mjs validate`
2. `cd frontend && npm ci`
3. `cd frontend && npm run typecheck`
4. `cd frontend && npm test -- --runInBand __tests__/v5-29-lifecycle-and-equipment-ui.test.tsx __tests__/v5-29-field-catalogue-disclosure.test.tsx __tests__/v5-29-active-contracts.test.ts`
5. `cd frontend && npm test -- --runInBand`
6. `cd frontend && npm run lint`
7. `./scripts/rebuild-dev.sh`
8. `cd frontend && CI=1 SMOKE_BASE_URL=http://localhost:3002 SMOKE_USERNAME=admin SMOKE_PASSWORD=admin-change-me ROW16_CHROMIUM_PATH=/home/sinh/.nix-profile/bin/google-chrome npm run e2e -- e2e/movement-detail.spec.ts`

Pass Criteria:
- Commands Total: 8; Commands Passed MUST equal 8 (100% completion), in order, at the pinned Feature SHA; every command exits 0.
- Required outputs/artifacts: version validation reports success; TypeScript emits zero errors; focused Jest reports the three named suites passing; full Jest reports zero failing suites/tests; ESLint reports zero warnings/errors; rebuild reports healthy web, health, and movement API probes; Playwright reports all 11 `movement-detail.spec.ts` tests passing and retains trace/screenshot/video only on failure.
- Review confirms the exact UI diff removes the global catalogue only, preserves movement-specific Apparatus, and makes no backend, schema, seed, authority-package, or DTO contract change.
- Unresolved findings require `Critical = 0` and `Major = 0`; every accepted or deferred Minor finding includes a written rationale in the review report.
- Project guides may inform discovery but cannot override, append to, delete from, or conflict with this matrix. Review admission fails before project commands unless `HEAD == Feature SHA`, the SHA is 40 lowercase hexadecimal characters, this digest freshly recomputes to the approved 64-lowercase-hex value, approval evidence resolves, and the authorization/launch-intent constraints above hold.

## After Matrix

Fixture only. No historical migration or approval.
