# PAP-315: foreground Herdr exit cleanup

## P1 outcome

**Automatic deletion is unsafe on the audited protocol-22 shared `herdr:pi`
lane. Keep that dependent effect unavailable until the server can retire an
exact process incarnation.** Normal same-shell overlap is not the blocker:
PPA holds the foreground until settlement. The demonstrated problem is server
work that can survive the client's bounded timeout and apply after shell return.
No live teardown, installation, pane closure or daemon restart was performed.

## Evidence and provenance

Observed 2026-11-18 in the PAP-315 worktree:

- Baseline `407a87047fdf801b7fecc44a06687c232bbc37a2`.
- `herdr --version`: 0.9.5. `herdr status --json`: client/server protocol 22,
  compatible, no restart needed, session `pa-platform`.
- Installed binary: `/nix/store/1a6fy989j3d68aqicm3gs83y21kkzri1-herdr-0.9.5/bin/herdr`.
  Deriver: `q0bvl2mcls8w7blqym7mq13753cy062r-herdr-0.9.5.drv`; derivation
  metadata records source `7qaqrw2wdmlqq74cvpn2dr0ha0xrypaf-source`, no patches.
- `herdr api schema --json`: protocol 22/schema 1. In
  `schemas.request.$defs`, `PaneClearAgentAuthorityParams` has `pane_id`,
  optional `source` and `seq`; `PaneReleaseAgentParams` adds `agent` but no
  expected incarnation/session/revision. Schema retrieval does not contact the
  daemon or establish successful deletion.
- Public source: <https://github.com/herdrdev/herdr>, fetched at
  `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`; Cargo version 0.9.5/protocol 22.
  This is not proven byte-for-byte correspondence to the installed server.
  Its Pi v9 asset SHA-256 is
  `2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4`,
  matching the historical PAP-303 asset observation, not proving server custody.

The first local derivation parser assumed the older JSON shape and failed with
`AttributeError`; a corrected parser read `derivations` successfully. No product
check or teardown success is inferred from either command.

## Actual operation and ordering contract

Paths/lines refer to the public revision above:

| Owner | Audited behavior |
| --- | --- |
| `src/app/actions.rs:1593–1620`, `src/agent_resume.rs:328–348` | `HookAgentReleased` ignores official sources, including `herdr:pi`. Release is not Pi teardown. |
| `src/terminal/state.rs:1762–1808` | Clear matches shared source and accepts a newer sequence, suppresses current hook authority/session and recomputes fallback state. It is not conditional on process incarnation and does not necessarily remove a process-detected agent. |
| `src/terminal/state.rs:1742–1750,1946–1953` | Sequence is a per-source ordering watermark, not compare-and-swap ownership. |
| `src/terminal/state.rs:1767–1784` | If authority is absent, clear returns before recording a sequence fence. |
| `src/terminal/state.rs:1244–1283,1385–1415,1654–1663` | Stale session references suppress some reports, but explicit Pi new/resume/fork reports may reactivate them; conversation path is not a permanent process-incarnation fence. |
| `src/terminal/state.rs:765–768,982–990,2327–2337` | Replacement/respawn paths reset sequencing or stale-session retention. |
| `src/api/server.rs:122–149,601,958–1019` | Connections dispatch independently into the app queue. Normal lifecycle dispatch waits without an app-response deadline; client disconnect does not retract the queued action. |
| `src/app/api/panes.rs:1873–1909` | Clear/release reply generic OK after handling, including rejected/no-op cases. OK is not evidence of disappearance. |

Concrete counterexamples:

1. B registers on the same shared source with sequence 12 after PPA A has timed
   out and returned. A's delayed clear/13 then clears B. A fresh timestamp or
   checking B before submitting A's clear does not fix this application race.
2. A session/10 is recorded but authority is not yet installed. Clear/12 returns
   without a fence. A delayed state/11 can still acquire authority. Locally
   dropping the reporter queue does not retract already-dispatched server work.
3. Session path/id may be reused by an in-process resume or a new process.
   Server tombstone reactivation semantics preclude using that path alone as an
   irreversible process-retirement token.

Smallest required server contract: atomic retire-if-current on a launch/report
incarnation, a retired-incarnation fence for already queued reports (including
clear-before-authority), and explicit applied/stale/no-op outcomes with timeout
reconciliation. Do not invent wire fields on protocol 22. A future supported
contract must be audited/qualified before enabling the effect.

## Current PA ownership and composition

`packages/pi-pa/src/adapter.ts:runPiForeground` launches node-pty and owns
`onExit`, confirmed-process-death fallback, terminal restoration and registry
settlement. Cleanup belongs after that death evidence, before foreground return,
not on input `/quit`, idle, `agent_end` or shutdown-hook entry. The selected
native host has an outer PTY wrapper PID and a separately admitted Pi runtime
PID/birth; the wrapper PID is not the Pi incarnation.

Ordinary managed launch retains extension discovery while adding the trusted
extension. Protected review/validation disables discovery. The optional PA
`herdr-lifecycle.ts` bridge requires `PA_HERDR_LIFECYCLE=1` and an exact validated
same-user/root Unix socket plus pane. It and the official extension use the same
`herdr:pi` source, so opt-in alone does not prove exclusive ownership. The current
selected-host finite environment omits Herdr bindings; do not broaden it as an
incidental cleanup fix. Headless paths have no foreground teardown owner.

The PA reporter uses one in-flight connection and session/state slots. Shutdown
currently destroys its local socket and drops queued reports; it does not revoke
server work. The official Pi v9 asset likewise has no actual-exit cleanup and
can retry reports. Do not introduce a second reporter or assume PA can quiesce
unowned official-extension requests.

## Standalone and supervisor death

No standalone shutdown-hook change is made here. Pi shutdown hooks also occur
around continuing-process transitions in supported compositions; actual installed
API documentation access was denied by the source guard and was not bypassed.
The Home Manager-managed extension is not edited. NX-069/Herdr/Pi owns the
standalone declarative integration and a future incarnation-aware contract.

If the PPA supervisor is killed, no PA JavaScript callback is guaranteed to run.
A Pi hook cannot cover supervisor/child SIGKILL. No supported automatic stale
registration recovery is demonstrated for this separate-PTY case. Server-side
incarnation/process liveness or the guarded operator recovery below remains an
upstream dependency, not a cleanup success claim.

## Operator recovery constraints (protocol 22)

There is **no verified safe automatic recovery command** for this installed pair.
Do not recommend `pane release-agent` merely because it returns OK. Do not issue
unconditional `pane.clear_agent_authority` after a read-then-check in a pane that
can be reused, and do not restart the daemon or close the pane as a workaround.

For an explicitly authorized disposable/maintenance target:

1. Preserve the original request coordinates and any uncertain delivery. Inspect
   the same operation before considering another mutation; never blindly resend.
2. Identify the exact server/socket, pane, supervisor and Pi runtime PID/birth.
   Verify actual process death; idle state, missing marker or shell title is not
   enough. Recheck for independently launched replacements.
3. Use only a server-supported incarnation-conditional recovery operation, or an
   owner-reviewed maintenance procedure that prevents reuse and reconciles all
   outstanding work. Neither has been qualified in this session. Stop if absent.
4. After an authorized operation, obtain fresh agent list and API snapshot plus
   real sidebar observation; confirm the old registration is absent, other/new
   registrations survive, the pane remains and its shell accepts an inert command.

No live recovery operation or postconditions have yet been verified. P4 must
remain incomplete until a supported contract, an explicitly selected installed
candidate and disposable-session authorization exist. Source/model tests, generic
OK and this written procedure do not substitute for those observations.
