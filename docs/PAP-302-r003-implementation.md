# PAP-302 r003 — shortlist and explicit-choice implementation

## Current requirements and retained lineage

The current primary is `pap-302-auto-waitlist/r003/requirements.md` in the
requirements artifacts for PAP-302, with full `brief.md` and `uat.md` companions.
All three were read in this implementation session, together with d-668039's
`r003/continuity.md`, the published decision tracking attachment and the ticket's
primary-reference readback. Package subject:
`9befd660a27ccf209f2e130ffd98a341a5167813bc6c9ebd8bcbebefc866ba2c`.
The requirements handoff records native publish-only decision
`decision-22911cb7-7685-4cab-8a5d-0854767621cd`, publication
`effect-6bf693bab70ade09d9b0ba92da967c18465d7f1c23d619d29f686e26c31dfbed`,
journal revision 13 and no pending publication effects. The JSON attachment is
tracking, not an imported authority receipt. Publication is not policy adoption,
selection, source custody, launch, activation or product acceptance.

Work stays on the retained `feature/PAP-302-auto-waitlist` checkout. No new
branch/reset/rebase, canonical checkout repair, ticket metadata rewrite or PAPC
activation is part of this step. The requirements owner's advanced branch
readback remains a separate original-owner reconciliation obligation before any
future protected launch. Safe authorized source work does not grant that launch.

## r002 → r003 disposition

| Area | Superseded r002 direction | Current r003 direction |
| --- | --- | --- |
| Reasoning output | One automatic pick or no-pick | Saved advisory shortlist of 0–10; no filler and no selected ticket |
| Human interaction | Inspect automatic pick | Explicitly choose one stable shortlisted ID, including a non-top ID, or Cancel |
| Coverage | Full eligible metadata assessed | Still full coverage; distinguish eligible-but-not-shortlisted from excluded |
| Freshness | Reobserve before automatic finalization | Exact immutable view/version/hash, expiry no later than next refresh, immediate material recheck and native CAS before accepting human choice |
| Following choice | Delegated continuation | Draft/reuse, then admitted local work without routine second requirements/start approval; actual native adoption/admission still required |
| Idle periodic wake | Could choose new work | Scan/reason/refresh/notify only; never choose/draft/implement |
| Selected periodic wake | Continue selected work | Only the ORIGINAL explicitly chosen item, with current policy/intent/deadline/admission; no replacement on refresh or unknown launch |
| Draft quarantine | Explicit narrow move-on | Same fences/cap/evidence; DIFFERENT next ticket additionally needs a NEW explicit human choice |
| Final review/manual history | Human hold and retained receipts | Unchanged; no automatic integration, remote effects, done, return or UAT sign-off |

Accepted r002 changes retained in r003: own unsigned nonprimary draft document
refs/comments only, instruction-based repository-write prohibition rather than a
claimed OS sandbox/CPU quota, and exceptional operator-only draft quarantine.
The real-draft HOLD in `315518c` remains until an actual supported replacement
producer/limits/recovery owner is implemented and tested; this step does not
silently remove it. Implementation uncertainty is never draft move-on.

## Initial source component — unsigned contracts, not native owners

`packages/pa-core/src/auto/shortlist-report.ts` adds three INTERNAL schemas:

- `pa-auto-shortlist-assessment/v1`: model-authored explanations bound to
  caller-supplied session, full scan, goal, policy and configuration hashes.
  Exactly one disposition/rationale per eligible PAP/PAPC ID is required across
  all pages. Ordered recommendations contain goal alignment, bounded outcome,
  stage/next route, alternatives, risks/dependencies and plausible verification.
  Shortlist and dispositions must agree exactly, with 0–10 unique eligible IDs.
  Ranking is explanatory/advisory. There is no `selected`, `approved`, `started`,
  actor or accepted-outcome field. Zero recommendations remains valid even with
  eligible candidates; the report must explain suitability rather than pad.
- `pa-auto-shortlist-view/v1`: prospective immutable view bytes containing the
  assessment and version/scan-completion/generation/expiry timestamps. This is
  a request-validation input, NOT an implemented native publication or full
  session-report format. Its raw bytes are hashed externally; no self-hash.
