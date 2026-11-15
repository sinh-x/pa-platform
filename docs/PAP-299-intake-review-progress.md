# PAP-299 intake/review continuation — d-60da83

Partial source integration, **not enabled, PR-ready or accepted**. The existing
feature branch/check-out, historical base `469e0bf` and pre-rebase backup are
preserved; current integration base is `36d2766`. Initial clean HEAD `2c7b5b0`.
No further rebase/reset, checkout acquisition/return, push/merge or install.

## Native intake/association phase

`documents/handoff-intake.ts` composes actual `TicketStore.createWithIntent` with
`associateDeploymentTicket` and complete independent registry readback. Exactly
one creation identity is derived from authenticated native deployment/session/
repository/selection, never a caller-chosen intake namespace. Supplied tickets
are reused without lifecycle changes. New creation and association are separately
durable, not a cross-store atomicity claim. Original intent/ticket/audit recovery
precedes association; association reply loss resumes without another edge/ticket.
Changed content conflicts, missing original creation after association blocks,
and later legitimate ticket changes are not reset.

The existing ticket mutex precedes a short immediate registry transaction. Both
current and historical other-ticket owners are rechecked under registry write
exclusion. Only a fresh `requirements-handoff/v1` immutable start may enter this
internal candidate; retained profiles, replacement edges, builder/resource/parent
custody, foreign project and asynchronous admission hooks reject. Actual process/
selection authentication remains the native adapter's responsibility. This phase
does not register that profile or give the current rogue-one session its rights.
`TicketStore.inspectCreationWithIntent` only observes original reservation/audit;
it cannot allocate or repair.

Actual checks:

- Core typecheck: exit 0.
- Initial focused run: 52 pass / 3 fail. Two incomplete fixture tickets lacked
  timestamps, causing normalization-time drift; supplied fixtures now carry full
  stable timestamps (production exact readback retained). Unknown-field parsing
  leaked the generic workflow error; parsing now uses the existing document guard.
- Rerun: **55/55 pass**, zero skips, including actual registry and creation owners.
- Source inventory: semantically inspected the added read-only TicketStore method
  and internal intake call site; renew only the store digest. No dispatch, alias,
  permission or binding added; expanded inactive-entrypoint negative assertions.
- Logs: `/tmp/pap299-d60-intake-{typecheck,tests,tests-rerun}.log`.

No new human-facing CLI text/exit/stream or old schema changed. Existing typed
errors are reused. No installed propagation or human readability/UAT claimed.

## Current selection and blocked integration

Fresh observation: installed PPA 0.1.167, Pi 1.4.0; d-60da83 running on the exact
selected PAP-299 checkout. Native worktree inspection reports matching linked
HEAD, absent execution/capacity for this target (not global admission). Treehouse
shows exactly the retained lease `02a409647d9542fbc289a54ac19aab4f`, holder
`pa:pa-platform:PAP-299`, processes empty. Canonical checkout status digest remains
`015d6d878113708a32ae45fc6db69e0c7c06a9108a4056217207eff0822aaf18`.

The required selected Pi README read is **still denied**, freshly observed at
`/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/lib/node_modules/pi-monorepo/README.md`,
`LOCAL_SOURCE_UNSUPPORTED_FILE`. No alternative reader/copy bypass. Existing
PAP-298 owner request `c-20261114230653395` remains the route. Pi SDK/native UI
changes await permitted docs and independent actual-contract review. A journal
re-read also returned `LOCAL_SOURCE_UNAVAILABLE`; no journal mutation attempted.

## Distinct finite review/publication phase

`registry/handoff-reviews.ts` now owns a separate FULL-synchronous immutable
handoff subject/intent, hash-chained native request/issued events, original native
capture bytes, and finite original publication/queue intents. It never inserts a
legacy confirmation or extends a historical grant. The request is durable before
UI; capture bytes survive before mutable checks/issuance. Original-coordinate
replay uses the same capture without a second prompt. A request with no proven
capture stays uncertain, never reopens automatically. Actual selected foreground
capture is still an adapter integration gate, not supplied by test evidence.

