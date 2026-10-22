# requirements-test-workflow/v1 — phase-1 contract

Status: **staged, inactive; native test and same-resource product admission/execution implemented; independent phase acceptance and installed qualification pending**. Owner: PAP-265, approved requirements
`2026-10-22-pap-265-requirements-tested-oracle.md`, section 13 phase 1;
approval `PAP-265#c-20261021223147279`. Audience: core contract, Pi native launcher,
capacity/custody, assertion collector and PAPC-065 consumer implementors.

## Boundary and concrete example

Q2 baseline must pass. Q1 must fail for the exact missing-retrieval assertion through
consumer T. A plausible intact-values/wrong-consumer-output input must also be
rejected by that assertion. An import failure is blocked, not intended RED. This
establishes **oracle test-readiness**, never product PASS. Independent review must
check the meaning of T, not merely the assertion's spelling. Human recipient
observation remains planned/unexecuted. Final sign-off must bind the exact oracle
before product work starts from that test HEAD in the retained ticket resource.

This is **not an OS sandbox**. Exposed-tool restrictions and complete audits cannot
contain malicious repository code or prove the absence of transient/concealed
same-user host effects. Only trusted approved code is in scope. No credential,
production/network-service, product-remediation or unrestricted shell authority is
created. Exact command matching is not semantic safety. PAPC-065 must reconcile
its stronger confinement wording before any activation.

`requirementsTestCapability(unknown)` always returns
`{enabled:false,legacyUnchanged:true,reason:"unqualified-inactive"}` without reading
its argument. This is a pure-model descriptor, not the native selection reader.
There is no CLI activation flag, environment selector, model-selected authority
root, new approval database or parallel reservation owner. Native-only foreground
selection and standalone capture are described below; they require independently
produced exact installed/pair qualification and are not exercised on a real ticket
by this implementation. Helpers are not
exported wholesale from the package index. Phase 2 selectively exports pure
parsers/replay/types for the Pi consumer; none authenticates a caller or admits effects. Existing fresh/amendment/preparation/review
contracts, OPA/CPA, auto/spike, signing/hooks, review caps and inactive PAP-254 retain
their exact meanings. A v1 packet is never translated into legacy authority.

**Pure replay is not authentication.** `assessTestWorkflow` returns
`evidenceClass:"source-model",runtimeAuthorized:false,productPass:false` even for a
perfectly self-consistent or wholly forged journal. `product-consumed` is a modeled
stage, not a launch or grant. No project/process/resource effects occur in these
helpers. A source-model is not installed proof. Do not wire effects to their output
without the later authenticated native boundary. Public comments/JSON/environment
cannot select trusted roots, confirm liveness or mint approvals.

## Serialization and primitive grammar

Each authorization or event is **one complete UTF-8 JSON object**, 1–65,536 bytes.
No BOM, invalid UTF-8, unpaired surrogate (raw or escaped), trailing document,
non-JSON numbers, duplicate decoded keys at any nesting depth, missing/unknown
field, unsupported version, or nesting deeper than 64. JSON whitespace is allowed;
raw byte identity includes it. The existing protected-review bounded JSON reader
owns duplicate/UTF-8/depth parsing; errors are reprojected without input text.
All fields below are required; optional values use explicit `null`, not omission.
Arrays preserve order; bindings compare their complete normalized typed values,
including source ref/version/digest, not digest-only or subset equality.

Notation used below:

| Type | Exact grammar/limit |
|---|---|
| text | String, 1–4096 JS code units, trimmed, no U+0000–001F/U+007F–009F |
| id | `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` |
| git | Exactly 40 lowercase hexadecimal characters |
| digest | Exactly 64 lowercase hexadecimal characters, SHA-256 of raw UTF-8/bytes |
| source | Exactly `{ref:text,version:text,sha256:digest}`; an immutable locator, NOT proof of authentication |
| rel | 1–512 code units, ASCII `[A-Za-z0-9_./-]+`; no empty, dot, dot-dot or dot-prefixed segment; no slash prefix, backslash, colon or aliases |
| cwd | `rel` or literal `.`; relative to the authenticated worktree, never the canonical parent |
| absolute | Existing `workflowPath`: absolute, normalized `resolve(path) === path`; physical registration/symlink/hardlink checks are native obligations |
| holder | Existing custody holder grammar: exactly `{deploymentId,process:{pid,startTimeTicks,bootId}}`; deployment `d-` + six lowercase hex, pid integer 1–2147483647, ticks decimal text, bootId text |
| bounds | Existing `ExecutionBounds` grammar, described below; all eight fields required |

Object key order is immaterial for parsing; arrays are not reordered. Authorization
identity and event chain links hash **original bytes**, never a reparsed JSON
rendering. Only the explicitly identified derived result/Git digest projections
below use `JSON.stringify` of the normalized typed record. These are different
identity domains and must not be interchanged. All returned parsed structures are
immutable snapshots; input bytes remain owned by the producer.

## Authorization grammar

Exactly these top-level fields:

| Field | Type/value |
|---|---|
| schemaVersion | `"requirements-test-workflow/v1"` |
| kind | `"authorization"` |
| operationId | digest; service operation identity, reused across resume, never a second materialization identity |
| repository | Repository object below |
| parent | Parent object below |
| contract, assertions | source; immutable revision/raw source hashes |
| pair | Exactly `{runtimeSha:git,configSha:git,qualification:source,toolsAuditDecision:source}` |
| approvalOwner | `"sinh"` |
| scope | `"test-only"` |
| productBehavior | `"forbidden"` |
| paths | 1–64 Path objects, unique path |
| checks | 1–64 Check objects, unique id; at least one baseline and one feature |
| humanOnly | 0–64 unique ids; mapping only, never executed/human PASS |
| bounds | ExecutionBounds |
| retryLimit | Integer 1–3 |
| retriesUsed | Integer 0–retryLimit; fresh 0, amendment retains prior replay accounting |
| elapsedMs | Integer 0–86,400,000; fresh 0, amendment retains prior service elapsed time |
| cancellation | `"retain"` |
| resume | `"first-unproven"` |
| amendment | null, or Amendment below |

Repository is exactly `{key:id,root:absolute,ticket:text,baseSha:git,branch:text,
selectedHeadSha:git}`. Ticket matches `[A-Z][A-Z0-9]*-\d+`. Branch starts
`feature/<ticket>-`, uses only `[A-Za-z0-9/_-]`, has no `//` and no trailing `/`.
Fresh selected HEAD equals base. Amendment keeps the approved original base and
selects the retained approved test HEAD, never silently a new base.

