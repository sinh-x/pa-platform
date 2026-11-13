# PAP-297 implementation progress — partial CLI workflow

Worktree: ticket checkout on `feature/PAP-297-ticket-worktree-recovery`, based on
`5f5c8c302787cb1cd154368e0762d8d5948eb4b7`. This is **partial implementation**, not
completion of phase 1, PAP-297 acceptance, installed qualification or recovery.

## Continuation d-794eec — both preparation routes, not claim settlement

User selected **Both routes**: linked-HEAD refresh as needed during d-c1eccf's
PAP-297 preparation, plus retained execution diagnosis as encountered during
d-66733d's MVM-245 preparation. Added source-only canonical-CWD workflow:

```text
ppa pi ticket-worktree inspect --repo KEY --ticket TICKET [--json]
ppa pi ticket-worktree refresh-head --repo KEY --ticket TICKET --expected-observation SHA256 [--json]
```

[Operator workflow and contracts](PAP-297-ticket-worktree-workflow.md) distinguish
these metadata and execution routes. Inspection discovers the actual protected
predecessor; preparation deployment IDs are not assumed to own stale claims.
Refresh reauthenticates its exact preview under existing capacity/ticket locks and
uses the native TicketStore writer/audit with predecessor AND resolved-target CAS
before publication. Changed previews and repeated old requests do not update the
ticket or append another audit. Dirty source/index/refs/lease and all execution
claims stay unchanged. No new native tool, executor or role permission is added.

**Still no execution apply or automatic recovery.** Historical unknown descendant
cleanup remains insufficient. This does not unlock MVM-245, finish PAP-297 or fulfill
AC-10. The initial inventory subtask was deferred after the user's CLI scope
clarification; complete byte-level dirty inventory, runtime/launcher/descendant
proof and full capacity correlation remain phase-1 work. Execution settlement and
normal-finalization reuse remain phase 2; automatic integration and installed/UAT
qualification remain later phases. No live MVM-245 claims, checkout or lease were
inspected or changed, no real metadata refresh/recovery was applied, and no worker
was launched. Status reads for the two preparation deployments are not proof of
current custody clearance. No installation, independent review or human UAT.

Affected messages: new workflow help/usage, observed (not ready), metadata refresh
success, unavailable/blocked and uncertain-effect diagnostics; selection blocker
correction in `deploy.ts`; Fish descriptions. Before selection advised generic
“reconcile the exact existing materialized checkout”. After it names supported
`ppa pi ticket-worktree --help` and distinguishes HEAD metadata from execution
claims. New success: “The ticket's linked HEAD was refreshed. No execution claims
were released and no deployment was launched.” New blocked output explains the
stale HEAD and/or retained claims, gives one scoped action with actor/impact/
authorization/prerequisite, and requires reinspection before fresh admission.
Existing inspect-recovery JSON/exits are preserved. These are implementer clarity
review and structural tests, not genuine human acceptance.

The shared weighted formatter initially truncated a full command digest and its
action metadata (new test failed). Fixed only this new command-bearing envelope:
finite static prose plus re-derived strict commands render intact below 2,000
UTF-16 units, including maximum grammar and headline. Other messages are not bulk
rewritten. Hostile action strings do not become guidance.

Actual continuation checks:

- `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm completions` —
  passed. Only PPA completion output changed. `git diff --check` passed.
- Core focused eight-file regression — **181 passed**, zero skips. Exact command:
  `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/recovery-inspection.test.ts src/__tests__/linked-branch-lifecycle.test.ts src/__tests__/repository-finalization.test.ts src/__tests__/repository-admission.test.ts src/__tests__/treehouse-ticket-concurrency.test.ts src/__tests__/advisory-runtime-integrity.test.ts src/__tests__/advisory-operation-result.test.ts src/__tests__/tickets-parity.test.ts`.
  Log `/tmp/pap-297-core-regression.log`.
