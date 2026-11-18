# PAP-315: foreground Herdr exit cleanup

> **Revised at Sinh's direction, 2026-11-18 23:05:** the blanket unavailable
> verdict below is superseded by the
> [foreground-closeout implementation plan](../plans/261118-2305-pap315-foreground-closeout/plan.md).
> Normal same-shell launch ordering is already guaranteed by foreground PPA.
> A correlated server response supplies a usable completion barrier; actual
> cleanup is now being implemented. Historical results and limitations below
> are retained, not current product acceptance.

Historical delivery status: P1 audit and the explicitly narrowed P2 safe source work are
committed. P3 focused checks passed (224 tests), with workspace typecheck/build/
completions passing and the full test run timing out. P4 remains blocked.
See the [validation report](../plans/reports/validation-261118-2137-pap315-herdr-exit-cleanup.md)
and [installed/UAT handoff](../plans/reports/handoff-261118-2137-pap315-herdr-exit-cleanup.md).
Original product acceptance is incomplete; this branch does not remove entries.

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

## P2: authorized safe PA-side checkpoint

After P1, Sinh explicitly selected **complete safe PA-side work; leave deletion
blocked**. This narrows delivery, not the original product acceptance criteria.
No upstream repository change, install or live cleanup was authorized.

`src/herdr-exit-cleanup.ts` (under `packages/pi-pa/`) snapshots eligibility from
the actual foreground child's environment, using the existing explicit-opt-in
socket validator. Only PTY exit or existing confirmed-process-gone paths memoize
an immutable result. The adapter adds optional metadata:

```json
{"herdrCleanup":{"status":"unavailable","reason":"incarnation-safe-retirement-unsupported","deathEvidence":"pty-exit"}}
```

The fallback evidence value is `confirmed-process-gone`. This is an additive
internal result field, not a deletion/ownership claim or a new human-facing
message. No socket is opened, no process identity is fabricated, no timer or
retry is created, and no child result, registry terminal event, terminal stream
or finalizer is replaced. Binding/ownership transfer and a real retirement
transport remain unimplemented until a safe supported server contract exists.
Selected-host eligibility uses its actual filtered child environment, so the
unforwarded bindings remain inert. Headless paths do not create this checkpoint.

The existing PA reporter now closes its active attempt through the same
idempotent finish path, disposing its timer and dropping queued slots. Connect
callbacks check closed/finished/active identity before writing, so callbacks
queued before close or timeout cannot write stale reports afterward. This is
local quiescence only; it cannot retract an already submitted server request or
quiesce an independently loaded official extension.

Source inventory reconciliation covers only the adapter, checkpoint and reporter.
There is no new CLI/native operation, capability, environment forwarding or
permission. Existing interaction catalogue tests confirm no Herdr command is
advertised. No human-facing diagnostic was added or modified, so there is no
before/after CLI wording or installed readability claim.

P2 checks (2026-11-18):

- Initial checkpoint/reporter lane: 18 passed; expanded protocol lane: 27 passed.
- Combined checkpoint, lifecycle, protocol, adapter, extension composition and
  interaction catalogue: **109 passed, 0 failed, 0 skipped** (119.97 s).
- `corepack pnpm --filter @pa-platform/pi-pa typecheck`: passed.
- `corepack pnpm secrets:scan` and `git diff --check`: passed.
- Open-stdin subprocess tests, with the unavailable checkpoint selected, measured
  21.0 / 21.5 / 28.2 ms after child-exit evidence for valid JSON / plain text /
  other JSON; writer remained open, listeners were restored, one settlement.
- Fake PTY normal/nonzero/SIGTERM/SIGKILL, EOF, confirmed-death and unproven-death
  cancellation paths made zero cleanup socket connections. These are source
  fixtures, not signals sent to live Pi or installed Herdr observations.
- Protocol race tests are explicitly source-derived counterexamples, not actual
  server tests or proof of a retirement guard. No transport response handling or
  remote cleanup success is exercised because the unsafe effect is unavailable.

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