- `pa-auto-shortlist-choice-request/v1`: original operation ID, exact view
  version/hash and an explicit stable ticket ID. The pure validator refuses
  non-shortlisted IDs, changed view bytes/order, drift against supplied current
  observations, future/expired views and expiry beyond scan completion + 30
  minutes. Earlier expiry is supported and required if the actual next refresh
  or another owner bound is earlier. Cancel/default/timeout creates NO request.

No parser authenticates its caller context, proves a real PPA session or human
interaction, creates a policy, saves/accepts a selection, reserves a slot or
launches work. A valid choice request remains REQUEST DATA. An imported request
cannot be consumed as human-choice evidence. The future native owner must read
its own immutable view, authenticate actual explicit CLI input and reobserve
material facts/owners under CAS; recovery must reconcile the SAME request and
its outcome, never repeat an unknown interaction or substitute another ticket.
The maximum timestamp interval is a syntactic ceiling, not proof that the
scheduled refresh, adopted policy, goals or ownership remain valid.

Declared coverage does not prove the model actually assessed the input. Text
shape does not prove privacy, factual stage/route, goal quality, useful reasoning
or feasible checks. Full session/request/config/provider/resources/time/cleanup
provenance, safe goal references, complete scan/exclusion locators, immutable
native publication/readback, persistence, original choice evidence and actual
current policy/custody/admission are still required. Limits here are 1 MiB per
assessment/view and 64 KiB per choice request; canonical bounded single-line
fields, strict UTF-8/duplicate-key/depth checks and 20,000 eligible-ID ceiling are
fail-closed. Oversized complete coverage is incomplete, never a top-N fallback.
The complete native report may need a different reviewed storage contract; do
not promote this partial unsigned assessment into that report.

The old `selection-report.ts` r002 assessment is retained without changing its
schema or accepted historical data. It remains unexported from the public
package index and unconnected to CLI/session/launch. Its `selected` field is
never r003 human-choice evidence. Manual v1 coordinator, timer, receipts and
foreground start behavior are unchanged; no generic auto-draft route is added.

## Validation and message scope

Initial focused parser run: 18/18 passed, zero skips/failures (14 new r003 cases
plus four retained r002 cases), and core typecheck passed. These cover counts,
all-page declared coverage, membership/cap/disposition, source identity, strict
bytes/prose bounds, non-top request data, missing/default/imported choice fields,
exact-view hashes/order, expiry/calendar/drift and no substitute ticket.
Initial logs: `/tmp/pap302-r003-contract-tests.log` and
`/tmp/pap302-r003-core-typecheck.log`. Final contract renewal also passed 18/18
(`/tmp/pap302-r003-contract-final.log`), including Unicode line/paragraph
separators and exact/over-limit byte boundaries.

Current broader checks (all exit 0 unless explicitly stated):

| Check | Actual result / log |
| --- | --- |
| Core auto + interactions | 91/91, no failures/skips; `/tmp/pap302-r003-core-final.log` |
| Pi auto regression | 30/30, no failures/skips; `/tmp/pap302-r003-pi.log`; retained v1/simulated owners, not a live r003 session |
| Workspace typecheck | Passed; `/tmp/pap302-r003-typecheck-final.log` |
| Workspace build | Passed; `/tmp/pap302-r003-build.log` |
| Completions | Passed; `/tmp/pap302-r003-completions.log`; generated files unchanged |
| Staged secrets scan / whitespace | Passed; `/tmp/pap302-r003-secrets.log` and `git diff --cached --check` |
| Full core suite | **INCOMPLETE: 300-second timeout**, last top-level result 1541, no final summary; 14 external-config fixture skips observed, not passes; `/tmp/pap302-r003-core-full.log` |

The full-core timeout is a new retained unsuccessful attempt, not a pass or a
complete regression result. No workspace-wide full test/hosted/installed/pair
qualification is claimed. Focused SQLite fixtures used the existing installed
Node 22 native addon as a dependency, not candidate-installed runtime evidence.
Historical incomplete/full-suite timeouts remain historical. Source fixtures
are not independent/installed/provider/human qualification. All r003 TS-1–TS-16
remain Not run until their actual UAT owners execute them.

No human-facing CLI messages, JSON CLI/exit/stream contracts or completions are
changed. Before/after message behavior is therefore unchanged: current manual
v1 surfaces still show the manual waitlist, not the new r003 shortlist. The new
module only raises existing bounded `AUTO_SOURCE` internally and is not wired
to a public wrapper. Future native shortlist/choice/timer/final-review messages
must apply `docs/cli-message-standard.md` with their own before/after inventory,
real CLI propagation, structural checks and separate human-readability review.

