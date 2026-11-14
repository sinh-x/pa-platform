# PAP-299 P1: candidate contracts and independent-review gate

Status: **P1 groundwork only; NOT security-reviewed, enabled or phase-complete.**
No P2–P6 completion or product acceptance is claimed. This document and the new
pure parsers are review inputs, not runtime capabilities or authority. The source
candidate starts at `469e0bf6b12cadd79ddc06a3e050a13760a88e0c` in the selected
`feature/PAP-299-requirements-handoff-reader` checkout. Preserve its original base;
this change does not rebase, acquire/return a checkout, publish, queue or launch.

## 1. Controlling inputs and compatibility

Fully read: PAP-299 and its recorded clarifications; all four PAPC-079 r003
members; all four PAP-299 r002 members from d-34b0a6; the original runtime handoff;
config `docs/requirements-handoff.md`, `docs/requirements-handoff-validation.md`
and `contracts/requirements-handoff-v1.json`; repository AGENTS/message standard.
The PAPC-079 r003 raw hashes were freshly checked and match the ticket:

| Member | SHA-256 |
| --- | --- |
| brief | `6bc450a54f6e5d3a4293bbdaae327693fab2c8d822784850b3ca00e8f39a7704` |
| requirements | `d0bc03ef7b90c181c926a24aa8a821943c77974c338d61fab347d6840d9fe000` |
| uat | `4c46f4703e7e066b7a3f0ace8488d7e4a3d784163aa150253958220986f84d42` |
| specification | `1920a16cb2fd03a46578005ba09b4d71bb04d9393a16fb701d9abd9c01186866` |

PAP-299 r002 member hashes also match its derived decision representation.
Reading that JSON is **not native decision verification**. No current decision is
consumed and no effect is requested here. Its content-only scope would not grant
publication, branch creation, queueing or product acceptance in any case.

`PAPC-079#c-20261113010433988` controls the resource boundary: branch ref and
correlated ticket linkage ONLY. No worktree, reservation, lease, capacity permit,
checkout switch, stash/reset/discard, push, install or implementation launch.
PAP-303's historical manual bridge is a regression input, not repair authority.
No historical case was reobserved or repaired by these changes.

## 2. Actual owner inventory and reproduced gaps

| Source owner | Observed source behavior | Required change, not yet implemented |
| --- | --- | --- |
| `documents/package-service.ts` | Stable tagged legacy intake; caller association is separate; branch inspection only | New selected association/intent consumer, without changing old intake |
| `tickets/store.ts` | One mutex/audit owner; `createWithIntent`, scalar planning/status intent primitives | Durable finite branch-link and stage/assignment/ref transactions with complete-ticket CAS |
| `tickets/git-validation.ts` | Planned links cannot carry base/head; first physical linkage infers base from current ref | Separate authenticated reviewed-base record; do not use inference for advanced reuse |
| `tickets/package-publication.ts` | Exact member files/refs then primary; incompatible primary and lifecycle reject | Reviewed new-decision provenance consumer and full decision/delivery-ref prerequisites; preserve old behavior |
| `documents/confirmation-service.ts`, `registry/documents.ts` | Finite existing document confirmation and original-coordinate recovery | Separate new subject/native events, never forged legacy confirmations |
| `deploy/ticket-concurrency.ts` | Shared repository ticket-slot mutex; ordinary materialization and preparation use it | Narrow exclusion-only composition with no capacity reservation/update |
| `deploy/repository-admission.ts` | Primary/linked mutation mutexes; retained custody is not absence | Same physical identity and owner exclusion for ref writes, no checkout acquisition |
| `artifacts/render.ts` | Conservative marked-token renderer, escaped generated tags; pinned parser in lockfile | Reuse primitives for full semantic package renderer, not trusted parser HTML |
| `documents/presentation.ts` | Separate text companions; opaque image entries; no full reader or opener | New opt-in delivery, preserving old presentation bytes |
| `primer/index.ts` | Selected process bodies, but embedded document completion | Consume exact selected canonical completion closure, not a copied fragment |
| Pi managed browser | Existing AXI browser is headless/general-purpose | Not evidence of a finite human-facing bound local opener |

