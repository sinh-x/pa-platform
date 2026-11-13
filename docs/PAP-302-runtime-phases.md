# PAP-302 — remaining runtime phases (activation withheld)

The operator explicitly requested P2–P5 implementation after creating companion
**PAPC-086**, and reserved final activation/integration for manual handling. This
supersedes the earlier planning-only stop, not the retained safety/approval owners.
All edits remain in the PAP-302 ticket worktree. At the P2–P5 source checkpoint,
no PAPC configuration, user service, live provider/ticket worker, managed product
checkout, remote operation or activation was performed. The subsequently
operator-requested source PR #174 is tracked in the qualification handoff; source
integration does not activate or qualify the service.

## P2 — global coordination, bounded drafting and foreground support

- Registry schema 18 adds a global unique active slot, append-only hash-linked
  item history, controls and immutable first-owner claims. This is coordination,
  **not a permission/approval ledger**. Every awaiting, blocked, uncertain and
  review-ready item holds the same slot across PAP/PAPC and OS processes.
- Initial scanning/dispatch controls are disabled/paused. CAS reauthenticates under
  the existing registry transaction. Pause preserves a worker and all original
  state; a close needs settled original-owner proof. Missing PID/reply is never
  permission to execute again. Pure list/status retain existing-files-only reads.
- Bare `ppa auto` in a genuine unmanaged terminal offers human selection with
  complete 100-row pages and default Cancel. Managed/headless/JSON calls have no
  selection/approval flags. Existing pending packages are retained, not redrafted.
- A new explicit committed `contracts/auto-waitlist-v1.json` compatibility contract
  is required for effects. Retained analyze/analyze-auto modes are untouched.
  Selected source resources/provider/model are pinned and rechecked; absent or
  mismatched pairing blocks only the dependent effect. PAPC-086 owns actual config.
- The producer is a new native finite protocol, **not** a headless document approval
  profile. Tool-less noninteractive Pi requests bounded read/list observations from
  native source-aware readers, then emits full unsigned brief/requirements/UAT and
  material questions. It cannot invoke source/ticket/Git/checkout/launch tools.
  Native code owns outside-repository draft writes, structural checks and immutable
  document snapshots; original request/deployment IDs precede effects.
- CLI flags needed for no-tools/no-extensions/no-MCP/no-context/no-session isolation
  are probed, not guessed on older Pi. No fallback weakens those restrictions.
  Investigation bounds: 32 source requests, 128 KiB/file, 1 MiB total source,
  1 MiB response, 30-minute wall deadline. No live provider was invoked in tests.
- Native foreground review support exposes every complete text member and exact
  technical start bindings before one final decision (Cancel by default). A
  trusted terminal fixture tests UI behavior; synthetic choices are not genuine
  human approval evidence. P3 owns durable finite-start issuance and dispatch.

Message changes: passive list now says “this list does not select, approve or
execute work” instead of the obsolete global “selection ... not enabled”. Status
exposes observed active IDs/states or explicitly unobserved ownership. Native
blockers retain one static bounded five-field envelope and no raw exceptions.
Catalogue semantic reconciliation distinguishes scan (coordination **write**) from
interactive opening (possible native **launch**). Null native bindings remain null.

Initial focused P2 run: 21 pass / 1 fail, caused by a test expecting an ordinary
object from the strict null-prototype JSON parser. The draft reply boundary now
reconstructs its closed canonical data shape; the repeated new core/native tests
passed 13/13. Final P2 combined run passed **47/47** (auto coordination,
waitlist, catalogue and Pi native/compiled-CLI cases), zero skips/cancellations.
Core build and Pi TypeScript build passed. Evidence: `/tmp/pap302-p2-tests.log`.
Source checks do not establish actual desktop delivery, provider output usefulness,
installed pairing, independent review, hosted CI or human UAT.

## P3 — exact native start and original-intent dispatch

`pa-auto-start/v1` is additive to the existing native document registry/decision
owner, not a service approval file. Immutable proposals precede the prompt and bind
full document bytes/revision, relevant ticket scope, canonical repository, finite
source paths, matrix/checks, branch/base, configured Pi provider/model/resources,
objective, local-only effects and deadline. Ranking/comments alone do not rebind
scope. Old content/publish/queue receipts never grant implementation start.

One genuine unmanaged foreground review shows all complete text documents and
start bindings, then records one decision. Unchanged review reconciliation returns
the original record with no second prompt. Ready published content uses a distinct
start/queue-only scope without content reapproval. The new native queue-only path
is authorized by that exact new start grant even when an older package was
publish-only; old queue receipts/scopes themselves are not broadened. Cancel,
Reject and changes confer no start. Explicit withdrawal preserves/revokes original
evidence and cannot conceal an already-dispatched or unsettled effect.

Approved dispatch persists the original operation/deployment IDs first. Existing
document publication/queue and status owners execute their finite obligations;
branch planning is displayed and authorized in the exact start intent. The actual
Pi launcher consumes a native-only closure and new auto baseline while retaining
ordinary capacity, Treehouse, repository custody, Git effects, project-command and
source/check owners. There is no force/rogue/alternate-root/resume fallback.
The direct foreground worker starts automatically from the same CLI approval;
there is no manual deploy or second unchanged approval. Deadline bounds cover
preparation and the actual process start, not just an approval timestamp.

Native source/check boundaries reauthenticate the saved same deployment through
registry/process/custody evidence, exact selected pair, native decision/revocation,
material ticket and reviewed file/check scope. They do not accept a PA environment
flag as authority. Pausing stops new dispatch, not an already-admitted worker.
P5 hardens the initial P3 completion observer: terminal success alone is not
review-ready. Original native candidate/check/commit and process/cleanup proof are
required; local receipts still do not certify the full matrix/CI/human acceptance.
Uncertain/failure outcomes hold the slot and their original evidence.

