# PAP-316 follow-up: original planning recovery

## Current disposition: source integration; full verification deferred

On 2026-11-19 Sinh explicitly requested PR merge into `develop` and source-work
wrap-up, leaving UAT and full verification for later. The integration candidate
restores plain 0.1.176 for normal develop auto-patch flow. The installed
0.1.176-pap316.2 trial and clean reference commit
`4d967b3d427eb9ee79d71f282c9549346764be3d` remain historical trial evidence;
source integration does not reinstall or change the selected configuration.

Post-rebase checks passed: workspace typecheck/build, 100 core planning/ticket/
catalogue/routing/profile cases, five registered observation/diagnostic cases,
five Pi profile/session cases, and 109 OPA cases with one unavailable external
fixture skipped. Installed CLI/HTTP safety smoke passed 20/20 after a preserved
harness-only failure; native Pi/SQLite preflight passed. Current PAPC at 7aad756
selects the Analyst read-only profiles and analyze handoff capabilities, so the
older omitted-profile observation is not a current blocker. The installed package
metadata reports `unversioned-dirty-source`; exact installed source/module parity
was not established, and Sinh did not treat that fact as a feature-availability
or source-merge blocker.

Integration preparation reran typecheck/build/completions successfully. The
repository-owned pairing fixture lane initially had 30 passes and 15 failures:
two structural-preview callers still supplied noncanonical synthetic deployment
IDs. Only those preview inputs were updated to valid synthetic IDs; runtime
validation and all assertions remain intact. The rerun passed 45/45 with no skips,
and focused catalogue/routing checks passed 29/29. This is fixture compatibility,
not an external configuration checkout or a foreground/installed qualification.

These results do not establish genuine foreground/client/effect recovery,
forwarding, browser/accessibility, human UAT, complete final-candidate regression
or independent candidate review. Hosted CI results must be reported separately
from source fixtures and installed smoke. Deferred qualification remains with
PAP-317/PAPC-092 and its actual operator/review owners; no duplicate follow-up or
completed-case claim is created. Original PAPC-093 incident records and protected
history remain untouched. The dated phase evidence below is retained, not reset
or relabelled as complete UAT by this source-integration decision.

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

## P3 runtime primer routing

Both normal and minimal bare composition now project PAPC-093's canonical
administrative/product/native distinction and date/issue/slug naming under the
effective deployment artifact home. Existing launcher template variables supply
identity/date; authored context and `PA_DEPLOYMENT_DIR` cannot override the root.
These composition inputs are not process authentication or write admission.
Source CWD, omitted tools/hooks and retained pinned projections remain unchanged.
No filesystem destination is initialized by rendering this guidance.

The helper's intended-cause red had seven failures before implementation
(`/tmp/pap-316-p3-primer-red.log`). Parent verification of routing, primer,
handoff-primer and rogue-one suites passed 83/83 with zero skips
(`/tmp/pap316-followup-p3.log`). It covers alternate effective homes, independent
deployments, missing/spoofed context, hostile naming/locations, omitted resources
and retained projections. This proves actual primer composition, not subsequent
agent compliance or output-writer enforcement.

The real managed AgentKit environment bridge/emitter, its finite authenticated
context contract, and application diagnostic validators remain separately owned
and unmodified. No environment allowlist was widened. Consequently runtime
primer delivery is partial end-to-end PAPC-093 routing, not a claim that conflicting
installed hook directives or all administrative producers are repaired.

## P4 continuation: observation purity and adapter compatibility

The inherited P4 overlay now uses existing-file-only registry status/events for
handoff process authentication, including registered-tool guards. A missing
registry remains missing, and a checkpointed registry is read without creating
WAL/SHM files. Effects still open their existing durable connection only after
admission; read-only authentication grants no additional capability. Ticket
observation rejects orphan completion audits and malformed present ticket
collections/status rather than normalizing them into clean absence. The source
catalogue explicitly classifies `handoff.plan-status` as read-only and inventories
its typed repository-ref dependencies.