Parent is exactly `{holder:holder,runtime:"pi",team:"requirements",mode:"analyze",
channel:"foreground",root:absolute}`; root equals repository canonical root.
This is shape checking, NOT authentication. Only an independently live authenticated
foreground Pi requirements/analyze process at the registered canonical root may
request the future route. Parent gains no worktree/source/lease execution authority.
All other adapters/modes/background/generic-deploy/forged callers remain denied.

Path is exactly `{path:rel,role:"test"|"harness",existence:"existing"|"new",
beforeSha256:digest|null,actions:["write"|"edit"],rationale:text}`. Actions are
unique, 1–2 entries. New requires null before digest and write permission; existing
requires a digest. Harness rationale must name the separately approved support;
path naming alone does not prove test-only semantics. No rename/delete/branch/
remote/config/hook/security/delegation action is admitted by this grammar. Native
path wrappers and semantic review remain mandatory, including both rename endpoints.

Check is exactly `{id:id,kind:"baseline"|"feature"|"control",assertion:id,reason:text,
controlFor:id|null,input:source,command:text,cwd:cwd,environment:[Environment],
timeoutSeconds:integer,maxOutputBytes:integer}`. Environment is exactly
`{name:"CI"|"LANG"|"TZ"|"PATH",source:source}`, 0–4 unique names, non-secret
service-resolved references only; no literal values, credential names, inherited
caller environment or authority-root references. Commands are exact approved
strings (including spaces/quotes); the helper does not execute them or try to
sandbox arbitrary code by string filtering. Native command/environment producers
must enforce approval, minimal non-secret environment and no production effects.
Timeout is 1–14,400 seconds and no greater than bounds runtime; output is
1–16,777,216 bytes. Later native admission must additionally apply any stricter
actual runtime limit, never broaden it to this schema maximum.

Non-control `controlFor` is null. Every feature has at least one control. Each
control names an existing feature, uses its exact assertion/reason, and binds a
different input raw digest (plausible wrong-output variant). Approval/review must
establish that original values remain intact and this is an effective semantic
negative control; different bytes alone cannot establish that meaning.

Bounds reuses `parseExecutionBounds`, `assertUnresetExecutionBounds` and
`executionBoundStop`. Exactly `{startedAt,deadlineAt,runtimeMinutes,
consecutiveNoProgress,replacementsUsed,reviewCap,reviewsUsed,unresolvedFailureRef}`.
Times are canonical ISO UTC strings. Runtime integer 60–240 minutes; deadline is
exactly start + runtime. No-progress/replacements 0–3, reviewCap 1–3, reviewsUsed
0–reviewCap; unresolvedFailureRef is null or text and required for no-progress >0.
Fresh authorization has all used counters and elapsedMs zero and no unresolved failure. Amendment authorization retains prior counters/elapsed time. Events
retain exact start/deadline/runtime/reviewCap and failure ref; used counters cannot
decrease. The first failure ref may be introduced only by a failed-interruption
record whose evidence ref exactly matches it and whose no-progress count increases;
thereafter the ref cannot be replaced or cleared. This phase offers no
evidence-qualified failure/reset interface. Deadline,
three no-progress/replacements or exhausted independent review cap block progress.
Replanning/resuming must not mint a fresh authorization to reset accounting.

Amendment is exactly `{previousAuthorizationSha256:digest,contract:source,
assertions:source,repository:Repository,testHeadSha:git,tests:[File],
changedPaths:[rel],approval:source}`. Files are exactly `{path:rel,sha256:digest}`,
1–64 unique paths; changedPaths 1–64 unique paths approved in the new packet.
Canonical key/root/ticket/branch/original base remain equal; selectedHeadSha equals
retained testHeadSha. Each allowed path's before digest must equal its retained
file digest, or null for a genuinely new path. Previous sources/tuple/test hashes
remain immutable. `testWorkflowInvalidation(previous,next)` additionally requires
exact previous raw authorization digest/contract/assertions/repository and a new
operation ID. Material amendments require the prior event history, replayed to a
settled/reviewed/final-approved oracle (not an active product or interrupted state).
Retained test HEAD/files, bounds, retriesUsed, elapsedMs and retryLimit must equal
that replay. Any raw/material change invalidates authorization, results, oracle
review, final approval and continuation conservatively. Native owners must also
independently verify that the retained history is complete, actual HEAD/files and
all prior accounting still match; this pure helper cannot authenticate a caller's
selected prefix or authorize fresh accounting or silently amend legacy tuples.

## Event grammar and evidence order

Every event has exactly:
`{schemaVersion:"requirements-test-workflow/v1",kind:"event",operationId:digest,
authorizationSha256:digest,sequence:integer,previousSha256:digest,bounds:bounds,
retriesUsed:integer,elapsedMs:integer,evidence:source,data:Data}`.
At most 256 events, sequence 1–256 gapless. First previous hash equals raw
authorization hash; later previous hashes equal preceding raw event bytes.
Operation/authorization identities are invariant. `retriesUsed` 0–3, at most
retryLimit, never decreases and increments only at an explicit retry. elapsedMs
0–86,400,000, nondecreasing, collected from the service's monotonic elapsed clock;
progress before start+elapsed reaching the original deadline only. This is NOT an
agent timestamp or Git author-date chronology claim. Chain continuity can detect
ordinary edits/reorderings but cannot authenticate a wholly rewritten chain.

Data is a discriminated exact object (the listed fields plus `action` only):

