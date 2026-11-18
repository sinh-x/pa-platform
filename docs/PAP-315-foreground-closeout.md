# PAP-315: foreground cleanup before shell return

This is the current implementation contract. It supersedes the blanket
unavailable conclusion in [the historical audit](PAP-315-herdr-exit-cleanup.md).
Normal same-shell replacement cannot begin until foreground PPA returns; this
ordering is used, not treated as an upstream blocker.

## Implemented ownership and ordering

`packages/pi-pa/src/herdr-exit-cleanup.ts` creates a private 0700 temporary Unix
socket for one foreground child. The actual validated original Herdr socket,
pane and socket-file incarnation are captured before spawn. The child receives
the relay endpoint, not a newly discovered/current pane at exit. Existing native
runtime PID admission and process-death evidence remain in `adapter.ts`.

The relay is part of the supervisor process, not a daemon, additional reporter,
Pi extension or model-facing socket tool. It recognizes only its fixed pane's
`herdr:pi` / `pi` session/state reports for cleanup ownership. It serializes
these existing requests, preserves their bytes and IDs, tracks the maximum
forwarded safe-integer sequence and last reported session reference, and awaits
complete correlated replies. It does not infer a counter from wall time. Queued
reports are bounded to 32, each at most 4096 bytes; no automatic retry is added.
Existing independent reporter sequence rules remain server-owned. An observed
counter reset cannot lower the supervisor's final watermark.

Other Herdr operations pass through unchanged to the originally selected socket
using ordinary Node socket piping. This deliberately preserves existing Herdr
CLI/tools and subscription streams; no new command, permission, target choice or
peer-message interface is introduced. The original server's 1 MiB initial-frame
bound is retained. Requests/replies are not logged or exposed through cleanup
metadata. Fixed native cleanup replies are bounded to 64 KiB and interpreted
only inside the supervisor.

Only authoritative PTY exit or the adapter's existing confirmed-process-gone
fallback starts cleanup. Input `/quit`, EOF, idle/working/blocked, agent-end and
continuing-process new/resume/fork do not themselves prove death. The adapter
stops input forwarding and restores the terminal while continuing to hold the
foreground until cleanup finishes; its existing registry finalizer runs later.
No added signal, pane close, daemon restart, Git operation or second terminal
event is introduced.

At child death, the supervisor closes intake and drops unsent reports. It waits
for an already forwarded owned report, then observes `agent.get` and checks that
its pane, Pi agent and session reference match the launch-owned report. An
unowned/foreign registration is preserved. Any uncertain report suppresses clear.
It sends at most one `pane.clear_agent_authority` for the original pane,
`source:herdr:pi`, and `seq:maxForwardedSeq+1`. Official-source `release_agent`
is not used. After correlated clear acknowledgement it requests fresh agent
state; only a fresh `agent_not_found` observation establishes verified absence.

The entire post-death stage has one monotonic **500 ms** budget, including report
settlement, ownership observation, connect/write, acknowledgement, readback and
resource disposal. Every socket/timer belongs to that stage or the live relay;
all are disposed before foreground return. Herdr failures are advisory and do
not rewrite the child's status, terminal streams or registry settlement.

## Selection and inert paths

A complete `HERDR_ENV=1`, valid pane and exact same-user/root Unix socket select
managed cleanup for ordinary foreground Pi, including the official integration
without PA's optional lifecycle bridge. Explicit `PA_HERDR_LIFECYCLE=0` disables
it. The PA lifecycle bridge itself remains separately opt-in; no extra writer is
loaded. Protected extension policy is unchanged. Headless/background launches
have no relay. Selected-host environment filtering remains unchanged and drops
Herdr bindings, so that path is inert rather than silently broadening admission.
Missing, aliased, partial or foreign bindings are inert. If no owned report was
seen, cleanup is skipped and no destructive request is synthesized.

## Outcomes and exceptional uncertainty

Optional `metadata.herdrCleanup` distinguishes:

- `verified-absent`: a fresh server observation found no agent, not merely OK.
- `acknowledged`: the clear handler replied, but disappearance is not verified
  (for example, process fallback still appears or readback exceeded the budget).
- `skipped`: no owned report or a different registration was observed.
- `unconfirmed`: timeout, report uncertainty, socket/protocol/rejection failure or
  sequence exhaustion. `submitted` indicates possible destructive delivery.

A submitted clear also retains its bounded native `requestId` for reconciliation.
No raw reply, exception, transcript, environment, socket path or session text is
published. No human-facing CLI message or CLI grammar is added.

A correlated response is a handler-completion barrier in the audited server, so
normal same-shell B begins only after A's acknowledged operation has completed.
A clear submitted before a timeout can still apply later: disconnect is not
cancellation. It is never retried or reported as successful removal without
observation. Normal later-launch increasing-sequence behavior is regression
covered; arbitrary independent launch, wall-clock rollback/server reanchor and
server-restart races are **not** promoted to an atomic incarnation guard by this
implementation. The public schema has no such guard. These exceptional cases
remain a qualification/recovery limitation, not a blanket prohibition on the
supported normal path. The socket-file check rejects observed server replacement.

## Standalone, supervisor death and recovery

This fix is owned by PPA after actual child death. It does not edit the managed
standalone Pi integration or add shutdown hooks that could unregister continuing
processes. NX-069/Herdr/Pi still owns standalone actual-quit integration and any
server-side liveness recovery. Supervisor SIGKILL cannot run JavaScript cleanup;
no automatic recovery is promised. A private temporary relay endpoint can remain
on disk after abrupt supervisor death, but is not a daemon or a recovery owner.

For an uncertain outcome, preserve the original deployment, target and request
ID. Inspect that same operation and fresh Herdr/process state before considering
another effect. Never blindly resend, issue a guessed release, close the pane or
restart the daemon. Exclude live/replacement sessions and use a separately
authorized maintenance window or a server-supported guarded operation for manual
recovery. There is no generic safe concurrent read-then-clear recovery claim.

Installed validation must separately show absence in a fresh list/snapshot and
actual sidebar, an open functioning shell, and preservation of unrelated/new
sessions. A generic OK, source test, generated report or version label does not
substitute. Full installed-PPA adoption and genuine human UAT remain distinct
from source-candidate tests against installed Pi/Herdr.

## P2 source checks

- Checkpoint/relay suite: 32 passed. Combined relay/lifecycle/protocol/adapter/
  composition/catalogue lane: **127 passed, 0 failed**, 146.67 s.
- pi-pa typecheck, secrets scan and `git diff --check`: passed.
- Responsive natural open-stdin exit: 27.9–41.2 ms; dead connection: 26.1–39.9 ms;
  unresponsive cleanup: 524.5–529.1 ms after child-exit evidence. All remain below
  the unchanged 1000 ms bound, with writer open and input listeners restored.
- Pending-report and shared-deadline tests measure scheduling tolerance around
  the 500 ms stage. At-most-once, duplicate callbacks, partial/malformed/wrong-ID/
  oversized/rejected/no-op replies, missing socket, counter reset, and delayed
  old-clear/later-sequence cases are source fixtures, not installed acceptance.

The earlier advisory helper failed because its required skill was missing; no
skill code was repaired. Later source review, full checks and live observations
are reported separately rather than inferred from these P2 checks.
