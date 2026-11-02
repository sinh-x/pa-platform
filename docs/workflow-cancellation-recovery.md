# Explicit cancellation recovery (PAP-273)

A cancelled native package decision grants no permissions. Ordinary `capture`
remains ineligible after it; `revise` still requires genuine changes-requested or
material-amendment conditions. Neither a new analyst session, queue status nor an
ordinary structured question substitutes for native authority.

The existing Pi `pa_decision` tool now accepts exactly:

```json
{"action":"recover","revision":2,"decisionId":"decision-<exact-cancelled-id>","subjectSha256":"<exact-current-64-lowercase-hex>"}
```

Use the values from current workflow status/next. The run is derived from the
native caller's adopted repository/ticket; callers cannot supply a run, actor,
outcome, permissions or replacement package. The foreground requirements caller
must be the original authenticated owner or an existing registry-authenticated
same-role continuation. Relaunching an unrelated deployment is not continuation
authority. There is no shell/CLI approval workaround.

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

Retain the existing d-076ff1 run, cancellation and r001 pair. After operator
installation, a supported requirements continuation may inspect status and request
this recovery. The human must actually answer the native question. The earlier
record-only answer remains intent, not issued authority. Only then may the normal
publication/handoff owners run; the project-command profile remains a separate
later execution prerequisite. No recovery, publication, installation or human UAT
was performed by implementing this interface.
