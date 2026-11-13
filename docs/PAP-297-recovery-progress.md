# PAP-297 implementation progress — diagnostic increment only

Worktree: ticket checkout on `feature/PAP-297-ticket-worktree-recovery`, based on
`5f5c8c302787cb1cd154368e0762d8d5948eb4b7`. This is **partial implementation**, not
completion of phase 1, PAP-297 acceptance, installed qualification or recovery.

## Available source interface

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
