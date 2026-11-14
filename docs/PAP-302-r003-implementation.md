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

## R1 adapter/source integration

The new **additive** `ppa auto shortlist` route now has a native producer source
implementation, native unmanaged-terminal selection adapter and existing-only
report reader. Retained manual items and v1 tick/start keep their semantics;
bare `ppa auto` now routes durable r003-owned state only to its original owner.
This route is not yet the full delegated product: after recording a choice it
fails closed at the missing native delegated-continuation owner, retaining that
original item rather than prompting for old per-ticket start approval or using
manual deploy. The separately owned PAPC selection is absent/default-off; no live
provider or human-selection journey was run in this implementation session.

### Explicit observation-only pairing

`auto-shortlist-contract.ts` consumes NEW committed
`contracts/auto-shortlist-v1.json`, schema `pa-auto-shortlist-pair/v1`. Required
keys are exactly `schemaVersion`, `enabled`, `mode`, `resources`, `timezone` and
`goalSources`. Missing/disabled/dirty/unknown schemas refuse, without widening
`pa-auto-pair/v1`. `mode` is one explicit native-only `auto-reasoning` or
`auto-reasoning-*` requirements mode, with configured provider/model and a pinned
objective; no document profile/generic deployment is substituted. Resources and
team/objective bytes belong to the committed closure. `timezone` is explicit;
up to four unique goal sources each require `pathTemplate`, `dateFormat` and
`heading`. Only a relative `daily/...{date}....md` template is supported;
`dateFormat` is `iso` or `underscore`. These are runtime schema requirements, not
an edit/enablement of the external configuration.

The goal owner refreshes the current configured date and extracts exactly one
selected heading per source AFTER whole-file source-policy validation. It
retains relevant excerpts plus source/date/hash, not diary/reflection dumps.
Absent/duplicate/oversized/denied sections block rather than invent a goal.
The context's `policySha256` here binds the **observation scope**, not an adopted
implementation policy. It cannot be consumed as delegation evidence. Final
runtime/config/resource pins and joint PAPC qualification remain separate.

### Native producer and recovery

`auto-reasoning.ts` registers original requirements/Pi producer events, persists
request/raw responses/process incarnation/result evidence, assesses all eligible
metadata and saves the full immutable report before publication. Native finite
read/list requests reuse the existing source owner; denied reads return one
bounded unavailable result, not a retry/bypass path. Limits: 10-minute original
cycle deadline, at most 32 source requests, 128 KiB/file, 1 MiB context/prompt/
response. Scanner rechecks can now use a stricter remaining timeout, never raise
the retained 120-second scanner maximum. Publication refuses an expired original
cycle; native known-complete failed/stale output is retained as failed, while
unknown process/selection effects keep their original coordination.

`auto-producer-process.ts` uses supported ordinary Pi authentication, tool-less
no-extension/MCP/skill/context/session-discovery flags and stdin prompts. It does
not extract credentials. Every request has a saved native fingerprint before
stdin. A dedicated process group is observed; normal known completion differs
from timeout/oversize/unknown group cleanup. Destroyed pipes or killing a parent
never proves descendant settlement. No OS filesystem sandbox, CPU quota or
hostile/escaped-descendant guarantee is claimed. The native report explicitly
records `cleanupScope: observed-process-group-no-escaped-descendant-guarantee`;
`cleanup: settled` must not be read as a stronger whole-tree guarantee.
Bounded stderr byte counts and
exit/signal evidence are retained; full stderr content is not published. Captured
stdout bytes, including invalid UTF-8, can be preserved exactly through the
existing lower file owner; its path/symlink/size/write boundaries are unchanged.
Repository/Git writing is forbidden by instruction and no tools are exposed;
real-provider before/after and cleanup qualification remains unperformed.

Completed/uncertain work reconciles the original cycle and saved process/report
identities; it never creates a replacement because a reply/PID is missing.
Atomic original publication is read back before failure/recovery. A failed newer
refresh makes the last complete view stale for selection, but preserves all its
bytes/history. Human choice cannot be replaced by a rank, an empty/default
response, a timer, a machine flag or a freshly changed view.

### CLI/message paths and checks

New read grammar: `ppa auto shortlist --json [--view UUID] [--section
candidates|excluded|all] [--page N]`; 100 original-snapshot rows/page, immutable
view selection, complete report/coverage plus original cycle/choice/item state.
Readers never initialize/migrate/scan/request a provider. `time-current` is only
the timestamp window; material authority/source freshness is explicitly not
rechecked by inspection. Noninteractive input can never choose. Interactive
human selection is one native choice; Cancel records no item, and a valid choice
immediately calls only its actual continuation port, with no routine second
per-ticket approval. A missing port is a blocker, not permission to fabricate one.

