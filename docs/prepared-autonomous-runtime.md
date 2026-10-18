# Prepared autonomous runtime — inactive implementation notes

PAP-256 provides **CLI/runtime support for an agent-driven workflow**. This is
reference documentation, not active policy or an approval/activation receipt.
No configuration pin, review parser, historical lease, checkout allocation or
return is changed by merging this implementation.

## Scope reconciliation — operator direction, 2026-10-18

The operator clarified the delivery boundary: PAP-256 supplies reliable CLI/runtime
primitives, implemented code and verification tests. Agents verify implementation
and test results and mark work done through the ordinary workflow; a new
cryptographically/authenticated phase-completion protocol is not required.
PAPC-056 owns agent instructions, workflow guidelines, report templates and the
requirement to generate reports from actual work/check evidence. Those configuration
sources are not changed here. Existing admission, custody and Git safety protections
remain in force; prose or a done marker never bypasses them.

Automatic phase-end reports, terminal reconstruction, machine-certified outcomes,
viewer receipts and a multi-phase autonomous controller are **not PAP-256 CLI merge
requirements**. The optional native automation below remains inactive and its
unsupported paths are disclosed, not represented as completed features. The
historical broader automation/qualification plan is retained for context, not used
to block the supported independently usable CLI workflow. Normal PR code/test/CI
verification is separate from activation of that optional automation.

## Delivered core and Pi adapter

- `packages/pa-core/src/deploy/prepared-workflow.ts`: strict contracts, immutable
  protected records, ordered lock composition and a journaled preparation engine.
- `packages/pa-core/src/deploy/ticket-concurrency.ts`: durable preparation
  reservations in the **existing** repository capacity directory and mutex.
- `packages/pa-core/src/deploy/execution-custody.ts`: protected append-only
  plan/executor/operation/recovery journal, candidate-bound acceptance and fixed
  expected-remote-HEAD feature update primitive.
- `packages/pa-core/src/artifacts/phase-report.ts`: immutable source-bound report
  publication, redaction seam, existing-owner-report CAS/index and durable delivery
  evidence/debt primitives. Separate reading HTML reuses the existing escaped
  renderer; default Lavish/artifact rendering remains inert and byte-compatible.
- `packages/pi-pa/src/prepared-native.ts`: concrete fixed-location native
  policy/grant resolution, exact promoted-pair/13-check/matrix validation and
  native operator capture. This separates authority IO from tool/resource IO.
- `packages/pi-pa/src/native-execution-evidence.ts`: private original stdout/stderr,
  pre-dispatch process-incarnation/group frames, bounded output and retained native
  failure evidence. A printed success string cannot establish a successful check.
- `packages/pi-pa/src/execution-native.ts` and `native-execution-tools.ts`: concrete
  consumed-lineage direct-holder binding and lower Pi SDK write/edit/bash evidence
  producers. Unsupported executors/actions stop; this is not full Phase-3 acceptance.
- `packages/pi-pa/src/pi-extension/prepared-workflow.ts`: mode-scoped preparation,
  execution/feature-update/report tools, actual Pi custody hooks, native retry
  capture, caller correlation and a fixed Treehouse/Git preparation host adapter.
- Existing repository admission/materialization owners: callback-scoped vacant
  worktree locking, exact-approved-base creation and bounded crash reconciliation.

`preparedCapability()` remains a disabled informational projection, never enable
permission. The default Pi preparation tool now resolves its native authority from
fixed protected storage and verifies current promoted bytes; it no longer installs
an unconditional null resolver. **No live policy has been activated.** Protected
exact-revision qualification/activation/grant records are absent, so ordinary status
remains inactive and mutation requests reject before resource effects. The native
qualification producer and full execution/report integration remain incomplete.
The default execution resolver now supplies a concrete direct-holder adapter for
qualified consumed lineages. The default report resolver now supplies native live
capture/publication, owner indexing and source-bound foreground delivery observation;
terminal reconstruction and automatic phase-end collection remain unimplemented.
The actual orchestrator launcher now consumes authenticated ready records and
persists pre-spawn correlation; this is locally fixture-tested, not live-qualified. No public receipt or environment
flag supplies native authority. Tests exercise actual dispatch, source files, Git
and existing locks using isolated native qualification/Treehouse fixtures—not live
approvals, product acceptance or production allocations. Never call internal APIs
from an agent shell to manufacture activation or repair old authority.

