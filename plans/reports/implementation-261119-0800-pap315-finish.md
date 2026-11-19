# PAP-315 managed-source completion checkpoint

## Outcome

Rebased source now uses Herdr's supported custom-source lifecycle and conditional
release contract. A real source-PPA launch registered while live and disappeared
after actual `/quit`, without injected reports. This fixes the previously
unqualified production-wiring gap; further exact-candidate validation follows.

## Source changes and ownership

- One native `ppa:pi:<UUID>` identifies each foreground process incarnation,
  independent of conversation ID, extension counter or wall clock.
- Only the existing relay's matched official Pi lifecycle frames are translated.
  Herdr's state API accepts the managed source without detecting Pi through the
  outer PPA process. Other operations remain opaque transport.
- Retirement is `pane.release_agent` with fixed pane, managed source, `agent:pi`
  and later sequence. Its current-source/agent guard precedes sequencing, so a
  delayed A release cannot clear B even if B has a lower/equal counter or resumes
  the same conversation. No shared-source clear or check-then-delete is used.
- Supported native Pi recovery is retained through validated `resume_argv` on
  current state reports. Custom `agent_session` metadata is not invented. Stale
  reports cannot overwrite resume; unsupported shell text is omitted.
- Existing actual-death admission, 500 ms total deadline, once-only submission,
  socket incarnation binding, no retry and unchanged terminal/registry finalizers
  remain. Selected-host filtering and headless paths are not broadened.
- Native source/request/death/elapsed observations are appended through the
  existing activity owner in the actual deployment directory. Logging failures
  cannot block settlement or change child status. No new CLI stream is added.

## Checks actually run

- Rebase typecheck on `67339d8`: passed.
- Workspace build after correcting the initial type error: passed.
- Managed relay/activity suite: **42 passed**.
- Combined relay/lifecycle/protocol/primer-transport/adapter/read-only-profile/
  interaction catalogue: **168 passed, 0 failed**, 186.13 s.
- Current workspace `corepack pnpm typecheck`: passed.
- `git diff --check`: passed.

Logs: `/tmp/pap315-rebased-typecheck.log`, `/tmp/pap315-finish-build.log`,
`/tmp/pap315-managed-source-activity-tests.log`,
`/tmp/pap315-finish-implementation-tests.log`, `/tmp/pap315-finish-typecheck.log`.

Original failures: the initial source test exceeded 90 s while its fixture
waited for a spawn that could not occur without PAP-318's compiled preload. A
workspace build established that prerequisite; the fixture now fails promptly
if launch returns without spawning. The first typecheck identified an inferred
index type without `resume_argv`; an explicit finite record type fixed it.
Neither failure is hidden by the later passes. No skill code was changed.

## Actual production-wired observation

New disposable pane `w1:p3E`, source CLI v0.1.175 after rebase, installed Pi1.4.0
and Herdr0.9.5/protocol22. Command:

```sh
node packages/pi-pa/dist/cli.js deploy rogue-one --ticket PAP-315 \
  --objective 'Disposable PAP-315 final qualification only. Do not read or edit files, call tools, commit, or launch helpers. Reply exactly PAP315-MANAGED-READY and wait for the operator to quit.'
```

Deployment `d-82653f` produced the ready marker and was observed by native
`herdr_agent get` as a live/done Pi before exit. Actual `/quit` returned the shell
with exit 0; a fresh agent lookup then returned not found. This case used actual
installed integration reports through the production relay, not the previous
controlled report injector. It preceded the new durable activity text; final
qualification will rerun the exact rebuilt candidate.

Herdr's named interactive-control API refused this self-reported source-PPA
entry even after a display-name assignment. The test therefore used intentional
raw terminal `/quit` input on its own disposable pane. No peer messaging or
interactive-control capability is claimed or added by PAP-315. This limitation
is separate from live registration/removal and must not be hidden.

## Human-facing activity review (CLI message standard)

Read `docs/cli-message-standard.md`, especially agent procedure §4 and checklist
§8. Affected path: advisory `herdr_cleanup` activity body; categories information
and nonblocking warning. Before: no durable closeout observation—adapter metadata
was not retained by CLI settlement. After examples:

- Verified: "Pi exited and its Herdr entry is absent. No action is required."
- Acknowledged: "Pi exited. Herdr handled the cleanup request, but entry removal
  is not verified. Inspect the existing session before requesting cleanup again."
- Unconfirmed: "Pi exited, but Herdr cleanup is unconfirmed. Preserve the original
  request and inspect its outcome before requesting another cleanup."
- Skipped: "Pi exited without reported managed Herdr state, so no cleanup was
  submitted. If an entry remains, inspect that existing session before requesting
  cleanup."

These are not blockers or changed exit statuses, so no five-field blocker envelope
is imposed. The formatter selects static text from typed native status, performs
no probe/write/recovery, and includes no raw reply, exception, socket path,
transcript or secret. Structural tests check plain bounded text, uncertainty and
next action; adapter tests verify one durable observation and unchanged streams,
status and terminal listeners. Independent readability review and final installed
propagation are separate evidence, not claimed by these structural checks.

## Remaining validation

Independent final-source review, full workspace test completion, broader source
regressions, exact-candidate normal/EOF/signal/supervisor-death/resume and delayed
release live cases, and final human review remain. Supervisor SIGKILL cannot
execute cleanup; report uncertainty cannot cancel already dispatched server
state. These remain explicit supported-fallback/uncertainty qualifications, not
claims of successful removal. No global install, push or ticket Done occurred.
