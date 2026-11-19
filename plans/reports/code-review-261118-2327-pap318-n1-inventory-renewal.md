# PAP-318 N1 and inventory renewal

## Code Review Summary

**N1/F1 closure is not yet established. The requested preparation-failure path is repaired and passes, but a returned pre-spawn cleanup failure still loses its typed fact before supervisor finalization.** Inventory reconciliation passes its focused suite. No other new defect was confirmed.

### Scope

- Candidate: working diff after `e18ccb9531ddba9ce5dcd3fe04fb9d1939ad8bba`, branch `feature/PAP-318-pi-primer-file-transport`; nine files, +298/-46.
- Files: `packages/pi-pa/src/{adapter,background-runner,prompt-transport}.ts`, `packages/pi-pa/src/__tests__/pi-primer-transport.test.ts`, `packages/pa-core/src/interactions/{catalogue.ts,source-inventory.json}`, `packages/pa-core/src/__tests__/interactions-catalogue.test.ts`, `scripts/dev/pi-primer-input-runtime.test.mjs`, `flake.nix`.
- Read `AGENTS.md`, the complete CLI message standard, prior `code-review-261118-2304-pap318-f1-renewal.md`, and the implementation plan. Applied inline scout and both base-checklist passes. Scout traced no-child results, final ownership writes, post-termination observation, deploy cleanup consumers, and existing v3 admission/finite owners.
- Restricted nine-file `git diff e18ccb9 --binary` SHA-256: `f31523da099d853d1ca1ce2b05a05296461f4ba5ecd4836473907557321cf765`, unchanged across review checks.
- Read-only except this report. No full suite, build, Nix execution, installed verification, denied Pi source read, Herdr, live provider/ticket, production PAPC, code edit or commit.

### High Priority — N1 remains on returned no-child failures

**[packages/pi-pa/src/background-runner.ts:285-288] The readiness guard throws before latching a returned `cleanupVerified: false`.**

The confirmed control-flow counterexample is:

1. `buildPiBackgroundArgs` successfully creates the prompt snapshot.
2. Launcher setup or synchronous process creation fails inside `runPiManagedProcess`. Its catch calls `piPromptStartFailure` (`adapter.ts:696,802-811`). If owned snapshot removal also fails, that helper returns the fixed cleanup diagnostic and `metadata.cleanupVerified: false`; it does not throw `PiPromptCleanupError`.
3. No `onSpawn` ran, so `!ready || !childPid` throws at runner line 285. The assignment at line 288 is never reached. The catch only latches typed exceptions, so this generic readiness exception leaves `cleanupUnverified` false and also hides the cleanup diagnostic.
4. The durable failed record consequently omits the deny-only field. The outer launcher accepts a matching terminal record without that optional field as legacy evidence (`adapter.ts:962`). With verified runner termination and successful config cleanup, it can again return `cleanupVerified: true` while the claimed input remains.

This is the same unsafe cleanup-contract contradiction as N1, through a different entry path. `deploy.ts:1595` treats that flag as termination/finalization evidence. The current new regression injects preparation fsync failure, which throws the typed exception before this returned-result path, so its passing result does not cover this counterexample.

**Fix:** Latch `result.metadata?.cleanupVerified === false` immediately after obtaining the reviewer result, before any readiness/child-PID throw. On that no-child failure, preserve the known cleanup blocker through a typed cause rather than replacing it with the generic missing-PID message. Add the outer background regression with successful preparation, no established child, failed owned-input unlink, false durable and outer cleanup facts, retained input, and zero actual Pi children. Renew the affected inventory hash after repair.

This finding is established by source control flow, not a claimed executed reproduction. An attempted isolated real-runner probe was privacy-blocked before execution on environment access; it was not retried or counted as evidence.

### Closure evidence and inventory assessment