Disposable existing-service fixtures reproduce inspection-only capabilities and
per-member presentation with no single entry. New action names are rejected by
retained `pa_document`; P1 does not install them there. Original baseline focused
checks passed 4/4. The new reproduction compares actual ticket file bytes and
journal revision, not normalized model labels, to check for unexpected writes.

## 3. Executable candidate boundary

`packages/pa-core/src/documents/handoff-contract.ts` contains strict **dormant**
structural parsers and canonical digest derivation. It is not exported through
core's public index, selected by config, registered as a tool or consumed by an
effect owner. Compilation does not activate it. No new capability ID/profile is
advertised as supported. Final selection must be reviewed with the actual
consumer, not implemented by prose in this document.

Candidate versions:

- `pa-handoff-branch-intent/v1`: original request/caller identity, complete-ticket
  expected version, registered repository key/root/physical-identity digest,
  exact ticket/feature name, full develop pin with UTC provenance, expected legacy
  link digest and explicit existing native lineage for reuse.
- `pa-handoff-review/v1`: unchanged document-package digest, native branch-intent
  digest, bound delivery digest, immutable selection digest, caller identity and
  finite publish/branchRef/queue booleans.
- `pa-handoff-request/v1`: desired plan, exact review, original branch completion,
  or bound delivery opening. Requests cannot import observed SHA/root/actor,
  outcome, permissions, receipt, URL/path/program/callback/environment.

The four candidate effect sets are content-only, publication-only,
publication+branch, publication+branch+queue. Queue without publication+branch is
rejected on this NEW route; old publish-and-queue retains its existing contract.
Content-only sets all effects false. A branch-enabled publish-only subject stays
unqueued; the branch transaction has no status/assignee fields or effect.

Candidate intent deliberately supports only the registered default
`feature/<exact-ticket>-<lowercase-topic>` convention and develop. Its owner must
also validate the actual registered convention. Other conventions require an
explicit compatible contract, not silent normalization. Fresh create requires
observed develop == reviewed base. Existing reuse retains original base and a
separate observed develop/head; structural lineage is NOT ancestry/ownership
proof. Remote freshness is always `not-established`; no fetch is performed.

Strict raw requests reuse duplicate-decoded-key/UTF-8/depth/64KiB controls. All
nested unknown keys, old schema versions, invalid pins, invalid UTC dates and
cross-ticket names reject. Digests normalize object key order, not semantic
values. Changed source, pin, name, repository, selection, effects or original
request is changed identity. A parsed caller-supplied record is never native proof.

## 4. Native consumer and transaction design for review

### Selection, association and lifecycle

A future fresh Pi-only profile must bind the complete selected resource/capability
closure at launch. Retained v1/v2/v3/v4/policy/OPA/pinned/history do not upgrade.
No existing registered producer or document-package bytes change.

Use `TicketStore.createWithIntent` for new-route ticketless intake, with stable
native scope/request binding. Then independently bind/read caller association via
the authenticated session/registry owner. If that association port cannot prove
its result, preserve the created ticket and report the precise blocker; never
create another ticket to get an association. Supplied tickets are reused exactly.

New finite lifecycle owner must persist original full-ticket intent and recheck
current/historical deployment owners inside the same ticket mutex. Eligible
analysis/review/changes transitions are the exact pairs in the requirements.
Advanced/concurrent work is not regressed or reassigned. Existing incompatible
primary attachment needs explicit owner reconciliation, never automatic demotion.
Full exact members + decision + delivery refs must precede primary promotion.

### One review and explicit publication consumer

The genuine foreground review presents full document tabs plus exact native pin,
feature/ref effect and optional queue. Default Cancel; no page acknowledgements.
Do not hold mutation locks while waiting for a human. Native new-subject event
records original request revision, subject, scope/effects, caller, interaction and
evidence identity. No public outcome/principal port or legacy-event synthesis.

