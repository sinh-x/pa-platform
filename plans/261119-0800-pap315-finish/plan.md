# PAP-315: finish on updated develop

## Rebase record

Requested by Sinh on 2026-11-19, Asia/Saigon. Worktree was clean on
`feature/PAP-315-herdr-exit-cleanup` at `bcbb8922ed87a2bf346168cccc439771239d58d4`.
Fetched `origin develop`; selected remote base is
`b30f4d44a48f63cc795cb24ab41f2b4d34de7315` (v0.1.175).
Pre-rebase history is retained at `refs/backup/PAP-315/20261119-0800`.

The first detach failed on a transient index lock. The lock disappeared without
removal; clean state and original HEAD were observed before retry. Rebase then
replayed all eight commits. Adapter/source-inventory conflicts were resolved by
preserving PAP-318's bounded primer environment/start-failure cleanup and adding
PAP-315's awaited relay/disposal. Source hashes were reconciled at each conflict.
The resulting tip is `67339d8`, with the remote develop pin as an ancestor and no
uncommitted changes. Rebased pi-pa typecheck passed. Old report hashes refer to
historical candidates, not fresh qualification of this rewritten history.

## Remaining problem and supported fix

Prior source-PPA launches never appeared while live. Public Herdr 0.9.5 source
at `ee5bfb5` explains an important distinction: official `herdr:pi` full-lifecycle
claims are generation-gated by detected Pi, which PPA's separate PTY hides.
A custom source can hold Pi authority without that process detection. Its
`pane.release_agent` is supported and checks the current authority's source and
agent before sequencing. Official Pi release remains intentionally ignored.

Use one native random `ppa:pi:<UUID>` per foreground launch. Rewrite only the
existing relay's matching official Pi lifecycle reports to that managed source.
Keep the bounded serialized queue, original child/pane/socket binding, actual
exit admission, 500 ms total budget and no retry. A and B have different sources,
even if they resume the same conversation or their counters reset. A delayed
release must preserve B through the server's source guard, not check-then-clear.

Custom sources do not retain native `agent_session` fields. Preserve the existing
native Pi resume command through the supported, bounded `resume_argv` on state
reports (`pi --session <validated path-or-id>`). This does not select a new PPA
resume path or change selected-host admission. Do not infer ownership from a
conversation path or reintroduce the shared-source unconditional clear.
Standalone official reporting and protected/headless/selected-host policy remain
unchanged. Supervisor-death cleanup is not guaranteed; it must be observed and
its remaining server-side liveness dependency disclosed.

## Delivery sequence

1. Commit the rebase record and this design refinement.
2. Implement managed-source translation/release and protocol/failure/race/resume
   regressions. Include lower/equal/newer-counter B and delayed A release.
3. Independently review; run focused, primer-transport, workspace and secrets
   checks. Retain failures and do not call a timeout a full-suite pass.
4. Qualify actual source-PPA launches with installed Pi/Herdr in newly created
   disposable panes: live registration, normal quit/EOF, child signals and
   supervisor-death behavior. No synthetic report injection substitutes for
   production wiring. Keep shell and other sessions intact. Do not install
   globally, push or declare ticket Done without supported final evidence.

All delegates receive this worktree, timezone Asia/Saigon and language en_US.UTF-8.
No modification of the unrelated learning-management journal or bulletin is part
of this continuation.
