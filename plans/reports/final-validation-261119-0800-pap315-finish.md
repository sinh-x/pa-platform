# PAP-315 final source and installed-candidate evidence

## Outcome and merge gates

Actual PPA-managed sessions now use the explicitly approved Herdr self-reported
identity `ppa-pi`, register while alive, and retire through source/agent-qualified
release after verified child death. Standalone Pi, PPA's runtime/provider,
execution authority and default installation are unchanged.

Runtime source is frozen at `20c973f` on rebased develop
`b30f4d44a48f63cc795cb24ab41f2b4d34de7315`. Independent reviews found no remaining
actionable source defect. This report-only checkpoint does not turn pending
manual/hosted checks into passes. PR merge remains conditional on its required
checks and the remaining manual-suite result; no admin/force merge is authorized.

## Rebase, fixes and review

Original tip `bcbb892` is preserved at
`refs/backup/PAP-315/20261119-0800`. All eight earlier phase commits were rebased;
PAP-318's primer transport and launch-failure cleanup were preserved in conflicts.
Completion commits include `c1d5a92`, `c0777d4`, `d6ab4f8`, `9880bde`, `20c973f`.

Review found and fixed malformed method coercion/deep serialization, lossy UTF-8
rewriting, and stale resume inheritance. Current handling bounds serialization,
compares canonical bytes, rejects escaped lone surrogates, uses native reference
byte bounds, and atomically rebinds state authority on conversation changes.
Omitted/rejected new references cannot retain another conversation's recovery
command; state-only absence can retain its known current session. No unregister
operation occurs during continuing-process transitions.

Separate follow-up review confirmed the fixes. Public Herdr revision
`ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` was separately checked for custom-agent,
source-first release, reported resume and timestamp-scoped shell fallback
semantics. The final Unicode delta review compared 56 valid frames, rejected 60
malformed reports, checked all 2048 lone surrogate code units as keys/values,
and found no actionable defect. Those were in-memory/source checks, not installed
observations.

Sinh explicitly selected `ppa-pi` after the known/process-detected `pi` path
showed intermittent registration. This enables Herdr's existing self-reported
idle-shell fallback without claiming the hidden PTY child is directly detected.

## Actual software results and original failures

| Lane | Result |
| --- | --- |
| Completion focused implementation/primer/profile/catalogue | 168 passed, 0 failed. |
| Broader lifecycle/deploy/composition/primer/catalogue after review | 306 passed, 0 failed. |
| Final relay/protocol/Unicode cases | 61 passed, 0 failed. |
| Workspace typecheck/build | Passed before final Unicode-only delta; final affected-package typecheck passed afterward. |
| Completions | Passed; no grammar/completion source changed. |
| Staged secrets scans and diff checks | Passed at source commits. |
| Root harness | 43 passed, 0 failed. |
| pa-core full package | 2435 passed, 14 explicit skips, 0 failed (2449 total). |
| OpenCode full package | 109 passed, 1 explicit skip, 0 failed. |
| runtime-host full package | 1 passed, 0 failed. |
| Fresh-pane full Pi attempt | Timed out after 1800 s and contained 26 prerequisite failures; not a pass. |
| Targeted rerun of those failed cases in PPA's supported toolchain environment | 28 passed, 0 failed; no executable allowlist or confinement guard was weakened. |
| Correct-toolchain full Pi attempt / continuation | Pending at this report checkpoint; results must be posted separately before merge. |

The fresh-pane failures reported `DOCUMENT_UNAVAILABLE` and
`EXECUTION_PROJECT_PREREQUISITE` for trusted executable/namespace prerequisites.
Exact missing-program state was not recovered after the operator manually
closed those panes. The supported PPA toolchain had trusted Bubblewrap available;
the unchanged failed cases passed there. This establishes the successful
recheck, not a retrospective pass for the original environment. An earlier
"no failures so far" update was based on the current tail, not the whole log;
the full-log failures are retained here explicitly.

Early implementation failures are also retained: the pre-build test timed out
without PAP-318's compiled preload; build established that prerequisite and the
fixture now fails promptly if no spawn occurs. Initial record-index typing was
corrected. Review-harness mock pipe setup was repaired by the reviewer, not
production code. No skill code was changed. The missing advisory skill remains
a labelled failed helper attempt, not successful advice.

Logs are under `/tmp/pap315-*.log`; key files:
`pap315-final-workspace-test.log`, `pap315-final-pi-suite.log`,
`pap315-failed-cases-final.log`, `pap315-pi-suite-correct-runtime.log`,
`pap315-pi-remaining.log`, `pap315-final-unicode-tests.log`. Temporary-log retention
is not guaranteed; this report and subsequent PR check results retain outcomes.

## Immutable packages, not a global install

- Initial managed-source package:
  `/nix/store/4k0zy1ksgx3x0wgrxbyvnwmp2cs02mdd-pa-platform-0.1.175`.
- Approved self-reported package from `9880bde`:
  `/nix/store/c24jn23xsacsnh08rpva6v6cvwcysz61-pa-platform-0.1.175`.
