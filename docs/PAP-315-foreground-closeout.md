# PAP-315: managed foreground lifecycle and closeout

This is the current contract after rebasing onto develop v0.1.175. Earlier
shared-source clear implementations and controlled-frame observations remain
historical evidence in the linked reports, not the current protocol choice.

## Managed owner, not an official process-detected Pi

PPA runs Pi in a separate PTY behind its Node supervisor. Herdr's official
`herdr:pi` full-lifecycle source expects detected Pi and can therefore ignore
fresh PPA registrations. Its release operation also intentionally ignores
official sources. Reusing that source was the remaining integration defect.

`packages/pi-pa/src/herdr-exit-cleanup.ts` assigns a fresh native
`ppa:pi:<UUID>` source to each foreground launch. The existing launch-scoped
in-process relay translates only its fixed pane's official Pi lifecycle frames
to that managed source. It does not add another reporter, extension, daemon,
model-facing socket tool or permission. A new process resuming the same
conversation still receives a different source incarnation.

Custom-source state reports can establish Pi identity without process detection.
At actual child death, supported `pane.release_agent` compares current source
and agent **atomically**, before accepting its sequence. A delayed A release
cannot remove B's current authority, including when B's counter is lower or B
resumes the same conversation. This is the existing supported conditional
contract, not a read-then-clear workaround or a new upstream API requirement.
Standalone official reporting is unchanged; official-source release remains a
no-op and is not used by managed cleanup.

## Binding, serialization and resume compatibility

The original validated Herdr socket/pane and socket-file incarnation are captured
before spawn. A private 0700 temporary Unix socket is passed to the actual child.
Existing native runtime PID admission and verified process-death paths remain
owned by `adapter.ts`; cleanup never chooses whichever pane is current at exit.

Matching session/state requests are serialized, bounded to 4096 encoded bytes,
and queued at most 32 deep. The relay captures the maximum forwarded sequence
without inventing a timestamp watermark. Stale/equal-sequence references cannot
overwrite its current resume reference. Source rewriting accepts the canonical
JSON emitted by the official/PA integrations; duplicate/noncanonical owned
frames are rejected rather than converted into different valid requests.

Herdr does not expose custom `agent_session` metadata or infer its resume plan.
The relay preserves native Pi recovery using supported `resume_argv` on current
state reports: `pi --session <validated path-or-id>`, preferring the absolute
session path. Stale reports cannot overwrite that command. Invalid shell text
or an encoded-size overflow omits this optional command rather than forwarding
an invalid request or inventing another executable. This preserves supported
normal paths, not exact official metadata/deduplication. It does not alter PPA's
own resume admission or selected-host policy. Resume commands containing
apostrophes remain unsupported by Herdr's reported-command contract.

Other Herdr operations pass through unchanged to the captured original socket
using socket piping, retaining the original 1 MiB initial-frame bound. Normal EOF
is graceful, including slow consumers and request write-half-close. No opaque
request/reply body is logged or published. This preserves existing transport;
it does not claim that Herdr's process-detection-based interactive agent controls
are available for every self-reported PPA entry.

## Actual exit and one bounded retirement

Only PTY exit or the existing positively confirmed-process-gone fallback starts
closeout. `/quit` input, EOF, idle/working/blocked, agent-end and continuing-process
new/resume/fork are not themselves death evidence. Input forwarding stops and
terminal state is restored, but PPA holds the foreground until the Herdr stage
finishes, before existing registry settlement and shell return.

At death, intake closes and unsent reports are discarded. The supervisor waits
for any already submitted owned report. If that delivery is uncertain, it
submits no destructive release. Otherwise, after an owned state report, it sends
at most one release for the captured pane, unique managed source, `agent:pi`,
and `seq:maxForwardedSeq+1`. The source guard—not session metadata or a preflight
read—protects foreign/replacement registrations. A fresh `agent.get` follows a
correlated acknowledgement to distinguish OK from actual absence.

One monotonic **500 ms total budget** covers pending-report settlement, connect,
write, response, readback and disposal. No retry, added signal, pane closure,
daemon restart, Git action or second registry terminal event is introduced.
Herdr outcomes are advisory and cannot rewrite Pi's result or terminal streams.
All owned sockets/timers are disposed before normal foreground return.

