## Phase Implementation Report

P5 source implementation is complete. The exact same-ticket projection uses existing immutable report, native evidence and audited ticket owners; Planned bytes and producer schemas/templates are unchanged. Owned-only staged checks pass; the resulting separate commit hash is supplied in the handback.

### Executed Phase
- Phase: P5, same-ticket Actual, PAP-327 r002 AC-06/TS-06.
- Plan: `plans/261121-0355-pap-327-p5-planned-actual/phase-05-same-ticket-actual.md`.
- Status: completed; independent bounded rereview has no blocking findings. P6 qualification remains pending.

### Files Modified
- `packages/pa-core/package.json`: +4, explicit finite subpath export; no wildcard existed.
- `packages/pa-core/src/artifacts/phase-report.ts`: +16/-1, absent-only locator companion only.
- `packages/pa-core/src/tickets/planned-actual.ts`: +223, exact binding, projection, classification and attachment owner bridge.
- `packages/pa-core/src/__tests__/planned-actual.test.ts`: +91.
- `packages/pi-pa/src/phase-report-native.ts`: +165/-2, verified read/join and fixed foreground human observation.
- `packages/pi-pa/src/pi-extension/prepared-workflow.ts`: +16/-2, report dispatch only.
- `packages/pi-pa/src/pi-extension/ticket-tool.ts`: +20/-6, optional native ticket read projection.
- `packages/pi-pa/src/__tests__/pi-planned-actual.test.ts`: +132.
- `docs/planned-actual.md`: +57.
- Local P5 execution record: +36. This implementation report: +57.

### Tasks Completed
- [x] Proved native report receipt/check/candidate, orchestration index and path-only ticket attachment seams before implementation.
- [x] Added tests first for wrong bindings, missing/denied/conflicts, later append and exact attachment controls.
- [x] Added verbatim AC expectation/labelled actual rows, deviations with impact/owner, actual-only work and independent evidence classes.
- [x] Added native metadata plus real immutable locator companions and one audited non-primary ticket-reference update; no second report database or signed-byte rewrite.
- [x] Kept human Not run immediately at handback, independent of reference ordering; later fixed-class observations append stable native refs.
- [x] Preserved protected report producers/templates and all excluded parallel-owner files; no export/composition hub wiring required.

### Exposed Dispatch
- `pa_phase_report`: existing capture/publish; `attach-actual(report, reference, observations, actualOnly)` derives all authoritative identity fields from existing owners. `observe-actual(locator)` requires the same live authenticated foreground owner and collects coverage/result through UI, not caller evidence.
- `pa_ticket`: `read` or `show` with `plannedActual: true` discovers exact accessible choices. Supplying both `reference` and `candidate` projects that exact comparison. Ordinary reads retain their contract and existing read-only admission; no safety guard changes.
- Non-primary refs: existing `orch` owner index, immutable `impl` report, `attachment` locator. Candidate, subject/revision, repository key/root, ticket and manifest are explicit in the returned binding.

### Tests Status
- Build/type check: PASS, `corepack pnpm typecheck` and `corepack pnpm build`.
- Core owner/projection/retained report/ticket tests: PASS, 32/32, `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/{planned-actual,phase-report,tickets-parity,tickets-bulletins}.test.ts`.
- Pi normal dispatch/reader/report/preparation/ticket regressions: PASS, 52/52, `NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/{pi-planned-actual,pi-phase-report,pi-prepared-workflow,pi-phase3}.test.ts`.
- Root runtime/template/test-runner script tests: PASS, 43/43; exact command/output retained in evidence.
- Lint: no lint script is defined; scoped whitespace checks pass. Shell completions are unaffected by Pi tool parameters.
- Staged checks: PASS, `git diff --cached --check` and `corepack pnpm secrets:scan`; only the eleven owned paths are staged.
- Full `test:code`: NOT COMPLETE. It timed out at 240 seconds and observed another phase's then-missing `documents/content-publication.js` dependency. No unowned files were repaired; this is not a workspace pass.
- External PAPC orchestration template fixture: four tests skipped because `PA_PHASE5_CONFIG_ROOT` was not supplied. No policy edits/adoption occurred.

### Review and Message Evidence
- Kongming advised the native-owner bridge, filesystem locator companion and fixed human evidence seam. A scoped simplifier made three small changes; final build/tests above supersede its stale intermediate Pi run.
- Review defects fixed: pre-UI owner/binding checks, order-independent human baseline, candidate visibility, per-attachment failures retaining valid matches, full multiline expectations and typed missing-artifact classification. Final rereview confirms no remaining blocking findings in the bounded scope. Unsupported exceptions remain unknown; no exception text becomes facts or guidance.
- Message category: tool information/status. Before: ticket reads exposed metadata/paths only. After: opt-in reads expose exact rows and `human-uat: not-run`, while unchanged reads retain their shape. Attachment returns `state: attached` with `acceptanceClaimed: false`; existing failure wrappers remain in place. NO_COLOR source checks are separate from human readability/installed qualification, which were not run.

### Issues and Next Steps
- No file-ownership conflicts, live report/ticket/registry mutations, or external policy adoption. Tests allocate new disposable fixtures; no existing database required backup.
- P6 still owns installed default-path and real foreground-client qualification, browser/AT, independent product acceptance and human UAT. Source passes and code review do not populate those product evidence classes. Human append is limited to the same live report owner; cross-owner writes into ended deployments remain disabled.
- Evidence: `/home/sinh/Documents/ai-usage/deployments/d-5ee695/artifacts/checks/pap-327-p5-261121-0355-znWpkk/`. Files are created without clobbering previous evidence.

Status: DONE_WITH_CONCERNS
Summary: P5 implementation, focused source verification and owned-only staged checks are complete.
Concerns/Blockers: Full workspace testing is incomplete; installed/real-client/browser/human qualification remains Not run/Pending for P6.