Recovery has durable owner stages: claimed, ticket-effects, launch-requested.
Same-intent prelaunch publication/queue can finish through their existing owners.
Once a launch request may have crossed admission/spawn, recovery observes that
SAME deployment; missing PID/reply never permits another invocation. Settled close
checks native pending effects and source ownership/process evidence; it releases
coordination only, never resources or ticket completion.

The requirements producer can include a finite `Auto Execution Scope` JSON block.
Existing approved documents without one remain byte-identical: the operator can
supply unsigned finite path scope as part of the new START proposal before its
single final approval. Missing/invalid matrix, source scope, pair or original-owner
facts block dependent work rather than fabricate readiness.

P3 source checks: **35/35** combined auto decision/coordination/dispatch/native/CLI
cases and **70/70** retained document/session/workflow/catalogue cases, zero
failures/skips/cancellations. Core and Pi TypeScript builds passed. Logs:
`/tmp/pap302-p3-tests.log`, `/tmp/pap302-p3-retained-final.log`. Capture, process
launch and provider outcomes in unit fixtures are synthetic and do not substitute
for an actually selected installed pair or genuine human prompt-count observation.

## P4 — opt-in observation timer and informational desktop requests

`ppa auto units [--json]` renders fixed user-unit descriptions only. It does not
write/install units, call systemctl or enable anything. The timer uses a 30-minute
inactive interval and `Persistent=false`; registry wake CAS coalesces processes,
missed intervals and clock reversal rather than building an offline backlog.
`ppa auto tick [--json]` is disabled by default and initializes no absent registry.
An enabled tick only scans, observes the original native result and updates unsigned
coordination/notifications; it never selects, approves, publishes/queues or launches.
Opening, explicit scan and timer share the fixed 120-second scanner subprocess.

Notification transitions are durably claimed before argument-array `notify-send`.
Only bounded ticket/state text plus “Run ppa auto” is sent: no objective, secret,
command interpolation, action button or approval. Unchanged scans coalesce across
processes; lost replies remain unknown and never cause a delivery or launch retry.
Missing user-session bus/daemon/executable is a durable warning. Success means
**requested**, not human-seen delivery. `ppa auto status` retains that distinction.
No desktop notification was sent by development checks.

Control transitions now retain append-only registry history. Foreground pause is
not process termination. A safety review also fixed completed-draft observations
regressing a later approved/paused item: settled observations are now idempotent
and do not grow history on every timer wake.

Initial P4 check: 25 passed / 1 failed. The hostile-path test exposed JavaScript
replacement-string handling of `$$` in unit quoting; a function replacement now
preserves the required literal systemd escape. Repeated P4 check: **26/26 passed**,
zero skips/cancellations, including compiled disabled tick/unit routes, no
initialization, missing desktop, dedup/reply-loss, interval and regression cases.
Evidence: `/tmp/pap302-p4-tests.log`, `/tmp/pap302-p4-tests-final.log`.

## P5 — source hardening, regression review and manual handoff

See the [qualification handoff](PAP-302-qualification-handoff.md) for exact new
contracts, safety fixes, before/after messages, AC/TS coverage limits, original
failures/timeouts and the manual integration/activation sequence.

P5 self-review adds durable native review claims and observed-interaction recovery,
immutable versioned material questions, exact multiline objectives, bounded stdin
producer transport, explicit unsigned revision, registered check-profile pinning,
stronger native identity/freshness and real local candidate/check/commit receipts.
Terminal success without original process/cleanup/native proof remains held, not
review-ready. These are source changes, not independent review or installed proof.

Final focused source checks passed **73/73 core auto/interaction** and **29/29 Pi
auto**, zero failures/skips/cancellations. Actual native check/repair/commit receipt
reading passed **1/1** with simulated provider/Treehouse. Native-host/public-web
regressions passed **25/25** after the schema assertion repair; runtime-host **1/1**.
Workspace typecheck/build/completions passed. Final logs:
`/tmp/pap302-p5-core-focused-final.log`, `/tmp/pap302-p5-pi-auto-final.log`,
`/tmp/pap302-p5-native-result.log`, `/tmp/pap302-p5-pi-repaired.log`,
`/tmp/pap302-p5-host.log`, `/tmp/pap302-p5-{typecheck,build,completions}.log`.
Final core/Pi builds and the full workspace typecheck also passed after the last
foreground wording/propagation fix (`/tmp/pap302-p5-typecheck-final.log`). Source
inventory verification found zero mismatches. Whitespace checks and staged
`corepack pnpm secrets:scan` passed; `/tmp/pap302-p5-secrets.log`.

**The complete regression is not green/completed.** The repeated full command
passed root harness 42/42, core 2,020 pass / 14 skipped, OPA 106 pass / 1 skipped,
and Pi scripts 11/11, then exceeded the 2,400-second command limit in Pi source
checks. A second stale schema-17 assertion was corrected and its whole file passed
in the 25-case rerun. A remaining Pi group emitted 124 outcomes with no failure/skip
markers but timed out at 600 seconds without a final summary. Separately, workflow
config/startup passed 10/10 and 3/3. Partial output is not a passing completed run.
Preserved logs and skip reasons are in the handoff; neither timeout was hidden.

P5 source work/handoff does not complete the outstanding independent safety/code
review, hosted CI, complete final regression, exact installed pair, genuine human
prompt-count/reading-view qualification, actual desktop delivery, useful PAP/PAPC
canaries or Sinh UAT/adoption. No service was installed/enabled, no desktop request
sent, and no live provider/implementation worker was launched for this feature.
PAPC-086 pairing and final integration/activation remain manual.