| action | Other exact fields | Required producer / transition |
|---|---|---|
| authorized | `owner:"sinh",decision:source` | Native standalone operator capture binds raw authorization before any effect |
| intent-recorded | `intentId:digest` | Existing protected store publication before resource/branch/spawn effects |
| test-holder-active | `intentId:digest,resource:Resource,holder:holder,inventory:[Reservation],registry:source,launchSnapshot:source` | Trusted launcher; intent matches, exact selected base/branch/resource, unique non-parent holder; all launch correlation persisted before test code |
| test-settled | `holder:holder,settlement:source,git:Git,results:[Result]` | Actual native process/registry settlement and independent Git/content collector; exact author, all approved checks observed |
| oracle-reviewed | `oracle:Oracle,reviewer:id,delegation:source|null,decision:source,outcomeRationale:text,wrongOutputRationale:text` | Sinh or explicitly named non-author reviewer; neither author nor requirements deployment can self-approve |
| final-approved | `owner:"sinh",oracle:Oracle,reviewSha256:digest,pair:FinalPair,decision:source` | Final approval reader; exact reviewed oracle/review event and whole-document/matrix sources |
| product-intent | `resource:Resource,initialHeadSha:git,finalApprovalSha256:digest,intentId:digest` | Trusted product launcher, same retained resource and approved test HEAD; new intent, no new reservation/materialization |
| product-consumed | `resource:Resource,initialHeadSha:git,intentId:digest,holder:holder,previousHolder:holder,inventory:[Reservation],launchSnapshot:source,registry:source` | Atomic existing-owner custody transfer; previous settled author, unique new non-parent holder; snapshot before spawn |
| interrupted | `disposition:"known-absent"|"unknown"|"cancelled"|"failed",evidence:source` | Service retains original effects/failures/custody/resources, blocks next action |
| retry | `interruptionSha256:digest,owner:"sinh",decision:source` | Explicit operator manual retry only after known absence, same intent/resource, retry counter +1 |

Normal order is exactly table's first eight rows. Prefixes are incomplete, never
PASS. Replays recompute from unchanged evidence and have no effects. Duplicate
completed actions, missing interior events and reordering reject. Interruptions
preserve the prefix and first unproven action. Unknown/cancelled/failed cannot be
cleared by a retry or a caller's `settled:true`; actual owner reconciliation is
later native work, not a phase-1 bypass. Full capacity is not-ready/operator-notify,
manual retry only, never automatic queue/reclaim. No event requests cleanup, return,
merge, branch deletion, snapshot repair or content rollback.

Resource is exactly `{repository:Repository,worktreeRoot:absolute,leaseId:id,
leaseHolder:text,reservationId:digest,repositoryPermit:integer,lineageId:id}`.
Worktree differs from canonical root; lease holder equals
`pa:<repository.key>:<repository.ticket>`, permit 1–4. All fields, not just branch or
HEAD, remain equal during continuation. Missing/stale resources block, never legacy
fallback/create/reacquisition. Reservation is the **existing**
`IdlePreparationReservation` schema, parsed by its owner. A complete inventory
also accepts strict existing `RepositoryTicketSlot` rows from the same owner;
these remain occupied legacy slots, never test authority. Inventory 1–4 rows reuses
`assertReservationInventory` for prepared rows and `parseRepositoryTicketSlot` for
legacy rows, including idle/settled-retained resources. Unique
canonical ticket/operation/reservation/permit/lineage; same canonical key/root.
The matching active row binds operation/reservation/permit/lineage and exactly one
custody holder with no in-flight operation. Test-holder events require
`implement-child`; product-consumed events require `orchestrator-direct`, matching
the native transfer owner. Swapping those roles rejects; this corrects a staged
model/transaction mismatch, not legacy authority. Both are serialization carriers
in this model, NOT test-author admission or a new builder mode grant. Dedicated
holder authentication belongs to the native owner. No mutex, permit acquisition,
database or process ownership is implemented by pure replay.

## Results, Git, review and final bindings

Result has exactly `{checkId:id,command:text,cwd:cwd,environment:[Environment],
candidateSha:git,input:source,process:holder,stdout:source,stderr:source,
assertionEvidence:source,exitCode:integer|null,signal:id|null,
disposition:"exited"|"timeout"|"cancelled"|"unknown"|"not-run",startedElapsedMs:integer,
finishedElapsedMs:integer,durationMs:integer,outputBytes:integer,truncated:boolean,observations:[Observation]}`.
Exit 0–255, elapsed/duration fields 0–86,400,000 ms, output 0–16,777,216 bytes. Observation is exactly
`{assertion:id,outcome:"satisfied"|"violated"|"runner-error"|"import-error"|
"prerequisite-error"|"unknown",reason:text}`, 1–64 unique assertions.

Native collector owns original command/CWD/input/candidate/process/streams/exit/
signal/order and lossless raw stream storage. References cannot replace original
streams; observation extraction must bind assertionEvidence to actual report/stream
bytes, not a model's positive boolean. Native consumers must independently read and
verify those bytes. Source fixtures test classification only, not collection.

`classifyTestResult` requires exact command/CWD/environment/input/check id, exited,
no signal/truncation, within time/output limits and exactly the approved assertion/
reason, with finishedElapsedMs - startedElapsedMs exactly equal to durationMs.
Assessment requires results in approved check order, no overlap, no start before
launch and no finish after the settled event's service elapsed time. Baseline
requires exit 0 + satisfied. Feature requires nonzero + violated
and returns intended-assertion-red. Control requires nonzero + violated and returns
wrong-output-rejected. Everything else is blocked. Assessment requires every unique
approved check at the collected test HEAD, associated with the admitted author
deployment; raw failures remain failures. No `passed`, `ready`, human-observation or
product-PASS fields are accepted. Structured observations are not proof against a
malicious approved-code runner; semantic review remains load-bearing.

Git is exactly `{baseSha:git,initialHeadSha:git,testHeadSha:git,ancestry:[git],
commits:[Commit],files:[File],porcelainV2Base64:string,inventory:source}`.
Ancestry 1–128 unique Git IDs starts at original base and ends at selected initial
HEAD. Commits 1–128 unique objects exactly `{sha:git,parentSha:git,changes:[Change]}`;
each parent is previous HEAD, no repeated ancestry/commit SHA. Changes 1–64 unique
destination paths, exactly `{path:rel,previousPath:rel|null,beforeSha256:digest|null,
afterSha256:digest|null}`. Both rename endpoints must be approved; before digests
match tracked contents, new/delete use null. Every intermediate change is checked,
not just final diff. Final files (1–64 unique) exactly cover all approved paths and
computed content at testHeadSha. Full canonical base64 NUL-safe porcelain-v2 bytes
are parsed by `parseRepositoryGitStatus`; acceptance requires zero records. Binary
and new file raw digests are not inferred from display excerpts. Native collector
must independently read Git ancestry, every intervening commit, both rename
endpoints, full staged/unstaged/untracked state, registration and physical content;
serialized ancestry claims alone do not prove Git facts or confinement.