- Pi focused five-file regression — **138 passed**, zero skips. Exact command:
  `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/ticket-recovery.test.ts src/__tests__/pi-treehouse.test.ts src/__tests__/prepared-native.test.ts src/__tests__/child-reconciliation.test.ts src/__tests__/advisory-runtime.test.ts`.
  Log `/tmp/pap-297-pi-focused.log`. Includes actual source CLI subprocess JSON,
  stream/exit tests, lock observation and in-lock lease drift, HEAD-only/orphan-slot
  cases, changed preview/ref/owner/ticket/environment, ancestry and dirty preservation.
- Expanded Pi regression with `src/__tests__/pi-deploy.test.ts` additionally
  **timed out at 240 seconds**, no terminal total; NOT passed. Its expensive real
  contention scenarios were still progressing. Log `/tmp/pap-297-pi-regression.log`.
  Subsequent process inspection found no matching retained test runner.
- `timeout --signal=TERM --kill-after=10s 180s corepack pnpm test` — **exit 124**,
  incomplete. Preliminary script harness passed **42/42** (the prior increment's
  ETIMEDOUT did not recur); core suite progressed through test 950 before timeout.
  Also exposed source-inventory mismatch, including prior increment's readonly
  index/registry exports. Log `/tmp/pap-297-workspace-current.log`. NOT full green.
- Semantically reconciled interaction catalogue: two read-only diagnoses and
  operator-only metadata write, no native binding or execution apply; guarded write
  classification. Renewed only five changed tracked digests and added the four
  reviewed recovery/materialization sources. Prior registry change merely passes
  existing-files-only to its read-only database opener. New refresh uses existing
  ticket/audit owner and no claim release. Recheck:
  `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/interactions-contract.test.ts src/__tests__/interactions-catalogue.test.ts src/__tests__/interactions-discovery.test.ts`
  — **16 passed**; `/tmp/pap-297-interactions.log`. This fixes the observed guard
  failure, not the incomplete workspace run or independent semantic qualification.

Local `/tmp` logs are ephemeral source-test evidence. No commit or installed-pass
claim is implied. Sensitive staged scan is required before a future commit.

## Prior diagnostic increment (3a17944): available source interface

From the exact registered canonical repository root:

```text
ppa pi inspect-recovery --repo KEY --ticket TICKET --deployment-id ID [--json]
```

This new Pi-only source command diagnoses a retained terminal advisory
builder/orchestrator. It has **no apply mode** and cannot launch, reclaim capacity,
release an owner, return a Treehouse lease or grant mutation authority. This source
change has not been installed; do not assume an older PPA supports the command.
OPA/CPA and existing child/prepared/structured settlement owners are unchanged.

The result separates checkout, ownership, capacity and native operation facts.
Outcomes currently are `blocked` or `unavailable`, never eligible or already-settled.
The observation digest is only a diagnostic coordinate, not a CAS/apply capability.
Complete eligibility and settlement contracts remain future work.

Readers use existing-only registry access, protected evidence, canonical/linked Git
identity, raw ticket linkage, and read-only Treehouse selection. No TicketStore,
mutation mutex or evidence directory initialization is used. Git optional writes
and executable metadata filters are disabled/refused for the snapshot. Public
results omit tokens, process births, commands, output and filesystem inventory.
Missing, malformed, oversized, aliased or conflicting evidence fails closed.

Operation enumeration is bounded to 512 records/8 MiB with a two-second observation
deadline. Process enumeration is bounded to 16,384 `/proc` entries under that same
deadline. Protected storage additionally enforces its existing per-record bound.
Git subprocesses have a 15-second/16 MiB bound; Treehouse retains its existing
15-second/1 MiB bound. This is not a globally cancellable recovery transaction.

## Diagnosis and safety boundary

