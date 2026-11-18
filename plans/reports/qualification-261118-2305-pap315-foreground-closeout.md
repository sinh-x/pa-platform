# PAP-315 revised P4 live qualification

## Outcome and limits

**The cleanup module removed an actual exited disposable Pi registration from
installed Herdr.** Clear acknowledgement took 313.39 ms; separate fresh absence
was observed at 541.17 ms. The shell/pane and unrelated agents were preserved.
Sinh explicitly confirmed seeing those sidebar and preservation postconditions.

This was a **controlled lifecycle fixture with a real Pi process**, not complete
installed-PPA end-to-end acceptance. Two actual source-PPA deployments started
and quit normally but never appeared in Herdr while alive; they cannot establish
removal. The production cleanup code is implemented and source-tested, but the
normal source-PPA registration/composition lane remains unqualified. No blanket
upstream-API blocker or full ticket acceptance is asserted.

## Exact candidate and environment

- Production source candidate: `ea95ff8`, including initial implementation
  `8c7a354` and corrected contract `7991148`. PPA source version label: 0.1.174.
- Source CLI executed as `node packages/pi-pa/dist/cli.js`; workspace build and
  typecheck passed. It was **not** installed over the global PPA binary.
- Qualification shell: Node v22.23.4, fish, Linux, Asia/Saigon. Live testing
  crossed midnight into **2026-11-19**; report naming retains session start.
- Installed Pi: 1.4.0,
  `/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/bin/pi`.
- Installed Herdr client/server: 0.9.5, protocol 22, compatible, no restart needed,
  `/nix/store/1a6fy989j3d68aqicm3gs83y21kkzri1-herdr-0.9.5/bin/herdr`;
  session `pa-platform`.
- Newly created disposable target: `w1:p3C`; observer: `w1:p3D`. Both were split
  from the caller's existing topology with focus preservation requested. The
  current Pi in `w1:p39` and all other sessions were outside mutation scope.

No installation, extension-file edit, daemon restart, pane closure, lease/worktree
return, branch change, push or ticket completion occurred. The blocked `.envrc`
was not approved or changed. No live test signal was sent to an unrelated process.

## Actual source-PPA launches

Commands used the compiled source CLI and fixed rogue-one profile. Objectives
instructed the disposable sessions not to read/edit files, launch helpers or call
tools, and to emit a ready marker before operator quit.

| Deployment | Configuration and observations |
| --- | --- |
| `d-cc9c33` | Ordinary source CLI; actual Pi PID 1443476. Ready response observed. No Herdr agent entry while alive. `/quit` plus Enter returned shell exit 0. Native registry settled once to `partial`, preserving existing unstaged-completion behavior. |
| `d-e457bb` | Same source CLI with `PA_HERDR_LIFECYCLE=1`; actual Pi PID 1953533. Ready response observed. Still no Herdr agent entry while alive. `/quit` plus Enter returned shell exit 0. Native registry settled `partial` with the same existing explanation. |

The original process/registry behavior was preserved; the CLI's existing
"Deployment completed" text is not a claim that the registry status was success
or that Herdr cleanup was verified. These cases are **not cleanup passes**.
Underlying installed registration/loading/process-detection behavior requires
further qualification; no exact root cause is claimed from public source alone.

## Controlled installed protocol/process case

Manual fixture:
`plans/261118-2305-pap315-foreground-closeout/qualify-live-herdr.mts`.
It imports the actual production cleanup module. It requires the explicitly
named disposable agent, identifies its sole foreground Pi, pins native process
birth, sends controlled session/state frames through the private relay, waits
for verified process disappearance, then calls the actual closeout module. It
sends no process signal and never closes a pane. Its report frames are labelled
synthetic; they are not misrepresented as installed-extension output.

