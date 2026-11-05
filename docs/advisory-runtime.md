# Advisory-first runtime (PAP-277)

Source baseline: `6f7d3462f805ab9f217473da64c2e80f9b9ee395` (0.1.155).
Requirements/UAT: PAP-277 r004, published native decision
`decision-9404b043-44ff-4fdf-b95a-c9740dd7bbd6`. Package approval is not UAT.

## Phase 1: shared result and policy interface

`packages/pa-core/src/operations/result.ts` exports `pa-operation-result/v1`.
This is an additive data contract, not a new workflow, grant, evidence store or
approval importer. The parser validates structure, not the truth/authenticity of
caller-provided observations. Only existing operation/evidence owners can issue
facts; consumers must resolve evidence through those owners. No model-facing
operation accepts a supplied result, passed flag or human decision as authority.

Dimensions are independent:

- `completion`: completed, cancelled, timed-out, error (execution completion).
- `outcome`: passed, failed, warning, unknown, skipped (domain observation).
- `enforcement`: allowed/denied (this operation only).
- `capability`: available/unavailable (this capability only).
- `required`: explicit requirement for this observation, not permission.

Each envelope binds an operation ID/kind/time to observed source/input scope,
findings with stable codes/severity/correction owner/next action, actual nullable
process exit/signal, timeout/abort/cleanup facts, evidence refs/digests/versions/
freshness/covered scope, bounded redacted output and inline or referenced payload.
Missing observations remain null/unknown. A current digest is not proof by itself.
A pass requires completed, allowed, available, nonfailed settled process facts
(if a child exists) and current evidence covering the observed source. Historical
context may be exposed without certifying it. Original failures remain immutable;
a later pass has a distinct operation identity and does not overwrite a failure.

CLI wrapper exit precedence: denial **3**, cancellation **130**, timeout **124**,
invocation error/unavailable/incomplete process/required unknown or skipped **2**,
failed check **1**, passed/warning **0**. Explicitly nonrequired unknown/skipped
may exit 0, but never counts as passing. Actual child exit/signal stays separate.
Native domain failures, denials and cancellations are inspectable data;
`operationNativeIsError` reserves invocation-error status for completion=error.
A host's transport failure still follows that host's error semantics.

Example: a test child exits 17: completed/failed/allowed/available, child exit17,
CLI exit1, native domain data. Inspect/repair/recheck remains available. A missing
optional template: skipped/unavailable with a named owner, CLI exit2, not approval.
A protected mutation: denied with its security finding, CLI exit3; correct the
input or consult the owner, never retry via aliases to bypass the denial.

### Bounds and evidence

Public text <=50KiB and 2000 lines; complete compact JSON <=64KiB. UTF-8,
duplicate decoded JSON keys, depth, fields and cross-field invariants are checked.
`boundOperationOutput` clips already-redacted text at scalar/line/JSON boundaries;
truncation requires an existing-owner full-evidence ref. Oversized inline payload
must be published/referenced by its existing owner, not silently dropped. Ref
resolution retains that owner's authentication/access checks. A serializer is
not a file reader and does not create an unrestricted evidence endpoint. Known
sensitive output rejects without echo; redaction configuration failure is local
to this result. Owner redaction must precede formatting, including streaming.

PAPC-074 owns check selection, order, retries, reviews, escalation and adoption.
Changing policy does not change this contract or grant security exceptions.
Neither an available capability nor successful command certifies review/CI/UAT.
Legacy formats/exits remain unchanged until explicitly version-dispatched;
subsequent adapters must select `--format pa-operation-result/v1` explicitly.

## Phase 2: capability and adapter surfaces

Both `ppa operation` and `opa operation` dispatch the same core service:

```sh
ppa operation capabilities --format pa-operation-result/v1
opa operation run --command 'corepack pnpm test' --timeout 1200 --format pa-operation-result/v1
```

`pa_operation` is Pi's native equivalent with one strict JSON `request`.
OpenCode has the shared CLI and safety hook, not a native `pa_operation` tool;
discovery reports that difference explicitly. An unauthenticated execution
request is unavailable, not permission to run or a session stop. Discovery does
not require optional project configuration. The operation service never imports
model-supplied facts, uses no command catalogue, and creates no phase controller.

The existing native evidence/process implementation moved unchanged into
`pa-core/src/operations/evidence.ts`; the Pi module is a compatibility facade.
Original record versions, references, bytes, process frames and private channels
remain unchanged. Check failure returns the actual child exit as data. Native
invocation errors use error status. Timeout/abort/output limits retain facts and
owned cleanup rather than a forged pass. Whole-buffer redaction precedes output.

