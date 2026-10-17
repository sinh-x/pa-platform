# Prepared autonomous runtime — inactive implementation notes

PAP-256 is **partially implemented**. This is reference documentation, not active
policy, an approval receipt, or a claim that the whole ticket is delivered.
PAPC-056's separately verified existing-tools workflow does not depend on this
optional automation. No configuration pin, review parser, activation, historical
lease, checkout allocation or return is changed by this implementation.

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
qualification producer, execution/report evidence adapters and ready-consuming
builder-launch integration are still incomplete. No public receipt or environment
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
idle-ready, active or uncertain-retained; requester death never releases them.

`withPreparedTicketCapacity()` supplies a synchronous, callback-scoped transaction.
It rejects expired callbacks, asynchronous results, duplicate ticket/operation/
reservation/permit/lineage identities and compare-and-swap drift. Its transitions
are preparing → idle-ready → active, or conservative uncertain-retained. An active
transfer requires a verified live orchestrator process and no in-flight operation.
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
or ticket drift prevents consumption. The adapter's consume transition is tested,
but it is not yet connected to the real builder spawn/correlation path.

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
a different lineage cannot replay it, including after a crash. Core consume tests
are not proof that the current production builder launcher supports this protocol.

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
or artifact/config environment overrides. Owner-only regular single-link records
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
or migration. Native consuming-launch authority is separate and still rejected by
the preparation-only authorization path until launch integration is delivered.

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

## Remaining delivery

1. Complete Phase 2: connect native prepared grants/reservations to trusted builder
   launch/correlation and deliver the authorized final native qualification producer.
   Default preparation authority/source resolution and native capture are implemented,
   but fixture qualification records are not production approval/activation or spawn
   integration. Preserve exact-candidate/live-owner checks; do not synthesize a baseline
   receipt from factual CLI output.
2. Complete Phases 3–4 integration: bind the implemented services/hooks to actual
   native policy, protected caller/check/Git evidence and existing sole-writer
   capacity/admission/launch owners. Implement the trusted terminal reconstruction
   and safe full-diff producers, cross-phase lineage-bound handoff and actual
   browser/Obsidian observation adapters. Current execution journals deliberately
   reject changing phase via a plan edit; they are not an independent multi-phase
   controller or proof of production sole-writer enforcement. Positive local
   fixtures use explicit native-owner fakes; actual installed integration and
   phase acceptance remain unverified.
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
corepack pnpm exec tsx --test --test-concurrency=1 packages/pi-pa/src/__tests__/prepared-native.test.ts packages/pi-pa/src/__tests__/pi-prepared-workflow.test.ts packages/pi-pa/src/__tests__/pi-execution-custody.test.ts packages/pi-pa/src/__tests__/pi-phase-report.test.ts packages/pi-pa/src/__tests__/treehouse-runtime.test.ts
corepack pnpm exec tsx --test scripts/dev/validate_prepared_workflow.test.mts
```

Tests use disposable local repositories, protected directories and fake native
approval/Treehouse hosts. The fixed adapter exercises real local bare-remote fetch,
Git materialization, ticket publication and existing capacity/worktree locks.
Cross-process tests cover shared capacity, requester exit and concurrent journal
reconciliation. None is a production-policy,
human-delivery, general OS-sandbox or full acceptance claim.
