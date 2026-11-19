# PAP-315 P4 blocked handoff

## Outcome

**P4 installed qualification was not executed. Automatic removal remains
unavailable, and PAP-315's original acceptance criteria are not satisfied.**
Sinh explicitly selected safe PA-side implementation with deletion left blocked
after the P1 protocol findings. This handoff is the P4 checkpoint, not an
installed-validation pass or a claim that all original phases are complete.

Source commits:

- P1 `ed49242`: audit and required safety contract.
- P2 `f51efac`: fail-closed supervisor checkpoint, local reporter hardening,
  focused regressions and inventory reconciliation.
- P3 `451b957`: source-validation and independent agent-review evidence.
- P4: this separately committed blocked handoff and recovery limits.

The source candidate remains `f51efac`; later phase commits change reports only.
The selected branch/worktree is retained. No ticket completion, installation,
rollout, push, managed-extension edit, live teardown or pane closure is claimed.

## Observed installed metadata, not a selected test candidate

Read-only commands at handoff: `ppa --version`, `pi --version`, executable
realpath lookup, `herdr status --json`.

| Component | Observation |
| --- | --- |
| Installed PPA | 0.1.174; `/nix/store/a0ikvrhgspzw023rydc248x5ys62h66b-pa-platform-0.1.174/bin/ppa` |
| Installed Pi | 1.4.0; `/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/bin/pi` |
| Installed Herdr | Client/server 0.9.5, protocol 22, compatible, no restart needed; `/nix/store/1a6fy989j3d68aqicm3gs83y21kkzri1-herdr-0.9.5/bin/herdr` |
| Herdr session | `pa-platform`; metadata inspected only, no target pane selected for mutation. |
| Candidate/config qualification | Not selected or installed. Same version labels do not mean this branch's source is installed. |

No disposable live session was created. No live test signals or authority-clear
requests were sent. Existing source fixtures are isolated test doubles/processes,
not installed PPA/Pi/Herdr or actual sidebar observations.

## Original acceptance disposition

| Group | Source evidence | Installed/UAT status |
| --- | --- | --- |
| TS-1 / AC-1 normal quit/EOF | Verified-death-only unavailable checkpoint; existing single-event/no-Git and natural-exit regressions pass. | Not run; no automatic disappearance implemented. |
| TS-2 / AC-2 crash/signals/supervisor death | Fake child crash/TERM/KILL and fallback paths pass without cleanup connections. Supervisor death is explicitly uncovered. | Not run; server-side fallback remains unproven. |
| TS-3 / AC-3 delayed/replacement races | Public-source audit and labelled counterexample models establish why shared-source clear is not used. Late local callback tests pass. | Not run; no actual-server incarnation-safe contract established. |
| TS-4 / AC-4 continuing/inert paths | Disabled/partial/aliased/headless/selected-host paths stay inert; continuing-process reporter sequences increase without teardown. | Not run; ordinary/protected/selected installed composition not qualified. |
| TS-5 / AC-5 failure/uncertainty | Unsupported cleanup submits nothing, so it cannot retry, hang or clear replacements. Reporter close/timeout callbacks are source-tested. | Not run; real retirement response/failure/timeout behavior is not implemented or qualified. |
| TS-6 / AC-6 checks/recovery | Focused lane 224 passed; workspace typecheck/build/completions passed; separate source review found no actionable defects. | Full workspace tests timed out at 600 s. Hosted CI, installed observations, recovery postconditions and genuine Sinh UAT remain incomplete. |

Source test passes deliberately do not establish the missing remote guarantees.
The synchronous unavailable path also does not measure a future real transport's
500 ms total cleanup deadline. See the P3 report for actual timings and failures.

## Required next owner work

1. **Herdr upstream:** define and qualify atomic retire-if-current for a distinct
   process/report incarnation, retained fencing of queued old reports even before
   authority exists, and applied/stale/no-op outcomes with timeout reconciliation.
   Prefer an existing supported contract if the exact selected server proves one;
   do not invent protocol-22 fields or use check-then-clear.
2. **NX-069 / declarative Pi integration owner:** select the exact Herdr/Pi
   integration pin and one reporting owner, assess actual-quit versus continuing
   session transitions, and supply a supported supervisor-death recovery path or
   retain that explicit limitation. Do not imperatively edit Home Manager output.
3. **PA implementation owner:** after that contract is available, separately
   implement the real launch/PID-birth/report ownership handoff and bounded
   retirement stage. The current checkpoint does not manufacture those identities
   or pretend opt-in is exclusive registration ownership.
4. **Installed qualification owner and Sinh:** explicitly select/install the
   candidate/config and authorize disposable sessions and test signals. Execute
   all six published UAT groups; observe fresh list/snapshot, real sidebar,
   preserved other/replacement sessions and an open functioning shell. Obtain
   separate human acceptance. Hosted CI and the incomplete workspace test lane
   still need their own results.

## Recovery guidance

The version-specific constraints in `docs/PAP-315-herdr-exit-cleanup.md` are the
supported handoff: preserve uncertain request coordinates, prove exact process
death, exclude replacements and reconcile outstanding server work before any
separately authorized mutation. Generic OK is not disappearance. There is no
verified safe cleanup command for the observed pair; official-source release is
not a workaround, and unconditional clear, daemon restart or pane closure must
not be recommended. Recovery postconditions have **not** been verified.

## Unresolved items

The server retirement/fencing contract, standalone integration and
supervisor-death fallback, safe operator recovery, full workspace test result,
hosted CI, installed qualification and genuine human UAT remain open. No further
user decision is requested in this narrowed source handoff; resuming those lanes
requires the relevant owner and explicit scope/authorization.