Oracle is exactly `{authorizationSha256:digest,contract:source,assertions:source,
testHeadSha:git,files:[File],resultsSha256:digest,gitSha256:digest}`.
It is computed from settled evidence: result/Git digests use UTF-8
`JSON.stringify` of the normalized `results` array/`git` object, in declared field
order from the parser (nested source order ref/version/sha256). This is NOT raw
stream hashing or an event hash. Review/final binding requires complete Oracle
value equality including ordered file set and every source field. Reviewer must
be Sinh or carry explicit named delegation, never author/parent deployment;
actual identity and recipient/wrong-output semantic reasoning require independent
review. Human-only criteria remain unperformed; fabricated product observation
cannot satisfy this grammar.

FinalPair is exactly `{requirements:source,uat:source,matrix:source,
matrixApproval:source,finalChecks:source,finalCheckCount:13}`. Requirements/UAT refs
differ; matrix source ref equals requirements ref, but matrix raw digest is its own
authority identity. Final native reader must authenticate actual 13 checks, durable
whole-document approval and raw requirements/UAT/matrix bytes, not accept a field
count or copied receipt as proof. Product admission must authenticate this approval
and actual settled holder/resource/test HEAD under shared locks, atomically transfer
existing custody/reservation and persist launch before spawn. No second acquisition,
legacy create/select fallback or branch reconstruction is represented or allowed.

## Ownership, diagnostics and delivery

Phase 2 must compose the existing canonical repository capacity -> worktree
admission -> journal publication locks and `ProtectedWorkflowStore`; phase 1 does
not create a store or speculative injection host. Capacity/concurrency remain owned
by ticket-concurrency/execution-custody; native registered process, physical Git/
lease/canonical configuration and operator approval roots must be resolved out of
band from protected owners, **never supplied by untrusted JSON/environment**.
Phase 3 owns actual exposed-tool enforcement and evidence collection. Unknown
capture/settlement blocks dependent actions with resources/history retained.
Matching finalization is idempotent and performs zero checkout return/content/
branch/merge effects. Only operator-approved existing return procedure applies.

Public diagnostic is fixed, redacted before presentation: Condition, Source,
Reason, Correction, Resume Action, <=2000 JavaScript code units. It never interpolates
untrusted fields, commands, private streams, tokens or synthetic secret canaries.
Private original evidence stays with its owning capture service. `TestWorkflowAssessment`
contains source-model stage, firstUnprovenAction, raw authorization/history hashes,
retained counters/elapsedMs/bounds/resource/oracle; it is NOT a public credential-bearing
projection and never contains process fingerprints or raw streams. Production
status projection/allowed artifact roots remain native follow-up work.

## Complete AC / TS / evidence mapping

These rows scope obligations, not passing placeholders. Source cases run in
`packages/pa-core/src/__tests__/requirements-test-workflow.test.ts`. TS01–TS15 are
stable scenario groups; parameterized mutations are mandatory and never skipped.
No independent full matrix, installed runtime, semantic review, human UAT or
activation is executed by this source suite.

| AC | Phase-1 source evidence | Native/installed/semantic/human obligation |
|---|---|---|
| AC1 | TS01, TS03, TS04 inactive selection/version/caller shape; zero effects by pure design | Phase 2 authenticated actual caller rejection/effect counters; phase 4 installed pair denial |
| AC2 | TS02–TS04, TS06 strict authorization/path/action/command/bounds/result mutations | Phases 2–3 native operator capture and exact byte approval; phase 4 installed mutation cases |
| AC3 | TS05, TS07, TS08 intent/resource/branch/base/holder modeled order | Phase 2 real protected publication, acquisition, registration and launch fault injection; phase 4 installed |
| AC4 | TS07 existing shared-owner inventory validator, duplicate/fifth modeled rejection | Phase 2 real cross-route mutex/concurrent capacity/sole holder; phase 4 installed, not fixture concurrency |
| AC5 | deferred — no native-tool PASS claim; TS04 only lexical grammar negatives | Phase 3 actual tool aliases/symlinks/hardlinks/rename/shell/delegation enforcement; phase 4 installed; explicitly no OS sandbox |
| AC6 | deferred — no native-audit PASS claim; TS08 only intermediate history/content/inventory model | Phase 3 actual external mutations/intervening commits/unknown process collection; phase 4 installed effects |
| AC7 | TS05, TS06 evidence-derived baseline/RED/control versus blocked classifier | Phase 3 raw streams/process/assertion extraction; phase 4 installed negative controls |
| AC8 | TS09 exact non-author/full-source/reason bindings | Phase 3 authenticated reviewer/delegation; independent recipient/wrong-output semantic oracle review; human product evidence stays planned |
| AC9 | TS08, TS09, TS13 chain/order/exact source/drift model; no agent timestamps | Phases 2–3 service sequence and independently read actual Git/content/approval; phase 4 forgery installed cases |
| AC10 | TS05, TS10 exact same-resource/test-HEAD transfer model | Phase 2 atomic actual retained reservation/holder transfer, no allocation; phase 4 installed |
| AC11 | TS11, TS12, TS13 all interruption points, retained unknown/cancel barriers, bounded retry/amendment | Phase 2 actual crash reconciliation/operator-notify/full-capacity/idempotent finalization with counters retained; phase 4 installed |
| AC12 | TS01, TS04, TS14 no index/authority injection/new-route selection/legacy reinterpretation | Phase 4 retained legacy regression, exact PAPC-065 grammar and tools/audit owner compatibility, actual clean installed qualification and separate explicit Sinh activation |
| AC13 | TS15 complete mapping, TS14 safe diagnostics; source-only evidence class | Phase 4 all source/installed matrix variants; independent full review/CI/semantic oracle/human UAT and later activation, each separately reported |

## Phase-2 internal transaction adapter (not an activated route)

`packages/pi-pa/src/requirements-test-native.ts` composes the existing
`ProtectedWorkflowStore`, shared ticket capacity, vacant/execution worktree mutexes,
`TreehouseClient` and exact-base ticket materialization. It is not a public CLI,
new generic builder mode or core authority export.
The historical `requestPiRequirementsTestNative` preflight helper still rejects the
pure inactive descriptor. The dedicated native tool below is a distinct composed
boundary, not a generic deployment flag or a legacy preparation grant. Generic product preparation explicitly rejects
retained test intents/reservations, including missing-resource and cancelled cases;
no legacy reconstruction or second reservation is allowed.

