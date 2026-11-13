# PAP-302 — paired PAPC follow-up plan

## Operator selection and limits

On 2026-11-13 in d-573872, after P1 commit `dcf722f`, the operator selected
**Plan a paired PAPC follow-up** rather than runtime-only development or stopping
for review. This document plans that follow-up. It is not package approval,
configuration selection, permission to create a ticket/branch/worktree, or service
activation. No companion ticket exists as a result of this plan.

Continue implementation only in each ticket's separately selected worktree.
Never edit either repository's `develop` checkout. The PAP-302 worktree remains
`/home/sinh/.treehouse/pa-platform-cdb114/14/pa-platform`.
See [P1 delivery/evidence](PAP-302-auto-waitlist.md) and the published PAP-302 r001
requirements/UAT for the unchanged product scope and all fourteen acceptance cases.

## Read-only baseline, not an installed pair

PAPC canonical repository: `/home/sinh/git-repos/sinh-x/tools/pa-platform-config`.
Reobserved 2026-11-13T10:22:32Z: local HEAD/develop
`d1b8cad4b0e00c65c2cbee1f953f39f4df3e6ce5`; no fetch or remote-freshness claim.
This is newer than the published requirements' historical PAPC observation and
must be rechecked by the paired owner; do not overwrite retained selection.

Observed files (raw SHA-256):

- `teams/requirements.yaml`:
  `47d4500ff902f5ed20a28c2748925e85085f8a1a91f13b2193f41a144a784d1c`.
- `skills/requirements/analyze-auto.md`:
  `9fe5e6a447d16e7708cd18e9f6fa8105cd31cbace7c160d79d802fe52bebc49d`.

Existing `analyze` selects `pa-document-policy/v1`, whose runtime caller is
foreground-only. Existing `analyze-auto` has no such native profile and explicitly
requires ticket claim/tag/comment and a later interactive analyze handoff. Neither
is the service's compatible bounded draft-only producer. Preserve both.

## Proposed companion task — intake still required

- Project: registered `pa-platform-config` / PAPC.
- Proposed title: **Add opt-in PAP-302 auto draft and review contract selection**.
- Depends on: PAP-302's new runtime contract implementations and source tests.
- Delivers: additive mode/instructions, exact paired contract/version declaration,
  fixture tests, retained-profile negatives, qualification/adoption checklist.
- Excludes: source runtime implementation, installed enablement, live canaries,
  approval of any future ticket, alternate providers/models, remote operations.
- Assignee, priority, estimate, ticket creation, branch/base and worktree selection
  need the actual intake/repository owners; PAP-302's metadata is not inherited.

## Contract work, in dependency order

### A. Freeze the producer and foreground host interface together

Runtime and config owners must agree exact versioned names/schemas before either
side selects them. Proposed names such as `auto-draft/v1` are placeholders only.
The compatibility declaration must bind both producer and review/start host; an
unknown/mismatched version blocks dependent effects but not P1 inspection.

Producer invariants:

1. Fresh background Pi route with native registry/process identity, exact ticket,
   canonical registered source root, selected config/provider/model and finite
   deadline; no foreground-only document session launched headlessly.
2. Native tool/effect boundary permits source investigation and unsigned full
   brief/requirements/UAT artifacts outside repositories only. Instructions alone
   are not writer isolation. No ticket claim/status/tag/comment/ref mutation,
   approved branch-plan persistence, Git/checkout operation or builder spawn.
3. Persist original service item, draft request, deployment and package identities
   before effects. Result distinguishes complete unsigned package, material
   question/blocker, failed and uncertain work; never caller-supplied readiness.
4. Existing pending packages and current approved published packages bypass new
   drafting. Unknown publication/foreign lineage stays with its original owner.

Foreground/start invariants:

1. CLI-owned human-only foreground host rejects managed-origin, headless, piped,
   caller-forged actor/outcome and environment-grant inputs. Full required
   documents, hashes/revision, scope/exclusions and finite intent are accessible;
   default Cancel, request changes and Reject confer no dependent effects.
2. Extend actual native decision owners with a new compatible version, not a
   service JSON approval ledger. Retained content/publish/queue receipts keep
   `builderLaunch: false`; no receipt is reinterpreted as a start grant.
3. One approval action may combine exact document scope and separate finite start
   intent only when both are displayed and supported by that new native contract.
   Already-approved usable work needs one start decision, not content reapproval.
4. Bind repository/ticket snapshot, full package bytes, route/runtime=pi,
   selected config/provider/model, objective/local effects, branch/base/continuation
   where required, deadline and validation obligations. Material drift requires
   changed review; unchanged owner reconciliation never asks again.

### B. Runtime P2–P3 implementation, then compatible PAPC selection

PAP-302 owns durable global selection across PAP/PAPC and all hold states,
foreground decisions, finite admission/dispatch and original-intent reconciliation.
Persist native operation/deployment references before every first-unproven action.
Pre-dispatch checks repeat current caller, pause boundary, approval lifecycle,
material bindings, blockers, manual ownership, capacity and custody. Unknown spawn
reply retains the slot and original intent; no PID-based duplicate launch.

PAPC then adds the compatible new opt-in mode/instructions in its own feature
worktree, leaving retained analyze/analyze-auto/review profiles unchanged. It must
not select an unimplemented contract, cheaper model, broader writer or fallback
root. Fixture compatibility is not installed qualification. Commit each completed
phase in its respective ticket worktree and cross-reference exact candidate IDs.

### C. P4–P5 qualification and opt-in rollout

Only after A/B, implement timer/notifier controls with no default activation:
30-minute/no-catch-up scans, serialized overlap, informational bounded freedesktop
notifications, durable warning on unavailable desktop, and pause preventing new
dispatch without pretending to kill a worker.

Required separate evidence: all TS-1–TS-14 source cases, real two-process selection
races (not just P1 scanner races), fault injection at decision/publication/queue/
admission/spawn boundaries, exact prompt counts, retained-mode regressions,
independent safety/code review, full workspace regression/hosted CI, exact installed
runtime/config pair, actual desktop observations, one explicitly authorized useful
canary per registered repo, and Sinh's human UAT/adoption. Record failures/skips
without promotion to passes. P1's original full-suite inventory failure and its
focused repair are retained, not replaced by a full-green claim.

Rollback disables new scans/dispatches, preserves all snapshots/history/decisions/
pending effects and reconciles the existing item through original owners. No
automatic process kill, counter reset, evidence deletion, checkout return or done.

## Next owner action

Use this plan for companion intake and exact runtime/config contract review.
No runnable activation, publication, queue or launch instruction is supplied.
P2–P5 remain undelivered until their actual effects and separate qualification
obligations are implemented and observed; this planning commit closes none of them.
