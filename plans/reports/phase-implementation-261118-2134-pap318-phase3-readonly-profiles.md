## Phase Implementation Report

Implemented Phase 3 locally and left the checkout uncommitted. Explicit v3 profile starts support configuration-owned public names without reinterpreting fixed historical v1/v2 bindings.

### Executed Phase

- Phase: PAP-318 phase 3, reusable supported read-only document profile.
- Plan: `plans/2026-11-18-PAP-318-pi-primer-file-transport/plan.md`.
- Requirements: exact published r002 `requirements.md` and `uat.md`, particularly FR7/FR8 and AC7/AC8.
- Base: `5470d27a57a09577c1e752914fecb0c2af13ea09`; branch `feature/PAP-318-pi-primer-file-transport`.
- Status: completed for source implementation and focused verification; integrated validation/review/commit remain with the main agent.

### Tasks Completed

- [x] Introduced strict `pa-readonly-document/v1`, `pa-mode-capability-binding/v3` and `readonly-document-policy/v1` dispatch. Historical profile/session markers, v1/v2 fixed identities and canonical serialization remain separate.
- [x] Updated committed selection, transitive resource capture, primer composition, immutable planning and Pi launch selection. Public names/resources/tools/agents are selected from configuration; effective role and actor remain natively fixed to requirements/analyze.
- [x] Updated process anchoring, session authentication and finite document, workspace/confirmation, handoff/origin/continuation, intake and status consumers. Generic CLI/API ticket writers do not acquire privilege from v3 names, including public `builder` spelling.
- [x] Kept canonical-primary-root, fresh foreground/source/process gates and existing managed/inherited/background/force/pinned/resume/ticket-worktree exclusions. V3 skill bodies are captured in the primer; no mutable skill paths go to the unchanged adapter.
- [x] Added committed disposable PAPC fixtures for three Analyst modes and synthetic team/mode addition, agent/objective/policy edit and rename on one unchanged runtime. Real inert foreground children verify complete >635831-byte primer digests, bounded kernel arguments, exact graph/tools/public identity, process anchors, supplied tickets and replay-safe ticketless intake. Report selections reject implicit handoff.
- [x] Added malformed/unknown/privilege-widening, dirty/missing/aliased/drifting resource, environment-alias, noncanonical-root and session-version relabeling negatives; retained historical tests remain exercised.
- [x] Documented the stable runtime-owned contract and parser-tested inert example in `docs/readonly-document-profile.md`.

### Files Modified

Line counts are additions/deletions against the base; new-file counts are complete lengths. This report is additional evidence, not a runtime change.

| Path | Lines |
| --- | --- |
| `packages/pa-core/src/mode-capabilities.ts` | +68/-14 |
| `packages/pa-core/src/readonly-document-config.ts` | new, 68 |
| `packages/pa-core/src/types.ts` | +1/-1 |
| `packages/pa-core/src/yaml-parser.ts` | +9/-5 |
| `packages/pa-core/src/mode-capability-selection.ts` | +1/-1 |
| `packages/pa-core/src/analyst-resource-selection.ts` | +14/-11 |
| `packages/pa-core/src/primer/index.ts` | +7/-7 |
| `packages/pa-core/src/deploy/plan.ts` | +14/-9 |
| `packages/pa-core/src/documents/handoff-intake.ts` | +7/-7 |
| `packages/pa-core/src/documents/handoff-preflight.ts` | +4/-4 |
| `packages/pa-core/src/documents/local-review.ts` | +5/-5 |
| `packages/pa-core/src/interactions/tickets.ts` | +5/-5 |
| `packages/pa-core/src/tickets/status-service.ts` | +2/-2 |
| `packages/pa-core/src/tickets/store.ts` | +10/-3 |
| `packages/pa-core/src/__tests__/readonly-document-profile.test.ts` | new, 101 |
| `packages/pa-core/src/__tests__/analyst-identity-origin.test.ts` | +14/-12 |
| `packages/pa-core/src/__tests__/execution-plan.test.ts` | +21/-0 |
| `packages/pi-pa/src/deploy.ts` | +11/-9 |
| `packages/pi-pa/src/document-session.ts` | +13/-12 |
| `packages/pi-pa/src/process-identity.ts` | +14/-1 |
| `packages/pi-pa/src/document-native.ts` | +3/-3 |
| `packages/pi-pa/src/document-confirmation-native.ts` | +2/-2 |
| `packages/pi-pa/src/handoff-native.ts` | +2/-2 |
| `packages/pi-pa/src/pi-extension/document-tool.ts` | +4/-4 |
| `packages/pi-pa/src/ticket-status.ts` | +1/-1 |
| `packages/pi-pa/src/__tests__/readonly-document-profile.test.ts` | new, 163 |
| `packages/pi-pa/src/__tests__/analyst-identity-session.test.ts` | +13/-9 |
| `packages/pi-pa/src/__tests__/analyst-identity-ticket.test.ts` | +22/-11 |
| `docs/readonly-document-profile.md` | new, 109 |

Transport files, `runtime/*`, `flake.nix`, production `teams/`, phase 1/2 evidence and `pi-primer-transport.test.ts` are unchanged. The phase plan is left for the main agent's validation/commit reconciliation.