The internal `RequirementsTestNativeService` requires native authority and executor
ports. Those are trusted embedding dependencies, NOT JSON/environment/tool options.
No default success executor/approval producer is installed. The native capture,
restricted SDK definitions and dedicated registry owner below now supply concrete
producers. The later direct continuation adds a protected keyless model-transport
consumer and manual capacity-retry capture. The product continuation below now
connects native chronology to the existing admission/execution owners. Complete
phase-3 validation and actual installed qualification remain pending.
Source fixtures supplying dependencies do not establish installed readiness.

Authority must independently authenticate original approved bytes, live foreground
canonical parent, separate exact test-only approval and pair; retained settlement
has a distinct non-new-work authorization. Final approval must resolve the complete
protected phase-3 history, original results, independent review and exact final
sources, not a caller prefix or replay result. Executor ports prepare/inspect a
parked native process with registry correlation, authenticate it, release it only
after persisted launch snapshot, and prove actual process/registry settlement.
Unknown release is inspected, never blindly reissued. None of these ports receives
an agent-selected authority root or a `passed` Boolean.

### Staged existing-owner parked transport (not executor qualification)

`PiParkedTestTransport` in the existing Pi background supervisor now implements a
real **inert native supervisor** prepare/inspect/settle boundary. It does not start
Pi, expose tools, execute repository tests/product code, or accept a prompt/shell/
environment packet. Its fixed owner program receives initialization over private
IPC only, with empty inherited environment and an absolute positive deadline
(maximum two hours). This is process transport, **not a restricted Pi tool runner**
and not an OS sandbox. The ordinary adapter's dedicated-holder selection rejects
before preflight or effects. Ordinary background JSON cannot activate this route.

The internal `pi-parked-test/v1` correlation binding is strict: intent and original
authorization SHA-256, distinct child/parent deployment IDs, canonical key/root,
worktree/ticket/branch/base/HEAD, exact lease/holder, retained reservation/lineage/
permit, and deadline. These are non-authoritative pointers to existing owners,
not a second approval or capacity store. A private deployment directory contains
an exclusively created intent directory and immutable owner-only intent, actual
process-birth, parked and stop records. Intent publication/fsync precedes spawn;
parked acknowledgement follows actual birth verification. Concurrent duplicate,
partial intent, lost prepare response and unknown process state are inspect-only;
there is no automatic respawn or record repair. Stop intent precedes cancellation;
a lost stop response is inspected without repeating the signal. Original deadline
is retained on disconnect. No checkout/reservation cleanup or return occurs.

Observations separately report `spawned`, `parked`, registry correlation and
`restrictedHolderReady:false`. Registry correlation independently reads the actual
registry row and compares PID, dedicated role, roots/ticket and an immutable
objective digest pointer to the entire transport binding. Existing Treehouse
registry fields require builder authority and are deliberately NOT reused. This
ordinary lifecycle pointer is NOT authority or dedicated custody; copied public
text cannot make `restrictedHolderReady` true or release executable work. A
dedicated resource/custody correlation is deliberately absent from this historical
inert class. The separate composed owner below adds it without relabelling this
ordinary objective pointer or changing this class's unconditional release denial. Settlement requires actual matching process absence,
original stopped receipt AND an exactly correlated explicit terminal registry row;
registry-only, crash-without-receipt and missing/unknown settlement remain blocked.
The transport never writes a success registry marker or releases a shared permit.
`release` remains unconditionally unreachable, even with exact parked/registry
facts: no generic Pi prompt can fill the missing restricted executor.

This historical inert transport remains incomplete as an executor. The new async
service and restricted SDK owner below are separate from it; neither converts an
inert acknowledgement into qualified readiness. The dedicated product owner below
is a separate new-version admission/execution path; installed qualification remains
pending. No live new-route launch, installed qualification, human UAT or activation is claimed by
these source transport tests. They use real inert processes with explicitly
fixture-authored registry rows and exercise actual process-birth/death, premature
release, drift, cancellation, response loss, retained records and old-route suites.

Native records use `requirements-test-native/v1`, immutable chained request/action
intents and outcomes in the EXISTING operations store. Request binds canonical
tuple, raw authorization identity, native decision and original bounds/counters.
Each resource/branch/process intent precedes its effect. Exceptions preserve private
originals and unknown barriers. Full capacity records known zero-resource failure;
only an independently authenticated explicit manual retry of that exact failure can
advance the same operation, incrementing the retained counter. Cancellation never
returns/merges/deletes/cleans or removes a retained reservation.

Dedicated reservations add optional `purpose:"requirements-test-workflow/v1"` to
`prepared-reservation/v1`. They share the old/prepared permit directory and mutex;
idle/uncertain/settled records still occupy one of four permits. Test-author custody
uses `implement-child` only as a dedicated carrier, not generic builder borrowing.
Actual process absence plus native terminal registry is required before settlement.
Only after independently verified final approval and actual Git/content checks does
one atomic compare-and-swap transfer the SAME reservation/lease/lineage to a parked
product holder at exactly the approved test HEAD. Its launch snapshot precedes
release. An explicit amendment preserves resource/permit/lineage and old native
journals, requires exact previous source/history/HEAD/files/counters plus renewed
approval, and changes the operation only through the existing capacity owner.

The native source suite uses disposable registered Git repositories, actual shared
locks/publication and barrier processes; Treehouse replies, approval capture and
phase-3 results/review are labelled source fixtures. It does not run installed
Treehouse, repository test commands, a model/composer canary, semantic oracle review,
human UAT, or activation. AC5–8 actual tools/results/review remain phase-3 obligations.

FR1–4/6–12 and NFR1–6 are modeled here only as specified above. FR5 native behavior,
shared-owner races, durable authentication, independent real Git proof, original
stream custody and runtime limits are not qualified by fixtures. Matrix completion,
Critical/Major findings, accepted Minor rationale, configuration/model evidence,
actual native SDK/process observations, actual human/browser/Obsidian access and
operator activation must each retain distinct provenance. Help/status/source
fixtures/file existence/merge/HTML generation prove none of the other classes.

## Native composition continuation — still unaccepted/inactive

`pa_requirements_test` is registered only for foreground Pi requirements/analyze.
Every request uses an exact `schemaVersion:"requirements-test-native/v1"` and a
strict discriminated object (unknown fields reject):

- `{schemaVersion,action:"selection-status"|"activate"}`: inspect exact native
  qualification, or show a separate native operator selection dialog. Neither
  public JSON nor this method can produce qualification.
- `{schemaVersion,action:"authorize",authorization:<raw JSON string>}`: a separate
  native test-only dialog displays the complete packet and raw SHA-256. Fresh
  caller, process, sources, pair and environment rereads precede immutable capture.