`documents/handoff-review.ts` requires a completed exact native ticket plan and
reverifies the actual full reader before freeze, before the native review and
after interaction, before issuance. Full immutable document bodies, exact intent
and finite effects go to the native host together. Local UID, caller/session,
selection, evidence bindings, latest decision, revocation and pending history are
checked. Changed subjects/review coordinates cannot bypass unresolved native
review, publication, queue, branch or retained document intents for that ticket.

`documents/handoff-publication.ts` explicitly consumes this new provenance.
Decision JSON and both exact delivery references precede all-member primary
promotion; original publication intent precedes writes. The combined real Git/
SQLite/TicketStore branch owner now consumes that decision and exact publication,
not a fixture receipt or old scope. Publish+branch with queue=false stays unqueued.
Queue requires its own finite effect plus the actual complete correlated branch,
and keeps the same repository -> ticket exclusion through the status write.
Completed effects can be observed after revocation; missing writes cannot proceed.
Approval/publication/branch/queue/checkout/launch/UAT remain distinct.

**Limits:** first-publication only; successor/predecessor provenance currently
returns DOCUMENT_UNAVAILABLE instead of adopting old destinations. An interrupted
review lacking native capture requires future explicit owner reconciliation, not
another prompt. Native repository observation/planning adapter, selected tool/
profile, actual Pi foreground capture, and fixed trusted browser/display/network/
cleanup integration remain missing. These are internal services, not production
enablement or completed FR1–16. No new public CLI text, machine/stream/exit contract,
retained schema or capability selection changes. Errors reuse existing typed codes;
no human readability/installed propagation claim.

Actual checks at this source phase:

- Workspace typecheck/build: exit 0, including final barrier/queue-lock changes.
- Thirteen focused suites initially **148/148 pass**. Expanded final run:
  **151 pass / 1 fail**, zero skips; the failure is a worker error surfaced as
  DOCUMENT_UNAVAILABLE during concurrent broad validation/build, not a proven
  root cause. No worker limit/check was relaxed.
- Isolated final review/publication suite: **22/22 pass**, zero skips. This includes
  new cross-subject pending barriers, concurrent review, revocation after partial
  publication and original queue response-loss recovery. Earlier initial run
  14/18 was four fixture errors caused by shadowing the document subject with the
  handoff subject; the fixture names were separated, not production checks weakened.
- All review evidence is explicitly synthetic source-test evidence, not human
  consent or foreground prompt-count qualification. Actual Git/ref/link and file/
  ticket owners are exercised in disposable repositories, with no resource effects.
- Completions: exit 0, tracked output unchanged.
- Current PAPC is now clean `5fc3c97457c1a01ca5c7994a79321fdffef19c0d`, not the
  historical 504a8dc candidate. Full common13: **1373 pass / 51 fail**, zero skips.
  Findings include missing requirements/auto-reasoning primer budget and retained
  config/contract drift. No external config/checker was changed. Source-pair first
  rejected this uncommitted runtime as dirty; renew against the committed source.
- Full workspace regression is running separately; no aggregate pass asserted.
  Historical timeouts and RUNTIME_SHELL_LIFECYCLE remain preserved until a genuine
  final current check supplies another outcome.

Logs: `/tmp/pap299-d60-{owner-focused,owner-final,review-isolated-final}.log`,
`/tmp/pap299-d60-workspace-{typecheck-final,build-final,test}.log`,
`/tmp/pap299-d60-papc-{common13,source-pair}.log`.

Independent review, hosted CI, installed/default entry, genuine foreground prompts/
effects, browser/accessibility and TS1–18 human UAT/adoption remain separate. No live
document/branch/queue/opening, ticket Done, install, push/merge or checkout return.