Touched categories and actual examples (source behavior, not installed output):

| Path/category | Before | After |
| --- | --- | --- |
| Help/completions | Manual waitlist routes only; misleading read-only umbrella comment | Add native shortlist route and exact-view inspection; no choice/approval flags |
| New saved-report information | No r003 surface | `Shortlist saved: 10 suitable tickets. No ticket selected.` plus exact view/report/session/source hashes and individual rationale |
| New choice progress | No r003 surface | `Selected PAP-…; original choice …` followed by native policy/admission-next wording, not worker success |
| Cancel | No r003 surface | `Ticket choice cancelled. No item was selected; recommendations remain available.` |
| New blockers | No r003 surface | Outcome-first static five-label diagnostic, current typed cause, original-evidence preservation and supported read-only inspection; <=2000 UTF-16 units |
| Generic requirements/auto-reasoning | Could otherwise resolve as an ordinary mode | `Reasoning session not started: this mode cannot run through ordinary deployment.` before repository/planning/allocation |

The new reader has its own result schema; old JSON/exits/streams are unchanged.
Formatting introduces no probes/effects. Returned and thrown wrapper paths,
actual noninteractive CLI subprocess propagation, label uniqueness/length,
source/read/launch classifications, and direct/default/force/background Pi/OPA
mode negatives are tested. Human comprehension/installed usability is NOT tested.
Inventory hashes were renewed after these effect/alias/owner changes and their
negative tests, with no native/delegation bindings invented by discovery.

Current focused results: core auto/execution-plan/registry/interactions/lower-file
integrity **159/159**, Pi auto/native-host **67/67**, OPA adapter **94 passed,
1 external fixture skip**, zero failures. Workspace typecheck/build/completions
passed. Logs: `/tmp/pap302-r003-r1-{core-final,pi-final,opa-final,typecheck-final,build-final}.log` and
`/tmp/pap302-r003-reasoning-completions.log`. The Pi total includes 16 new cases:
composed native registry with SIMULATED provider/process proof, one native-choice
fixture and continuation spy, actual noninteractive CLI, finite source requests,
failed-refresh retention, scope/goal negatives, raw-byte evidence and actual
Node stdin/group/timeout fixtures. These are NOT real Pi/provider/human canaries.
Initial syntax/type errors and readback failures from testing concurrently with
a dependency rebuild are retained; final checks rebuilt first, then tested.
The earlier full-core timeout and all independent/hosted/installed/human gates
remain open. No PAPC source/flags, live timer, adoption, provider or worker changed.

## R2 ticket-owner foundation and mode barrier

`TicketStore.appendAutoDraftWithIntent` is now a finite **data-owner primitive**,
not a registered native tool, policy grant or completed draft producer. The
strict `pa-auto-draft-ticket-append/v1` request accepts only exact PAP/PAPC ticket,
item/generation/deployment/original-request IDs, complete normalized ticket CAS,
1–3 own brief/requirements/UAT paths/hashes and a bounded comment. No actor,
planning/status/assignment/tag/blocker/primary/Git/approval/imported outcome fields
are accepted. Actor is derived as `requirements/auto-draft`; added refs are always
nonprimary and the appended comment explicitly says agent-authored UNAPPROVED.
Existing primary refs, comments/history and all protected fields are preserved.

Mandatory synchronous native caller/generation/policy and own-artifact checks run
inside the existing ticket mutex before intent/ticket/audit effects and final
readback. Callback copies cannot mutate the original candidate. These callbacks
must be supplied by the future genuine native policy/producer port; an empty test
callback is not admission. There is NO CLI flag or model-authored grant for them.
The original immutable `.ticket-auto-draft-<digest>.json` is ticket-owner
idempotency data only, not a second permission ledger. It binds the full original
request/candidate before writes, shares the ordinary audit owner, and recovers
one original update/comment/ref set after reply loss. Pending same-ticket appends
block fresh IDs; intervening human work, unknown markers, corruption, aliases,
unsupported extra raw fields and torn audit refuse without normalization,
rollback, overwrite or evidence deletion. Completed replay returns current work
and its original applied version without reverting later human changes.