- `{schemaVersion,action:"request"|"status"|"cancel"|"settle"|"review-oracle"|"retry-capacity"|"continue-product"|"settle-product",operationId:<digest>}`.
  `retry-capacity` captures and consumes one exact native manual decision; it does
  not execute `request`, queue, reclaim a slot or clear unknown effects.
- `{schemaVersion,action:"approve-final",operationId:<digest>,requirements:<attached final source ref>}`.

`continue-product` authenticates the exact final-approved pair/reviewed oracle,
actual settled author and same retained resource before admitting one product
holder. `settle-product` performs factual matching terminal reconciliation only.
Neither accepts a holder, grant, receipt, root, command, tuple or approval from JSON.
`status` reports `activationPerformed:false`, not a false assertion that an already
selected policy is inactive; `selection-status` independently reports selection.
There is no generic product-deploy flag, shell, delegation, authority-root or arbitrary
record option. Public lifecycle HTTP JSON cannot mint `requirementsTest` custody.
Missing/malformed/unqualified native policy blocks; no activation occurs in this
implementation run. The pure model's `runtimeAuthorized:false` remains accurate.

`PiRequirementsTestAuthority` resolves fixed native roots through the existing
`PiPreparedNativeAuthority` store and independently pins installed Nix provenance
and clean exact config revision. Dedicated qualification uses the explicitly
versioned protected record `requirements-test-native-qualification/v2`, identified
by SHA-256 of `JSON.stringify([schemaVersion, runtime])`. Its exact fields are
`{schemaVersion,runtime,native,installed,pairing,toolsAuditDecision,modelTransport}`.
The four existing protected source-bound evidence records (`native`, `installed`,
`pairing`, `toolsAuditDecision`) and the keyless transport below must bind those
exact facts. A v1 qualification lacking model transport is rejected, never silently
upgraded or treated as executable readiness. Wire authorization/event v1 and legacy
prepared policy remain unchanged. It is not today's prepared policy or post-final grant.
Qualification production/installed assessment remain phase-4 work; fixture
qualification records are explicitly synthetic and cannot qualify the installed
route. Activation is a distinct exact native UI capture. Test authorization then
requires the actual live foreground canonical requirements parent, exact registered
ticket and attached raw contract/assertion/input sources. Environment references
resolve only native non-secret `CI`, `LANG`, `TZ` and root-owned physical `PATH`
entries. A check must bind PATH; no credentials, inherited deployment/task/activity
principals or caller-selected literal values enter its process environment.

The concrete `PiRestrictedTestExecutor` publishes a dedicated immutable process
intent before spawn. Registry `requirements_test` serializes exactly
`{schemaVersion:"requirements-test-custody/v1",operationId,authorizationSha256,
intentId,parentDeploymentId,repoKey,repoRoot,worktreeRoot,ticket,branch,baseSha,
initialHeadSha,leaseId,leaseHolder,reservationId,lineageId,repositoryPermit}`.
It round-trips through registry events/status and is immutable across terminal
publication. Builder/review authority, repository slots and legacy Treehouse
correlation fields cannot mix with it. This correlation is identity, not approval.
The actual child has to agree with the shared retained reservation, its process
incarnation and registry role before release.

`requestAsync` and `continueProductAsync` persist exclusive intent barriers under
short synchronous capacity/worktree/publication transactions, release those locks
for bounded async prepare/start, then reacquire and reread before publication or
custody release. Expired transaction handles never cross await. Lost responses
inspect the same intent; they cannot respawn or repeat an unproven release. Actual
process absence plus matching terminal registry/owner records are mandatory for
settlement. Cancellation records retain custody/resources and revoke new native
actions; no cleanup/return is introduced.

The dedicated process constructs a genuine Pi SDK session with no discovered
extensions, context, skills, prompts, user settings or host credential store. It
selects only the qualified keyless model below, never an ambient default. Its only
active definitions are SDK-backed exact-path `write`/`edit`, exact-path `read` and
`check({checkId})`. There is no bash, deploy, branch or arbitrary-environment tool.
Lower file operations use no-follow dirfd traversal and reject hardlink/symlink
aliases. Ignored approved paths and mismatched existing/new file identities reject
before tools are parked, rather than escaping the ordinary complete Git audit.
Every operation preserves intent, original failures and full NUL-safe
before/after inventory/content identities; intervening commits are independently
read, including both rename endpoints. Native checks preserve actual process-frame,
separate private streams, exit/signal/deadline/cancel/output evidence. Stdout/stderr
share one total approved budget. Public reading excerpts are redacted/bounded;
reading truncation is not raw-result completion. Observable scope escape blocks
readiness with retained evidence, not rollback. **This is not an OS sandbox.**

Native assertion collection accepts one strict raw stdout JSON object:
`{schemaVersion:"requirements-test-assertion/v1",assertion,outcome,reason}`.
The native protocol requires empty stderr and exit 0 for a satisfied baseline or
reserved exit 42 for a completed violated feature/control assertion. An earlier
stdout marker followed by an ordinary import/runner exit cannot count as RED.
Only exact approved assertion/reason and native exit/process facts can classify
baseline PASS, intended RED and wrong-output rejection; infrastructure errors,
missing controls, duplicates, unknown/truncated/unsettled results block. Raw RED
remains RED. Exact test HEAD must cover all collected checks, and the complete
Git history/content is independently verified before settled oracle evidence.
Native service-owned sequence records precede resource/release effects. Independent
Sinh review additionally captures native operator-provided recipient-outcome and
wrong-output rationales, not agent-invented text. Final-pair capture rereads the
existing 13-check/pair/matrix/approval producer and binds the reviewed exact oracle.
These are implementation producers, not claims of semantic/human acceptance.

### Qualified keyless model transport consumer (staged, not qualified here)

`modelTransport` is a SourceVersion with
`ref:"requirements-test-model-transport:<64-hex protected record id>"`,
`version:"requirements-test-model-transport/v1"` and SHA-256 of the exact stored
JSON rendering. It resolves only within the existing protected operations store,
not a file/URL/model-selected root. The referenced record has exactly:

`{schemaVersion:"requirements-test-model-transport/v1",runtime,endpoint,modelId,
contextWindow,maxTokens,process,source,outcome:"qualified"}`.

- `runtime` equals the independently authenticated installed source/config/package/
  store tuple. `source` is the independent qualifier's immutable evidence reference;
  neither this consumer nor a native tool produces qualification.
