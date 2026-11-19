# PAP-318 final independent source review

## Code Review Summary

**Do not land unchanged. One high-priority preparation-cleanup defect remains. Prior R1 and R2 are repaired.** No additional confirmed privilege-widening or selected-mode consumer defect was found.

### Scope

- Candidate: `e18ccb9531ddba9ce5dcd3fe04fb9d1939ad8bba`; combined diff from `407a87047fdf801b7fecc44a06687c232bbc37a2`.
- Reviewed all 43 changed files: +1446/-162 lines; package source/tests account for 35 files, +1009/-162. Also traced unchanged foreground gate, background supervisor, native selected entry, session/tool guards, committed-source owner and registry consumers.
- Rulebook: `AGENTS.md`, published r002 requirements/UAT/brief, all four phase-plan/evidence files, prior independent review, profile contract and CLI message standard. Applied scout and critical/informational base/API checklists.
- Environment: requested worktree, Linux, Asia/Saigon, English/en_US.UTF-8; Node `v22.23.4`, pnpm `10.28.0`, page size 4096 bytes.
- Read-only except this report. No code/plan-state edits, commit, installation, live deployment/ticket, network provider, external PAPC activation, denied Pi read or Herdr invocation.

### High Priority — blocking

#### F1. Preparation failures bypass owned cleanup and conceal retained prompt bytes

**Locations:** `packages/pi-pa/src/prompt-transport.ts:75-82`; propagation at `packages/pi-pa/src/adapter.ts:319-321`.

The atomic private-claim fix covers consumption and terminal cleanup, but **not preparation's catch**. After assigning the public snapshot path, any open/write/chmod/fsync/stat/close failure calls `unlinkSync(path)` directly. It neither proves that creation succeeded nor verifies the inode being deleted. Cleanup errors are swallowed, and callers receive only `PI_PROMPT_INPUT`; the adapter drops all cleanup-state evidence.

Two disposable, process-local filesystem fault probes reproduced this:

1. At snapshot fsync, move the owned file aside, create a different file at its public pathname, then throw `EIO`. Preparation deletes the replacement and leaves the owned original. This is the same public-path replacement class addressed by the successful cleanup-claim test, not a claim of hostile-same-UID isolation.
2. Throw `EIO` at snapshot fsync and `EACCES` when its unlink is attempted. The complete snapshot remains, but only `PI_PROMPT_INPUT` is reported. With the composed-input overload this includes the protected authorization location. An adapter-level repetition confirmed exit 1, zero spawns, one retained mode-0400 snapshot, **no `cleanupVerified: false`**, and no cleanup diagnostic. The protected body was synthetic; no credential was used or printed.

This violates FR-3/FR-5 and AC-03/AC-05: foreign evidence can be destroyed, and failed/unknown cleanup of the newly persisted input is indistinguishable from an ordinary input rejection. Private permissions limit exposure but do not establish cleanup or authorize indefinite retention.

**Remedy:** Record ownership immediately after successful exclusive creation. On partial preparation failure, reuse identity-checked private claiming/removal; never unlink an uncreated or substituted pathname. If ownership/removal cannot be established, retain the evidence and propagate a typed cleanup-uncertain outcome through foreground/managed/background preparation, preserving the original operation and fixed secret-safe guidance. Add negatives for failed exclusive open, partial write/fsync/close, replacement before error cleanup and cleanup failure, including composed protected input. Assert replacement survival, owned-input disposition, no spawn and explicit cleanup uncertainty at the adapter/supervisor boundary.

### Rechecked repairs and scout closure