Publication must explicitly verify the new registry decision and project its
finite publication permission into a private owner call. It cannot send an
invented old decision ID through `DocumentPackageService.approved`. The old
consumer remains unchanged. Branch checks exact complete publication and current
new-subject authority again. Queue follows a required branch result on the new
branch-enabled route, but never regresses a historical queue result.

### Lock order and first unproven write

Proposed order: existing repository ticket-slot exclusion mutex -> primary
mutation mutex -> sorted linked-worktree mutation mutexes -> TicketStore mutex ->
short synchronous journal transaction. Enumerate/revalidate physical Git common
directory/backlinks and owner evidence under exclusion. No live dialog or async
callback under these locks. A dedicated internal composition seam must reuse
existing mutex identities; a second branch-only lock alone is insufficient.

`withVacantRepositorySetup` is NOT a ready-made branch owner: it has setup-wide
capacity/vacancy semantics. `withPreparedTicketCapacity` exposes reservation and
inventory durability behavior that must not leak into this finite owner. Reuse
exclusion-only locking, not capacity acquisition, ordinary materialization, or
preparation callbacks. Audit all reverse lock paths and verify process-level
exclusion with materialization/admission before enabling the new seam. Idle known
resource evidence is not itself permission to allocate or to reclaim anything.
Live/uncertain ref writers/custody block; no death/expiry inference or cleanup.

Durable original operation precedes compare-and-create. Use only fixed native Git
argv, exact full ref/base, old zero OID, suppressed untrusted hooks/config and
bounded execution. No shell or force update. A matching ref is reusable only with
native history plus ancestry, never its name. Persist physical result before the
same full-CAS materialized link with original base/current head. Reread native
result, exact ticket fields and actual physical ref. A no-lease ref result is
legitimate and separate from retained PREPARATION_NEEDED/launch admission.

**Unresolved security-critical implementation detail:** crash correlation across
Git ref/reflog durability and the owner journal must be proven, not assumed.
A candidate is an owner-generated unguessable original-operation marker in the
Git creation reflog, bound before mutation and verified with ref ancestry under
serialization. Do not add another Git ref as a hidden correlation effect. A
journal intent plus same-name/same-SHA ref is insufficient. Review exact Git
ordering/fsync guarantees and process-kill tests before accepting this mechanism.
If correlation is not proven, return unknown; do not adopt or recreate. This is
an open P1 gate, not an implemented recovery claim.

Created-ref/missing-link resumes original linkage only. Link-written/reply-lost
settles exact readback. Revocation preserves observed effects but denies every
remaining new write. Deletion/replacement after completion is drift, not a create
retry. No new request ID, repeated approval/publication/queue or resource fallback.

## 5. Renderer and opener design for review

New opt-in `pa-document-reader/v1` (candidate, not registered) verifies the complete
immutable package/member inventory before rendering, then rechecks all outputs
before advertising its entry. Preserve existing per-member presentation unchanged.
Reuse conservative token/tag primitives, but version any shared byte-affecting
change; no generic parser HTML. Add member-ordinal/heading-ordinal anchors, full
semantic bodies, nested sidebar/in-flow mobile contents, Previous/Next/Contents,
labelled focusable local table/code overflow and complete raw/per-member fallbacks.
PNG/JPEG bytes and descriptive alternatives must be verified and rendered in order.
Only generated internal links/verified local assets activate; other source URLs
remain inert text. No scripts/events/SVG/forms/remote assets/fonts/public server.

Delivery identity binds document subject/revision/effects/ordered inventory and
renderer/parser/style implementation digest. Use deterministic relative outputs,
no absolute mutable draft paths/time/random IDs. Manifest lists every output hash;
its own digest is external. Renderer implementation digest must include the actual
shipped implementation/dependency closure, not just a version label. Static state
is always UNAPPROVED-at-generation. Preserve older deliveries and reject
same-identity/different-bytes conflicts.

Stage all verified outputs privately; no-replace publish only the complete
inventory. Reuse descriptor-confined file and exact own-inode cleanup patterns;
do not reuse `AdvisoryFiles.file` overwrite behavior as atomic package publication.
Original pending identity survives interruption. Current package input limits stay
unchanged; proposed delivery ceiling 64MiB/30s needs actual accepted worst-case
measurement. Worker deadline/output accounting must abort without advertised
partial files. No current measurement of a future renderer is claimed.