## Capacity ownership

Both legacy process slots and durable reservations occupy the same four-permit
namespace under the existing repository ticket mutex. Preparation records use a
separate `<ticket-hash>.prepared.json` suffix, so even unreadable, malformed,
insecure or aliased preparation evidence is preserved and cannot be quarantined
by ordinary `--force` admission. Valid reservations count while preparing,
idle-ready, active, uncertain-retained or settled-retained; requester death never
releases them.

`withPreparedTicketCapacity()` supplies a synchronous, callback-scoped transaction.
It rejects expired callbacks, asynchronous results, duplicate ticket/operation/
reservation/permit/lineage identities and compare-and-swap drift. Its transitions
are preparing → idle-ready → active, or conservative uncertain-retained. An active
transfer requires a verified live orchestrator process and no in-flight operation.
The native consuming launcher can attach a private execution handoff to the active
reservation. Ordinary slot authentication, supervisor process transfer and matching
terminal finalization resolve that same record, not a second slot/permit. Terminal
or no-spawn failure releases execution capability into `settled-retained`; the
checkout and occupied permit remain retained for operator-owned disposition.
Malformed/aliased/conflicting legacy-plus-prepared records never become authority.
No delete, expiry, reclamation, lease return or reverse transition is provided.
Legacy process-slot cleanup remains with its existing owner; preparation conservatively
counts stale legacy evidence rather than reclaiming it itself.

Publication uses an exclusive temporary file, file fsync, no-clobber link (or
mutex-protected replacement), directory fsync and protected readback. Re-observation
reaffirms directory durability before a successor. Owner-only regular single-link
records are bounded to 65,536 bytes. Interrupted temporary files remain forensic
evidence, not another reservation.

## Pi tools and fixed resource adapter

The tool schema accepts only `{action: request|status|retry}`. There is no root,
argv, contract, receipt, author, enable or consume override. Native caller correlation
requires a foreground TUI requirements/analyze session, matching running Pi registry
identity, canonical roots, process incarnation/lineage and session identity. These
checks are not activation or promotion authority; the native binding/host must
independently resolve those. Auto/spike/background/rogue-one/builder and non-TUI
contexts cannot use this preparation tool. Legacy tools and other adapters retain
their existing registration and admission behavior.

A retry opens one fixed native selector, forwards cancellation, then reauthenticates
caller, source/policy binding and exact failed attempt. Its adapter-owned protected
record binds event UUID, operation, binding/caller digests, deployment/tool call,
attempt, failure digest and capture time. The service rechecks attempt/failure/time
under the repository mutex. Two dialogs against one failed attempt cannot retry
different attempts, and cancellation/revocation/drift never publishes a retry proof.
Status is allowlisted and never spreads protected host fields; oversized output
rejects instead of truncating a receipt into misleading evidence.

The resource adapter uses pinned Treehouse v3.1.3 acquire-or-reuse/status, the existing
repository capacity owner and checkout-specific vacant admission mutex. Any retained
lease/borrower/reviewer record blocks without cleanup, even if stale or malformed.
It performs a fixed `origin` fetch for the configured develop branch, then materializes
the exact approved full base, not a later local develop SHA. Other target/remote
semantics stop explicitly; no general shell/refspec controller is exposed.
Canonical checkout files/status remain unchanged. Production authority callbacks
must complete synchronously; a pending Promise or Boolean is never treated as approval.

