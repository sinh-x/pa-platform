# PAP-316 follow-up: original planning recovery

## P0 baseline and scope

The selected editing checkout is `feature/PAP-316-approval-handoff` at
`3caec8924a85d98f154f3709b3bb4c7a0655a99e`, originally clean. Its original
base is `5d5c28c8d5a987197bfebd7b1b7f183bd174fcfa`. Preserve its advanced
history; no checkout allocation, reset, live handoff, installation or adoption
is part of these source changes. Prior PAP-316 phase commits remain delivered.

The November 19 requirements package defines the remaining P0–P5 work. It is
review material, not native consent. Current directives retain local-unverified
confirmation and the complete linked reader. PAPC owns workflow and quality;
PAP-317 owns separate installed provenance/qualification, and PAPC-093 owns
cross-owner administrative-output routing.

## Original incident

Preserve `d-23e31a`, `PAPC-093`, request
`papc-093-artifact-routing-plan-v1`, expected complete-ticket version
`926e31f1c1ea9ebebbe4408f4fb5d90896d54f93898976d35208f04fa2757f43`, and branch
`feature/PAPC-093-deployment-artifact-routing`.

Native registry observation on November 19 confirmed a single started Analyst
session, its v3 selection, one native null-to-ticket association, and subsequent
partial completion. The original tool returned `DOCUMENT_UNAVAILABLE` without a
plan receipt. A bounded current inventory of the effective default ticket store
found no `.ticket-handoff-*` records. This is an inventory observation, **not proof
of incident-time absence, exact incident root cause, or recovery authority**.
No original request was replayed and no live owner record was repaired.

There is no selected pre-subject plan observation action in this source baseline.
Existing `status` requires a review subject. `TicketStore.inspectHandoffWithIntent`
uses a writable mutex, and construction creates the ticket directory. Neither is
an appropriate hidden initialization path for read-only observation.

The demonstrated diagnostic risk is independent of the unknown incident cause:
repository-ref custody and writer exclusion throw ordinary errors, whereas the
registered Pi tool preserves only recognized document errors. Known ticket-owner
errors are also lost. Fix only typed cause transport, never parse exception prose.
Unknown/hostile exceptions must remain unknown.

## Reviewed source interface delta

Add **v2-only** `plan-status(ticket,requestId,expectedTicketVersion,branch)` to
`pa_handoff`. These are the original plan's desired coordinates, not root,
actor, origin-deployment, grant or recovery overrides. The native caller derives
the existing plan identity from its authenticated current deployment/session,
selection and repository. Foreign origins cannot be selected by request data.

Return `pa-handoff-plan-status/v1` with original coordinates, identity, durable
intent disposition (absent/partial/complete), ticket observation, original CAS
comparison, saved intent when present, and an explicit next owner. Observation
reads existing bounded files only: no directory/mutex/journal creation, database
migration, repository locks, repair, probes of physical refs or grant issuance.
Conflicting, malformed, changing or unavailable evidence rejects as uncertain;
absence is never inferred from an arbitrary exception. Observation is a point-in-
time fact, not reusable effect admission. No-record/stale-CAS requires original
owner reconciliation; it does not authorize a refreshed version/new request.

Historical associations and legacy branches remain protected. Existing native
same-operation partial/lost-response recovery is reused and tested, not replaced
with global historical-association exemptions. Unsupported retained origin
adoption stays a specific original-owner dependency.

## P1 source evidence and message examples

The registered-tool red reproduced two distinct gaps before source changes:
`plan-status` returned `DOCUMENT_INPUT`, and a real preserved custody marker
returned `DOCUMENT_UNAVAILABLE` instead of its established owner cause.
`/tmp/pap316-followup-p1-red.log`: 0/2 passed. After minimal implementation,
`/tmp/pap316-followup-p1-focused.log`: 4/4 passed, including typed/hostile messages.
Core intake/planning/ticket/Git/branch regressions passed 112/112 with no skips
(`/tmp/pap316-followup-p1-core.log`). Workspace typecheck passed. The first
complete native suite exceeded its 300-second execution bound after 23 passing
cases; that attempt is incomplete, not a full-suite pass.

Affected categories are native handoff failures/blockers and tool information.
Before: an established custody conflict became a generic unavailable result.
After: the same denial returns existing `DOCUMENT_CONFLICT`, explaining that the
repository-ref owner found retained custody and cannot reclaim it. Original
request inspection is the recommended read-only action; repairs still require
the genuine owner. Unknown errors still say the cause is not established.
Ticket-owner errors map only their finite typed codes to existing document codes.
Raw exception prose, marker content and hostile getters are never guidance.

The existing result envelope, error flag, streams and `executionAdmitted=false`
remain unchanged. The necessary new observation result is separately versioned;
no effect API or imported authority was introduced. Structural checks confirm
one five-label envelope under 2,000 UTF-16 units. Agent plain-text review finds
outcome, consequence and next owner explicit; genuine human readability and
installed propagation are not claimed.

## P2 original-operation and retained-history qualification

The existing recovery owners required no demonstrated behavior change. Added
five composition cases cover pre-intent, intent, ticket and audit interruption,
later comments, immutable original coordinates, read-only observation and caller
lineage drift. The combined planning/ticket suites passed 61/61, zero skips
(`/tmp/pap316-followup-p2-recovery.log`). Existing tests additionally retain
advanced native branches, original base/actor, competing-process exclusion,
legacy/foreign-marker rejection and unchanged physical refs.

A completed original plan replays its saved receipt while preserving later
comments. A partial plan followed by unrelated ticket work remains uncertain;
no-intent plus stale CAS remains stale. Observation identifies their original
owner without replaying, refreshing CAS, dropping later work or inventing an
adoption grant. Such protected blockers are intentional supported dispositions,
not repaired by broad historical-association exceptions. The original foreign
PAPC-093 operation still needs its genuine owner; this same-session source seam
cannot select another deployment by a model-supplied identifier.

## Phase exits

- P0: evidence and finite contract above; incident cause remains unknown.
- P1: intended-cause registered diagnostic and observation reds before fixes;
  focused green and safe unknown/hostile cases.
- P2: original CAS, interruption, later comments and retained-lineage regression
  evidence; minimal demonstrated changes only.
- P3: normal/bare primer delivery of PAPC's administrative-output distinction;
  managed AgentKit emitter and application writers remain external owners.
- P4: affected/workspace checks, independent source review and maintained docs.
- P5: separate actual installed/client/browser/CI/human evidence or explicit gaps.
  No source test can establish installation, genuine consent or human UAT.