Full workspace testing exposed a P3 compatibility defect: path-safe historical
adapter labels such as `PAP-TEST` were rejected by the new primer naming check.
The new focused regression failed for that exact cause before the minimal fix.
Routing now accepts bounded uppercase issue labels as **naming hints only**;
native ticket owners retain canonical numeric-ID admission. Traversal, controls,
trailing newlines, markup delimiters, oversized labels and empty components still
reject. No launcher, native ticket grammar or repository ownership was widened.

Before: a previously supported OPA launch with `PAP-TEST` failed during primer
composition. After: composition supplies the current deployment artifact location;
actual persistence and ticket effects still require their existing admission.
The invalid-context blocker text and its five-label envelope remain unchanged.
Affected paths/categories: normal/bare Pi/OPA primer information and composition
blockers; registered native handoff observation, authentication and owner failures.
Agent plain-text review is not independent human readability review.

Actual continuation checks (deployment `d-fe1db6`, Node 22.23.4, pnpm 10.28.0):

| Command / scope | Observed result |
| --- | --- |
| `corepack pnpm typecheck` and `corepack pnpm build` | Passed after the compatibility fix. |
| `corepack pnpm test` before that fix | Root harness 43 passed; core 2,447 passed / 14 skipped / zero failed. OPA 74 passed / 35 failed / one skipped; the workspace command failed and later package completion was not established. Full captured output: `/tmp/pi-bash-77c8819a3f38cd96.log` (tool-managed temporary evidence, not a permanent artifact). |
| Core ticket/planning/catalogue/routing focused suites before compatibility fix | 90 passed, zero skipped. |
| Registered original-plan/observation/custody/hostile diagnostics selection | Five passed, zero skipped. |
| Legacy-label intended-cause regression | One failed before fix. |
| Core routing/primer/handoff/rogue suites after fix | 81 passed, zero skipped. |
| `corepack pnpm --filter @pa-platform/opencode-pa test` after fix | 109 passed / zero failed / one unavailable external-config fixture skipped. |
| Pi native handoff + Analyst identity + session + transport suites, 500-second bound | 55 subtests reported passed before timeout; no complete suite pass. Includes all eight CLI/API outcome convergence cases, conflicting foreground input and disconnect/detachment. |
| Core API/source/review/catalogue selection, 100-second bound | 84 subtests reported passed before timeout; no complete suite pass. |
| Pi document-session and local-review CLI/contract/server suites separately | 34 passed, zero skipped. |

Timeouts are incomplete checks, not passing suites. The first workspace failure
and its repaired OPA rerun are separate evidence. A final complete workspace run,
independent candidate-bound source review and applicable CI remain required for
P4 acceptance; these source commits do not declare that gate complete.

## P5 handoff: qualification remains open

Source repair candidate: `858d01c` (P4 continuation). Catalogue verification
separately passed 16/16 after final digest reconciliation. Completions generation
passed with no tracked completion changes; staged secret scan and whitespace
checks passed before the source commit. A transient Git index lock prevented the
first commit attempt; it disappeared without deletion or repair, then the same
staged candidate committed successfully.

Next work, in order:

1. Runtime source owner: finish complete final-candidate workspace/Pi regression
   with a sufficient bounded execution window, preserving the failed workspace
   run and both incomplete focused runs. Do not remove cases or weaken gates.
   Obtain separate independent source review and applicable candidate-bound CI.
2. Original PAPC-093 runtime owner: inspect/reconcile the preserved original
   foreign-session operation. Same-session `plan-status` cannot impersonate that
   origin or authorize adoption, refreshed CAS or a replacement request. The
   incident's inner cause remains unproven; no live operation was retried here.
3. PAP-317 and PAPC-092 owners: establish exact installed runtime/config/resource
   provenance and separately qualify genuine supplied-ticket/ticketless entry,
   open-Pi external decisions, partial effects/recovery and actual reader delivery.
4. Browser/accessibility and Sinh: perform genuine reader/human UAT. Future-start
   adoption remains a separate decision, not an implication of these source checks.

PAPC-093 managed AgentKit/application writers remain separate routing owners.
No runtime install, live final decision, publication, branch/link repair, queue,
checkout allocation/return, push/merge or implementation launch was performed.
Decision trust stays **local-unverified**, not authenticated human consent.
Original completed effects/history and the old deployment's still-running registry
record remain preserved. Overall P4/P5 acceptance is **partial**, not completed.

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
