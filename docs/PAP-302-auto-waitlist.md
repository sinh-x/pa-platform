# PAP-302 — auto waitlist delivery record

## Scope and phase boundary

Implementation worktree: `feature/PAP-302-auto-waitlist`, selected ticket checkout
`/home/sinh/.treehouse/pa-platform-cdb114/14/pa-platform`, base
`7f208de75fad52c003d151d9338934c6caa06d19`.

The published `pap-302-auto-waitlist/r001/{brief,requirements,uat}.md` package in
the ai-usage requirements artifact store defines five delivery phases. Its
publish-only decision is **not** an implementation-start grant for future items.

**P1 implements inspection, not an enabled automation service.** P2–P5 remain
undelivered. No selection, human approval, drafting, builder, user timer,
notification, enablement, push, PR, merge, release, ticket-done or checkout-return
effect is exposed by these commands. There is no manual-deploy substitute.

## P1 interfaces

```text
ppa auto                         # refresh observations and display candidates
ppa auto scan --json              # bounded read-only source scan; unsigned result
ppa auto list --section all       # read retained snapshot, no initialization
ppa auto list --section excluded --page 2
ppa auto status --json            # read freshness/service availability only
ppa auto --help
```

Pages contain at most 100 rows and expose page/total/next-page information. Every
registered PAP/PAPC canonical ticket ID is considered, including legacy unpadded
IDs. Terminal/archived/advanced/owned/blocked entries remain separately visible.
Priority, creation time and ID determine display order, never execution order.
Document titles and ticket status do not establish approved requirements.

Runtime-neutral code lives in `packages/pa-core/src/auto/`; Pi command/worker code
lives in `packages/pi-pa/src/auto-{cli,scan-worker}.ts`. Only PPA has the command
and generated Fish completions; OPA retains its existing grammar.

### Observation and storage owners

- Registered `pa-platform/PAP` and `pa-platform-config/PAPC` mappings are mandatory.
  Missing/unreadable sources fail the scan, not a fresh empty-list result.
- Protected bounded artifact reads inspect ticket bodies/refs, dependencies and
  active bulletins. Neither TicketStore nor BulletinStore is constructed.
- The existing registry is opened through its existing-files-only read owner;
  there is no initialization, migration, writable PRAGMA or process-death probe.
  Registry document events, immutable snapshots, current decisions/revocations,
  pending effects, destination hashes and primary requirements refs are checked.
- Existing workflow lineage is observation-only. Partial/unknown owners and
  unsettled publication/queue effects are never replaced. Unverified legacy refs
  remain with their original owner instead of triggering duplicate drafts.
- A scan is a dated point-in-time observation, **not** a cross-owner transaction,
  custody release, applicability approval or dispatch-time freshness proof.
- `$PA_AI_USAGE_HOME/auto/waitlist.json` (default ai-usage root) holds one atomic,
  versioned unsigned projection plus the last attempt. AdvisoryFiles owns atomic
  rename/fsync. Storage inside a registered product repository is rejected.
  The effective ai-usage root must already exist. Readers create nothing.
- The cross-process exclusive scan lock coalesces overlapping readers. A crashed
  scan leaves an explicitly unsettled lock; this phase supplies **no lock repair**
  or deletion advice. Its original owner must establish safe reconciliation.
- A failed scan retains the previous complete snapshot/version and marks it
  stale. Snapshots also age stale after 30 minutes; there is no periodic scanner
  until the later timer phase is implemented and explicitly enabled.
- PPA runs the fixed read-only scanner subprocess with a 120-second wall timeout,
  no stdin, argument-array invocation and a bounded output buffer. Core scanning
  also checks a cooperative deadline and file/byte limits. No ticket text is
  evaluated as a command. Exception prose is not returned or persisted.

`pa-auto-result/v1` JSON is a new unsigned observation interface, never an
importable receipt. JSON goes to stdout without prose, including failure results;
human failures go to stderr. Exit 0 means the requested observation completed
(or a retained snapshot was read), not approval/readiness. Failed/coalesced
refreshes and invalid requests exit 1. Source-sensitive titles are withheld;
other titles are bounded and stripped of terminal/control/bidi characters.

## Human-facing message inventory

New paths: `auto/presentation.ts`, `pi-pa/src/auto-cli.ts`, PPA help/completions.
Affected categories: information/help, stale/coalesced warnings and blocked
observations. No new launch-progress or implementation-success message exists.
Before: `ppa auto` had no supported command. After examples from the new paths:

```text
PPA auto — inspection only; selection and execution are not enabled.
Nothing starts from a recommendation or this list. No approval has been requested.
```

Before (synthetic inadequate warning): `Scan failed; queue empty`.
After: `Warning: the latest scan failed. Any retained entries are stale; inspect the original source owners.`