- `endpoint` is exactly `http://127.0.0.1:<port>/v1`, port 1024–65535. No DNS, other
  host, URL credentials/query/fragment, alternate path, custom header, key, command,
  interpolation or remote URL is accepted. `modelId` is 1–128 ASCII characters
  matching `[A-Za-z0-9][A-Za-z0-9._/-]*`. Context is 4096–1048576 tokens; max output
  is 1–32768 tokens and no greater than context.
- `process` is the exact live broker process fingerprint. Linux kernel TCP-listener
  and `/proc/<pid>/fd` socket ownership must independently agree on the exact
  numeric loopback endpoint. A live unrelated PID or copied qualified receipt is
  insufficient. Broker exit/restart/listener loss requires owning requalification,
  never automatic discovery or launch. This remains a trusted-host observation,
  not protection against malicious same-user replacement/races.

The consumer revalidates qualification/listener before selection, authorization,
allocation, SDK construction and every model request. It uses an explicit model,
empty in-memory credential storage, disabled catalog refresh, and the supported
Pi OpenAI-completions streaming implementation. Only POST to that exact endpoint's
`/chat/completions` is accepted; no authorization header or caller headers are
forwarded. Fetch omits credentials and rejects redirects. SDK/provider automatic
retries are disabled. Request bytes are bounded to 16 MiB; cumulative response
bytes to 16 MiB; requests to 128; model output to the qualified token cap and every
request to the original workflow deadline/cancellation signal. The broker is
separately provisioned/approved by its owner; the runner never launches a broker,
reads upstream credentials, or grants any production/network-service effects.
A keyless fixture server proves only native SDK/protocol behavior, not useful
model behavior, operator/installed qualification or semantic oracle acceptance.

Original model messages, selected transport and terminal failures remain private
native stream evidence. The 64-KiB protected terminal journal envelope contains
only the native blob reference and actual truncation/failure flags, not the whole
conversation. A transcript exceeding its 16-MiB private stream budget is explicitly
truncated/failed, never silently complete. Assistant error/aborted terminal messages
cannot be promoted to successful authoring even if the SDK prompt resolves normally;
a failed/crashed model holder cannot produce settled oracle evidence. Missing/invalid
transport rejects before resource effects; a later transport failure retains
resources and original failures, never oracle readiness.

### Native explicit manual capacity retry

Only a proven last `reservation/failed` record with the fixed full-capacity,
operator-notification/manual-only result is eligible. No observed resource/action,
unknown/cancelled effect or same-ticket reservation may exist. Original bounds,
no-progress failures and retry counts remain; three no-progress failures, deadline
or exhausted retry allowance blocks. Historical full-capacity failures stay in the
journal after retry and still count against limits; they are not current status
blockers after the exact explicit retry is observed.

The foreground requirements caller receives the exact authorization digest,
failure reference, next retry count and unchanged bounds. Cancellation/non-exact
choice creates no decision. Native caller/process/source/pair/environment and the
complete native chain/capacity inventory are reread after the dialog under existing
locks. The immutable protected record is:

`{schemaVersion:"requirements-test-native-capacity-retry/v1",operationId,
authorizationSha256,failure,retriesUsed,bounds,caller,toolCallId,decisionId,capturedAt}`.

Its id is SHA-256 of `JSON.stringify([schemaVersion,operationId,failure,retriesUsed])`.
The returned SourceVersion uses `ref:"requirements-test-capacity-retry:<id>"`,
that version, and SHA-256 of the stored JSON rendering. Public JSON cannot mint it.
Consumption authenticates every binding and appends one existing-owner
`capacity-retry/observed` record. Repeated consumption or use for a different failure,
count, source or bounds rejects. Capture/consume does not request allocation or
release/reclaim capacity; a later explicit request resumes the same operation.
Async request validation honors only this exact superseding retry, never clears
unknown failures or resets counters.

### Native product chronology and terminal retention (staged transaction)

The internal sync/async continuation now publishes the existing strict
`product-intent` event after its durable `product-process/intent` barrier and before
executor preparation. Its intent id is SHA-256 of
`JSON.stringify([operationId,"product-process"])`; finalApprovalSha256 pins the
original final-approved event, not the current journal tail. Missing/no-op event
producers block before product spawn. After exact test settlement and same-resource
custody transfer, the service persists the launch snapshot and publishes
`product-consumed` before executor release. The event binds the actual parked
holder/registry, previous author, exact approved test HEAD and shared inventory.
Both publications use the existing native event producer/store, not model input.

Final preflight reads/replays the COMPLETE service history, selects only its exact
final-approved prefix and rereads the final pair. Later product stages are not
new approvals. Native product events must additionally match the service's own
process/transfer/start publications and the current same-ticket reservation.
Rehashed copied intent/registry/snapshot/slot bindings and removed events reject.
Unrelated capacity rows may change; their historical inventory snapshot does not
freeze other tickets. Repeated continuation authenticates the existing holder
without a second reservation, process or release. A lost response at a pre-spawn
or pre-release barrier is inspect-only; lack of original proof stays blocked, even
when that means retaining an inert parked holder until owning cancellation.

Cancellation selects the latest product intent/holder rather than signalling only
the settled test author. An aborted async continuation attempts the same native
cancellation; unknown process effects stay retained. Internal `settleProduct`
requires the admitted product publication, original released process and actual
process-absence/terminal-registry proof. It adds immutable
`product-settlement/intent` and `/observed` native transaction records and changes
only same-holder occupancy to `settled-retained`. It is idempotent across lost
responses. If release acknowledgement was lost, only the original native start
proof plus actual terminal settlement can close that same start barrier; release
is never repeated and the original unknown record is retained. Missing start proof
remains blocked even when the parked process has died. Settlement captures
changed/dirty product Git state without approving it or reapplying the initial
clean-test-HEAD gate. It grants no product PASS, source
approval, linked-head update, new execution, permit release, merge or return.
The bounded operation-id-only `continue-product`/`settle-product` native actions
now connect these transactions to the concrete owner below. They preserve the
foreground-only qualification/caller/final-approval gates; auto/OPA/CPA stay denied.

The original transaction cases use real disposable Git/locks/processes and
explicitly modeled approval/registry ports. Additional cases below observe actual
SDK product tools, native admission, registry and execution owners; authorization,
final-pair preview and model service remain explicit source fixtures. Neither case
class establishes installed qualification, semantic review, human UAT or activation.

