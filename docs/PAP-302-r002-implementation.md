# PAP-302 r002 — implementation lineage and initial assessment contract

The published `pap-302-auto-waitlist/r002` requirements and UAT supersede r001
for the **new delegated mode** while retaining the manual mode. The r002 native
decision is publish-only: it does not adopt a delegation policy, queue work,
launch a worker, or enable a service. The existing PAP-302 ticket worktree and
history remain the implementation lineage; no checkout/custody repair is inferred.

## R0: reconciliation and first non-authoritative component

The existing manual coordinator reserves `auto_items.active_slot` only after a
human ticket selection; it cannot represent a pre-ticket selector reservation.
Its hash-linked events and effect claims are coordination evidence, not policy
authority. Existing `pa-auto-start/v1` binds a genuine per-item human decision;
its parser, review journal, old content/publish/queue scopes and v1 background
tick cannot be reinterpreted as a delegated grant. Existing `auto-draft` is
explicitly held in the runtime candidate, and generic deploy remains reserved.
R002 accepts instruction-only repository protection in the **new** route, but
requires a supported replacement owner, honest process uncertainty, append
fencing and a separate policy/admission bridge before that hold can be removed.
The old manual route remains unchanged. R002 does not authorize clearing any
existing hold, creating a second approval ledger, or releasing uncertain
implementation custody.

The new internal `pa-auto-selection-assessment/v1` parser is a deliberately
partial, unsigned model-data contract: it checks exact PPA session/snapshot/
goal/policy identity against caller-supplied observations, requires one rationale
per eligible PAP/PAPC candidate across all pages, and permits one eligible pick
or explicit no-pick. It rejects extra keys, duplicate candidates/JSON keys,
malformed or excessive bytes and identity drift. The caller context is **not**
authenticated by this pure parser. The assessment is NOT the complete r002
selection report: native session provenance, times/cleanup, config/provider/
resources, goal locator and safe excerpt, exclusions, evidence and finalization
remain unimplemented. Nor does syntactic rationale prove useful reasoning,
privacy, eligibility, fresh goals, policy adoption, reservation, CAS or launch
rights. It is not exported as a CLI/tool or connected to any worker. A later
owner must filter/report sensitive content and perform all these checks; invalid,
incomplete or oversized coverage must never silently choose a top-N fallback.

Exact future native policy, reservation, report, draft append, quarantine,
periodic-effect and final-review contracts require their actual owner integration
and separately coordinated PAPC pairing. This source step is not joint contract
agreement, a new authority or activation. No model, config flag, old receipt or
human-readable rationale can stand in for genuine native policy adoption.

## Initial source checks

On the initial r002 source candidate, core auto/interaction tests passed 77/77
with no skips, including four assessment parser tests and retained v1 tests;
core typecheck and build passed. Logs: `/tmp/pap302-r002-r0-core.log`,
`/tmp/pap302-r002-r0-typecheck.log`, `/tmp/pap302-r002-r0-build.log`.
These do not test a real PPA session, reports, decision/selection, authority,
persistence, recovery, paired config or UAT. In particular, the assessment parser
is not yet an implemented selector or an agreed complete cross-repository API.

## Remaining phases

- R1: native global pre-ticket reservation, real tracked PPA reasoning session,
  bounded goal/source discovery, complete durable report, reobservation and CAS;
  preserve all original evidence and recover the same intent.
- R2: bounded real draft owner and idempotent append-only own draft refs/comments,
  with source protections and generation fencing; no unmediated ticket mutation.
- R3: actual native exact-policy foreground adoption/revocation/expiry, immutable
  policy-bound item intent, and explicit existing publication/lifecycle/launcher
  bridges, without fabricated per-ticket human decisions.
- R4: operator-only uncertain-draft quarantine with one-quarantine cap and late
  effect fencing, final-review hold and separate versioned periodic effects;
  retained v1 tick stays observation-only.
- R5: complete current tests, independent review, exact PAPC/runtime/resource
  pairing, installed and real foreground/provider/desktop canaries, human UAT,
  and separately authorized service adoption/activation. All TS-1–TS-16 remain
  Not run until their actual owners execute/accept them.