## Selection and inert paths

Complete `HERDR_ENV=1`, valid pane and exact same-user/root Unix socket select
managed foreground lifecycle. Explicit `PA_HERDR_LIFECYCLE=0` disables it. The
PA bridge remains separately opt-in; the relay also accepts the discovered
official integration, so it loads no competing reporter. Protected extension
policy is unchanged. Headless/background paths have no relay. Selected-host
filtering remains unchanged and drops Herdr bindings, keeping that path inert
rather than silently broadening its allowlist. Partial, aliased, missing or
foreign bindings are inert. Session-only/no-state paths submit no retirement.

## Native observations and honest uncertainty

`metadata.herdrCleanup` and one advisory `herdr_cleanup` activity observation
retain native `source`, `requestId` when submitted, actual death evidence and
`elapsedMs` including local disposal. The activity uses the existing deployment
log, not stdout/stderr or another terminal finalizer. Its static text distinguishes:

- `verified-absent`: a fresh server observation found no agent; no action needed.
- `acknowledged`: the handler replied, but entry removal is not verified; inspect
  the existing session before another cleanup request.
- `skipped`: no managed state was reported; no destructive request was submitted.
- `unconfirmed`: delivery/response/sequence/socket outcome is uncertain; preserve
  the original request and inspect before requesting another cleanup.

No raw exception/reply, transcript, credentials, socket path or session text is
copied into that guidance. The random source is an incarnation identifier, not a
permission token. Formatting is side-effect-free; audit persistence failure
cannot prevent Pi settlement. No CLI grammar or machine stream is changed.

A missing reply is never cancellation. A submitted release can still execute
after timeout, but its source/agent guard preserves a different current managed
registration. An uncertain already-submitted **state report** is a distinct
remaining delivery limitation: local disconnect cannot retract server work, and
no successful cleanup/fence is claimed for that path. Closeout suppresses
retirement when report delivery is uncertain and never blindly retries effects.

## Standalone, supervisor death and recovery

No managed Home Manager extension is edited. Standalone actual-quit integration
and server-side liveness recovery remain with NX-069/Herdr/Pi. Supervisor SIGKILL
cannot execute JavaScript cleanup and can leave its relay endpoint on disk or a
stale registration; that behavior must be observed, not called automatic success.

For an uncertain operation, retain the exact deployment, managed source and
request ID. Inspect that same request and fresh process/Herdr state before any
separately authorized repair. Do not blindly resend, use shared-source clear,
restart the daemon, close the pane or delete evidence. A separately authorized
source-qualified release is conditional on the captured managed incarnation;
normal same-shell B is not permitted to overlap A's foreground closeout.

## Evidence by candidate

- Historical v0.1.174 candidate: 262 focused checks and controlled live frames,
  with acknowledgement at 313.39 ms and separate absence at 541.17 ms. Sinh's
  sidebar confirmation applies to that scoped case, not full product acceptance.
  See [historical qualification](../plans/reports/qualification-261118-2305-pap315-foreground-closeout.md).
- Rebase and completion plan:
  [2026-11-19 record](../plans/261119-0800-pap315-finish/plan.md). Original branch
  history is retained in `refs/backup/PAP-315/20261119-0800`.
- Current managed-source work: 42 relay tests passed, including hidden-Pi state,
  native resume, lower/equal/higher-counter delayed release, duplicate callbacks,
  reply failures, half-close/4 MiB buffering and open-stdin natural exit. The
  first pre-build run timed out because PAP-318's compiled preload was absent;
  after workspace build the rerun passed. Initial TypeScript index typing was
  corrected; neither initial failure is re-labelled a pass.
- A real source-PPA launch `d-82653f` on the managed-source build appeared in
  Herdr while live and disappeared after `/quit`, leaving its shell open. This
  is the first production-wired observation without synthetic lifecycle frames.
  Final exact-candidate checks and the remaining live matrix are recorded
  separately; no global install, hosted CI or full-suite success is inferred.
