# PAP-273 v003 runtime repair handoff

Source implementation against the corrected requirements brief and alignment
review, deployment `d-1b33db`. **Not ticket completion, installed qualification,
independent review, human UAT, release or adoption.** PAP-271/PAPC-072 stay done.

## Source identity and boundary

- Checkout: `/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`.
- Branch: `feature/PAP-273-workflow-startup-compatibility`.
- Starting Git HEAD: `abb8e5a1d228f33e952ecc11e3350d531f517678`.
- Initial delivery was an **uncommitted overlay**. The external
  `source.patch`/`evidence.json` preserve that pre-version-bump snapshot, including
  new files. The operator subsequently requested separate phase commits and the
  `.3` label; use their final Git HEAD for packaging, never the old snapshot or
  starting commit as proof of the current candidate. Historical results remain
  bound to the bytes actually tested, not automatically to the final commit.
- Current worktree label: `0.1.154-pap273.3`; installed `.2` is unchanged.
- No main/develop/branch/link/allocation/checkout-return, remote, install,
  credential, selected-config or live application-workflow mutation performed.

Evidence directory:
`/home/sinh/Documents/ai-usage/deployments/d-1b33db/artifacts/PAP-273-v003/`.
The record is factual agent reporting, not native approval or a signed matrix.

## Delivered interfaces and ownership

### 1. Explicit fresh-session coordinator adoption

A fresh authenticated Pi foreground `requirements/analyze` session without
`--resume` can inspect the existing ticket run. It cannot recover or execute
merely because it has the same ticket. `coordinatorContinuation` in status/next
provides a structural request, distinct from actual native caller eligibility:

```json
{"action":"adopt","revision":2,"subjectSha256":"<exact-current-subject-sha256>"}
```

Use `pa_decision` with exactly those fields from current observations. Repository,
ticket, run, actor, outcome, coordinator and permissions are not caller inputs.
The readable native flow binds old/new coordinator, exact run/package/resources,
continuation purpose and, for queue settlement, the existing intent/decision.
Optional technical bindings remain available. Consent is NOT package approval.

Native admission proves the effective coordinator and supported resume descendants
inactive, using registry identity/terminal evidence AND private launch-incarnation
anchors with actual procfs absence. Staged completion, live processes, PID reuse,
missing anchors, different boot and uncertain reads reject. Unrelated nonowning
auditors do not become coordinators. The launcher now records analyze-role
anchors; **never manufacture historical anchors** where older launches lack them.

Consent appends `coordinator-adopted` under the existing journal CAS. Replay retains
original caller and history, derives the effective coordinator, and validates exact
subject/resource identities. Authentication/liveness/evidence are checked again
after review and inside CAS. Four actual competing child processes demonstrate
one committed successor. There is no separate claim/grant ledger or reservation
that can strand a crashed review. Lost replies are resolved by reading existing
succession; stale retries do not transfer again. Old unaware readers reject.

For cancelled review, reread the new revision and explicitly request `recover`;
only its fresh native package decision grants package permissions. The existing
16-decision bound, attempts and execution/custody bounds are not reset. Explicit
registry resume remains supported; old/resumed coordinators cannot act as a
second coordinator after adoption. Ticket/source/matrix owners use effective,
not overwritten historical, coordinator identity.

For approved pending queue intent, adoption is **existing-queue-intent-only**.
It cannot recapture, revoke, revise, request another step or gain source/check
scope. Native package grants are neither renewed nor extended.

### 2. Same-intent queue convergence

Original concrete gap: `queueComplete` required builder ownership, but `queue`
accepted only review/approval starting statuses. Thus an already-prequeued
`pending-implementation/sinh` ticket could never complete its retained intent.

The existing ticket mutex now recognizes a narrow audited administrative
review/approval -> pending-implementation transition, with known incomplete
assignment and no intervening conflicting status/assignment. The actual current
pair/primary refs and unrevoked queue permission remain mandatory. Only missing
permitted fields change; a prequeued ticket receives an assignee-only update.
No new approval, pair publication, intent, subject attempt, link or builder launch.

Unknown/unaudited/foreign assignment, changed pair, stale revision, unsupported
advanced/terminal states and revoked-before-new-write stop. An exact already-proven
result may settle after revocation without a write, preserving existing rules.
Concurrent reconciliation has one winner/field update/result. Fresh queue-only
coordinator adoption uses this same owner and exact retained intent.

### 3. Stage/caller and issued-decision diagnostics

Status/next distinguish structural adoption, current native caller eligibility,
effective versus original coordinator, package outcome, publication/queue intent
and independent execution prerequisites. CLI without native session proof reports
`uninspected`, never permission. Native reads expose specific safe liveness gates.
Conflicting/duplicate/foreign ticket workflow markers and ambiguous runs reject;
no newest-directory/run heuristic or replacement-run fallback is used. Native
mutation authentication rechecks ticket markers across review/effect boundaries.