The native quarantine owner may inspect `pendingAutoDraftAppends`, but cannot
mistake a missing process/reply for settled appends. Actual fencing/quarantine
and the native draft/policy adapter remain unimplemented. This primitive adds no
live ticket changes in this implementation session, no primary promotion or
publication/queue/launch bridge, and does not remove the retained real-draft HOLD.

The manual foreground now checks native reasoning/choice/item correlation before
opening its old selection/start UI. Durable r003-owned work resumes through its
own owner instead of translating into manual v1 content/start receipts. Before:
an r003-held item could reach `Review exact implementation start` in the manual
menu. After: the original shortlist controller owns it, with no repeated choice,
manual start prompt, replacement producer or fabricated grant. Existing manual
items retain their prior path. The same already-tested bounded shortlist blocker
propagates if its native continuation owner is missing. No new wording formatter
or native tool/machine schema is introduced by this barrier.

Current checks: **206/206** core auto/all-ticket/document-service/registry/
interaction/execution/lower-file integrity tests; **67/67** Pi auto/native-host;
workspace typecheck/build passed. Logs:
`/tmp/pap302-r003-r2-owner-{core,pi,typecheck,build}.log`. Ten new append-owner
cases cover protected-field preservation, original intent/ticket/audit faults,
stale/concurrent changes, fresh-ID refusal, strict/malformed/foreign fields,
native generation/artifact/async negatives, callback mutation, late-generation
fencing, unsafe sources/records/audit and real two-process same-intent writes.
Native CLI tests additionally prove bare auto does not reopen a manual start for
the r003 original. These are source/fixture checks, not genuine policy adoption,
real provider usefulness, installed qualification or human UAT. Initial 30-case
append/create/planning run passed; no old failure/skip/timeout is erased.

## R2 bounded draft generation and producer source

Registry **21** adds immutable draft request/response/source snapshots, generation
revision chains and pre-provider claimed/anchored/observed turns. Every generation
binds the ORIGINAL accepted human choice, item, draft operation/deployment, full
ticket version and an exact policy reference. References are correlation, not
permission: the mandatory native host must authenticate and reauthorize each
effect against the actual current policy. Asynchronous callbacks, changed copies
of deadlines/state, expired checks and unknown original turns cannot grant
continuation. Historical original responses can still be recorded after
revocation, without authorizing any follow-on write. Unknown states coalesce and
retain their slot; no PID/reply-absence or replacement-producer recovery exists.

`auto-delegated-draft.ts` supplies the finite Pi producer/package/append adapter.
It requires an actual native `PiAutoDraftAuthority`; there is deliberately NO
permissive production implementation or CLI-supplied grant. It uses the existing
instruction-only, tool-less Pi process driver with ordinary authentication and
observed-group cleanup limits. Native preparation records the actual registered
repository configuration, Git observation, check profile, original ticket and
document-journal prefix. Those are checked again before protected transitions.
Previously read/listed sources are rechecked through the same source owner,
including changed content on already-dirty paths. Unread/ignored file bodies are
not comprehensively fingerprinted; Git status is not a filesystem-write sandbox.
The original 30-minute ceiling includes preparation, is capped by policy expiry,
and also retains a native boot/monotonic-clock anchor across controller restarts.
Boot changes, clock reversal and deadline expiry hold; a restart cannot reset the
budget. There are at most 32 native source reads/lists (128 KiB/file) and 1 MiB
context/prompt/response ceilings. These are cooperative native admission/driver
bounds, NOT an OS filesystem sandbox, CPU quota or escaped-descendant guarantee.
Registry liveness names the producer controller; each actual Pi child incarnation
and observed group result is separately preserved in the immutable turn log.

The producer requests complete unsigned brief/requirements/UAT plus a
material-questions member, rather than collapsed feature summaries. Without material
questions, FR/NFR/AC/TS identifiers and TS-to-UAT coverage are structurally required;
a finite validation matrix must match the native repository/branch/base and actual
registered checks, and requirements must declare finite source scope. Shape checks
cannot establish semantic usefulness, feasibility or human UAT.
Raw invalid/failed output remains evidence and holds the original item. Material
questions save their own complete draft evidence but block implementation.

