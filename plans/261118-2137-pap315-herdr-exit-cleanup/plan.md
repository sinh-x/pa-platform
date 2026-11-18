# PAP-315 implementation plan

Date: 2026-11-18. Branch: `feature/PAP-315-herdr-exit-cleanup`.
Baseline: `407a87047fdf801b7fecc44a06687c232bbc37a2`.
Requirements: published `pap315-herdr-exit-cleanup/r001`, subject
`f9dafc81b5e1d6bd1a49c141b5075458e187f7bf0b5ce3659cada85517bf9ea1`.
The user requested implementation and a separate commit after each phase.
Rogue-one admission does not authorize installation or live destructive tests.

## Phases

1. **P1: protocol and ownership audit.** Inspect installed metadata/schema,
   public server ordering and current launch/reporting composition. Commit the
   finite supported contract and any demonstrated dependent-operation gap.
2. **P2: implementation and regressions.** Implement only safe PA-owned behavior;
   never substitute check-then-clear for an atomic incarnation contract. Preserve
   existing process/terminal/registry finalizers and the 500 ms total stage bound.
   Commit the source and focused regressions.
3. **P3: review and checks.** Obtain a separate agent review, run focused tests,
   workspace typecheck/build/test and secrets scan as applicable. Record original
   failures and limits separately from installed or human acceptance. Commit.
4. **P4: installed qualification and recovery.** Use only explicitly authorized
   disposable sessions and selected installed candidates. If a required safe
   operation or authorization is absent, commit an accurate blocked handoff and
   recovery constraints, not a fabricated acceptance result.

## Discovery

No previous implementation changes or untracked files were present. Installed
Herdr reports 0.9.5, protocol 22, session `pa-platform`. Its schema exposes no
expected incarnation on clear/release. Public source audit demonstrates that
release ignores official Pi, clear uses shared source/sequence rather than
incarnation, and client timeout cannot retract dispatched work. See
`docs/PAP-315-herdr-exit-cleanup.md` for provenance and concrete races.

A read of the selected installed Pi `docs/extensions.md` was denied with
`LOCAL_SOURCE_UNSUPPORTED_FILE`; it was not retried through another spelling,
reader or copied file. New standalone-hook implementation is therefore not
claimed; existing PA lifecycle APIs can be assessed from repository source.

## Validation lanes

Source: lifecycle, protocol, supervisor, replacement/delayed-report tests;
existing open-stdin natural-exit regression must remain below 1000 ms.
Workspace: `corepack pnpm typecheck`, `corepack pnpm build`,
`corepack pnpm test`, and `corepack pnpm secrets:scan` before sensitive commits.
No CLI grammar change is planned. Independent review, hosted CI, exact installed
behavior/sidebar observation and genuine Sinh UAT are separate evidence.