## Native registry coordination phase

`auto/shortlist-journal.ts` now implements the registry-owned pre-ticket cycle,
complete scan/goal/request/raw-output/report snapshots, original producer claim,
report-before-publication ordering, immutable shortlist history and atomic head
refresh. A separate original native choice interaction is claimed before UI,
its captured evidence is saved before mutable selection checks, and one item is
created under SQLite CAS. The choice is coordination intent, never a start or
policy grant. Trusted adapter callbacks must authenticate actual sources/session
proof and human input; source fixtures simulate those callbacks, not real humans.

Registry schema 20 adds immutable byte/event/report tables and cross-owner SQL
slot guards. Manual item selection and held states exclude reasoning; reasoning
or unknown cleanup excludes manual/new selection. A waiting shortlist owns no
ticket. Refresh while an old view is open causes the original choice to be
refused, not translated. Cancel has no item/effects. Requested/unknown capture
cannot be reprompted; observed evidence can finish the SAME interrupted CAS.
Accepted selection reply loss reuses its original item. No code infers process
settlement from missing PID/reply. Producer proof is mandatory, not model flags.

The new exports expose typed owners/data only, not CLI/tool dispatch. Inventory
reconciliation covers that export, schema-20 storage and manual selection's new
shared-slot guard; the two shortlist modules are newly tracked. Existing CLI,
OPA, manual receipts and observational tick keep their grammars/effects. No
service/config enablement, native adoption or live session follows from migration.

Actual checks: core auto/registry/interactions **138/138**, Pi auto/native-host
**51/51**, workspace typecheck and core build passed; no skips in focused runs.
Logs: `/tmp/pap302-r003-coordination-{core-final,pi,typecheck,build}.log`.
Initial failures are retained: null-prototype strict JSON needed normalization
before comparing native data, typed boundary errors needed preservation, and a
multiprocess choice fixture needed the ORIGINAL persisted scan identity rather
than a newly randomized fixture snapshot. The interaction source guard initially
refused changed exports; hashes were renewed only after the boundary review and
negative/race tests. This is implementer/source evidence, not independent review.
The earlier full-suite timeout remains unresolved, not converted into a pass.

Tests include genuine OS-process races for reasoning versus manual selection and
for two explicit native-choice fixture hosts; full report preservation; zero,
non-top and stale/expired/foreign choices; source/config/policy drift; refresh
while a view is open; invalid raw-output retention; session-bound limits;
immutable history; lost capture reply; interrupted final CAS and same-request
recovery. Production adapter/provider/CLI integration remains the next phase.

## Remaining dependency-ordered implementation

1. **R0/R1:** agree exact PAPC/native session/report/publication/choice contracts
   through their owners; one durable pre-ticket reasoning reservation across the
   same manual/delegated domain; actual registered bounded PPA session; complete
   evidence/report store and atomic shortlist refresh. Then genuine explicit
   CLI selection with fresh native facts/CAS and original-request recovery.
2. **R2:** actual instruction-only bounded draft producer, useful complete
   requirements/UAT/matrix or safe reuse, own unsigned append-only ticket owner,
   artifact/generation/CAS fences, ordinary-process uncertainty and recovery.
3. **R3:** genuine exact foreground policy adoption/revocation/expiry and
   immutable original-human-selection-bound intent; native document/lifecycle/
   repository/preparation/launcher bridges, no fabricated human content/start
   receipt and zero routine second per-ticket approvals under valid delegation.
4. **R4:** operator-only narrow draft quarantine, one unresolved quarantine cap,
   late-effect fences and a NEW human choice for a different item; final-review
   hold/disposition; separately versioned state-aware periodic effects. Retained
   observational v1 tick cannot acquire launch authority.
5. **R5:** complete feasible regression, independent review, hosted CI, exact
   runtime/PAPC/resources/installed pairing, actual PPA/provider/CLI-choice and
   delegated-worker canaries in both projects, desktop observation and human
   UAT/adoption, with separately authorized activation afterward.

PAPC-086 owns pairing/configuration. Its effective v1 contract stays disabled;
no runtime commit, document publication, new schema or config flag adopts policy
or enables services. No real shortlist, human selection, provider/worker, desktop
request, timer installation or activation was performed by this source step.