New-start dispatch and removal of old ordinary-tool prerequisites are staged
behind native registry identity; the producer and local writer integration land
atomically in Phase 3. Phase 2 alone does not activate advisory sessions.
Source adapter tests exercised actual CLI/native dispatch and real disposable
children, not installed binaries or foreground agents.

## Veto/controller inventory

Paths below are relative to `packages/`. These are gate families, not a claim
that every throw is a procedural veto. S=security/input/provenance, I=operation
integrity, C=coordination/capacity, P=workflow policy. Mixed families are split
by predicate. **Nothing is removed by Phase 1.** Later changes require native
new-run dispatch; retained/unmarked/ambiguous runs keep historical semantics.
Tests named here are source suites, not installed/foreground acceptance.

| ID/category | Source / caller closure / owner | Input -> output and rejection scope | New-run disposition / recovery / tests |
|---|---|---|---|
| G01 S | `pa-core/src/safety-policy.ts` evaluateSafetyPolicy; Pi `pi-extension/safety.ts` -> index tool_call; OPA `plugins/pa-safety-activity.ts` before hook | shell/path semantic operands -> local decision; destructive/deletion/protected/admin/traversal/symlink | retain; correct safe operation or operator owner, no alias retry; safety-policy, pi-extension, opencode safety tests |
| G02 S | core sensitive-patterns, selected-config-source, repos, deploy/runtime-config; both deploy/adapter/CLI paths | content/path/runtime/provider/repository identity -> local validation | retain bounded input/config diagnostics; correct dependent input only; sensitive-patterns/runtime-config/repos tests |
| G03 I | core deploy/repository-admission: acquire/authenticate/inspect/transfer/finalize leases and borrowers; Pi deploy/native execution/child reconciliation; OPA deploy/background runner | physical Git/root/process/token/live or uncertain holder -> conflicting mutation/launch denial | retain; native matching-owner reconciliation, no unrelated-read barrier; repository-admission/finalization, child reconciliation tests |
| G04 C/I | core deploy/ticket-concurrency: acquire/authenticate slots, withPreparedTicketCapacity; Pi deploy/treehouse/prepared-native | same repo/ticket lineage, four permits, live process -> atomic admission | retain one lineage/four-checkout ceiling; wait/owner reconcile, never fifth/duplicate; treehouse-ticket-concurrency, prepared-native tests |
| G05 P | core deploy/plan + Pi deploy/workflow-consumers assertPiStructuredLaunchPrerequisites/resolvePiStructuredBaseline | ticket queue/package/publication/source intent + command profile -> ordinary-builder admission | remove prerequisite for genuinely new advisory work; PAPC chooses procedure; execution-plan/workflow-consumer/pi-workflow-runtime |
| G06 S/I | same consumers authorizeStructuredConsumer, core workflows/consumers, evidence/revisions | exact retained subject/decision/resource/intent bytes -> use of THAT protected workflow transaction | retain for existing workflow effects, not ordinary tool permission; same-run exact-intent reconciliation; workflow-state/consumer/adoption |
| G07 P | Pi execution-native assertToolCall/resolveCheck/#phaseFacts; project-command-contract; native-execution-tools built-ins | source plan/path/check catalogue/hash/order, commit-after-all-pass -> veto bash/write/edit | remove ceremony in new advisory sessions; PAPC task scope/check policy; project-command-*/native-execution-*/advisory-runtime |
| G08 S/I | same native execution scopedPath/file/prepareOperation/execute/resolveToolResult + native-execution-evidence | physical caller/input/current resource, native process frames and exact begin/finish -> own conflicting effect/evidence rejection | retain safe inputs, actual process identity, atomic write and truthful completion; preserve uncertain intent; native-execution-evidence |
| G09 P | core deploy/execution-custody runnable/transition + Pi prepared-workflow createPiExecutionModule hooks | plan/phase/recoveryPending/originalFailure/check-pass/review/replacement/no-progress/deadline counters -> new-work veto | phase/order/retry/review/workflow deadline advisory for new runs; PAPC handles failures; execution-custody/pi-workflow-runtime |
| G10 I | same custody transition begin/finish/settle/restart and ProtectedWorkflowStore | active holder/in-flight/reused operation ID/CAS/hash chain/native evidence -> conflicting transaction denial | retain locks/idempotence/unknown effects; owner same-intent reconcile, independent diagnosis available; execution-custody/workflow-execution-restart |
| G11 P | core deploy/prepared-workflow nextPreparationAction/replay; Pi prepared-native/validation launch/workflow host | mandatory preparation steps, retries/ready/consume and package queue -> ordinary admission | optional/legacy capability only, never mandatory new tool setup; prepared-workflow/pi-prepared-workflow |
| G12 I/C | same preparation store/locks + ticket-concurrency/repository-admission | protected native receipt/reservation/consume intent -> atomic allocation/custody transfer | retain lock order capacity->worktree->journal, native one-shot effects, exact receipt recovery; prepared-workflow/prepared-native |
| G13 P | core repo-setup/project-command-catalogue + Pi project-command-contract/workflow-consumers/execution-native | registration/approval/input hashes/task-command catalogue -> ordinary source/check prerequisite | optional new capability, retained legacy execution only; missing/malformed optional capability affects its call only; repo-setup/catalogue/source tests |
| G14 S/I | core repo-contract-authority/repo-contract-git/repo-setup-inputs/catalogue-files; Pi repo-setup-native/extension repo-setup | operator credential/approval/revocation, safe candidates/paths/locks -> own privileged setup effect | retain operator-only provenance and path/input safety; operator corrects optional setup, never model approval; repo-setup/native tests |
| G15 P | core workflows/service eligibleSteps/projectWorkflowNext/requestStep + registry/workflows; Pi workflow-host/source/matrix/consumers/resume/config | graph/step ordering, capability/profile, package permissions -> pinned step progression | no general ordinary tool gate; PAPC policy for new advisory work; retained graph stays versioned; workflow-state/owner/CLI/runtime |
| G16 S/I | same service replay/requireDecision/perform/reconcile + registry journal, ticket-owner and decision captures | exact revision/hash/owner/human capture and pending intent -> local transaction authorization/CAS | retain actual human provenance and idempotent uncertain-effect rejection; exact-intent owner recovery, never fabricate settlement; workflow-owner/adoption/revision |
| G17 P | Pi review-preflight/review-v1-launch/validation-launch/validation-supervisor/workflow-matrix | prescribed review launch/order/budgets/caps + approved matrix -> review operation | optional review remains factual; no safe-tool dependency; retained protected-review route unchanged; review-preflight/pi-validation-executor |
| G18 S/I | same review launch + core validation/review-contract/executor; repository review reservations | authenticated exact candidate/matrix/input, isolated workspaces/process/output/host bounds -> own review execution | retain genuine exact-artifact provenance, reservation conflict and bounded execution; no claim of product acceptance; review-contract/validation suites |
| G19 S/I | core deploy/background-ownership/control; both adapters/background runners; Pi runtime-start-gate/process-identity/native-host | owned process lineage, runtime exec gate, real host/per-operation timeout, SQLite binding -> local execution/cleanup | retain limits/cleanup, foreign process exclusion; unavailable only dependent execution; background-ownership/pi-background-runner/native-host |
| G20 P | Pi workflow-resume/execution-native report and phase-report-native; core artifacts/phase-report | workflow-derived deadline/phase completion/report/delivery -> continuation/report readiness | advisory for new ordinary work, never equate generated report with observation/UAT; phase-report tests |
| G21 S/I | same report/capture + operator-origin/operator-terminal/decision-payload, templates service/registry | native facts vs narrative, authentic foreground human, selected template bytes/context -> own publication/capture/retrieval | retain provenance/digest/sensitive/path bounds; missing template does not veto unrelated tools; template-service/provenance/pi-phase-report |
| G22 P exception | core deploy/rogue-one, deploy/plan and both deploy adapters | exact rogue-one selection -> explicit historical admission bypass | preserve existing exception/audit, NOT advisory-mode selector or security bypass; rogue-one/execution-plan tests |
| G23 S/I exception | core readonly-helper-context; Pi deploy helper routes/child-reconciliation/dirty-borrow approval | authenticated read-only helper or supported matching borrower -> narrow local observations/mutations | retain ownership/context restrictions, no new broad bypass; readonly helper/reconciliation/dirty-borrow tests |
| G24 P/transport | core CLI and both CLI entry points; Pi extension tool-result/native-execution-tools; OPA hook result summaries | old status/errors/throws/truncation -> transport and blanket negative-result guidance | additive explicit v1 output; failed check is data, only invocation error isError; legacy selectors unchanged; result-contract/advisory adapter tests |