The complete deterministic bundle is saved BEFORE own artifacts, freeze or
append. Own files use exclusive creation, fsync and exact-byte replay; conflicting
or partial bytes refuse without overwrite. Native package freeze and generation
CAS share SQLite ownership. The original append request is then saved before the
existing ticket mutex/intent/audit owner is entered. Exact native generation,
policy, own-member hashes and ticket CAS are rechecked there. Read-only
`observeAutoDraftAppend` distinguishes absent/intent/ticket/completed/conflict
without repair or a cleanup claim. Reply loss after output, artifact, freeze,
append or finish reuses the SAME producer, bundle, package and append request.
Foreign ticket/repository/document work is retained and causes a hold, not reset,
substitution or primary-reference rewriting. Completion still issues NO human
content/start receipt, queue effect, source custody or implementation launch.

NEW consumer proposal `contracts/auto-delegated-v1.json` has exact keys
`schemaVersion,enabled,draftMode,policySource,resources`, schema
`pa-auto-delegated-pair/v1`. It requires an explicit committed requirements
`auto-draft-delegated`/suffixed mode, builder `orchestrator`, explicit Pi models,
pinned instructions/resources and bounded policy-source bytes. It is NOT an
agreed external PAPC contract, native policy adoption or activation. Unsupported
extra CPU/sandbox settings, missing/disabled/dirty pairing and ordinary mode
substitution fail closed. Generic `auto-draft-*` reservation and the released v1
real-draft HOLD remain unchanged. R003 continuation is still held until its real
policy/admission owner is implemented and connected; safe existing-package reuse
belongs to that native bridge, not to a fabricated manual receipt.

Message/reader changes are additive source behavior, not installed evidence:

| Path/category | Before | After |
| --- | --- | --- |
| New producer success | No supported r003 draft producer | `Own unsigned draft package and nonprimary ticket evidence saved; delegated admission remains separate.` |
| New material-question limitation | No r003 producer outcome | `Own unsigned draft evidence saved with material questions; implementation remains held.` |
| New known-failed producer blocker | No r003 producer outcome | `Draft preparation did not produce a complete unsigned package.` plus exactly Condition/Source/Reason/Correction/Resume Action; supported read-only inspection and owner reconciliation, no blind restart |
| Existing-only shortlist JSON | Original item/effect IDs | Adds `draftGeneration` metadata/hashes, never raw request/output bodies or a permission grant; still no initialization/provider/choice/effects |

The blocker is static, <=2000 UTF-16 units, contains no exception/model text, and
explains inspection versus owner repair and re-admission. Registry propagation
and label/length/safe-text assertions passed; independent human readability and
installed propagation remain unperformed. No old JSON schema, manual receipt,
exit/stream or OPA capability was reinterpreted. Interaction inventory renewal
covers the new private adapter/data owners, schema/export and read-only field;
no discoverable native permission binding was added.

Actual focused checks: **215/215 core**, **80/80 Pi**, zero focused skips or
failures; workspace typecheck/build, staged secrets scan and whitespace checks
passed (secrets log: `/tmp/pap302-r003-r2-generation-secrets.log`). Logs:
`/tmp/pap302-r003-r2-generation-{core,pi,typecheck,build}-renewed.log`.
The additional 9 core and 13 Pi cases cover claims/incarnations, revoked/expired/
changed authorization, async callback rejection, immutable history, complete
package and append replay at five fault stages, 32-source ceiling, unknown
cleanup/no respawn, protected ticket preservation, drift and strict pairing.
Composed policy/human/provider callbacks are SIMULATED; actual native Git reads
and retained multiprocess append fixtures do not qualify a real provider, native
adoption or installed pairing. Earlier syntax/type/fixture-time failures remain
in `/tmp/pap302-r003-r2-producer-*` logs; later passing reruns do not erase them.
Full regression timeouts, independent review, C0/PAPC agreement, actual policy
adoption/implementation, both-project canaries, desktop delivery and r003 UAT
remain open. No live provider, ticket, configuration or service was changed.

### R3 authority-owner readback before extension

Current source inspection reconfirms two boundaries, not new authority:
`documents/auto-start.ts` owns the retained per-ticket human full-review/start
receipt; `pi-pa/prepared-native.ts` owns optional prepared automation with exact
installed runtime/config qualification and genuinely promoted human-approved
sources. Neither is the r003 policy owner, and neither its policy nor its
qualification/promotion records may be reinterpreted as r003 delegation. R3 must
extend genuine native authority with a distinct exact scope and original-review
recovery, rather than issue old receipts from an agent callback or use a parallel
model-authored permission store. Genuine adoption itself must remain distinct
from qualification, effect controls, canary admission and service activation.