Before (synthetic inadequate blocker): `AUTO_SOURCE`.
After: `Auto action not completed; no automatic work was requested.` followed by
exactly one Condition/Source/Reason/Correction/Resume Action envelope. The typed
cause identifies incomplete observations; the recommended operator inspection is
read-only, asking the owner has no mutation effect, and neither needs a new
approval. Repeated approval or replacement launch is not offered as repair.

Plain output and blocker structure are software-tested separately from actual
human comprehension. No human readability acceptance is claimed.

The source interaction catalogue explicitly lists `auto.help`, `auto.list` and
`auto.status` as reads, and `auto.scan` (including bare `auto`) as a **write**:
refresh saves coordination data and a lock, despite reading product sources only.
All native/schema bindings remain null. An independent high-risk invariant and
negative tests prevent reclassifying refresh as a read. The initial full suite
caught the conservative source-inventory mismatch; affected handlers and imported
domain effects were reviewed, these entries/negative tests added, then only the
affected/new source digests were renewed. No admission check was weakened.

## Verification record

P1 focused source checks (2026-11-13):

- Core: `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/auto-waitlist.test.ts`.
- Pi: `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/auto-cli.test.ts`.
- Catalogue/strict discovery regressions: the core command with
  `src/__tests__/interactions-{catalogue,contract,discovery}.test.ts` alongside the auto suite.
- `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm completions`.
- `git diff --check`; staged `corepack pnpm secrets:scan` before committing.

Native core tests use the existing installed **Node 22** SQLite addon via
`PA_SQLITE_NATIVE_BINDING`; the deployment's inherited Pi/Node 24 addon is not
ABI-compatible with the source-check Node 22 host. This is a dependency, not an
installed-candidate qualification claim. Fixtures are disposable and synthetic;
fixture decisions are not genuine human approvals.

Actual final focused results: **35/35 core + catalogue/discovery** (18 auto and
17 interaction cases) and **9/9 Pi auto CLI**, zero failures/skips/cancellations.
Workspace typecheck/build/completions and whitespace checks passed. Additional
regressions: Pi document/mode/workflow/template wrappers **6/6**, runtime-host
**1/1**, OPA **106 passed / 1 skipped / 0 failed** (external data-analysis config
fixture unavailable).

The full `corepack pnpm test` attempt is **not green**: root harness 42/42;
core 1,992 passed / 1 failed / 14 skipped, stopping the recursive run before
adapter suites. Its sole failure was the conservative source-inventory guard
described above, subsequently repaired and verified in the 35-case focused run.
The entire full suite was not repeated after that repair. Existing skipped cases
are not passing evidence. Original output: `/tmp/pap302-d573872-full-test.log`;
separate adapter regression outputs use `/tmp/pap302-d573872-{pi,opa,host}-regression.log`.
Some final safety/test additions postdate the original full attempt; only the
final focused runs and repeated typecheck/build are current for those additions.

Focused cases cover all routes, complete pagination, read-without-initialization,
two-project byte-preserving scans, bulletin/dependency/owner exclusion, protected
source failures, hostile titles and exceptions, exact pending/published package
reuse, changed publication bytes, unsettled effects, stale retention, corrupt
storage, external storage, actual concurrent scanner processes, actual scanner
crash, bounded diagnostics and actual compiled public CLI routes, including a
successful real read-only scanner subprocess across both disposable projects.

## Remaining delivery contracts

P2 requires durable global selection/hold states plus an actually supported,
bounded unsigned background producer and a genuine versioned foreground review
host. Existing `requirements/analyze` selection explicitly rejects background
runs. The selected PAPC `analyze-auto` routine is not a drop-in producer: it
requires ticket claiming/tagging/comment/optional branch-plan effects and a later
interactive analyze session. It has no native document-session profile. Those
retained semantics must not be silently relabelled as this service's draft-only
contract.

P3 must extend actual native decision/admission/launch owners with exact finite
start intent and original-effect reconciliation. Existing document confirmation
scopes remain content/publication/queue only; `builderLaunch: false` is explicit.
The current CLI document description is not a foreground grant. A new approval
ledger, shell confirmation phrase or rogue-one dispatch would not satisfy P3.

The selected PAPC config is outside this ticket worktree. Paired mode/instruction
changes require their own authorized task/worktree and exact contract/version
agreement; this implementation makes none. P4 timer/notifier activation must
wait for the dependent service contracts. P5 independent review, hosted CI,
installed pairing, foreground prompt-count evidence, real desktop delivery,
one-ticket canaries in both repositories and Sinh's UAT/adoption remain separate,
unperformed gates. No source test proves those outcomes.