After a crash between exact branch creation and ticket publication, only the same
live capacity owner, operation, vacant checkout, planned branch and exact approved
HEAD can finish publication without constructing a second branch. Legacy planned
branch races remain rejected. Unknown/changed work is preserved, never reset or
silently adopted. Repeated requests/consumption reuse one reservation; candidate
or ticket drift prevents consumption. The adapter's consume transition is now connected to actual builder/orchestrator
admission before planning, lease acquisition and preflight. The existing ordinary
slot view authenticates the same retained reservation. A protected native consumer
intent binds deployment/process/receipt before transfer; source-bound correlation
is fsynced in `prepared-consumption.json` before registry start/spawn. Ordinary
registry ticket/root/branch/slot/permit identifiers agree with that artifact; no
secret token or consumer record enters the model environment. This does not add a
new registry database field or independently qualify the installed runtime.

## Preparation engine

A host supplies the existing repository/worktree lock owners and authenticated,
fixed operations: reservation, allocation, branch materialization, structured
materialized-ticket reread, ready publication and same-reservation consumption.
The host is trusted runtime code, **never** model-supplied JSON or environment.
It must resolve native activation/caller identity, exact promoted sources and
approvals, current Git/Treehouse identity, explicit changed-base authority where
needed, and the exact consumer lineage. Public receipt parsing grants none of
that authority. There is deliberately no permissive default resolver.

Before any effect, the engine persists the contract-bound intent and an immutable
`started` event. Before each successor it persists the observed result. Replay
validates every predecessor digest, sequence, filename, timestamp, action and
receipt/ticket-reread binding; gaps, swaps and conflicting bytes fail closed.
It does not silently adopt Phase-1 result-journal bytes as service authority.

On resumption, the host must inspect the stable operation identity first. Only
positively proven absence permits an effect. A crash after an effect therefore
reconciles its existing result rather than allocating again. Unknown observations
block; host exceptions leave an unresolved intent, not fabricated success or
failure. Status performs no resource actions and withholds a receipt while any
outcome is pending. A crash-time hard-link alias is uncertain and is not repaired
automatically.

Capacity/known failures do not queue or retry on another ordinary request. Retry
requires independently authenticated, fresh native operator evidence, and that
reference/digest cannot be reused across attempts. Proven prior steps and original
failure evidence remain intact. Definitively uncertain results and failed consume
outcomes require owning reconciliation, not a preparation retry. Journal bounds
stop conservatively at 32 attempts or 256 events; reaching a bound grants no reset.

Ready publication follows all resource results and the matching final ticket
reread. A consume intent binds one authenticated lineage before capacity transfer;
a different lineage cannot replay it, including after a crash. The trusted launcher resolves only native protected ready state; it never accepts
a request/environment receipt. Absent/unrequested native intent retains the normal
independently authenticated CLI path. Pending/uncertain/consumed state cannot spawn
a duplicate lineage. Ready consumption performs no Treehouse get, branch creation,
unchanged ticket publication or setup prompt. After preflight, native policy/source,
Treehouse, candidate, correlation and live capacity identity are reread before
spawn. Dirty candidate or revocation stops without stash/reset/cleanup of content.
Local actual-deploy fixtures cover one allocation during preparation, same-permit
foreground consumption, preflight rejection and retained terminal capacity.
Supervisor-transfer compatibility is tested at the existing slot owner; actual
installed/background/parent-child qualification remains acceptance work.
Consumed launches now bind a digest locator in the existing immutable registry
started-event note. This is not a grant: missing or contradictory correlation
fails closed, including after extension reload, instead of becoming legacy mode.
Only consumed native launches use the 120-minute default execution window (whole
minutes, 60–240 minutes). Invalid explicit bounds reject before consumption;
unrequested/legacy launches retain their existing timeout behavior.

## Concrete native preparation authority

`pa_workflow_policy` is registered only alongside foreground requirements/analyze.
Its action-only schema offers status, activate, bind and deactivate. Mutations
require fixed native TUI selectors, fresh caller correlation after the dialog and
fresh source/revision rereads. It cannot qualify a runtime, run the matrix, supply
an arbitrary root/source/author/argv, or self-certify human UAT. Cancellation/drift
publishes no grant. Activation and source adoption are distinct; neither performs
checkout/resource actions. Ordinary preparation then reuses the captured binding
without repeating source/setup prompts.