PAPC-086 readback still records an administratively completed, default-disabled
**v1** delivery at `813cd53`; no later acceptance of the r003 proposal was found.
Do not reopen/rewrite that ticket or treat its done state as r003 agreement. A
separately admitted configuration/requirements-owner successor is now **PAPC-087**.
Sinh explicitly requested its creation and separately confirmed feature / medium /
provisional L / sinh / idea. Installed native ticket creation returned PAPC-087;
full readback verified the project, metadata and empty document/branch/commit
links. Native sanitization removed semicolons, so its first comment separately
clarifies each finite limit. PAP-302 and PAPC-086 contain reciprocal tracking
comments. PAPC-086 stays done. Creation is not C0 agreement, requirements approval,
checkout/deployment allocation or activation. Independent default-off source work is not blocked merely by that absent pair;
actual adoption/launch/installed qualification remains dependent on its owners.

Follow-up review also corrected a test call: `readAutoShortlistStatus` takes an
optional query, NOT a database handle. The composed draft test now calls the
actual existing-only API, opening its disposable registry through the native
reader. This changes no production behavior or machine contract. Renewed Pi
**80/80** and Pi/core typecheck passed; logs:
`/tmp/pap302-r003-r2-reader-api-{pi,typecheck}.log`. Staged secrets/whitespace
checks were also renewed; no new full/installed/human result is claimed.

## R3 native global-policy decision component

This source phase extends **RegistryDocumentJournal**, the existing native
SQLite document-decision owner, with a DISTINCT global policy scope. Registry
**22** adds immutable `document_auto_policy_events` and
`document_auto_policy_captures`; actual subject/capture bytes use the EXISTING
immutable `document_snapshots` owner. No model-owned permission file, imported
receipt, per-ticket human confirmation or old prepared-native activation is
converted into delegation. All old document/manual/v1 and OPA meanings remain.

`documents/auto-policy-contract.ts` defines closed unsigned proposals and native
subjects. `pa-auto-delegation-definition/v1` has exact keys
`schemaVersion,lifetimeSeconds,repositories`. Lifetime is 60..86400 seconds. Both
registered project keys are required, each with finite `sourceScope` and unique
registered `checkIds`. Actual roots/repository configuration/check profiles,
commands, Pi reasoning/draft/builder roles, objective source paths/hashes,
configuration/resources, installed identity and goal rules are resolved by the
native producer, not copied from caller claims. The native
`pa-auto-delegation-policy/v1` subject binds these, the UID/data-root/registry
domain, fixed supported initial bounds, local/excluded effects, honest
instruction-only/observed-group restrictions, final human review, original
UTC expiry and boot/monotonic-clock anchor. Unknown keys, unsupported bounds,
old schemas and extra approval/actor flags refuse. No proposal is adoption.

`AutoDelegationPolicyService` separates original request, raw actual capture,
validated observation and issuance. Requests are claimed BEFORE opening UI.
Actual raw capture is saved BEFORE mutable checks/issuance, including invalid or
late bytes. Missing capture is UNKNOWN and cannot reprompt; saved capture or
observation can reconcile the SAME original decision under fresh native caller
and current facts. Issued reply loss reuses that decision while still current.
History, captures, policy IDs, interactions and issuance are immutable/unique;
readers validate hash chains, semantic phase ancestry and exact capture bindings.
A previously reviewed subject/ID cannot be silently reactivated. New material
policy scope/lifetime requires a new exact native review, never a restart reset.

Pending permission review conservatively holds eligibility. Revocation remains
available after source drift or expiry and never asserts process death/cleanup.
`withdraw` is an EXPLICIT exceptional operator decision about the original
unresolved POLICY REVIEW, not draft quarantine, ticket closure or execution
custody release. It preserves evidence and fences late original issuance. It can
remove a conservative review hold on a still-valid older policy; the UI discloses
that consequence. Cancel retains the unresolved original. Unknown withdrawal
attempts remain history; no old permission interaction is reprompted. Protected
work uncertainty is not settled by any policy operation.

The native Pi source adapter uses existing unmanaged-origin/controlling-terminal
checks and displays the entire exact policy before one default-Cancel choice.
Production identity must come from the executing immutable Nix installation and
its package/provenance, never PA_* source/version flags or a local checkout.
Those identity observations are NOT v1 qualification or r003 acceptance.
Reasoning/draft objective identities are explicit; implementation objective bytes
(or its team-configuration fallback) are now also in the committed resource
closure, preventing an unobserved objective-file change. The private future
continuation adapter checks the actual registry, current original item/choice,
exact immutable view, adopted-policy observation closure, goal and configuration
identities. Observation-only old shortlists cannot be upgraded by supplying a
policy hash. Draft admission now rechecks policy and generation AFTER source
reobservation too, so an intervening revocation/fence cannot claim the next turn.

