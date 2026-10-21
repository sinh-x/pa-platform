# requirements-test-workflow/v1 — phase-1 contract

Status: **staged, inactive; phase-1 source model plus phase-2 internal native transaction adapter**. Owner: PAP-265, approved requirements
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
its argument. There is no activation flag, environment selector, authority-root
parameter, callback-based authority injector, public request command, constructor,
new approval database or parallel reservation owner in this phase. Helpers are not
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
`IdlePreparationReservation` schema, parsed by its owner. Inventory 1–4 rows reuses
`assertReservationInventory`, including idle/settled-retained resources. Unique
canonical ticket/operation/reservation/permit/lineage; same canonical key/root.
The matching active row binds operation/reservation/permit/lineage and exactly one
custody holder with no in-flight operation. Existing `implement-child` custody is
a serialization carrier in this model, NOT test-author admission or a new builder
mode grant. Dedicated test-holder integration belongs to the native owner later.
No mutex, permit acquisition, database or process ownership is implemented here.

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
new generic builder mode, activation method or core authority export.
`requestPiRequirementsTestNative` reuses foreground caller authentication and then
rejects the inactive capability. Generic product preparation explicitly rejects
retained test intents/reservations, including missing-resource and cancelled cases;
no legacy reconstruction or second reservation is allowed.

The internal `RequirementsTestNativeService` requires native authority and executor
ports. Those are trusted embedding dependencies, NOT JSON/environment/tool options.
No default success executor/approval producer is installed. Native operator capture,
complete result/audit/oracle/final-pair producers belong to phase 3; exact installed
qualification, SDK composition and separate activation belong to phase 4/later
rollout. Source fixtures supplying these ports do not establish installed readiness.

Authority must independently authenticate original approved bytes, live foreground
canonical parent, separate exact test-only approval and pair; retained settlement
has a distinct non-new-work authorization. Final approval must resolve the complete
protected phase-3 history, original results, independent review and exact final
sources, not a caller prefix or replay result. Executor ports prepare/inspect a
parked native process with registry correlation, authenticate it, release it only
after persisted launch snapshot, and prove actual process/registry settlement.
Unknown release is inspected, never blindly reissued. None of these ports receives
an agent-selected authority root or a `passed` Boolean.

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