### Concrete same-resource product admission and execution (staged)

`PiRestrictedTestExecutor` delegates product role to the dedicated native product
owner, not the test-only loadout or ordinary `deploy` fallback. Preparation first
calls the service's full native `productPreflight`: exact final sources, actual
settled test process/registry, complete service history, independent Git/content,
retained physical resource and current custody. Missing or arbitrary product
intent still rejects even with qualified test-only capability.

The strict native records are separate from legacy preparation:

- `requirements-product-preflight/v1`: exactly `{schemaVersion,operationId,
  authorizationSha256,intentId,resource,oracle,bounds,retriesUsed,testHolder,
  finalApprovalSha256}`. `intentId` is the already-published product-process intent;
  `finalApprovalSha256` pins the original final-approved event. Bounds/counters are
  inherited, not recalculated from product process start.
- `requirements-product-consumption/v1`: exactly `{schemaVersion,binding,launch,
  launchSnapshot,consumedEventSha256,reservation}`. `binding` is the preflight above;
  `launch` is the actual native parked product holder/registry; the snapshot is its
  exact clean approved test HEAD. `reservation` is PRIVATE full existing capacity
  evidence, including the original slot token. It is never placed in a model
  prompt/status. The reader reconstructs the record from both protected native
  chains, not caller JSON. Its protected id hashes
  `JSON.stringify([schemaVersion,binding.operationId,launch.holder])`.
- A SourceVersion uses `ref:"requirements-product-consumption:<id>"`, that version
  and SHA-256 of the exact stored JSON rendering. The private deployment sidecar
  `requirements-product-consumption.json` contains only this reference, not a
  legacy receipt/grant or caller-selected resource packet.
- `pi-restricted-product-owner/v1`: exactly `{schemaVersion,binding,deploymentId,
  directory}` in the existing operations store, before the exclusive directory and
  actual process spawn. Existing/unknown intent is inspect-only, never respawned.
- Registry uses the EXISTING strict builder/orchestrator Treehouse/branch/slot
  fields, actual process anchor and immutable started-event note
  `requirements-product-launch/v1:<SHA256(JSON.stringify(binding))>`. This note is
  correlation, not authority. No schema/legacy authority restriction is relaxed;
  `requirements_test` remains test-only and cannot mix with builder evidence.

Before release, `admitPiRequirementsProduct` captures consumption under existing
capacity -> worktree -> publication owners. It authenticates the same complete
reservation, actual holder, registry, process anchor and physical Treehouse lease.
It acquires only the existing worktree MUTATION authority, never a second checkout,
permit, reservation or branch. Its `requirements-product-admission/v1` intent binds
`{schemaVersion,reference,holder,physical}` in the same operations store. The existing
repository-admission owner's native `beforePublish` callback publishes that intent
inside the worktree mutex immediately before exclusive lease publication. Throw,
Promise or non-void callback blocks lease publication. Ordinary callers retain
unchanged behavior. An existing admission intent with absent/uncertain/mismatched
lease blocks rather than authorizing reacquisition. Same matching live lease may
only be inspected/reused. No force, cleanup or legacy create/select is involved.

`resolvePiRequirementsProductExecution` and `NativeExecutionSession` explicitly
adopt this new version. They independently reread the protected consumption,
registry/process lineage, existing mutation owner, physical lease and COMPLETE
current reservation (operation/reservation/lineage/custody, not merely its ordinary
slot view). Legacy prepared markers/grants retain their exact original path; new
product markers cannot fall through to generic child admission. Native execution
uses the same `ExecutionCustodyService`, existing tool/result/process evidence,
plan/select, failure/recovery and source-authority advancement. Its initial HEAD,
lineage, original deadline and used counters come from the new binding. No runtime
or review/replacement accounting restarts at product spawn.

The actual parked SDK has only `write`, `edit`, `bash`, `pa_execution`, `read`, with
no resource/extension/settings/credential discovery and the same explicit keyless
qualified model transport. Definitions are inert until exact consumption/admission
and native release. Custom SDK wrappers reuse the actual native execution module's
begin/finish hooks and lower SDK builtins. A model cannot supply their binding,
resolver or authority. Every mutation/check persists native intent before lower
SDK dispatch and requires native result/process/scope evidence to close it. Shell
commands are limited to the native plan's fixed checks and bounded scoped Git;
there is no unrestricted shell, delegation, feature push or acceptance producer.
Checks receive only native non-secret environment, not inherited PA/PI principals
or host credential environment. This is tools/audit enforcement, NOT a sandbox.

Plans cannot include the reviewed oracle or a path containing/contained by it.
Every new action rereads final source approval and oracle bytes/ancestry. Every
intervening commit is checked for oracle changes: restoring the same final bytes
cannot hide an intermediate oracle edit. Post-operation checks preserve scope
escape and stop dependent work rather than rolling back or granting acceptance.
Original model messages/errors remain private bounded native stream evidence.
Product terminal status is partial/failed, never independent product PASS.

Factual settlement additionally uses the existing execution journal's pure
`inspectRetained()` reader after independently observed parent-process death and
terminal registry/owner records. This reader does NOT assert a live host or grant
an action. A pending tool/process barrier blocks settlement/finalization even when
the SDK parent is dead. `initialize/status/apply` retain full host/live admission.
Matching mutation-authority finalization is recorded before/after its native effect
and uses the existing owner release primitive only after these proofs. The shared
reservation/Treehouse checkout/branch/contents remain retained. No linked product
HEAD approval/refresh, checkout return, merge or deletion occurs.

Source integration now observes a real product SDK process, actual native registry,
capacity, mutation admission and execution journals, real SDK tools, Git commit,
check streams/process settlement and matching terminal authority release. A native
admission-intent interruption observes zero model requests/lease publication and
rejects reacquisition after response loss. Operator/test-result/final-pair preview,
Treehouse service replies and deterministic model server are explicitly SOURCE
fixtures, not installed/runtime/model/semantic/human qualification. Source success
is an implementation candidate, not independent phase acceptance or activation.

Phase-3 producer validation, phase-4 qualification/PAPC-065 compatibility (including
these new operation actions/status/record shapes and tools/audit wording), independent
full matrix/review/CI and actual human UAT remain pending. Exact installed source
and paired config qualification plus separate explicit Sinh activation still block
selection; no existing qualification migrates across a different source/config pin.
No fixture/help/status/merge or this document establishes installed/human PASS.
