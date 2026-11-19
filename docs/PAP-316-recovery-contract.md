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
