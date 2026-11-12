# PAP-292 implementation contract and delivery ledger

This is an engineering contract, not a requirements approval or acceptance receipt.
Source: d-e19912/r002 requirements, contracts and validation in ai-usage. The operator
requested implementation in rogue-one and phased commits, with PAPC work on a new
feature branch in its canonical checkout. No installation, merge or adoption is implied.

## P1: capability and compatibility contract

Only fresh, unpinned foreground Pi requirements/analyze selects
`pa-document-policy/v1` / `pa-mode-capabilities/v1`. The existing committed-resource
and immutable registry binding remains authoritative. v1–v4, resume, background,
OPA, inherited and ticket-worktree routes are not upgraded.

| New ID | Canonical tool | Implementation / limits |
| --- | --- | --- |
| ordinary.bash | bash | Pi ordinary implementation; existing shared adapter shell/host limits |
| ordinary.read | read | Pi ordinary read/pagination, normal host reach, shared path safeguards |
| ordinary.edit | edit | Pi exact ordinary edit; shared path safeguards |
| ordinary.write | write | Pi ordinary write; shared path safeguards |
| ticket.status | pa_ticket_status | pa-core finite status owner; strict 64KiB JSON, complete snapshot CAS, durable original request |
| workflow.request | pa_workflow | Existing Pi workflow parser/owner; unchanged 64KiB and protected gates |
| decision.request | pa_decision | Existing genuine native foreground decision owner; no imported outcomes |

`context.read` keeps its existing guarded semantics. Selecting it together with
`ordinary.read` is rejected as ambiguous; there is never registration-order
precedence. Canonical tool lists are deduplicated. Unknown/duplicate/wildcard IDs
reject. Ordinary tools do not grant credentials, arbitrary executors or approvals.
Existing selected specialists keep their parsers and intrinsic guards.

Task policy: investigate/read freely, including the whole normal effective
ai-usage tree; author mutable artifacts there. Do not write repository/source/Git,
including generated files, caches, build/test/install outputs or branch/index/refs.
This is NOT a same-UID sandbox. Broad shell has the same residual local-process
risks as rogue-one; supported effects still require authenticated owners and native
provenance. No safety, review, decision, publication or queue check is removed.

## P3: status and operation contract

Additive native `pa_ticket_status({request})` and Pi CLI
`ppa ticket-status --request '<JSON>'` use the SAME finite owner. Request version
`pa-ticket-status/v1`; actions `inspect` (project,ticket), `set` (also requestId,
expectedVersion,status). Native caller uses the real session; CLI uses verified
native process lineage/immutable policy, not an invented TUI identity. Request
scope is deployment/project so original intent recovery works across both routes.
No caller actor/outcome/root/approval fields. Result is explicitly administrative
status-only, never publication, queue, UAT, launch or acceptance evidence.

The underlying store has no fine-grained edge graph. All nine enum values are
recognized: idea, requirement-review, pending-approval, pending-implementation,
implementing, review-uat, done, rejected, cancelled. Status changes do not change
assignment. Terminal values set resolvedAt (preserving a prior terminal date);
reopening clears it. `done` with open children is rejected. Unprivileged callers
and builder/implement children cannot change status. The new service additionally
rejects competing/uncertain owners and retained workflow controllers. Same-status
requests are durable administrative no-ops. Stale snapshots reject before intent;
changed original payload conflicts; completed replay never overwrites later work.

### Complete T/W disposition (not a parity claim)

| Rows | Current supported bindings / delivery disposition |
| --- | --- |
| T-01 | pa_ticket read/show/list; ppa ticket list/show/check-refs; retained bounds unchanged |
| T-02–04 | pa_ticket_intake capabilities/create/inspect/reuse/patch-planning; legacy CLI create/update do NOT yet share all native intent semantics |
| T-05–07 | Legacy CLI update tags/blockers, comment/attach/refs; pa_ticket comment. General native collection/ref ports remain PAP-290 gaps |
| T-08 | Only native document/workflow publication is protected package-primary authority; administrative metadata is not a receipt |
| T-09 | New dual-route status service; legacy CLI assignment remains; native assignment/claim/handoff parity incomplete |
| T-10 | Legacy CLI authenticated branch/commit metadata owners; no source mutation authority, general native route missing |
| T-11 | Legacy CLI subticket list/create/update/complete; equivalent general native port missing |
| T-12–14 | Existing CLI archive/unarchive/move/delete guards remain; reviewed native operator handoff remains missing |
| W-01–06 | Selected existing pa_workflow/pa_decision read/request/decision/recovery owners; CLI workflow/decision remains read-only, no unattended consent |
| W-07–11 | Existing pa_document package/check/freeze/read/confirm/publish/queue; CLI describe-only, no new effect bridge |
| W-12–13 | Selected workspace/discovery/template/reader unchanged; helper confinement and reader URL limits unchanged |
| W-14 | Source execution/preparation/push/merge/install/activation excluded from automatic analyst authority |
| W-15 | Existing review/custody/evidence/UAT owners unchanged; no acceptance grant |

Single-controller rule: document protected effects already reject retained workflow
controllers; workflow admission must not be used as a second document controller.
Any missing coexistence/CLI effect route remains a release gap, not an excuse to
edit authority files. Preserve original pending intent and exact approval scope.
G-01–08 remain with their current owners; general tool exposure adds no exemption.

## Concrete source checks

- N-01/02/07/08: `mode-capabilities.test.ts`, `mode-capability-session.test.ts`,
  `requirements-tool-parity.test.ts` under their existing pa-core/pi-pa test roots.
- N-03: `packages/pa-core/src/__tests__/ticket-status.test.ts` and
  `packages/pi-pa/src/__tests__/ticket-status-native.test.ts`.
- Existing: public-web-launch, document-session/native/confirmation/workspace,
  interactions-ticket, workflow-state/adoption/document-continuation/owner,
  repository-admission and Pi deployment suites from r002 validation.md.
- `corepack pnpm typecheck`, `build`, focused `node --import=tsx --test ...`,
  correct-resource code/full lanes, `completions`, staged `secrets:scan`.

## Exit boundaries

P1 records concrete choices, not independent owner/security approval. P2 implements
ordinary-tool mechanics, with no active selection. P3 delivers status and existing
workflow reach, NOT all PAP-290 operation bridges. P4 is a separately committed
PAPC candidate; preserve unrelated sample.html and other-mode policy. P5 source
checks do not substitute for exact installed provenance, matched foreground runs,
independent review/CI or Sinh's human UAT. Full PAP-292 acceptance remains blocked
until every required catalogue variant and all 13 AC/25 scenarios are reconciled.
Rollback omits new IDs for NEW starts; never widen running bindings, delete
intents/decisions or downgrade unreadable retained records.
