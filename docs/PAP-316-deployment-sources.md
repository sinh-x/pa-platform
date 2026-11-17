# PAP-316 P3 deployment source intake

Implemented and verified own-deployment requirements artifact authoring/intake without copying sources to historical roots.

## Phase Implementation Report

### Executed Phase

- Phase: PAP-316 P3, own-deployment requirements sources.
- Plan: `plans/2026-11-17-PAP-316-approval-handoff/plan.md` (read only; outside exclusive write ownership).
- Status: completed.
- Report identity: `implementation-261117-2258-pap316-p3-deployment-sources`.
- Report location follows the explicitly authorized `docs/PAP-316-deployment-sources.md` ownership boundary rather than creating a separate plans report.

### Files Modified

- `packages/pa-core/src/documents/package-contract.ts`: 7 added, 2 removed.
- `packages/pa-core/src/documents/package-tools.ts`: 12 added, 1 removed.
- `packages/pa-core/src/documents/package-service.ts`: 9 added, 6 removed.
- `packages/pa-core/src/__tests__/document-deployment-sources.test.ts`: 292 new lines, 30 tests.
- `docs/PAP-316-deployment-sources.md`: this report.

### Tasks Completed

- [x] Initialized a session-local todo before mutations; inspected instructions, CLI standard, native selection/authentication, service/runtime fixtures, safe file owners, journal, publication and reader consumers.
- [x] Added tests before implementation and preserved the intended-cause red run.
- [x] Extended the finite v1 grammar with `deployments/d-[0-9a-f]{6}/artifacts/<relative-member-path>`. Existing canonical relative-path validation remains mandatory. No arbitrary-root option was added.
- [x] Reused the native host's existing `recoveryProfile` predicate, which is derived from qualified policy-profile `document.package` selection. It now gates deployment-source authoring/intake as well as recovery. No new environment/config/request selector was introduced.
- [x] Restricted deployment-source draft writes to the authenticated caller's exact deployment. Historical draft authoring restrictions remain unchanged.
- [x] Checked every deployment source owner against the authenticated caller before `check`/`freeze` reads any member. A last-member foreign source takes precedence over an earlier stale member.
- [x] Preserved historical requirements drafts/reviews and `pa-document-package/v1`, including retained-profile historical intake.
- [x] Kept ownership checks out of generic parsing, frozen snapshot replay, confirmation/publication continuation, and delivery inspection. Existing repository/ticket authority and byte-drift checks remain in place.
- [x] Reused `AdvisoryFiles`, `readArtifactFile`, existing sensitive policy, content/media validation, digest/size limits and journal CAS. No file-owner implementation was bypassed or replaced.
- [x] Verified foreign writes/intake, malformed deployment IDs, arbitrary roots, root-prefix tricks, traversal, symlink ancestors/final files, hardlinks, directories, sensitive filenames/paths/content, active text, invalid UTF-8, changed bytes, CAS conflicts, media and package limits.
- [x] Verified exact source metadata and frozen bytes without historical copies; snapshot/delivery use after source removal and caller change; confirmation/publication/queue continuation and successor history.
- [x] Preserved derived package publication, approval and reader destinations. No Builder implementation or admission changes were made.

### Tests Status

Working directory for every command: `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`. Each command below ran with the exact environment prefix `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`. All stores/configuration/tickets used by tests were disposable fixtures, not live resources.

**Intended-cause red, before source edits:**

```bash
set -o pipefail; TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-deployment-sources.test.ts 2>&1 | tee /tmp/pap316-p3-red.log
```

Exit 1: 29 tests, 8 passed and 21 failed. Valid own-deployment grammar/authoring failed with `DOCUMENT_INPUT` at the original source boundary; the historical compatibility test passed. This was a product-boundary red, not a missing dependency or fixture startup failure.

**Final focused green:**

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-deployment-sources.test.ts > /tmp/pap316-p3-green.log 2>&1
```

Exit 0: 30/30 passed. The final suite includes same-length source digest drift during confirmation and before publication, plus stronger result-shape assertions.

**Affected document checks:**

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-*.test.ts src/__tests__/workflow-document-continuation.test.ts src/__tests__/immutable-document-policy.test.ts src/__tests__/paths-documents.test.ts > /tmp/pap316-p3-affected.log 2>&1
```

Exit 0: 359/359 passed, including package/service, confirmation, integrity, process recovery, readers, publication/retirement, handoff and historical continuation. Only assertion-helper cleanup followed this run; the final focused suite and its strict TypeScript check were rerun afterwards. Production sources remained unchanged.

**Affected Pi adapter checks:**

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/document-*.test.ts > /tmp/pap316-p3-adapter.log 2>&1
```

Exit 0: 42/42 passed.

**Build/type checks:**

- `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core build`: exit 0; `/tmp/pap316-p3-build.log`. This builds the fixed reader worker used by source fixtures.
- `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm typecheck`: exit 0 across the workspace; `/tmp/pap316-p3-typecheck.log`. Its existing scripts also build dependency packages.
- `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck src/__tests__/document-deployment-sources.test.ts`: exit 0; `/tmp/pap316-p3-test-types.log`. This separately checks the new test, since normal package compilation excludes test files.
- `git diff --check`: exit 0. No dedicated lint script exists in the inspected root/core manifests.
- Final source/test SHA-256 verification passed: `/tmp/pap316-p3-source-fingerprint.txt`.

### Issues Encountered

- The first implementation run passed 27/29. The full-reader worker still used stale built grammar, and one test incorrectly expected ten total refs despite the confirmation owner also creating two approval refs. Rebuilt core and corrected the assertion to verify ten package refs, two approval refs and exactly one primary. Original output: `/tmp/pap316-p3-first-green-attempt.log`.
- The first broad affected run reached 285 passing tests before its 240-second harness timeout, without a completed suite result. It is not counted as a pass. Original output: `/tmp/pap316-p3-affected-timeout.log`. The same test command subsequently completed with a 600-second budget: 359/359 passed.
- No ownership conflicts, staging, commits, live database/configuration/ticket writes, installs or Builder changes occurred. No plan file was updated because it is outside this phase's exclusive write list.

### Message and Verification Boundaries

No human-facing prose, CLI formatter, streams, exit mapping or outer response schema was changed. The CLI message standard was read; there are no changed human-message categories requiring a wording review. For the newly admitted own-deployment request, the machine-result example changes from `ok:false, code:DOCUMENT_INPUT` to `ok:true` with the same exact source path and existing unsigned/snapshot state. A qualified foreign deployment request now receives `DOCUMENT_AUTHORITY`; retained unqualified intake receives `DOCUMENT_UNAVAILABLE`. These codes do not grant approval or execution.

Review was performed inline; no independent reviewer/delegation capability was available. These results prove disposable source integration, not installed/default-entry selection, real native human acceptance, browser/accessibility behavior, hostile same-UID exclusion, or filesystem/ticket/SQLite atomicity. The complete monorepo test suite and installed qualification were not run.

### Next Steps

P4/P5 can use exact own-deployment sources through the qualified requirements owner without relocating bytes. External workflow selection and installed/human qualification remain with their respective owners. There are no unresolved implementation questions.

```text
Status: DONE
Summary: Qualified requirements draft/check/freeze now admits exact own-deployment artifact sources while preserving historical paths, safety checks and continuation.
Concerns/Blockers: Installed and human qualification are not asserted.
```