Candidate open request contains ONLY delivery digest. Authenticated owner derives
and re-verifies native path/output hashes/inodes/allowlisted entry, writes original
opening intent, then uses a fixed packaged local launcher with bounded child and
cleanup tracking. No xdg-open, shell, arbitrary application or managed-browser
permission fallback. Existing AXI headless/general-purpose browser does not prove
this narrower human-visible port exists. **Exact launcher, display/network
confinement, ownership and cleanup implementation remain review/packaging choices;
there is currently no selected trusted launcher for this contract.**

Opening states: unavailable/failed/cancelled/uncertain/open-requested. Independent
viewing evidence is separate; launch exit/navigation does not establish viewing.
Unknown child/cleanup reconciles original identity before another launch. An
explicit full-source fallback permits a particular review, not opener acceptance.

## 6. Composition and message boundaries

P4 must load the actual selected process/aid/objective/dispatch/completion closure
through the retained resource owner. Missing/unverified completion is an explicit
compatibility blocker on the new route, not hardcoded current-policy substitution.
Compare whole normalized bodies in composition tests, including retained/omitted
capability negatives and unchanged producer hashes. Fix ordinary-tool prose only
for the explicitly selected policy; no generic Git/source rights.

No public diagnostic or CLI output changes in this P1 patch. Future changed paths:
native presentation/opening/branch result adapters and primer completion. Before:
inspection-only capability and separate companions, observation not performed.
Proposed after, only with proven owner facts: “Documents published. Feature ref
and ticket link verified at the reviewed base. No checkout prepared or launched.”
An opening request must say viewing is not established. Blockers use the existing
message standard's single bounded five-label envelope, typed causes and pure
formatting, with separate NO_COLOR/adapter/machine/side-effect/readability checks.

## 7. Evidence, remaining phases and reviewer decision

Focused entrypoints for this candidate:

```sh
corepack pnpm --filter @pa-platform/pa-core typecheck
node --import=tsx --test packages/pa-core/src/__tests__/document-handoff-contract.test.ts packages/pa-core/src/__tests__/document-presentation.test.ts packages/pa-core/src/__tests__/document-branch-interface.test.ts
```

Initial new run: typecheck passed; tests 9/10 passed. Reproduction compared two
normalized fixture reads whose missing timestamps default to different current
times. Corrected the assertion to compare raw ticket file bytes (stronger write
preservation evidence); no production normalizer change or weakened field subset.
Final rerun: core typecheck exit 0; focused suites **10/10 passed**, zero failures,
skips or cancellations; `git diff --check` exit 0. Staged secrets-scan outcome is
recorded with the commit report.

These are structural/source-fixture results, not independent security review or
software acceptance. P2 real owner/process race/crash/revocation/zero-resource tests,
P3 full reader/opener/security/budget/browser checks, P4 composition, P5 complete
repository/PAPC lanes/review/hosted CI, and P6 installed/default-entry/foreground
prompt counts/browser/accessibility/TS1–18/human adoption remain unperformed.
No installed qualifier is newly asserted by dormant parsers.

The operator selected **Arrange an independent reviewer** in this deployment.
Configured `requirements/review-auto` is an authenticated-candidate protected
review route; it requires an exact committed candidate, approved raw validation
matrix, durable approval evidence and one-use review authorization. Those
bindings are not provided by this planning/content-only ticket or that general
reviewer-selection answer. No reviewer was launched and no alternate role was
used to bypass admission. Prepare/review those exact bindings with the operator;
source tests are not a substitute.

Independent reviewer must decide the actual native event/selection consumer,
complete-ticket association/lifecycle/ref owner, compatible lock hierarchy,
Git/ref correlation/durability, renderer closure/budgets/publication and fixed
opener/cleanup boundary before enablement. An operator choosing a reviewer is not
itself that independent review. Material changed effect choices return through
applicable exact review. Until these gates are resolved, retain the candidate
inactive and report P1/P2–P6 incomplete rather than claiming all phases done.
