# Explicit cancellation recovery (PAP-273)

A cancelled native package decision grants no permissions. Ordinary `capture`
remains ineligible after it; `revise` requires genuine changes-requested,
material-amendment or approved unmaterialized document-revision conditions. Neither a new analyst session, queue status nor an
ordinary structured question substitutes for native authority.

The existing Pi `pa_decision` tool now accepts exactly:

```json
{"action":"recover","revision":2,"decisionId":"decision-<exact-cancelled-id>","subjectSha256":"<exact-current-64-lowercase-hex>"}
```

Use the values from current workflow status/next. The run is derived from the
native caller's adopted repository/ticket; callers cannot supply a run, actor,
outcome, permissions or replacement package. The foreground requirements caller
must be the effective authenticated coordinator or an existing registry-authenticated
same-role continuation. A fresh same-role deployment without `--resume` can first
request explicit native adoption, as below; relaunching alone grants nothing.
Approved/published packages without pending effects now also support narrowly
scoped [document continuation](workflow-document-continuation.md).
There is no shell/CLI approval workaround.

Recovery is offered only for the latest unrevoked cancelled decision on the
current subject, with retained resource closure, no pending intents or other
step outcomes, and fewer than 16 decisions for this subject (initial capture
included). It explicitly displays resuming the cancelled review, traverses the
readable exact scope, and asks for a fresh native decision. Cancelling again
records another permissionless decision; there is no automatic retry.

The service verifies subject evidence before/after capture and inside final CAS,
rechecks the caller and exact predecessor, and appends `decision-recovered` to the
**existing** registry workflow journal. The original cancellation, snapshots,
run/subject/resource identities and attempts remain retained. Replay validates
predecessor cancellation, scope/permissions, unique decision/capture references
and absence of executable effects. Only the effective decision outcome advances;
no publication, ticket/branch/checkout operation is performed by recovery.

Stale or concurrent recovery, subject/evidence drift, foreign caller/decision,
approved/rejected/changes-requested/revoked predecessors and exhausted bounds
fail closed. Older runtimes reject the new event rather than guessing its meaning;
install the new runtime before using recovery, and do not downgrade an affected
run to an unaware runtime.

## Fresh foreground continuation without `--resume`

Read status/next in the new authenticated `requirements/analyze` foreground
session. `coordinatorContinuation` distinguishes structural eligibility from
native caller eligibility; CLI without native session proof reports uninspected.
When eligible, its exact request is:

```json
{"action":"adopt","revision":2,"subjectSha256":"<exact-current-64-lowercase-hex>"}
```

Send this through `pa_decision`, not a CLI/password or generic chat question.
Native review binds both coordinators, run/revision, exact package and retained
resources. Consent appends `coordinator-adopted` to the SAME journal; the original
caller, decisions, snapshots, attempts and bounds remain unchanged. It does
not approve the package. Reread the incremented revision, then explicitly request
`recover` and obtain the fresh native package decision. A queue-only adoption is
instead restricted to reconciliation of the existing approved queue intent; it
cannot request new steps, revoke, revise or acquire source/check authority.

The previous effective coordinator AND its supported resume descendants must
have terminal registry evidence plus a private launch-incarnation anchor and
proven process absence. Live/staged completion, reused PIDs, different boot,
missing anchors or unreadable process evidence fail closed. The launcher now
records requirements/analyze anchors; do not manufacture historical anchors for
older sessions. A nonowning auditor without a resume edge is not the coordinator.
Proof is repeated after consent and inside final registry CAS. Competing claims
have one winner; stale callers reread. A crash before commit leaves no reservation
or grant; a lost reply after commit is resolved by reading existing succession,
not another takeover. Old readers reject the new event: do not downgrade the run.

## Actionable projections

Status/next now distinguish `runState=admitted` from `packageReview.outcome` and
its approval boolean. A cancelled package exposes an explicit operator-owned
`recovery` request, or an unavailable recovery with workflow-owner guidance when
bounds/resources do not permit it. Next/primer no longer project cancellation as
an unexplained empty eligible list. These requests are diagnostic data, never
approval or automatic recapture.

Builder launch inspects adopted package/publication/queue gates before returning
branch-only repair advice. Its diagnostic lists missing branch evidence alongside
those gates and names the separate project-command execution prerequisite. A
manual link or queue-only status is not a complete readiness repair. Observing
these blockers performs no workflow effect or checkout acquisition.

## LM-101 continuity

The original d-076ff1 cancellation and r001 pair are historical continuity, not
current mutation arguments. Later audit evidence reports the unchanged pair was
approved/published and its queue intent remained pending. Reauthenticate the
actual run before acting: an already-approved pair must not be recovered or
approved again to fix infrastructure queueing. Use the existing authorized queue
intent through its owner; only a recognized audited administrative prequeue can
converge missing fields, without republish, new intent or builder launch. Exact
already-complete effects settle without another write; revoked authority blocks
new writes. Conflicting/advanced states stop, and execution/link/custody blockers
remain separate. No live LM-101 effect, installation or human UAT was performed
by this source implementation.