`decision verify` retains `issued`, current-subject, outcome and revocation facts
when canonical artifact inspection is unavailable. It separately reports
`evidenceState=unavailable`, correction owner and next action. This is not a
successful evidence check or execution readiness; downstream owners still require
exact real bytes/authority. An unavailable read never revokes an issued approval
or becomes a reason to recapture the unchanged package.

### 4. Typed existing-branch initial handoff

A real selected producer -> parser -> publication -> queue -> structured baseline
test proves initial amendment/reuse without a fabricated previous canonical source.
The existing full native materialization case proves exact retained feature reuse
and denial on HEAD drift. Legacy `pa-task-handoff/v1` select and JSON review-bundle
reuse remain separate typed contracts; no global string rename or parser weakening
was needed. Actual checkout/link/custody effects still demand their exact evidence.
The ticket selection observed at launch already recorded HEAD `abb8e5a`; the old
brief's stale-HEAD observation was not blindly replayed as a link repair.

### 5. Qualification inventory

All previous **34 installed groups remain**. Five groups are added: fresh
coordinator adoption, fresh native adoption, same-intent queue convergence,
selected existing initial handoff and issued-decision read diagnostics: **39 total**.
Every exact test anchor has a canonical source owner and must originate in that
file under the private installed harness. Same-count subcase substitution,
owner/lane swaps, duplicates, missing/skipped cases and foreign harnesses reject.
The explicit installed import/provenance/confinement guards remain unchanged.

## Actual checks and failures

| Check | Result and limit |
| --- | --- |
| Final workspace typecheck | Exit 0; `typecheck-final.log`. An earlier combined tool call timed out during typecheck; the separate final run passed. |
| Final workspace build | Exit 0; `build-final.log`. |
| Final mandatory core/Pi workflow/setup/catalogue/native source entry | **504 passed, zero failed/skipped/cancelled**; `mandatory-final.jsonl`. Uses real native owners/confinement/CAS plus labelled fixture consent/provider seams, NOT installed qualification or human UAT. |
| Source-owner anchor audit | All 97 exact anchors originate in expected source files; source lane only, not an installed report. |
| Script/verifier/portable-split regressions | **33 passed**, zero failures/skips; `scripts-final.log`. |
| Full workspace attempt | **NOT GREEN**: tool timed out at 1,200 seconds. Completed root scripts26/26; core1739 passed/14 optional skips; OpenCode104 passed/1 optional skip; Pi scripts11/11. Pi source had a runner-readiness failure and no final suite summary; runtime-host was not reached. These earlier counts do not cover later edge-case additions. |
| Background-runner independent rerun | **22 passed, 1 failed**: launcher/persistent-runner boundary did not establish ownership inside 4,000 ms. Current source failure; regression relation/cause not established. No timeout/safety weakening or host-load excuse. `background-rerun.log`. |
| Completions | Exit 0; generated completion files have no diff. |
| Candidate secret scan | Complete candidate scanned through an isolated temporary index; real index unchanged; see evidence record. No empty-index scan claimed. |
| Native selected template observation | 17 producers; selected config `519dc3945869de619f725e1f539320d61a8ba82c`, registry `86c78a59faf6b2130ef8a73c44112c94b584706d36ca54007a540d0c2d14b7d5`. Observation only, not final paired qualification. |

Earlier inventory regressions initially expected 34 rather than 39 groups;
corrected to assert the complete exact ID list, not a count-only pass. The
original temporary inventory log was reused by the rerun: its four assertion
failures remain in the tool transcript, not the final passing log. Full workspace
and independent runner failure logs are preserved separately; no failure or
timeout is reclassified as passing.

The currently selected installed `.2` store remains
`/nix/store/dpcyrw1sb8pgwgzv6bhv8iajk53dyy3a-pa-platform-0.1.154-pap273.2`;
its provenance is still `sourceSha=unversioned-dirty-source`, build config
`d4855185cecc3cb26af5d3ceec2133bc0297455f`. It is NOT this overlay and cannot qualify
it. No exact installed 39-group report, hosted result, independent approved
matrix/review, human UAT or production adoption is claimed.

## Requirements/case disposition

All AC/TS retain human/installed acceptance as **not run**. The following are
source dispositions, not 16 passing UAT cases or a replacement signed matrix.

