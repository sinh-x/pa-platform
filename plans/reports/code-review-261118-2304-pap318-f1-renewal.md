# PAP-318 F1 read-only renewal

## Code Review Summary

**F1 is not fully closed. Unsafe preparation deletion and hidden cleanup diagnostics are repaired, but one newly identified background-launch propagation defect remains.** All 28 focused transport tests pass.

### Scope

- Current staged/unstaged changes after `e18ccb9531ddba9ce5dcd3fe04fb9d1939ad8bba`: six files, +201/-13. Files: `packages/pi-pa/src/{prompt-transport,adapter,background-runner}.ts`, `packages/pi-pa/src/__tests__/pi-primer-transport.test.ts`, `scripts/dev/pi-primer-input-runtime.test.mjs`, `flake.nix`.
- Reviewed `AGENTS.md`, the complete CLI message standard, prior `code-review-261118-2242-pap318-final-readonly-e18ccb9.md`, and relevant plan/evidence. Applied scout and both base-checklist passes. Scout traced partial-file ownership, protected-review exception propagation, durable supervisor ownership and the outer background launcher.
- Reviewed diff SHA-256: `28e91b31c8e07566b805307d294157d8eb70bbd15090711e7a425b0fc4d673b1` (`git diff HEAD` restricted to these six files). Source hashes remained unchanged through verification.
- Read-only except this report. No full suite, Nix build, installed Pi source read, Herdr, real provider, live ticket, production PAPC, code edit or commit.

### High Priority — new propagation finding

**N1. Background startup reports verified cleanup despite retaining the failed prompt.**

Locations: `packages/pi-pa/src/background-runner.ts:347-353,565-566`; `packages/pi-pa/src/adapter.ts:940-956`.

The runner preserves `PiPromptCleanupError` only as diagnostic text in its ownership record. The background launcher then sets `metadata.cleanupVerified` solely from `terminateRunner(...).verified`. Thus verified runner termination overwrites the prompt-cleanup uncertainty: the outer adapter returns `cleanupVerified: true` while an owned `.cleanup-*/input` remains. The new test exercises the direct supervisor and dry-run adapter separately, not `PiAdapter.spawn({ mode: "background" })`.

An isolated launcher probe injected real preparation `EIO` plus private-claim unlink `EACCES`, persisted the same failed ownership shape as the runner, and used trusted no-process launcher/termination seams. It produced:

```json
{"exitCode":1,"cleanupVerified":true,"reportsCleanupFailure":true,"retainedInputs":1,"runtimeSpawns":0}
```

The public error is now truthful, but its machine cleanup contract contradicts it. This matters to callers such as `deploy.ts:1595`, which use that flag for retained-state finalization (`deploy.ts:1350-1352`). No privilege escape or real-process leak is claimed by this synthetic observation.

**Fix:** Persist a typed prompt-cleanup uncertainty fact in supervisor ownership and combine it with runner termination when returning launcher cleanup metadata. Do not reconstruct the fact by matching diagnostic prose. Add the full background adapter failure case with a known-dead runner, retained input, `cleanupVerified: false`, and zero Pi spawns.

### F1 closure evidence

- `prompt-transport.ts:80-85` records creation and physical identity before writes. Failed exclusive open performs no unlink; failure before identity capture conservatively reports uncertainty.
- Partial preparation uses the existing private atomic claim/removal, not public-path unlink. Replaced evidence survives; failed claiming/removal or close becomes `PiPromptCleanupError`.
- Foreground/dry-run preparation returns fixed cleanup guidance and `cleanupVerified: false`. Direct supervisor failure retains the cleanup guidance and existing crashed-registry contract. Protected-review `startReviewer` exceptions propagate unchanged through `validation-supervisor.ts:214-215` to the runner catch.
- Accordingly, the original filesystem destruction and diagnostic-suppression mechanisms are repaired. N1 prevents complete cross-boundary F1 closure. No other new defect was confirmed in this narrow review.

### Runtime input fixture assessment

`scripts/dev/pi-primer-input-runtime.test.mjs` is a sound scoped **input-boundary** fixture by source inspection: it resolves the immutable selected entry, holds/releases the native child, observes the actual Pi `input` event, checks exact byte count/digest and dispatch count, matches PID/birth, checks bounded kernel arguments/environment, and checks snapshot removal. Missing referenced input must fail before dispatch. The isolated extension handles input before agent execution; a separate marker forbids `before_agent_start`. The model catalog targets loopback with a disposable value, not a real provider or credential.

Limits: its Nix execution is separately owned by main and was not run here. The handled input event intentionally prevents downstream user-message creation, persistence and provider execution; it does not independently prove those later behaviors or compare against a separate inline control. This is not an installed-pairing or human-acceptance result. No additional fixture defect was confirmed.

### Checks actually executed

Environment: requested worktree, `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`.

- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-primer-transport.test.ts`: **28 passed; zero failed/skipped**. Includes six preparation faults, composed synthetic protected bytes, direct adapter/supervisor uncertainty and zero-spawn assertions. Existing child tests use checkout-generated outputs; this is not a fresh build.
- `node --check scripts/dev/pi-primer-input-runtime.test.mjs`: passed; syntax only.
- Inline `tsx` cleanup-diagnostic assertions: 644 UTF-16 characters, exactly one of each required field, equal to the typed error message. Human text review is separate from these structural checks.
- Isolated full-background-launcher probe: reproduced N1 as shown above. It used real prompt preparation/cleanup and production launcher code, with synthetic failed supervisor ownership and verified termination, not a real runner process.
- An earlier in-process runner integration probe was privacy-blocked before execution on environment access. It was not counted as evidence or retried; the separate launcher probe did not inspect that environment.
- `git diff --check HEAD`: passed. Integrated typecheck/build/full regression and Nix execution remain main-owned. Coverage percentages and lint counts were not measured.

### CLI messages and follow-up

Affected category: preparation cleanup blocker and its adapter/supervisor propagation. Before: only `PI_PROMPT_INPUT` despite retained bytes. After: fixed five-field `Pi prompt cleanup is incomplete.` / `PI_PROMPT_CLEANUP`, with preserve-and-inspect guidance and no protected body. N1 is the remaining contradictory machine cleanup fact, not a readability issue. No wording rewrite is recommended.

Complete the background typed-state propagation and focused regression before closing F1. Keep phase 4 open until main records its integrated and Nix results; do not infer installation, hosted CI, provider behavior or UAT. No plan state was changed.

### Unresolved Questions

None requiring redesign; N1 is a local owner/launcher contract repair.

Status: DONE_WITH_CONCERNS
Summary: Preparation ownership and safe cleanup are repaired, and 28 focused tests pass. Full background launch still returns verified cleanup when failed prompt removal retained bytes.
Concerns/Blockers: Fix N1 and add the outer background adapter regression before fully closing F1; main-owned Nix and integrated results remain separate.
