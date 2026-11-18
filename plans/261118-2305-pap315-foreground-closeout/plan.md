# PAP-315 revised foreground closeout

Date: 2026-11-18. Baseline: `0c1404a` on
`feature/PAP-315-herdr-exit-cleanup`. The user requested completing actual
cleanup and disposable live validation, retaining separate phase commits.

## Correction and supported normal path

The previous blanket unavailable verdict was too strong. Foreground PPA retains
control through closeout; ordinary same-shell B cannot launch until it returns.
Public protocol-22 source handles lifecycle mutations synchronously in its app
queue and responds afterward. A correlated response is a handler-completion
barrier, although generic OK alone does not prove disappearance. No new upstream
API is required to implement the acknowledged normal path.

The earlier arbitrary-sequence counterexample did not demonstrate an actual
normal-launch race. Timeout/lost acknowledgement remains a distinct uncertain
case, not a reason to leave every launch unavailable. Neither disconnect nor a
later request on an independent socket is assumed to retract/fence unknown work.

## Design

- Capture the validated real Herdr binding at foreground launch. A private,
  launch-scoped in-process Unix socket relays the child's existing integration
  reports; no extra reporter, extension hook, daemon or package is added.
- Serialize matching `herdr:pi` lifecycle requests and record their exact sequence
  and session reference. Do not guess a watermark from wall time or reserve a
  permanent maximum. Fixed lifecycle payloads remain bounded to 4096 bytes.
- Preserve existing non-lifecycle Herdr operations as opaque transport to the
  already selected original socket. This is not a new model tool or permission;
  it prevents changing existing Herdr CLI/tool behavior when the child receives
  the relay endpoint. The existing server's 1 MiB initial-frame bound applies.
  No request/reply body is logged or published to model context.
- On authoritative child death, close intake and discard unsent reports. Await
  any submitted report within the single exit deadline. If delivery is uncertain,
  do not add a destructive clear. Check the observed registration against the
  launch-owned reported session; preserve a foreign/unowned registration.
- Send at most one `pane.clear_agent_authority`, fixed original pane/source and
  sequence later than every forwarded owned report, before foreground return.
  Await a complete correlated response; verify absence with fresh `agent.get`
  if budget remains. Acknowledged and verified-absent are distinct outcomes.
- One monotonic 500 ms post-death budget covers pending-report settlement,
  ownership observation, clear, readback and disposal. No automatic retry,
  restart, pane close or additional signal. Preserve uncertain delivery honestly.
- Preserve selected-host filtering, protected extension policy, no-Herdr,
  explicit-disabled, headless, live-turn and terminal/registry settlement paths.
  Supervisor death remains uncovered by JavaScript callbacks.

A submitted clear that times out is still delivery-uncertain. This exceptional
case must be tested and disclosed separately; source tests cannot turn an
unacknowledged operation into verified removal or prove arbitrary independent
launch/clock-reset safety. It does not block the supported acknowledged normal
path. No shared-socket check-then-clear is claimed to be a general atomic guard.

## Phases

1. Commit this corrected contract and phase plan.
2. Implement the relay and asynchronous once-only closeout; add lifecycle,
   socket/error/timeout, sequence, unrelated-operation and foreground regressions.
3. Run focused and workspace checks, obtain separate source review, fix findings
   and commit actual results, retaining original failures/timeouts.
4. Use only newly created disposable panes to run the source candidate with
   installed Pi/Herdr. Record exact tuple, actual quit/signals, fresh list/snapshot
   and shell preservation. No installation/global extension edit is selected;
   installed-PPA rollout and genuine human sidebar/UAT remain separate evidence.

## Discovery limits

Public audit revision: Herdr
`ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`, declared 0.9.5/protocol 22. The
installed schema has clear/source/seq, and no lifecycle watermark read API was
found. Official `release_agent` ignores Pi; custom per-launch sources do not
preserve official Pi full-lifecycle semantics. The installed Pi documentation
read denial remains respected. The advisory helper failed with
`ADVISE_SKILL_NOT_FOUND`; no skill repair was attempted. A separate read-only
Explore audit confirmed the normal-path barrier and relay design.