A Herdr-managed Pi was started in `w1:p3C` with `--no-skills --session-id
c9a31500-1111-4111-8111-000000000003`, named `pap315-qualification`. A no-tools
prompt produced a ready response; a real installed session file with that UUID
was identified by filename metadata only. Native foreground PID was **3225708**.
The fixture used that actual session **path**, matching the installed reporter's
reference shape, and observed the registration while the process remained live.

The operator then sent Ctrl+D via the recognized Herdr agent tool. After native
PID/birth disappearance, the production module submitted exactly one clear:

```json
{"status":"acknowledged","reason":"still-listed","submitted":true,"requestId":"ppa-herdr:1db734be-691e-479f-8afa-99744e64b829","deathEvidence":"confirmed-process-gone"}
```

- Module duration after confirmed death: **313.389598 ms**, below the 500 ms
  budget. Immediate readback still saw process fallback, so it honestly returned
  acknowledged—not verified absence.
- A separate **read-only** external observation found `agent_not_found` at
  **541.168683 ms** after confirmed death. It did not resend clear and is not
  included in, or substituted for, the production 500 ms stage measurement.
- The fixture's fresh before/after `agent.list` comparison retained every unrelated
  agent. Subsequent native `agent.get` found no target agent.
- Fresh `herdr api snapshot` showed target/observer panes present with unknown/no
  agent and the caller's Pi in `w1:p39` still idle.
- Target shell PID **1267769** and observer shell PID **2470266** remained. Both
  accepted inert printf commands producing `PAP315-TARGET-SHELL-OK` and
  `PAP315-OBSERVER-SHELL-OK`. Both panes remain open for inspection.
- Fixture exited 0. Sinh answered **Yes** to the explicit question about observing
  the disposable entry disappear while these panes and other sessions remained.
  That is scoped visual confirmation, not blanket sign-off for all six UAT groups.

## Original failures retained

1. Initial fixture admission required visible session argv. Installed Pi replaces
   visible argv with its process title `pi`, so the guard failed **before mutation**.
   The owned test fixture was corrected to require the exact named disposable
   pane's sole foreground Pi and pin its native birth. Recorded agent.start args
   retain the selected UUID; no skill code or production admission was bypassed.
2. A first controlled ID-reference case received acknowledged/still-listed, and
   an overly strict fixture assertion expected immediate verified absence. That
   assertion failed; later native observation found no agent. No success timing
   is invented for that run. The fixture now separates acknowledgement and later
   read-only absence observation, matching the production result contract.
3. Another ID-reference fixture encountered a different path-shaped registration
   at exit and returned `skipped/foreign-registration`, `submitted:false`, in
   102.65 ms. It preserved that registration rather than issuing a guessed clear.
   The successful run used the actual installed session path, not a synthetic ID.
4. A direct Pi prompt once returned Herdr's prompt-stalled result despite the
   ready reply being visible. Its later native terminal response was inspected;
   the error was not re-labelled prompt correlation success.
5. Some read-only CLI probes initially used unsupported `--json` flags/positional
   syntax. Corrected `herdr api snapshot` and `pane process-info --pane` succeeded;
   those syntax errors had no teardown effect. A wait-output call timed out even
   though later direct terminal read recovered the successful fixture JSON; the
   recovered output plus fresh API checks are the evidence, not the wait result.

## Remaining acceptance lanes

Source tests cover child crash/TERM/KILL, EOF, duplicate callbacks, uncertain
reports/clear responses and forced sequence/late-work cases. **Live** child
crash/TERM/KILL, supervisor death, forced delayed clear/replacement races,
standalone transitions, and every protected/selected/headless installed variant
were not qualified here. Supervisor SIGKILL recovery remains an explicit upstream
liveness limitation, not a claimed successful cleanup.

The ordinary source-PPA registration gap, fully installed candidate/config
selection, remaining live matrix, full workspace test completion and hosted CI
remain open. The last full workspace run timed out; focused 262-test validation
and scoped visual confirmation do not waive those results. Do not blindly retry
an uncertain clear; preserve its original request ID and fresh process/session
state before separately authorized recovery.