- The requested preparation fsync/unlink-failure regression really calls `runPiBackgroundRunner` inside `PiAdapter.spawn({ mode: "background" })`, using a trusted dead-runner launcher/termination seam. It asserts false outer cleanup, false durable ownership, retained input, the cleanup diagnostic and zero Pi spawn calls. It passed here.
- `cleanupVerified?: false` is additive and deny-only; the ownership reader rejects other supplied values. Once latched, the common ownership constructor carries false through finalizing, finalized, failure fallback and authority-finalization writes. No current extra-field call overrides it. The gap is latching before readiness failure, not subsequent overwriting.
- The outer failure path reobserves deployment/token-matching ownership after termination, combines input/process/config cleanup, preserves an earlier matching false, and treats absent, malformed, mismatched or nonterminal observations as unverified. It does not infer cleanup from diagnostic prose.
- Browser lifecycle setup and foreground terminal-status observation now sit inside the no-child cleanup try. That scope correction is valid; returned cleanup uncertainty must still survive the supervisor guard described above.
- F1's exclusive-create ownership capture, private cleanup claim and fixed preparation-cleanup diagnostic remain repaired. Full lifecycle closure is blocked by the remaining N1 path.
- Catalogue changes modify descriptions only, not operation IDs, forms, channels, effects or authority. The v3 description matches explicit public-name/resource binding, missing-mode rejection in both `deploy.ts` and the immutable planner, process/session authentication, and selected `ticket.status` finite-owner checks. Historical v1/v2 handling remains explicit.
- The four added private dependencies are `readonly-document-config.ts`, `prompt-transport.ts`, `prompt-preload.ts` and `background-runner.ts`. All recorded source hashes pass the conservative inventory check. This is not semantic completeness or installed provenance.
- The Nix input-boundary fixture adds exact content-fact comparison against inline controls for sub-argument-limit bodies, including Unicode and empty input. Source inspection confirms native admission holding, actual Pi input-event observation, PID/birth binding, bounded kernel arguments/environment, snapshot removal, missing-input rejection and an agent-start prohibition. No additional fixture defect was confirmed. Its large body cannot use the oversized inline route as a control.

### Checks actually executed

Environment: requested worktree, `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`; targeted suites ran as separate processes.

- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-primer-transport.test.ts`: **28 passed**, zero failed/skipped.
- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-background-runner.test.ts`: **23 passed**, zero failed/skipped.
- `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/interactions-catalogue.test.ts`: **17 passed**, zero failed/skipped, including all recorded inventory hashes.
- `node --check scripts/dev/pi-primer-input-runtime.test.mjs`: passed, syntax only.
- `git diff --check HEAD`: passed.
- Coverage percentages, type coverage and lint counts were not measured. Some child fixtures use existing checkout-generated JavaScript; these runs are not fresh builds.

### CLI messages and remaining limits

Affected category: preparation/startup cleanup blocker and supervisor/adapter propagation. Before the preparation repair, uncertainty collapsed to `PI_PROMPT_INPUT`; afterward it retains the fixed five-field `Pi prompt cleanup is incomplete.` / `PI_PROMPT_CLEANUP` guidance. The wording preserves the original evidence and asks its owner to inspect; no protected body is interpolated. Human text review is separate from passing structural/software tests. The remaining no-child branch replaces that known blocker with `runner-spawn: Pi child did not expose a process id`; its repair must preserve both the typed false fact and the safe diagnostic.

Main's full-repository retry and renewed exact-source-built Nix fixture result were not observed here. The reported earlier Nix success applies to an earlier fixture revision, not the current inline-control candidate. Neither source review nor handled input events prove downstream session persistence, provider behavior, installation, hosted CI or human acceptance.

Plan recommendation: phases 1–3 retain their recorded evidence; keep phase 4 and N1/F1 closure open for the returned-result repair, focused regression, hash renewal and main-owned integrated/Nix results. No plan state was changed.

### Unresolved Questions

None requiring a design decision. Main-owned integrated and renewed Nix outcomes remain unobserved.

Status: DONE_WITH_CONCERNS
Summary: The new full-background preparation-failure regression passes, and inventory reconciliation passes 17 focused checks. A pre-readiness returned cleanup failure still loses its deny-only fact, so N1/F1 closure is not established.
Concerns/Blockers: Latch returned cleanup uncertainty before the missing-child guard and preserve its diagnostic; complete the focused regression and main-owned verification.