**Production full-scope adoption/authorization remains HELD.** The native
factory has no supported document/lifecycle/preparation/source/check/launcher
bridge in this build; `effect-owner-bridge` refuses before issuance. A private
embedding/test callback is not that production owner or qualification. Neither
configuration flags nor this decision component may remove the hold. The actual
per-item intent, safe existing-package reuse, protected document/queue/branch/
capacity/launch transitions and final-review execution still need implementation.
No production `continueSelected` port is connected by this phase.

### CLI, interaction classification and message evidence

NEW PPA-only grammar: `ppa auto policy [status] [--json]` and native unmanaged
foreground `ppa auto policy adopt|revoke|withdraw`. No JSON mutation, actor,
outcome, yes or policy-file flags. Existing-only status never initializes,
migrates, rechecks eligibility, captures a prompt or starts work. Its new
`pa-auto-policy-status/v1` result carries original IDs/full scope/pending reviews
and explicitly separates unverified eligibility from execution/activation.
No old JSON/exit/stream contract is rewritten. Discovery classifies inspection
as read and review as operator-only WRITE, with no invented tool/delegation
binding. New PPA completions do not suggest mutation JSON/selection flags.

| Affected path/category | Before | After (source behavior) |
| --- | --- | --- |
| Policy help/information | No global r003 policy route | Exact scopes/grammar and read-only status, with eligibility explicitly not rechecked |
| Native policy result | No r003 issuer | `Native policy adopt: approved/cancelled` with ORIGINAL review/decision/subject IDs. No item/provider/worker/service effect is claimed. Positive UI fixtures are SIMULATED, not real adoption |
| Unsupported production owner | Generic missing-continuation hold only | `Automatic policy review did not complete through this request.` plus exactly Condition/Source/Reason/Correction/Resume Action and actual `effect-owner-bridge` cause |
| Unknown permission interaction | No global recovery path | Preserve original capture/request. Reconcile known evidence without another prompt or explicitly withdraw the exact original review. No blind retry/fresh worker advice |

Diagnostics are static/finite, <=2000 UTF-16 units, NO_COLOR-safe and do not
interpolate raw errors, objectives or hostile getters. Grammar, actual
noninteractive CLI propagation/no initialization, full displayed-subject hash,
label uniqueness/length and hostile input negatives were exercised. Human
comprehension, real foreground provider/human interaction and installed delivery
remain unperformed.

Actual source checks and retained failures are recorded below. New owner tests
use simulated native caller/current-scope/UI/installed facts; the multiprocess
race uses genuine OS processes/SQLite but NOT human permission. No genuine
native adoption/revocation/withdrawal, provider/worker, policy enablement,
installation, desktop request or service activation was performed here.

| Actual check | Result and evidence |
| --- | --- |
| Core auto/all-ticket/document confirmation/process/integrity/registry/interactions/execution | **261/261**, no skips/failures; `/tmp/pap302-r003-r3-policy-core-final.log` |
| Pi auto/native host | **89/89**, no skips/failures; `/tmp/pap302-r003-r3-policy-pi-final.log` |
| OPA retained adapter | **94 passed / 1 external-fixture skip**, zero failures; `/tmp/pap302-r003-r3-policy-opa-focused.log` |
| Workspace typecheck/build | Passed; `/tmp/pap302-r003-r3-policy-typecheck-final-workspace.log`, `/tmp/pap302-r003-r3-policy-build-final.log` |
| Completions | Passed; `/tmp/pap302-r003-r3-policy-completions.log`; only PPA output gained policy forms |
| Staged secrets / whitespace | Passed; `/tmp/pap302-r003-r3-policy-secrets.log` and `git diff --cached --check` |

The new cases include 12 policy-owner cases (one real two-process SQLite race),
9 Pi policy cases, and a draft late-revocation recheck. Retained document
confirmation/process tests were included explicitly. Original unsuccessful
catalogue-effect vocabulary, fixture declaration emission and original-view
linkage typechecks remain in `/tmp/pap302-r003-r3-policy-*` initial/rerun logs;
repairs did not weaken guards or erase failures. The installed Node-22 addon is
only a test dependency. Full regression timeouts, independent review, exact
installed pairing/provider/native-human trials and all r003 product UAT remain
open, not converted into passes by these focused results.

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
