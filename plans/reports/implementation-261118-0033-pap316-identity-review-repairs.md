## Phase Implementation Report

**Independent findings R1–R3 are repaired and verified at the production source boundaries. Canonical omitted-profile launch remains intentionally denied; no adoption or installed qualification is claimed.**

### Executed Phase
- Phase: PAP-316 identity independent-review repairs (R1, R2, R3 only).
- Plan: `plans/2026-11-17-PAP-316-approval-handoff/`; main plan remains with its orchestrator.
- Status: Completed within identity ownership, with qualification concerns below.
- Tasks: `/tmp/pap316-p4-identity-review-tasks.json`. No live task/delegation capability was exposed; implementation and review were inline.

### Files Modified
Current file lengths are shown, not attribution of the pre-existing dirty-tree changes.

| File | Lines | This repair |
| --- | ---: | --- |
| `packages/pi-pa/src/process-identity.ts` | 81 | Record the actual Analyst/analyze child anchor. |
| `packages/pi-pa/src/adapter.ts` | 1465 | Suppress redundant V2 native skill loading. |
| `packages/pi-pa/src/deploy.ts` | 1974 | Compose policy freshness into synchronous native child admission. |
| `packages/pa-core/src/primer/index.ts` | 906 | Separate explicit native composition from ordinary source/report composition. |
| `packages/pi-pa/src/__tests__/analyst-identity-adapter.test.ts` | 145 | Six new real-adapter/PTY tests. |
| `packages/pa-core/src/__tests__/analyst-identity-composer.test.ts` | 18 | Seven new composer tests. |
| `docs/PAP-316-analyst-identity.md` | 107 | Corrected contract, remediation evidence and limits. |

### Tasks Completed
- [x] Preserved pre-fix failures in `/tmp/pap316-p4-identity-review-red.log`. The initial early-preflight fixture mismatch and corrected second-preflight regression are both retained.
- [x] R1: `deployWithPi` → actual `PiAdapter` → real `node-pty` → disposable child authenticates, registers and invokes selected `pa_document`; no test plants an anchor. The child PID agrees with registry and production-written evidence.
- [x] R2: Both adapter-await and PTY-admission mutation fail with `CAPABILITY_BINDING`, with one inert bootstrap, no release file and no target result. Actual command bytes contain `--no-skills`, no `--skill`, and captured active/reference-only bodies. Auto/resume gates retain their owners. `runCommand` cannot bypass the native gate.
- [x] R3: Pi and OPA source/report composition works without native authority. Explicit native composition still requires V2 capture; omitted-profile production launch rejects before allocation/preflight.
- [x] Ran canonical source consumers read-only, updated identity documentation, and confirmed stable owned-source fingerprints (`/tmp/pap316-p4-identity-review-final-{before,after}.sha256`, `cmp` exit 0).

### Tests Status
Commands ran from the requested checkout with `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`.

- **Build/typecheck passed:** `corepack pnpm build`; `corepack pnpm typecheck`; `corepack pnpm exec tsc -p /tmp/pap316-p4-identity-tests-tsconfig.json`. Logs: `/tmp/pap316-p4-identity-review-{build,typecheck,tests-typecheck}.log`. Scoped `git diff --check` passed; no separate lint script is defined.
- **Core 88/88:** `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/{analyst-identity,analyst-identity-origin,analyst-identity-composer,mode-capabilities,primer,primer-handoff}.test.ts`. Log: `...-core-affected.log`.
- **Pi 16/16:** same Pi package runner over `src/__tests__/{analyst-identity-adapter,analyst-identity-launch,analyst-identity-session,analyst-identity-ticket,document-session,mode-capability-session,ticket-status-native,runtime-start-gate}.test.ts`. Log: `...-pi-focused.log`.
- **Adapter compatibility 12/12:** Pi runner with `--test-name-pattern='skill|execution plan|managed|resume|gate' src/__tests__/pi-adapter.test.ts`. Log: `...-adapter-compat.log`.
- **Auto compatibility 6/6:** Pi runner over `src/__tests__/auto-dispatch.test.ts`. **Retained gate 1/1:** Pi runner with `--test-name-pattern='foreground default launcher retains' src/__tests__/pi-workflow-runtime.test.ts`. Logs: `...-auto-compat.log`, `...-retained-gate.log`.
- **Canonical actual composer 1/1:** `PA_PLATFORM_REPOSITORY="$PWD" corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-name-pattern='actual composer' /home/sinh/git-repos/sinh-x/tools/pa-platform-config/scripts/analyst-team-source.test.mjs`. Log: `...-canonical-composer.log`.
- **Canonical sweep 118/118:** Actual source parser/composer over all 12 teams/59 modes for both runtimes. Log: `...-all-mode-source.log`.
- **Canonical compatibility validator passed:** From canonical config CWD, `PA_PLATFORM_REPOSITORY=<requested checkout> node scripts/validate-with-platform.mjs`: 59/59 modes, 269/269 references and compatibility fixtures. Log: `...-canonical-validator.log`. Its optional recovery diff-scope check was not selected. Canonical HEAD stayed `3ed0496880ee7c968ee90c40df94944b13e72f9f`, with clean Git status.

All abbreviated log paths above begin `/tmp/pap316-p4-identity-review`. New-regression green is `...-green.log`. Coverage percentages were not measured.

### Messages and Ownership
No public message text or machine/exit/stream contract changed. Before, adapter-time drift could reach runtime code under the old binding; after, the existing fixed `CAPABILITY_BINDING` blocker reaches the deployment result before child release. Focused policy assertions and actual drift propagation passed. This is agent/source review, not human acceptance.

No ownership conflict occurred. No edits to `handoff-review.ts`, core bridge files, `handoff-native.test.ts`, Builder source, external configuration or installed state; no working-tree staging/commits. Only disposable fixture repositories establish test commits. Build outputs remained inside the checkout.

### Issues Encountered / Next Steps
- A broad Pi invocation including the complete `pi-adapter.test.ts` timed out after 180 seconds with 68 passing subtests and no completed result (`...-pi-affected.log`); it is not a pass. Complete focused suites above passed. The full workspace suite was not rerun; the orchestrator owns its already-observed two core failures and non-identity repairs.
- Actual selected installed-host/provider behavior remains unqualified: the tests use the production PTY/bootstrap with an inert executable and controlled version/native-host probes.
- Canonical Analyst still omits a native profile. The review's hypothetical explicit-selection missing `docs/json-workflow-runtime.md` closure is not qualified by these offline checks; a separately authorized configuration/resource contract is still needed before real V2 adoption. No missing-resource guard was weakened.

Status: DONE_WITH_CONCERNS
Summary: R1–R3 now close the production source anchor/start/skill boundaries and restore canonical offline composition. Focused tests, canonical consumers, builds and typechecks pass.
Concerns/Blockers: Full/installed qualification remains separate; canonical explicit-resource adoption and the orchestrator's other findings are not closed by this repair.