| AC/TS | Source disposition |
| --- | --- |
| 1–2 | Implemented and tested: no-resume consent-gated same-run adoption; exact markers/unique journal selection. |
| 3 | Implemented and source-tested with real distinct process liveness/death, terminal-but-live, missing anchor, synthetic reused-incarnation and live resume descendant. Actual denied procfs permissions remain a host qualification case. |
| 4–6 | Implemented and tested: native consent bindings, CAS/multiprocess winner, interruption/lost reply, retired caller denial, immutable resources/history; explicit resume retained. |
| 7–8 | Source-tested readable/abort/control contract and cancellation/bounds. Actual small-terminal accessibility/readability is not run. |
| 9 | Implemented/tested independent structural/caller/stage and issued-versus-unavailable-read projections. |
| 10 | Preserved/tested safe analysis/review/queue independent of execution registration; source/check denial still enforced. |
| 11 | Implemented/tested exact same-intent prequeue convergence, conflicts, revocation, partial/already-correct state and concurrency. No real LM-101 repair performed. |
| 12–14 | Preserved/mandatory regressions passed. No shell-form Go/Nix/Android capability inferred from catalogue validity or Node observation. |
| 15 | Inventory/identity protections extended/tested; exact installed/hosted/matrix/human qualification BLOCKED/NOT RUN, full workspace NOT GREEN. |
| 16 | Actual typed producer/baseline and existing native materialization tests pass; legacy parser unchanged. Companion guidance/real owner handoff still separate. |

Each preserved C01–C116 obligation remains in the following disposition ranges:

| Cases | Source evidence / remaining gate |
| --- | --- |
| C01–C12 | Core adoption/revision plus default native host and readable capture positives/denials. Real foreground operator variants NOT RUN. |
| C13–C16 | Exact marker/ambiguous-run tests and retained-root/startup denials; no fallback. |
| C17–C24 | Native liveness/identity tests; actual unreadable-procfs and final installed host variants NOT RUN. |
| C25–C32 | Four-process and overlapping CAS, active resume-descendant denial, stale caller, capture interruption/lost-reply tests. No permissionless reservation is allocated. Real crash canaries NOT RUN. |
| C33–C40 | Evidence/caller drift, retained resource/config and replay guards; old-reader rejection follows the new strict event discriminator. Exact final installed/unsupported-host checks NOT RUN. |
| C41–C48 | Existing revision/cancellation negatives and new adoption-bound tests; scope cannot transfer arbitrary in-flight effects. |
| C49–C56 | Native scope paging/abort/technical-detail/control tests; actual small-terminal human UAT NOT RUN. |
| C57–C64 | Current-caller/status/launch and exact publication/interruption/queue tests. |
| C65–C72 | Safe producer field/rule and staged startup/effect-boundary regressions. |
| C73–C84 | Mandatory catalogue/task-required exact-command/confinement and bounded setup/operator lifecycle cases; real operator credential/onboarding UAT NOT RUN. |
| C85–C92 | Provenance/module/import audit negatives and honest lane separation preserved. Final Git package/host/CI/independent review/UAT NOT RUN. |
| C93–C96 | Typed initial-reuse and native materialization tests, marker/lineage guards. No automatic real link/checkout repair. |
| C97–C108 | Same-intent queue convergence/partial/conflict/stale/revoked/concurrent source tests; real LM-101 settlement NOT RUN. |
| C109–C112 | Issued/read-unavailable parity and package/queue/lifecycle separation tests; actual foreground staging is not completion or owner death. |
| C113–C114 | Mandatory same-count/source-owner/harness-lane substitution negatives pass. |
| C115–C116 | Runtime inventory retained/extended. PAPC-073 owns its explicit repo-setup matrix entry, original16 families/six followups and final paired evidence. NOT certified here. |

## PAPC-073/operator first unproven actions

1. Consume the delivered `adopt` and `coordinatorContinuation` contracts. Update
   guidance/UAT to describe fresh consent plus separate package recovery, not a
   mandatory `--resume` workaround. Preserve explicit resume and all original
   config qualification families/subcase owners; add exact new case identities.
2. Do not reapprove an unchanged approved/published LM-101 pair. Its owner must
   reauthenticate current revision/intent/pair and use supported reconciliation
   for the recognized partial queue state. Missing historical process anchors
   remain a specific blocker, not permission to fabricate liveness evidence.
3. Resolve/classify the full-workspace failure/timeout; obtain a green complete
   source run before claiming that gate. Do not weaken readiness/confinement.
4. Through the source/release owner, create the final clean Git candidate and
   review its exact diff. Build/package/install/select/reload only under separate
   actual authority; do not reuse dirty `.2` provenance or historical passing SHA.
5. Qualify the exact runtime/config/store/ABI/plugin pair with all39 groups and
   actual fresh/retained CLI/native hosts; obtain hosted results, independent
   approved full matrix/review, genuine operator UAT, then explicit adoption.
6. Resume LM-101/NX-067/TTL-017 only through their owners at first unproven action,
   preserving valid approvals/links/history and independent execution blockers.
   No Gmail/MIME/private-mail/device product work belongs to this repair.