Native authority roots derive from the OS account home, not `HOME`, `PA_PLATFORM_DATA`
or artifact/config environment overrides. Ordinary read/write/edit and bounded
shell operands deny the native authority namespace and ticket-slot storage,
including filesystem aliases. Trusted native services use their narrow private
IO owners instead; public status never spreads those records. This remains a tool
boundary, not confinement of arbitrary out-of-band code or a general OS sandbox. Owner-only regular single-link records
are bounded and published under the existing repository capacity mutex. A concrete
installed-runtime reader requires the running Nix-store module, packaged version,
source/config provenance and exact clean registered config revision contained in
origin/develop. A source checkout cannot activate itself. Production activation
also requires protected exact-runtime/config native review, CI, pairing, human-UAT
and delivery qualification receipts. **The authorized producer of those final
qualification receipts is not implemented yet; their grammar/readback is not a
claim that qualification occurred.** Public report/ticket prose is never substituted
for that native qualification or operator capture.

The native adoption verifier reads exactly selected attached requirements and UAT,
requires approved interactive-analyst/builder route, verifies all thirteen final
checks and raw pair/matrix hashes, parses the existing versioned matrix without
changing its commands, and corroborates exact branch/base/durable comment evidence.
It handles retained amendment bases independently of the specialized review-launch
parser, without editing that parser or fabricating fresh-only headers. Planned
links retain their existing no-SHA grammar; materialized links must preserve the
approved base. Ticket source primacy is not guessed from a builder implementation
report. A native operator selects/authenticates the exact promoted pair before a
protected grant is written; existing public author strings alone cannot create it.

Default service authorization resolves those same protected policy/grant records
and revalidates caller/source identity at resource boundaries. Revocation blocks
new optional requests without deleting resources or resetting caps. Same-revision
reactivation after revocation is deliberately unsupported, not an implicit retry
or migration. Native consuming-launch authority is separate: analyst authorization still rejects
consume, while the real launcher authenticates a distinct private consumer intent
and transfers the same reservation. No author string, public receipt or raw CLI
argument can supply that native intent.

## Execution custody and recovery primitives

The execution service stores an immutable binding and hash-chained commands using
`ProtectedWorkflowStore`, with mandatory existing capacity/admission lock owners.
Its identity is stable across candidate, plan, executor and bound changes; a new
binding cannot overwrite the old journal to reset caps. Native callbacks must
return synchronously and prove caller/process/registry identity, current policy,
Git/scope evidence and existing authority settlement. Boolean/async authority,
missing references, gaps, insecure records and aliases reject before successors.
These required ports are **not** a production admission integration by themselves.

A bounded written plan records paths, traceability, prerequisites, named checks,
size, complexity and rationale before selecting direct, implement or review
custody. There is no numerical task-size threshold. Only the exact source holder
can begin a write/edit/shell/check operation. Begin is durable before dispatch;
started operations survive restart and cannot be cleared by model-supplied close
flags, cancellation, quiet logs or shutdown. Handover requires the native owner to
prove registry/process/Git/finalization settlement. New source effects invalidate
check/acceptance evidence before they run, including when they subsequently crash.

Failed checks retain their first exact candidate/command/exit/output evidence.
A failed operation blocks another writer until a settled evidence-bound recovery
attempt is recorded. New diagnostic/remedy digests plus rationale may qualify as
progress; the service verifies identities, not semantic novelty. Third consecutive
no-progress stops new work. Runtime deadline, three replacement and independent
review limits survive replan/executor/restart/rebase. The third permitted
replacement can still do its work; the limit rejects a fourth replacement.
Rebase records SHA mapping and invalidates checks/review/CI/UAT/integration.
Integration evidence requires fresh exact-candidate review, CI and human UAT;
this primitive neither launches review nor grants merge/done authority.

