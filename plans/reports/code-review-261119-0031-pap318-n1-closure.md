# PAP-318 final narrow N1 closure

## Code Review Summary

**The last N1 finding is closed for the inspected source and focused regression.** No blocking or informational finding remains in this narrowly reviewed correction. This is not whole-ticket acceptance or an exhaustive candidate review.

### Scope

- Prior finding: `plans/reports/code-review-261118-2327-pap318-n1-inventory-renewal.md`.
- Candidate: working tree on `feature/PAP-318-pi-primer-file-transport`, HEAD `e18ccb9531ddba9ce5dcd3fe04fb9d1939ad8bba`.
- Inspected only the obtained-result/readiness guard and existing propagation context in `packages/pi-pa/src/background-runner.ts`, its entry in `packages/pa-core/src/interactions/source-inventory.json`, and the fault helper/outer-background regression in `packages/pi-pa/src/__tests__/pi-primer-transport.test.ts`.
- Applied inline scout and both base-checklist passes to this scope. Reused the prior review's surrounding lifecycle assessment rather than reopening the ticket.

### Closure evidence and scout result

1. `background-runner.ts:285-290` now latches returned `cleanupVerified: false` before checking readiness or child PID. Thus the prior returned-result counterexample cannot bypass the latch. A missing child with known cleanup uncertainty throws `PiPromptCleanupError`; the generic missing-PID error remains for cases without that fact. The existing catch and ownership constructor preserve the typed cleanup blocker and durable deny-only false.
2. `pi-primer-transport.test.ts:76-112,136-185` covers both preparation failure with failed cleanup and successful preparation followed by synchronous no-child spawn failure with failed cleanup. The `startup-cleanup` variant does not inject a preparation error; it fails removal of the private claimed input. Both outer-background cases await the real supervisor and assert false outer cleanup metadata, false durable ownership, a retained cleanup claim, and the cleanup diagnostic. Exactly one spawn attempt reaches the throwing seam, and zero children are admitted. The known-dead runner seam does not certify actual OS process termination.
3. `source-inventory.json:8` matches the current runner SHA-256, `c9aaa21157006cd93e22b2940d3f52967678bb44e3b0bd4ed5f0761068d4e793`.

The scoped scout specifically checked the distinction between thrown preparation errors and returned no-child failures, early-throw ordering, retained ownership evidence, and awaited fault-injection teardown. No additional edge-case defect was established within this scope. No new production API, authorization path, database query, or input parser was introduced by this correction.

### Checks actually executed

Environment: requested worktree, `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='adapter and persistent supervisor' src/__tests__/pi-primer-transport.test.ts
```

**Exit 0: 1 passed, 0 failed, 0 skipped.** Only the selected test ran; this was not the complete transport suite.

- Direct Node SHA-256 comparison against the runner inventory entry passed before and after the test.
- `git diff --check HEAD -- packages/pi-pa/src/background-runner.ts packages/pi-pa/src/__tests__/pi-primer-transport.test.ts packages/pa-core/src/interactions/source-inventory.json` passed.
- All three scoped file fingerprints were unchanged across checks. Test SHA-256: `a28292301deef84b8b37c7aa8e7520bf1654e3100226e2f94fb896c15fc9acc2`; inventory SHA-256: `d2a8f7a5862d4d4fdd2fd9d44e0a1f980d74ab04c84312ed482ded6462394fc1`.

### Message propagation

Affected category: startup cleanup blocker through supervisor and outer background adapter. Before, the returned no-child path replaced the known cleanup blocker with `runner-spawn: Pi child did not expose a process id`. After, it preserves the existing `Pi prompt cleanup is incomplete.` / `PI_PROMPT_CLEANUP` diagnostic and false cleanup fact. No new wording or arbitrary spawn exception is interpolated by this correction. Human review here covers that substitution; the selected test checks diagnostic propagation, not the entire CLI message standard or installed rendering.

### Recommended action and limits

Close the recorded N1 finding. Leave integrated validation and acceptance with main; no plan state was changed. The user-reported earlier full-repository pass and main's ongoing refresh are not independently observed results from this renewal.

No source edits, commits, full suites, build/typecheck, Nix execution, installed/UAT verification, Herdr, denied Pi reads, providers, live tickets, or PAPC operations were performed. Only this report was written. Coverage percentages and lint counts were not measured. The hash check establishes this runner entry only, not complete inventory reconciliation or installed provenance.

### Unresolved Questions

None within this closure scope. Main-owned integrated/Nix outcomes remain outside this report.

Status: DONE
Summary: The last N1 returned-result/readiness counterexample is closed; the selected outer-background regression passes and the runner inventory hash matches.
Concerns/Blockers: None within the narrow closure scope; no whole-ticket or installed/UAT acceptance is claimed.
