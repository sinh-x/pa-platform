## Phase Implementation Report

**Owned core/Pi P1 source is implemented. Production happy-path qualification awaits the lead-owned capability registration; the gate has not been weakened.**

### Executed Phase
- Phase: PAP-314 P1 core and Pi integration.
- Plan: `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform/plans/261117-PAP-314-requirements-review-approval/`.
- Status: Partial integration. P1 source is complete within this ownership boundary; two capability-dependent tests remain failing.
- Environment: Asia/Saigon, en_US.UTF-8. No commits, staging, live registry changes, dependency changes, installation, activation or PAPC edits.

### Files Modified
Paths are relative to the checkout. Counts are additions/deletions.

| File | Lines |
| --- | --- |
| `packages/pa-core/src/documents/handoff-contract.ts` | +46/-10 |
| `packages/pa-core/src/documents/handoff-review.ts` | +157/-4 |
| `packages/pa-core/src/registry/handoff-reviews.ts` | +55/-14 |
| `packages/pa-core/src/documents/local-review.ts` | New, 90 |
| `packages/pa-core/src/index.ts` | +1 |
| `packages/pa-core/src/__tests__/document-local-review.test.ts` | New, 225 |
| `packages/pi-pa/src/handoff-native.ts` | +58/-13 |
| `packages/pi-pa/src/pi-extension/handoff-tool.ts` | +2/-1 |
| `packages/pi-pa/src/pi-extension/handoff-review-ui.ts` | +1/-1 |
| `packages/pi-pa/src/__tests__/handoff-native.test.ts` | +42/-2 |

### Tasks Completed
- [x] Added isolated `pa-handoff-review/v2` subjects with immutable original deployment/session and native plan coordinates. Native v2 preparation verifies those coordinates against the actual authenticated native caller.
- [x] Implemented shared `LocalHandoffReviewService.show/request/decide/revoke` and strict `pa-local-review/v1` input. Revoke only requests a review; decide uses its original revision/key and persisted target.
- [x] Reused `RegistryHandoffReviewJournal` and its existing subject/event/capture/effect tables. No second ledger or migration was added.
- [x] Bound generated interaction/time/outcome bytes atomically with issuance. Exact replays return the original decision result; changed outcomes conflict. Intentionally pending v2 requests remain decidable.
- [x] Kept v1 evidence/principal validation and uncaptured-request uncertainty semantics. Every local action rejects v1 subjects.
- [x] Exported production `executeLocalReview(raw: string): Promise<Record<string, unknown>>`. It checks saved native start/selection, all three capabilities, historical ticket association, derived original plan identity and completed native plan/audit. It never authenticates or impersonates the ended origin, trusts a supplied actor, initializes journal tables, invokes planning or performs publication/ref/queue effects. Show uses an existing-only readonly registry connection; oversized responses are rejected rather than truncated.
- [x] Integrated selected Pi native v2 request/show/decide/request-only revoke and foreground review through the shared local owner. Preserved local-unverified provenance in UI/results/bounded tool summaries.
- [x] Added typed optional origin, eligibility and approval-boundary host hooks for P3. P1 reports eligibility/branch-effect admission as unassessed and denies native v2 effect authorization. It does not implement develop drift, refresh or fresh-session effect continuation.
- [ ] Lead capability inventory/registration and complete P1 integration qualification.

### Tests Status
Core was built before reader-backed tests. All tests used disposable files/registries.