- Final Unicode-hardened package from `20c973f`:
  `/nix/store/fik2civ4y5psg61r74irzbjg2if454y6-pa-platform-0.1.175`.

Each was built with `nix build --no-link --print-out-paths .#ppa`, without
installing over the user's default PPA. Runtime uses the packaged Node22.23.2;
Pi displayed v1.4.0 and installed Herdr client/server reported 0.9.5/protocol22.
Source-CLI live attempts exposed mutable editor-bundle interference while the
full Pi suite selected both editors. Qualification therefore used immutable
package executables, isolated from those generated source artifacts. The failed
source launch `d-055d04` is not counted as cleanup success. `.envrc` was never
approved or changed.

## Actual live matrix, no injected lifecycle state

The final one-pane sequence used only disposable `w1:p3J`, with fixed no-tools/
no-file-change objectives and actual package execution. Other sessions were not
targeted. Herdr showed `ppa-pi` while each tested process was alive. Native
cleanup observations below come from each deployment's `activity.jsonl`.

| Deployment | Actual test and outcome |
| --- | --- |
| `d-88285d` | Empty-input Ctrl+D/EOF: live entry observed, shell exit0, fresh absence; one verified cleanup in 204.31 ms. |
| `d-11cb2b` | Actual child SIGTERM, with parent surviving at signal: live entry observed, one verified cleanup in 209.77 ms, shell exit0. |
| `d-98dda0` | Actual child SIGKILL, with parent surviving at signal: live entry observed, one verified cleanup in 204.32 ms; both child/parent subsequently gone and fresh absence. Existing CLI exit0/partial-registry interpretation was preserved, not re-labelled a normal child success. |
| `d-519997` | Actual supervisor SIGKILL: both owned PID/births gone after500ms; shell exit137. Herdr removed the self-reported entry via its server fallback. Zero PPA cleanup events: no claim that killed JavaScript ran. |
| `d-a24083` | Same Pi PID3667916 stayed live/listed through `/reload`, `/new`, actual `/fork`, and actual `/resume` to the disposable original session. No cleanup event before death. Final `/quit` submitted one verified cleanup in204.89ms. |
| `d-3fd197` | New Pi PID343236 resumed the same conversation UUID `7ce148dc-3812-4c43-a51b-acec15dec242` as retired `d-a24083`. Installed stale-source guard check preserved it, then normal quit verified its own cleanup in204.18ms. |
| `d-1dbb33` | Exact final `fik2...` package: live entry, actual `/quit`, fresh absence, one verified cleanup in211.69ms and shell exit0. |

Child/supervisor signals checked current process fingerprints, actual parent
relationship, exact immutable launcher path and the unique disposable objective
before signalling. No unrelated process was signalled. Normal/source child exits
retain the existing `partial` registry explanation when no completion payload was
staged. Supervisor death leaves its native registry row running until its existing
health/reconciliation owner acts; this ticket does not fabricate a terminal event
or sweep unrelated registry state.

Herdr's known interactive named-agent API refused some self-reported source
entries. Operator test input therefore used intentional raw terminal controls on
the owned pane. No peer-messaging capability was claimed or activated.

## Installed replacement guard and uncertainty boundary

After `d-a24083` was verified absent, a new process `d-3fd197` resumed the **same
conversation** and was observed live. A deliberate stale-source fault injection
used A's captured source `ppa:pi:dcb9af49-f798-491e-b0f0-8728d26fdaaf`,
`agent:ppa-pi`, and sequence9007199254740991. The native handler acknowledged;
fresh lookup still showed the replacement, whose PID/birth was unchanged. B then
retired normally with source `ppa:pi:bc74a662-bae3-46d9-938d-50aadddf67cc` and
verified absence, demonstrating that A did not poison B's sequence state.

This was an intentional new diagnostic request using the stale source and a
raised counter **after A's outcome was already verified**. It was not a blind
retry of an uncertain effect, nor a byte-for-byte delayed original request.
Source tests separately force delayed original release application with
lower/equal/higher B counters and verify source-first guarding.

The proposed delayed-original live proxy was not run: the launcher was privacy
blocked on `env:process.env`; the user's one-time approval could not be applied by
the tool. No alternative access to the protected full environment was attempted.
The unexecuted prototype was removed from the final tree through native trash
`T-542`; its bytes and Git history at `9880bde` remain. It is not counted as a live
pass. Already-dispatched uncertain state reports remain a separate liveness
limitation; disconnect does not retract them, retirement is withheld on uncertain
report delivery, and no safe deletion is fabricated.

## Visual and preservation postconditions

Fresh agent lookups found the retired target absent; caller `w1:p39` remained
listed/idle. The disposable shell accepted an inert completion marker. Sinh
explicitly confirmed the `ppa-pi` entry disappeared automatically while other
sessions stayed. Only that one newly created test pane was then closed, per the
operator's permission; manually closed earlier panes were not counted as
lifecycle-success evidence.

This visual observation is scoped, not approval of unperformed network-delay,
standalone or hosted-CI scenarios. Standalone official hooks were not edited;
future standalone changes remain with NX-069/Herdr/Pi. No daemon restart, default
installation, worktree/lease return or branch deletion was performed.