Cross-cutting persisted controllers are existing registry events/workflow journal,
protected preparation/execution store, repository leases/borrower/settlement,
ticket slots/materialization intents, review reservations/attempt journal and
operator contract authority. No second permission ledger is introduced. Native
start-version dispatch belongs to the registry owner; model/env/ticket prose is
not a new-run version. Live/uncertain effects continue to exclude conflicts.

## Consolidation dispositions (all cancellations are NOT acceptance)

Original source: `deployments/d-329c19/artifacts/ticket-consolidation/review-and-decision.md`.
No signed artifacts, branches/tags, original failures, pending effects or holders
are rewritten by this inventory.

| Ticket | Disposition / successor / acceptance debt |
|---|---|
| PAP-172 | adopt routing intent in PAPC-074; retire global routing veto (G05/G17); fresh review evidence required |
| PAP-180 | retain loader/safety in PAP-277; policy in PAPC-074 (G01/G02/G15); adapter qualification still owed |
| PAP-185 | adopt factual telemetry (G08/G24); retire procedural enforcement; no performance claim |
| PAP-233 | retain checkout/base/candidate facts (G03/G18); PAPC owns reconciliation/review schedule |
| PAP-254 | adopt impact observations; retire global input-hash gate (G07/G13); old passes never transfer to new bytes |
| PAP-262 | retire mandatory preparation activation (G11); retain optional preparation/capacity; installed/human debt retained |
| PAP-264 | retain direct-holder/process/writer integrity (G03/G08/G10); retire old controller rollout; acceptance unpassed |
| PAP-275 | adopt source/caller audit (G01–G24); no historical audit completion inferred |
| PAP-276 | adopt no-catalogue intent (G07/G13); retire routine runtime controller; retain approved r002 and pending queue intent unchanged |
| PAPC-009 | PAPC-074 adopts independent review/UAT policy; no runtime-wide routing veto |
| PAPC-013 | PAPC-074 adopts validation/amendment/readiness; retires obsolete matrix ceremonies |
| PAPC-022 | PAPC-074 adopts failure taxonomy/repair/escalation; retires mandatory child/STOP assumptions |
| PAPC-025 | PAPC-074 retains needed branch/handoff facts; retires duplicate ordinary-work ceremony; resources untouched |
| PAPC-027 | PAPC-074 adopts exact review inputs/failure accounting/reporting; no retrospective pass |
| PAPC-029 | PAPC-074 adopts readiness/incident guidance; retires blanket relaunch for recoverable failure |
| PAPC-031 | PAPC-074 adopts base/candidate drift and review/CI/UAT; no implicit merge |
| PAPC-033 | PAPC-074 retains authenticated worktree/canonical distinction; no canonical mutation |
| PAPC-036 | PAPC-074 retains distinct approval/launch/base and exact-candidate acceptance |
| PAPC-037 | PAPC-074 adopts branch-local checks and final-candidate reconciliation |
| PAPC-038 | PAPC-074 retains real mode/root/owner identity; no unsupported adapter grant |
| PAPC-044 | PAPC-074 aligns nonsecret evidence/security exceptions; no private fields demanded from model |
| PAPC-045 | PAPC-074 adopts shared conflict/decision reuse; PAPC-048–055 remain independent |
| PAPC-057 | retire old workflow activation; retain merged optional capabilities/deferred acceptance; PAPC-039 remainder |
| PAPC-073 | retire mandatory setup/catalogue rollout; retain source/config/qualification debt; PAP-274 optional customization |

Retained exclusions: PAP-273/PAPC-039 pairing/protected-review/qualification;
PAP-241/242/255/259/263 incidents; PAPC-012/014 accounting/acceptance;
PAP-270/PAPC-071 templates; PAP-274 customization; PAP-246 diagnostics;
PAP-265/PAPC-065 quality; PAPC-069 design; PAPC-048–055 team investigations.
Done PAP-271/PAPC-070/PAPC-072, PAP-256/PAPC-056 and PAP-268/PAPC-068
stay historical. Cancellation neither releases resources nor settles PAP-276.

## Qualification ledger

Phase 1 source checks: result-contract 7/7 passed; workspace typecheck passed;
secret scan and whitespace check passed (d-ceb124). No runtime behavior activated.

Each phase is source implementation, not installed adoption. Installed exact
runtime/PAPC pair, real foreground transcript, independent 14-command matrix,
hosted CI and Sinh's human UAT require separate evidence. Missing candidate,
readiness or authorization blocks that qualification only; never use source
fixtures as installed or human acceptance. No installation, activation, push,
merge, checkout return or retained-state migration is performed by this work.
