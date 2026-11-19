# PAP-315 P3 source validation

Date: 2026-11-18, Asia/Saigon. Source candidate: `f51efac` on
`feature/PAP-315-herdr-exit-cleanup`; baseline
`407a87047fdf801b7fecc44a06687c232bbc37a2`. P1 audit: `ed49242`.

## Outcome

The explicitly selected safe PA-side checkpoint and local reporter hardening
passed focused checks, workspace typecheck/build and separate agent review.
**Automatic Herdr deletion is unavailable; original product acceptance is not
complete.** The full workspace test run timed out and is not a pass. No source
changes followed the independently reviewed candidate.

## Actual checks

| Lane | Result |
| --- | --- |
| Initial P2 checkpoint/reporter checks | 18 passed; expanded protocol lane 27 passed. |
| P2 checkpoint/lifecycle/protocol/adapter/composition/catalogue | 109 passed, 0 failed/skipped, 119.97 s. |
| P2 pi-pa typecheck | Exit 0. |
| P3 workspace `corepack pnpm typecheck` | Exit 0, all four workspace packages. |
| P3 workspace `corepack pnpm build` | Exit 0, all four workspace packages. |
| P3 prescribed lifecycle/protocol/deploy/composition lane, plus new checkpoint tests | 224 passed, 0 failed/skipped, 234.10 s. |
| Separate focused existing foreground `/quit` and open-stdin regressions | 2 passed; one terminal event/no Git mutation retained. |
| `corepack pnpm secrets:scan`, `git diff --check` before P2 commit | Exit 0. |
| P3 `corepack pnpm completions` | Exit 0; no generated tracked changes. |
| Full `corepack pnpm test` | Incomplete: external 600 s budget, exit 124. Root harness 43 passed; pa-core output reached `ok 1509` without a final package summary. No `not ok` appeared in captured output. Remaining packages were not reached. |

Focused P3 command (one external 300 s cap):

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-exit-cleanup.test.ts \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/pi-deploy.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts
```

With the unavailable checkpoint selected, natural open-stdin subprocess close
was 23.2 / 24.3 / 22.9 ms after child-exit evidence (valid JSON / plain / other
JSON). The original existing three-shape regression measured 29.6 / 27.1 /
24.9 ms in that same lane. All remained below 1000 ms with the stdin writer
open. The checkpoint creates no transport timer or network stage; these timings
do **not** qualify a future 500 ms real teardown transport.

Failure history is retained: the workspace timeout was not erased by the focused
pass and its cause was not diagnosed as part of this scoped fix. No unrelated
suite or skill code was changed. Node's experimental MockTimers warning occurred
in the reporter tests; it was not a test failure.

Session-local raw logs: `/tmp/pap315-p2-tests.log`,
`/tmp/pap315-p2-typecheck.log`, `/tmp/pap315-p2-secrets.log`,
`/tmp/pap315-p3-typecheck.log`, `/tmp/pap315-p3-build.log`,
`/tmp/pap315-p3-test.log`, `/tmp/pap315-p3-foreground.log`,
`/tmp/pap315-p3-focused.log`. This committed report retains results; it does not
promise indefinite retention of temporary files.

## Independent review

A separate `ak-engineer-code-reviewer` child reviewed every changed file in
`407a870..f51efac` read-only, including docs, fixtures and source inventory. It
reported no actionable critical/high/medium/low findings in the agreed narrowed
scope. It separately ran four mock/model tests and `git diff --check`, both
passing; it did not rerun the supplied heavy lane or claim full workspace results.

The review checked verified-death attribution, synchronous immutable memoization,
late connect/timeout/close races, timer/socket disposal, selected/headless/inert
paths, and unchanged status/stream/registry ownership. The reviewer explicitly
retained the original acceptance gap. This is independent **agent** source review,
not a human approval, hosted CI result or installed qualification.

## Message and authority review

No human-facing CLI message, CLI grammar, exit/stream policy, capability,
selected-host environment allowlist or registry finalizer changed. The additive
optional `metadata.herdrCleanup` reports `unavailable`, never removal. No raw
socket reply, exception, transcript, environment or local socket path is exposed
in that result. The source inventory renewal tracks exactly the changed private
adapter/checkpoint/reporter dependencies; it does not authorize an effect.

Hosted CI, installed PPA/Pi/Herdr qualification, real sidebar observation,
standalone hook implementation, supervisor-death recovery and genuine Sinh UAT
remain not run. See `docs/PAP-315-herdr-exit-cleanup.md` and the P4 handoff for
required upstream work. No install, live teardown, managed extension edit, daemon
restart, live Pi signal or pane closure occurred during this session. Tests used
isolated fixtures; the workspace budget terminated only its owned test process
group, not unrelated host processes.