`pa_execution` accepts plans or evidence references, never a process/capability,
privileged path, arbitrary argv or self-certified terminal result. Actual Pi
`tool_call`/`tool_execution_end` dispatch gates supported write/edit/shell aliases,
launch tools and unknown effectful tools. Read/status tools remain usable while
child custody exists. Native command matching identifies named phase checks.
In-flight work excludes concurrent operations and handover. Bound lineages cannot
fall back to legacy behavior when their resolver disappears. Untracked user-bash
execution is rejected for a bound lineage because that event has no supported
source-bound completion barrier. This is a managed tool boundary, not an OS
sandbox or control of arbitrary external terminal processes.

### Concrete native direct-holder increment

A real consumed launch must authenticate its private grant/consumer, immutable
registry locator, original Pi launch fingerprint, live registry/capacity/lease,
physical linked checkout and unchanged source/runtime policy. The direct adapter
uses the existing capacity → worktree mutex composition. Only after authenticated
session startup does it replace the actual SDK write/edit/bash implementations;
never-adopted/inactive sessions keep their original built-ins. Revocation blocks
new source work but retains status, existing result settlement and the journal.
Source/context/correlation drift never supplies a fresh binding or resets bounds.

`pa_execution observe` produces native holder, inventory, last-result and recovery
references; no tool accepts a caller's process, command-result or novelty flags.
Write/edit lower operations use dirfd-relative no-follow traversal and reject
hardlinks. Before another source action, full NUL status, both rename endpoints,
changed-file content hashes and current HEAD must match the last native result.
Unknown/unrelated changes are retained and block progress, even if a plan names
those paths. A scoped descendant commit advances only the mutable owner snapshot,
preserving the immutable launch snapshot and without manufacturing child evidence.
Every intervening commit's changed paths are checked, not merely the net tip diff.
The native execution status carries the current candidate; ordinary registry launch
correlation is not represented as a new independent source controller.

Named developer checks are currently typecheck/build/test/completions/secrets-scan
with fixed commands. These are **not** the full approved matrix or review/CI/UAT.
Original process channels remain private, with 16-MiB per-channel bounds; a limit,
timeout, abort or unproven group never becomes a passing check. Public SDK output
is redacted before logs/temporary output; unknown sensitive-pattern extent withholds
that output rather than leaking the remainder of a private key. Failed non-check
operations have separate implicit failure channels, not fabricated named passes.
A native failed recheck can open a bounded retry, incrementing no-progress. This
adapter deliberately claims no semantic diagnosis/remedy novelty. Only a fresh
matching successful action/check can resolve that original failure.

Process frames are fsynced while the child waits before dispatch. Observed remaining
process-group members retain the started barrier, including after leader exit zero.
This manages the recorded group, **not arbitrary detached/escaped descendants**;
escaped-descendant custody and trusted terminal reconstruction remain qualification
work. There is no OS-sandbox or complete sole-writer acceptance claim here.

Native delegation/review reservations, semantic-progress evidence, rebase adoption,
privileged feature update, cross-phase transitions and independent acceptance
producers remain unsupported. The actual parented launcher refuses an adopted
native parent before borrower/spawn effects until its native launch producer is
delivered; it cannot quietly use legacy admission to bypass the new barrier.

`pa_feature_update` persists native exact-candidate/expected-HEAD intent, then uses
only fixed `origin`/ticket-feature argv with explicit force-with-lease, no mirror,
no tag following and no recursive submodule push. It verifies remote and local
identity before/after; a remote race rejects. Generic shell force-push denials and
normal hooks are unchanged. Failure retains the started operation for owning
reconciliation; it is not an automatic privileged retry. The mandatory native
adapter must authenticate both configured origin and push URL, persist private
command/output/exit evidence, and verify scope/custody before this primitive runs.

## Report publication and settlement primitives