### Tests Status

Build/type checks pass:

```sh
corepack pnpm --filter @pa-platform/pa-core build
corepack pnpm --filter @pa-platform/pi-pa typecheck
git diff --check
```

The Pi package typecheck also verifies/bundles the existing repository extension sources and rebuilds core. No separate lint command is defined in these packages.

Focused core regression: **211 passed, 2 skipped, 0 failed**. The skips require an unavailable external PAPC fixture; no external configuration was activated. Output: `/tmp/pap318-phase3-core-tests.log`.

```sh
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity.test.ts src/__tests__/analyst-identity-composer.test.ts src/__tests__/analyst-identity-origin.test.ts src/__tests__/mode-capabilities.test.ts src/__tests__/execution-plan.test.ts src/__tests__/teams.test.ts src/__tests__/primer.test.ts src/__tests__/interactions-ticket.test.ts src/__tests__/ticket-status.test.ts src/__tests__/document-handoff-intake.test.ts src/__tests__/document-handoff-planning.test.ts src/__tests__/document-local-review.test.ts
```

After adding the documentation-example assertion, the final core profile/origin/plan rerun passed **27/27**: `/tmp/pap318-phase3-core-final.log`.

```sh
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-origin.test.ts src/__tests__/execution-plan.test.ts
```

Focused Pi regression: **41/41 passed**. Output: `/tmp/pap318-phase3-pi-focused.log`.

```sh
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-session.test.ts src/__tests__/analyst-identity-ticket.test.ts src/__tests__/analyst-identity-adapter.test.ts src/__tests__/analyst-identity-launch.test.ts src/__tests__/mode-capability-session.test.ts src/__tests__/document-session.test.ts src/__tests__/document-native.test.ts src/__tests__/document-confirmation-native.test.ts src/__tests__/ticket-status-native.test.ts
```

After the final typed-error/process-anchor changes, a `NO_COLOR=1` rerun of profile, ticket and production-adapter suites passed **11/11** (`/tmp/pap318-phase3-pi-final.log`). After strengthening exact-resource/agent and unchanged-primary assertions, the final real-launch profile suite passed **3/3** (`/tmp/pap318-phase3-pi-profile-final.log`).

```sh
NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-ticket.test.ts src/__tests__/analyst-identity-adapter.test.ts
NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts
```

The broad Pi invocation including `handoff-native.test.ts` exceeded 300 seconds. Its standalone rerun exceeded 600 seconds after **44 completed passing cases**, with no observed assertion failure (`/tmp/pap318-phase3-pi-handoff.log`). The remaining nine cases passed in a separate focused run (`/tmp/pap318-phase3-pi-handoff-tail.log`). Neither timed-out invocation is reported as a full-suite pass.

```sh
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='P3 R3 probe|P3 R1 probe: foreign|P3 R1 foreign custody|P3 R2 unsettled|P3 R3 replacement|P3 R4 revoked|P3 R4 retained|handoff diagnostics' src/__tests__/handoff-native.test.ts
```

### Message Evidence

Affected categories are capability-selection blockers and ticket-status help. Existing failed-result shape, streams and exits are unchanged. Typed errors use the existing fixed, bounded capability diagnostic; formatting introduces no probes/effects.

- Before help: “Selected fresh Pi policy sessions only: requirements/analyze or natively bound analyst/analyze.” After: the same historical choices plus “an explicit pa-readonly-document/v1 selection with ticket.status.”
- Before unsupported-profile parsing: `document_profile requires requirements/analyze and an exact supported document profile`. New explicit selections return the bounded “Operation not started: capability selection does not admit it.” envelope with the actual typed cause, including `CAPABILITY_UNKNOWN` or `CAPABILITY_POLICY_INVALID`, rather than an arbitrary exception or configuration body.
- Actual `NO_COLOR` propagation tests assert the typed reason, exactly one of each five labels, <=2000 UTF-16 units, no hostile configuration echo and zero allocation/preflight probes. Existing pure-diagnostic tests also pass. Independent human readability review and installed verification remain separate, unperformed evidence.

### Issues Encountered

Initial expanded tests exposed fixture-only defects: noncanonical synthetic v3 serialization, a shadowed test variable and a cached registry connection across two origin fixtures. They were corrected without weakening native checks, and affected reruns passed.

No ownership conflicts occurred. No checkout commit, install, live provider/ticket action, ticket-state change, external active configuration change, denied installed-Pi read, Herdr invocation or production PAPC edit was performed. Git commits inside disposable test configuration repositories are fixture qualification only.

### Next Steps and Remaining Limits

The main agent owns full integrated tests, exact-candidate independent review, any staged sensitive-workflow scan and the phase commit. Allow a longer budget or split the long handoff suite. Hosted CI, installed pairing, production PAPC qualification/enablement, normal-operator retry and human UAT are not performed or implied. No unresolved product-design question remains.

Status: DONE_WITH_CONCERNS
Summary: Phase 3 source, generic profile/authentication consumers, committed fixtures and contract documentation are implemented and uncommitted; focused checks and builds pass.
Concerns/Blockers: The full handoff invocation exceeded its time budget; 44 cases passed before timeout and the remaining nine passed separately. Full integrated validation and independent review remain with the main agent.
