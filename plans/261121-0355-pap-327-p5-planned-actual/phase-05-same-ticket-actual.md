# PAP-327 P5 — Same-ticket Planned / Actual

Status: completed (source implementation; P6 qualification remains pending). Scope: P5 only; user-authorized implementation of r002 FR-07/NFR-05, AC-06/TS-06. The external approved package is preserved, including its historical draft labels. This is a local execution record, not a replacement plan or report authority.

## Dependencies and parallelization

P4 `407dba7` supplies complete immutable reader verification; P1 `4e1be21` supplies exact branch-independent content-review references. Other phases own document/publication, reader, primer/selected-resource/adapter and composition/export hubs. No edits to those files or external PAPC policy are authorized here.

## File Ownership

- `packages/pa-core/src/tickets/planned-actual.ts`
- `packages/pa-core/src/__tests__/planned-actual.test.ts`
- `packages/pa-core/src/artifacts/phase-report.ts` — finite absent-only locator companion, not producer/schema changes.
- `packages/pa-core/package.json` — explicit finite subpath export; no wildcard existed.
- `packages/pi-pa/src/phase-report-native.ts` — authenticated projection/attachment and foreground observation.
- `packages/pi-pa/src/pi-extension/prepared-workflow.ts` — phase-report dispatch only.
- `packages/pi-pa/src/pi-extension/ticket-tool.ts`
- `packages/pi-pa/src/__tests__/pi-planned-actual.test.ts`
- `docs/planned-actual.md`
- This execution record and `plans/reports/implementation-261121-0355-pap-327-p5-planned-actual.md`.

## Tasks

- [x] Prove existing report receipt/check/candidate, orchestration index and ticket attachment owners before selecting the missing seam.
- [x] Add tests first for binding mismatches, missing/denied/conflicts, append-only observations and exact attachment controls.
- [x] Implement native exact Planned/Actual projection, preserving immutable Planned and protected producer records/templates.
- [x] Expose normal `pa_phase_report` attachment/observation and `pa_ticket` discovery/exact projection.
- [x] Preserve separate source/installed/independent/browser/human evidence and immediate human Not run.
- [x] Verify complete native reader degradation on tampered/missing entry, raw, member HTML and manifest despite saved approval.
- [x] Address review findings on pre-UI authorization, order-independent human history, candidate visibility, per-attachment issues and multiline expectations.
- [x] Complete final regression/build/typecheck, staged diff/secrets scan and independent rereview. Final results: core 32/32, Pi 52/52, root script checks 43/43; rereview has no blocking findings.
- [x] Commit only owned files as a separate P5 commit and report qualification limits; the handback supplies the resulting commit hash.

## Qualification limits

All mutations in tests use newly allocated disposable fixtures. No live ticket, report or existing registry was mutated. Source tests and read-only code review are not installed selection, real-client foreground observation, browser/AT qualification or human product UAT. Cross-owner post-deployment human evidence writes are not enabled. The broad `test:code` attempt timed out at 240 seconds and observed another phase's not-yet-created `documents/content-publication.js` test dependency; that is not a P5 pass or a file to repair here.