- **Pass:** `corepack pnpm --filter @pa-platform/pa-core build` and `... typecheck`.
- **Pass:** `corepack pnpm --filter @pa-platform/pi-pa build` and `... typecheck`, including existing extension-source validation/bundling.
- **Pass:** `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-handoff-contract.test.ts src/__tests__/document-handoff-review.test.ts`: **43/43** retained tests.
- **Partial:** `NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-local-review.test.ts src/__tests__/document-handoff-contract.test.ts`: **27 passed, 1 failed**, no skips. The failing production-origin happy path reaches the deliberate saved-selection gate before document disclosure/issuance because `document.local-review` is not registered. Evidence: `/tmp/pap-314-core-p1-final.log`.
- **Partial:** `NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/handoff-native.test.ts`: **11 passed, 1 failed**, no skips. The selected-v2 fixture fails at `parseModeCapabilityPolicy` with `CAPABILITY_UNKNOWN`; all retained native Pi cases and omitted-v2-selection denial pass. Evidence: `/tmp/pap-314-pi-p1-final.log`.
- **Pass:** Full workspace `corepack pnpm typecheck` (all four workspace projects), including core/OpenCode/Pi prerequisite builds. Evidence: `/tmp/pap-314-workspace-typecheck.log`.
- **Pass:** Scoped `git diff --check`. No lint script is defined for these packages. Full workspace tests, hosted CI, installed/browser/accessibility/human checks and coverage percentages were not run/measured.
- Early checks exposed an unstable synthetic ticket fixture and readonly connections unnecessarily requiring a writable FULL-synchronous setting; both were corrected. One combined verification command timed out after the 43 passing tests; subsequent standalone build/typecheck commands passed.

Passing new tests cover original coordinates, full document content, pending request replay, atomic rollback on failed issuance, reply loss, later delivery/develop changes after issuance, conflicting concurrent outcomes, request-only revocation with all four outcomes, imported-evidence denial, v1-target denial on all four production actions, missing dependencies and incompatible native origins. Native-host/UI fixtures are synthetic, not human consent or installed qualification.

### Human-Facing Messages
- Categories touched: Pi tool help and review information/trust disclosure. Existing fixed bounded blocker guidance is reused; its plain-text/sanitization assertions pass in the Pi suite.
- Before, retained v1: “native requirements handoff review.” That path remains unchanged.
- New v2: “Local unverified confirmation: no authentication is provided. Any local process with endpoint access can submit a decision; this is not authenticated human consent.” Tool help explains original pre-request coordinates and request-only revoke; results use `principal: local-unverified` and `method: unauthenticated-local-confirmation`.
- Source wording was reviewed without relying on color. Genuine v2 Pi UI propagation remains behind the unregistered-capability fixture gate; no installed or human readability acceptance is claimed.

### Issues Encountered
No ownership conflicts were resolved. Concurrent reader and CLI/server changes were left untouched. The shared plan checkbox remains for the lead to reconcile after transport/registration integration; this report records only the owned P1 tasks.

### Next Steps / Remaining Integration Needs
1. **Lead:** Register `document.local-review` in the trusted capability inventory, with the same `pa_handoff` tool and mandatory `document.handoff` plus `document.package` dependencies. Do not change retained/default selections. Advertise `pa-handoff-native/v2` only for the explicit fresh qualified selection. Rebuild core and rerun the two focused commands above; the production and real-process Pi happy paths must actually pass before P1 is marked qualified.
2. **CLI/API owner:** Import the root-exported `executeLocalReview(raw)` directly. The dispatcher throws sanitized `DocumentPackageError` codes and returns complete records; the transport still owns strict raw UTF-8, loopback/browser defenses, deadlines, load/output limits and response envelopes. No injected/current actor is required or accepted.
3. **P3:** Supply eligibility and approval-boundary hooks in the production host, implement stale dispositions/refresh and precise continuation admission, replace unassessed branch-effect status, and integrate versioned native effect authorization. Preserve the current caller separately from immutable origin coordinates. No P3 implementation is claimed here.
4. PAPC-090 continues to own external default selection/full-process closure. No external change or activation was made.

Status: DONE_WITH_CONCERNS
Summary: Implemented the owned shared v2 local review journal/service, production dispatcher and Pi integration while retaining v1 behavior and explicit unauthenticated provenance.
Concerns/Blockers: Lead-owned capability registration is still absent, so one production-core and one selected-Pi happy-path test remain failing; P3 effects and installed qualification remain separate work.