Report input requires identity/attempt/outcome/timestamps, full base/candidate or
honest unknown/no-commit, all fifteen evidence sections, exact command/result/output
records and earlier attempt references. Missing sections and inconsistent passes
reject. Native verification must authenticate complete Git inventories (including
both rename endpoints and binary/untracked metadata), checks, original failures,
accepted progress and any labelled reconstruction; parsing alone cannot do so.
There is no implemented automatic terminal-data collector/reconstruction producer.

A native-constructed fixed artifact root receives absent-only `report.md`,
`report.html` and digest metadata under dated phase/deployment/attempt paths.
Publication fsyncs and re-observes regular single-link owner-only files; symlinks,
conflicting bytes, aliases and tampering stop without overwrite/repair. Attempts
remain immutable on partial publication/index failure. Explicit private-value
scrubbing plus mandatory existing sensitive-pattern/native public-content checks
run **before** any public persistence. That seam is not a universal DLP guarantee.
Safe diff production/redaction and full provenance remain native-host obligations.

Reading HTML preserves escaped text, tables/code and source anchors. Only
native-allowlisted report-relative public companions/fragments are navigable;
external/script/encoded/traversal links remain inert. It is separate from Lavish.
Canonical files are bounded at 1 MiB Markdown / 4 MiB HTML. The existing owner
Markdown gets idempotent CAS-bound report and source-bound delivery entries, not
another workflow database. Contradictory metadata/outcome/index text blocks.

HTML generation alone records browser/Obsidian debt. Actual native operator or
labelled retained manual observations must bind both source and HTML digests.
Their immutable owner-index references survive service restart and are revalidated
before settlement. Missing canonical/check evidence blocks dependents; delivery
debt permits otherwise authorized work but blocks phase-delivery readiness. No
report status asserts product UAT, activation, ticket completion or OS confinement.
Ticketless rogue-one report registration adds no builder/ticket admission gate;
its default publication still requires a real native artifact/evidence binding.

### Native live-report increment

`pa_phase_report capture` accepts only `phaseId`, `summary`, `nextAction` and
`learning`. Narrative is explicitly labelled agent-provided, never acceptance
proof. The tool captures the real live Pi incarnation/registry/physical checkout,
full NUL Git inventory, and (where available) the adopted native execution journal.
It returns an opaque protected source reference; `publish` resolves that reference
and returns the protected report reference plus fixed Markdown/HTML/diff/owner
reading locations. No caller path, outcome, check list or passed flag is accepted.

Only recorded native developer-check operations populate the check table, with
original candidate, command, exit and private-output reference; writes/commits are
separate settled operation references, not extra passing checks. Historical
failures remain visible after successful rechecks. A source-proven idle direct
holder gets the **full** scoped text diff from the original launch base, including
committed changes and untracked files; binary contents are omitted, with metadata
retained. Unknown/unrelated scope and in-flight processes yield metadata-only
partial reports. Explicit environment/lease/capability values and sensitive
patterns are scrubbed before any public output. The immutable fixed `diff.patch`
and `diff.json` companion are verified again at settlement; excerpts are only
reading aids. Private inputs remain in the existing native protected namespace,
partitioned by deployment, not a new workflow/resource owner.

Rogue-one (including ticketless) and report-only implement contexts capture no
inferred check passes or source permissions. Rogue-one startup now records its
real Pi process anchor without acquiring builder admission. A captured native
policy authorizes only that runtime's artifact owner intent; revocation may settle
its existing report lineage but cannot reactivate automation or migrate code.
The dated runtime owner Markdown is created/indexed idempotently and subsequent
CAS updates preserve its existing non-managed content and delivery history.