| Area | Verified outcome |
| --- | --- |
| Prior R1 | Launcher `deploy.ts:788-790` and immutable planner `deploy/plan.ts:158-159` reject missing mode/default for profile-only teams. The analyst/evidence-lab/builder/requirements normal/dry-run matrix rejects before allocation/probes. Explicit selection without a default still completes a real inert launch. |
| Prior R2 | `readonly-document-config.ts:51,57` requires actual strings before enum membership. Array/object/number/null/boolean negatives pass. |
| Atomic claim | Consumption and terminal cleanup claim into a private directory, verify identity and check post-unlink link count. The existing public-replacement race test passes. F1 is the uncovered preparation branch. |
| Async lifecycle | Foreground/managed paths await process/browser completion before terminal prompt cleanup; explicit uncertain termination retains input. Missing selected executable/gate setup with no child removes unused input; uncertain PTY spawn retains it with cleanup failure. Source drift after preflight or during actual PTY admission blocks release. |
| Protected input | Incident-sized child-consumed input contains authorization exactly once inside protected metadata, absent from the ordinary primer. Successful snapshot consumption removes the private copy before target initialization. Preparation-error lifetime remains F1. |
| Exact bytes/bounds | Real inert children receive matching counts/digests for incident-sized spawn/resume and empty/small/BOM/Unicode/CRLF/trailing-newline/path-edge inputs, including the 16 MiB boundary. Over-limit and unsafe/changed/aliased input rejects. Kernel arguments remain bounded. |
| Selected host | Source pins the new prompt module in the generated selection, checks native parent/child kernel-argument agreement and incarnation before expansion, then passes expanded arguments to the existing `host.main`. It does not mutate the kernel argument contract or introduce a model-facing reader. Exact prompt-bearing selected-host execution was not performed. |
| Historical v1/v2 | Independent baseline comparison across ten bindings found byte-equal canonical serialization and identical selected tools, actor and route results. Retained v1/v2 source/session tests pass; no silent v3 relabeling was observed. |
| V3 consumer closure | Committed three-mode and synthetic add/edit/rename fixtures pass on one unchanged adapter. Native intake, handoff/origin/continuation/publication/link/queue and finite status tests pass. Selected tools, process anchors, public identity, effective attribution, capability omission and generic ticket nonprivilege remain distinct. Existing reserved native routes retain their owners. |

No other confirmed critical/high defect emerged from the concurrency, exception propagation, input/authentication/authorization, query-bound, compatibility and data-exposure passes. This is scoped source evidence, not an arbitrary-same-UID sandbox guarantee.

### Independent checks actually executed

All software commands used `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`; all suites below used `--test --test-concurrency=1`. **135 tests passed; zero failed, cancelled or skipped.**

```sh
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-primer-transport.test.ts src/__tests__/analyst-identity-adapter.test.ts src/__tests__/selected-pi-launch.test.ts
# 31 passed.

corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/execution-plan.test.ts src/__tests__/analyst-identity-origin.test.ts src/__tests__/mode-capabilities.test.ts
# 34 passed.

corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-session.test.ts src/__tests__/analyst-identity-ticket.test.ts src/__tests__/ticket-status-native.test.ts
# 10 passed, approximately 121 seconds.

corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='protected reviewer input' src/__tests__/pi-deploy.test.ts
# 1 selected test passed; not a complete pi-deploy suite run.

corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/runtime-start-gate.test.ts src/__tests__/pi-background-runner.test.ts src/__tests__/pi-native-host.test.ts
# 47 passed.

corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/analyst-identity.test.ts src/__tests__/analyst-identity-composer.test.ts
# 11 passed.

corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/mode-capability-session.test.ts
# 1 passed; synthetic web connector only, no network request.

git diff --check 407a870 e18ccb9
# Passed.
```

Additional inline checks:

- `corepack pnpm exec tsx --input-type=module`: obtained baseline `mode-capabilities.ts` with `git show 407a87047fdf801b7fecc44a06687c232bbc37a2:packages/pa-core/src/mode-capabilities.ts`, transpiled/imported it in memory and compared v1/v2 across five capability sets. Ten canonical serializations were byte-equal; tools, actor and four route checks per binding were identical. No baseline file was written.
- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --input-type=module`: two F1 probes replaced `fs.fsyncSync`/`fs.unlinkSync`, called `syncBuiltinESMExports()`, exercised source `preparePiPrompt` with a synthetic composed canary and restored builtins/deleted each temporary fixture in `finally`. Exact observations:

```json
{"variant":"replacement-on-fsync-failure","replacementOrSnapshotExists":false,"ownedOriginalExists":true,"reportsCleanupUncertainty":false,"remains":1}
{"variant":"unlink-fails-after-fsync-failure","replacementOrSnapshotExists":true,"ownedOriginalExists":false,"reportsCleanupUncertainty":false,"remains":1}
```

- The same command host repeated the second fault through a production `PiAdapter` with inert version/native probes, fault matching restricted to `.input` files, and a spawn trap:

```json
{"exitCode":1,"spawns":0,"snapshotsRetained":1,"cleanupVerified":null,"reportsInputFailure":true,"reportsCleanupFailure":false,"retainedModes":["400"]}
```

One initial over-broad adapter fault probe failed in existing terminal-marker unlink before reaching snapshot preparation; the scoped rerun above is the relevant evidence. These are intentional fault observations, not passing cleanup tests.

### Requirements, plan follow-ups and evidence limits

- Phases 1–3's source changes, documentation, retained baseline and supplied evidence exist. R1/R2 can be closed. Phase 2 cleanup is incomplete because of F1; phase 4 cannot be closed from this review. No plan state was changed.
- **FR-2/AC-02 and FR-3/AC-03 verification gap:** the new payload tests consume through the preload/inert JavaScript target, not the actual Pi parser/initial-user-message boundary. Existing selected-build tests do not supply a `pa-prompt-v1` reference. Therefore actual Pi role/order/exact-once behavior and prompt-bearing selected-host process/argument/source agreement remain unexecuted requirements evidence, not proven by these source tests. Add an admitted provider-free parser/input-boundary fixture and selected-host reference case; do not bypass denied installed-source access. This is a verification gap, not a demonstrated parser/host defect.
- The real OS `E2BIG` baseline was independently rerun. The old actual-adapter failure is preserved in phase 1 evidence/commit `1ae4945`; this reviewer did not re-execute that historical adapter revision.
- Main-agent full typecheck/build/full regression is independently owned and was not rerun or certified here. Focused suites use the checkout's existing generated core/preload outputs. Coverage percentages and lint counts were not measured; staged secret scanning was not run by this noncommitting reviewer.
- **Exact installed package/config/Pi pairing:** unrun. **Hosted CI:** unrun by this reviewer. **Normal foreground provider trial:** unrun. **Human readability trial and genuine UAT:** unrun. Production PAPC qualification/activation and any MVM-233 retry remain separately authorized work. None is inferred from source success.
- Touched message categories were checked against the CLI standard: input blocker, startup failure, cleanup uncertainty, selected-host failure and ticket-status help. Before: `Argument list too long` / `Pi exited with code 1`; after: fixed five-field `PI_PROMPT_INPUT`, `PI_PROCESS_START` or `PI_PROMPT_CLEANUP` guidance. Focused bounded/plain-output assertions pass; F1 fails to select the cleanup outcome when preparation leaves bytes behind. Human usability and installed propagation are separate unrun evidence.

### Recommended Actions

1. Repair F1 locally in the existing prompt/lifecycle owners and add the specified preparation-failure matrix.
2. Rerun affected focused suites and renew exact-candidate review; keep the main agent's integrated results separate.
3. Preserve the outstanding parser/selected-host, installed, CI and human acceptance layers explicitly rather than marking all ACs accepted.

### Unresolved Questions

None requiring redesign. Preparation cleanup is a local source repair; remaining acceptance layers retain their separate owners.

Status: DONE_WITH_CONCERNS
Summary: Prior R1/R2 are fixed and 135 focused tests pass, but snapshot preparation still bypasses owned cleanup and hides retained-input uncertainty.
Concerns/Blockers: Fix F1 before landing. Actual Pi initial-message/selected-host payload evidence, integrated checks, installed pairing, hosted CI and human UAT are not established by this review.