The original incident's retained result was reread (read-only): d-8860e8 operation
op-351ff0f3-0aaf-4b4d-bc80-090db4aa66a2 has timedOut=true, SIGTERM, null exitCode and
groupSettled=false. The source retains advisory custody on that result, refuses
owner release while custody is active, then refuses permit release while checkout
custody remains. The underlying reason cleanup was unproven remains undiagnosed.
No current MVM-245 checkout, lease or protected claim was inspected or changed.

The historical frame tracks a process group/session, not a complete descendant
inventory or confinement boundary. Fresh PID death/group emptiness cannot upgrade
that unknown cleanup result or rule out escaped writers. The new inspection keeps
it unknown. Even a historical settled result is a separate process observation,
not a passing check or sufficient runtime-wide recovery grant.

## Remaining dependency-ordered work

1. Finish phase 1: native runtime/launcher/descendant cleanup authenticator,
   complete NUL-safe byte-level staged/unstaged/untracked/rename inventory,
   physical metadata identity and full capacity inventory correlation. Current
   preview captures Git status, not a complete byte-level recovery snapshot, and
   does not authenticate all mutable facts atomically.
2. Phase 2: admission-locked intent/progress/result, original-intent resumption,
   exact operation -> owner/borrower -> slot settlement, fault/concurrency tests,
   and shared normal-finalization settlement. No such new mutator exists here.
3. Phase 3: authenticated conditional operator apply, same-owner automatic real
   launch recovery, fresh ordinary admission, read-only dry-run eligibility and
   replacement of both original admission/finalization blockers. Those original
   blockers and admission guards are intentionally unchanged in this increment.
4. Phase 4: independent review, hosted CI, exact installed qualification, separately
   authorized incident recovery, non-spawning admission proof, human clarity/UAT.

Historical proof insufficiency may keep the real incident blocked; do not call
synthetic passes AC-10 acceptance or change that criterion without its scope owner.

## Message review and verification

New paths/categories: `ticket-recovery.ts` CLI usage/help, read-only blocked and
unavailable diagnostics; `cli.ts` dispatch and Fish completion descriptions. No
prior recovery-inspection message existed. Before, the only relevant selection
message was “builder owner evidence is stale, malformed, context-conflicting or
not registry-running” (unchanged). New diagnostic starts “Ticket recovery was not
applied” and explains incomplete cleanup proof, read-only operator inspection,
prerequisites and the absence of apply support. Help says “Read-only diagnosis
only; no recovery apply, launch or lease-return rights.”

Structural tests check NO_COLOR-compatible output, one five-field envelope, total
length <=2,000 UTF-16 units, action metadata, strict bounded grammar, no caller
proof/token/path/force/apply overrides, and source CLI stdout/exits. This is agent
self-review and software evidence, not genuine human readability acceptance.

Executed successfully:

- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm completions` (only PPA completion output changed)
- `git diff --check`
- `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/recovery-inspection.test.ts src/__tests__/repository-finalization.test.ts src/__tests__/treehouse-ticket-concurrency.test.ts src/__tests__/advisory-runtime-integrity.test.ts src/__tests__/advisory-operation-result.test.ts` — 120 passed
- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/ticket-recovery.test.ts` — six passed

Initial Pi fixture runs failed because of a wrong advisory marker, then exposed
that explicit repo resolution did not enforce canonical CWD. The fixture marker
and production CWD guard were corrected; the rerun passed. Failures were not skips.

`corepack pnpm test` failed in the preliminary script tests: 41 passed, one failed;
`source-built document driver unit runs the pinned 45-case harness and default
entry mechanics without an installed-pass claim` timed out spawning its fixture
PPA executable (`ETIMEDOUT`). Workspace tests after that `&&` were not run. Local
log: `/tmp/pap-297-workspace-tests.log`. Do not claim a full regression pass.

No recovery race/crash suite, installed verification, live recovery, builder launch,
independent review, hosted CI or human UAT was performed. Sensitive staged scan is
required before the diagnostic increment commit.