`observe-delivery` requires a live foreground TUI and an actual operator choice
about the exact source-bound browser or Obsidian view. Both canonical digests are
shown, and authority/bytes are rechecked after the UI turn. Cancellation, RPC,
JSON/print, source replacement or a forged caller observation cannot record it.
Observations and debt survive reload/revocation. This is **not** an automatic
browser opener, verified DOM/Obsidian plugin receipt, or product UAT. Delivery debt
is independent of current check evidence: unproven and historical reports remain
readable/indexed but block dependents. A partial report alone cannot grant phase
advancement; otherwise authorized bounded work still needs current native checks. This live
producer emits only partial or native-failed outcomes, not inferred phase success
or terminal interruption. Automatic phase-end/terminal reconstruction and exact
phase-completion/acceptance producers would be needed only for the broader optional
automation, not the agent-generated-report/ordinary-done workflow above.

## Historical broader automation plan — not CLI merge requirements

The items below describe unimplemented or unqualified optional automation. They
are not an assertion that the supported CLI workflow needs a new authenticated
done protocol, native report generator, or automatic viewer observation. Keep the
optional path inactive; any future activation must still satisfy its actual gates.

1. Complete Phase-2 acceptance: deliver the authorized final native qualification
   producer and verify actual installed/background/parent-child consumption and
   migration. Default native resolution/capture and real orchestrator ready
   consumption/correlation are implemented, but fixture qualification records are
   not production activation or installed qualification. Prepared resume/migration
   is not silently inferred; unsupported transitions retain resources and stop.
   Never synthesize a protected receipt from factual CLI output.
2. Complete Phases 3–4 integration beyond the native direct-holder increment:
   implement native delegated/review/feature-update/rebase and semantic-progress
   producers, escaped-descendant/terminal settlement, automatic terminal/phase-end
   report production and exact phase-completion proofs, cross-phase lineage-bound
   handoff and installed browser/Obsidian qualification. Native live safe-diff/report
   publication and foreground operator observation are implemented, including
   ticketless rogue-one, but do not establish those missing journeys. Current journals reject
   changing phase via a plan edit; they are not an independent multi-phase
   controller or proof of production sole-writer enforcement. The direct fixture
   now traverses actual launch, SDK filesystem/process operations, native records,
   registry and existing owners, while qualification and Treehouse responses remain
   isolated fixtures. Installed integration and phase acceptance remain unverified.
3. Phase 5: finish the isolated runner, paired migration/rollback fixtures, exports,
   tool packaging and complete automated AC coverage. The existing runner still
   intentionally rejects all ten matrix expansions.
4. Independent review/CI and Phase 6 human UAT/readiness remain separate. The approved
   amendment consumer and installed paired-runtime-ready/PAP-235 dependencies must
   actually be resolved before review. No header aliases or fabricated readiness.
5. Native operator activation remains a separate exact-revision decision; no active
   lineage is automatically upgraded and no checkout is returned automatically.

## Focused development checks

```sh
corepack pnpm --filter @pa-platform/pa-core typecheck
corepack pnpm exec tsx --test packages/pa-core/src/__tests__/prepared-workflow.test.ts packages/pa-core/src/__tests__/treehouse-ticket-concurrency.test.ts packages/pa-core/src/__tests__/execution-custody.test.ts packages/pa-core/src/__tests__/phase-report.test.ts packages/pa-core/src/artifacts/__tests__/render.test.ts
corepack pnpm exec tsx --test --test-concurrency=1 packages/pi-pa/src/__tests__/prepared-native.test.ts packages/pi-pa/src/__tests__/native-execution-evidence.test.ts packages/pi-pa/src/__tests__/pi-prepared-workflow.test.ts packages/pi-pa/src/__tests__/pi-execution-custody.test.ts packages/pi-pa/src/__tests__/pi-phase-report.test.ts packages/pi-pa/src/__tests__/treehouse-runtime.test.ts
corepack pnpm exec tsx --test scripts/dev/validate_prepared_workflow.test.mts
```

Tests use disposable local repositories, protected directories and fake native
approval/Treehouse hosts. The fixed adapter exercises real local bare-remote fetch,
Git materialization, ticket publication and existing capacity/worktree locks.
Cross-process tests cover shared capacity, requester exit and concurrent journal
reconciliation. None is a production-policy,
human-delivery, general OS-sandbox or full acceptance claim.
