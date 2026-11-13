# PAP-302 — P5 source review and manual qualification handoff

## Current boundary

Runtime implementation is present; **paired delivery/acceptance is not complete**.
P2 `e6294d3`, P3 `700362a`, and P4 `f6ed3e7` are separate local commits. P5 adds
source hardening, regression evidence and this handoff. The operator reserved final
integration/activation. Nothing here selects PAPC configuration, installs/enables a
service, approves a future ticket, or certifies installed/human acceptance.

Companion **PAPC-086** owns separately selected configuration work. It is not a
blanket coding blocker: runtime code and tests were implemented with default-off,
fail-closed compatibility gates. Its compatible delivery is required for dependent
execution and paired qualification, not for continuing runtime development.

See [runtime phases](PAP-302-runtime-phases.md), [historical P1 evidence](PAP-302-auto-waitlist.md)
and [paired plan](PAP-302-paired-follow-up-plan.md). Published requirements/UAT remain
`PAP-302/pap-302-auto-waitlist/r001`; their human TS-1–TS-14 results are **not run**.

## P5 safety review and fixes

This was implementation-owner self-review, **not independent review**.

- A durable `auto-review` claim in the existing native document journal precedes
  opening the foreground decision. Concurrent callers cannot open two prompts for
  the same proposal. Native observed interactions are saved before freshness/CAS
  checks; unchanged recovery can finalize the saved interaction without reprompting.
  An unobserved/lost interaction stays pending until explicit native withdrawal.
  Withdrawal retains evidence and cannot conceal an admitted dispatch. Stale handles
  cannot revive withdrawn/closed items. Old document scopes retain their semantics.
- Default-owner integration tests exposed two previously untested defects:
  multiline objectives were being passed through a scalar parser, and material
  questions were stored as an array but read by an object-only parser. Objectives
  now preserve bounded multiline prose; questions use immutable
  `pa-auto-questions/v1` objects. Nonempty questions block start construction.
- Native ticket status/publication/queue effects use the authenticated operator
  host's trusted mutation context, not an unprivileged default store or an imported
  actor flag. A source fixture exercises the actual finite status/publication/queue
  owners, one synthetic decision and one simulated launcher request.
- Explicit unsigned redraft retains the original package ID, prior revisions,
  supporting members and native effect history. It cannot replace uncertain/live
  work. Revision notes are bounded, checked data, not approval or source permission.
- Draft requests include observed branch/base, registered check metadata and prior
  immutable documents. No model must invent an inaccessible Git SHA/check command.
  Large bounded prompts use stdin, not an argument exceeding the OS argv limit.
  Pi preflight/isolation probing, source/ticket rechecks, monotonic producer timing,
  source-aware config paths and bounded non-secret instructions remain mandatory.
- Start binds the registered command-profile digest as well as matrix/commands.
  Subject revision/root, matrix repository/base/branch, assignee progression,
  configured provider/model and live native process anchor are checked. Worker
  source/check use rechecks the original grant and registered profile. Clock reversal
  cannot enlarge the reviewed runtime timeout.
- A successful terminal label is **insufficient** for review-ready. The factual
  reader checks original protected native journal/process/output/commit receipts,
  current registered check inputs, candidate/branch and stable clean Git state.
  Ready/close additionally require original process and custody/slot settlement.
  Missing process/check/cleanup proof holds the item; it does not trigger relaunch.
  Local receipts do not certify the complete matrix, independent review, CI or UAT.
- Inspection/review display the full immutable text inventory and source locators.
  Terminal rendering visibly escapes carriage returns and Unicode/control hazards.
  Closed/declined proposals direct a new explicit choice, not resuming a closed item.
  Known typed busy causes survive the foreground public error boundary; arbitrary
  exception text is not printed. Catalogue semantics were reconciled before hashes
  were renewed; native/schema bindings remain null.
- Two retained regression assertions still expected registry schema 17. They now
  expect 19; migration tests also verify empty auto tables and disabled/paused
  defaults while retaining legacy evidence.

## Actual software evidence

Checks use the source Node 22 host and an existing Node-22 SQLite dependency:

```text
PA_SQLITE_NATIVE_BINDING=/nix/store/vlpnb0wh0v39rfcz36jdb1jhq7faq4p3-pa-platform-0.1.163-pap296.1/share/pa-platform/native-addons/node-22/better_sqlite3.node
```

That installed dependency is **not** installation/qualification of this candidate.
Disposable fixtures use real local Git/SQLite/native check processes where stated;
synthetic terminal decisions/provider/Treehouse responses are not human approval,
real provider usefulness, actual service delivery or installed acceptance.

| Check | Actual result / evidence |
| --- | --- |
| Workspace `corepack pnpm typecheck`, `build`, `completions` | Passed; final typecheck `/tmp/pap302-p5-typecheck-final.log`; `/tmp/pap302-p5-{build,completions}.log` |
| Core auto + interaction focused suites | 73/73 passed; final `/tmp/pap302-p5-core-focused-final.log` |
| Pi auto suites | Final **29/29** passed; `/tmp/pap302-p5-pi-auto-final.log` (earlier 28-case run retained) |
| Actual native check/repair/local-commit receipt reader | 1/1 passed, simulated provider/Treehouse; `/tmp/pap302-p5-native-result.log` |
| Initial full `corepack pnpm test` | Root harness 42/42; core 2,019 pass / 1 fail / 14 skipped; stopped at stale schema assertion. `/tmp/pap302-p5-full-test.log` |
| Repeated full command | Root 42/42; core **2,020 pass / 0 fail / 14 skipped**; OPA **106 pass / 0 fail / 1 skipped**; Pi script tests **11/11**. Pi source portion emitted 1,006 top-level outcomes, including the second stale schema assertion and five skip markers, before the **2,400-second command timeout**. No final full-suite success. `/tmp/pap302-p5-full-test-final.log` |
| Repaired Pi native-host + public-web files | **25/25** passed after correcting the second assertion; `/tmp/pap302-p5-pi-repaired.log` |
| Remaining Pi-file group | Emitted 124 top-level outcomes with no failure/skip markers, then **600-second command timeout** before a final summary. This is partial evidence, not a completed passing group. `/tmp/pap302-p5-pi-tail.log` |
| Workflow config/startup checked separately | 10/10 and 3/3 passed; `/tmp/pap302-p5-config-handles.log`, `/tmp/pap302-p5-startup.log`; temporary handle diagnostics are not production changes |
| Runtime-host | 1/1 passed; `/tmp/pap302-p5-host.log` |

Focused commands were `corepack pnpm --filter @pa-platform/pa-core exec tsx --test
src/__tests__/auto-*.test.ts src/__tests__/interactions-*.test.ts` and the Pi filter's
`exec tsx --test src/__tests__/auto-*.test.ts`. The native-receipt component used
`exec tsx --test --test-name-pattern 'actual ordinary launch: project-commands'
src/__tests__/ordinary-local-development.test.ts`. `NO_COLOR=1` and the dependency
binding above were used for final native tests. Final core/Pi builds passed after
the last foreground propagation fix. Whitespace/staged secret checks are recorded
in the runtime-phase record.

The overall full regression is **not green/completed**. The repaired failures were
schema expectations, but focused repairs and emitted partial results do not replace
a complete final run/teardown. Complete a sufficiently bounded full run or an
owner-reviewed complete sharding/teardown matrix before delivery acceptance.

Core/OPA skips require an external pa-platform-config fixture. Partial Pi skips
include pinned AXI/quota/MCP fixtures and installed dual-host coverage requiring
`PPA_STORE_OUTPUT`. None are passing evidence. Original failed/timeout logs remain;
no counters, native history, custody, source evidence or old failures were reset.
These temporary log locators are source-check evidence only; qualification owners
must retain their actual native/installed/human evidence separately. Markdown paths
and self-authored results are not approval or acceptance authority.

## Source coverage is not human UAT

| Requirements / scenarios | Source coverage and remaining limit |
| --- | --- |
| AC-1–2 / TS-1–2 | Two-project scan, complete pages, stale/failure retention, no-init readers, compiled CLI and mandatory-choice negatives. Actual laptop usability is not observed. |
| AC-3–4 / TS-3–4 | Finite protocol/source filtering, unsigned packages/questions, revision preservation and native pending/published reuse. Live provider usefulness and installed pairing are unqualified. |
| AC-5–6 / TS-5–6 | Native claim/capture/recovery/revocation/freshness and retained-scope negatives; synthetic port calls only, not genuine human prompt counts. |
| AC-7–9 / TS-7–9 | Actual two-process selection race, durable stages/claims, same-intent fault/reply-loss cases, default finite ticket-effect integration and pre-admission refusal. No end-to-end installed automatic Pi canary. |
| AC-10 / TS-10 | Existing native scope/check/repair/commit owners plus actual local receipt-reader proof and false-success negatives. No live auto worker or human task acceptance. |
| AC-11–13 / TS-11–13 | Notification claim/dedup/missing-session/hostile text, timer controls, safe close, pure rendering and public diagnostic propagation. No desktop delivery or human comprehension acceptance. |
| AC-14 / TS-14 | Incomplete full-regression record and this handoff only; independent/hosted/installed/canary/human/adoption gates remain open. |

## Exact configuration interface for PAPC-086

The runtime selects the committed file `contracts/auto-waitlist-v1.json`. This is
an **unsigned structural example**, not a selected file, grant or activation:

```json
{
  "schemaVersion": "pa-auto-pair/v1",
  "producer": "pa-auto-draft/v1",
  "review": "pa-auto-start/v1",
  "draftMode": "auto-draft",
  "resources": ["skills/requirements/auto-draft.md"],
  "enabled": true
}
```

The example resource is to be delivered by the separately selected PAPC worktree;
it is not asserted to exist now. Unknown/extra fields, disabled/missing contracts,
uncommitted resources and unsupported versions fail closed. The draft mode must
be a new `auto-draft` or `auto-draft-...` requirements mode, with explicit configured
provider/model, a nonempty bounded committed objective and **no document_profile**.
Retained analyze/analyze-auto modes must not be repurposed. Runtime pins contract,
requirements/builder YAML, objectives and declared resources. Builder route is
Pi `builder/orchestrator`, with no cheaper/alternate/rogue fallback.

The producer objective must produce useful full brief/requirements/UAT, truthful
material questions, the actual Full Validation Matrix/source and a finite
`Auto Execution Scope`. Implementation requires a supported current registered
project-command profile; missing/invalid/unapproved profile is not auto-approved.
Native child launches remain subject to their existing supported owners: paired
instructions must not demand an unsupported child route or substitute another mode.
Preserve existing modes and prove retained-profile negatives in PAPC-086.

## Manual integration/qualification sequence — not executed here

1. Select PAPC-086's own feature worktree and implement/review the compatible
   configuration. Record exact runtime/config commits and resources. Install only
   through separately authorized repository/release owners; this session performs
   no install, version release, push, PR or merge.
2. Qualify exact installed PPA/Pi/Node/native-addon identities and the effective
   registered repositories, ai-usage/config/registry roots. First inspect supported
   `ppa auto --help`, `ppa auto status --json`, `ppa auto list`, and
   `ppa auto units --json`. Units render only; list/status do not initialize state.
   Explicit scan/opening writes unsigned coordination data, not product data.
3. Complete source regressions/skips and independent safety/code review and hosted
   CI. Run retained document v1-v4/policy/history/OPA/ownership cases on the exact
   candidate. Test incompatible/default-off selections without changing old modes.
4. Use a genuine unmanaged controlling terminal for actual full-package/start
   review. Observe default Cancel, Reject, changes, one real approval interaction
   and unchanged recovery. Do not clear agent environment/ancestry or import a
   receipt/approved flag. Uncertain prompts/effects stay with their original owner;
   a new approval is not infrastructure repair.
5. With separate authorization, run one useful isolated canary per registered
   repo. Retain original decision/effect/deployment IDs, exact candidate, real
   failures/repair/check/commit receipts, exclusions and cleanup. Count actual
   prompts, not fixture calls. Prove no push/PR/merge/release/done/checkout return.
6. Only after compatibility/qualification and explicit operator choice, enable the
   desired controls and manually install/enable reviewed rendered user units.
   Defaults are `scansEnabled=false`, `dispatchEnabled=false`, `paused=true`.
   Unit text carries no credentials or custom environment: the service owner must
   separately qualify the same effective roots, executable identity and desktop
   bus/session environment. Do not copy managed role/approval environment as a grant.
7. Observe actual laptop notifications (not merely exit-zero notify-send), including
   unavailable/locked/offline cases, deduplication and CLI persistence. Obtain
   Sinh's TS-1–TS-14 human UAT/adoption separately. No current sign-off is claimed.

Automatic dispatch occurs in the exact foreground approval/reconciliation flow.
Periodic ticks **never select, approve, publish, queue or launch**; they only scan,
observe the original result and request informational notices. Pausing periodic
scans/new dispatch is not killing an existing worker. Closing a UI is not proven
process/cleanup settlement. An unknown launch is observed, never relaunched from
missing PID/reply. A crashed scanner retains its lock; no force-clear repair exists.
Full review currently requires textual members; unsupported views remain blocked.
The global slot belongs to the effective shared registry, not a cross-user or
independently configured registry scheduler. Qualification must pin one shared
service domain; alternate roots/registries are not a way to bypass an existing hold.

Rollback/disable-new-work must preserve snapshots, history, decisions, pending
native effects, original failures and checkout/custody. Do not auto-kill, reset,
remove a lock, return a checkout or mark a ticket done. Runtime-owner reconciliation
and any later repairs remain separately admitted actions.

## Human-facing message review record

Paths/categories touched: passive/status information and warnings (`auto-cli.ts`),
foreground inspection/control/progress/outcome/error propagation (`auto-foreground.ts`,
`auto-terminal.ts`), and existing static bounded auto diagnostics. No OPA message
rewrite, machine approval input or private raw-error support field was added.

| Before | After / meaning |
| --- | --- |
| Terminal success could become review-ready without native check proof | Missing native process/check/cleanup evidence holds the item; status distinguishes candidate/check receipts from independent review/CI/human UAT. |
| Closed proposal: “inspect/resume the same item” | “The ticket, documents and original evidence remain. Run ppa auto to choose another item; nothing is selected automatically.” |
| Raw carriage return/format controls in terminal text | Visible escaped controls, normalized CRLF, complete immutable inventory and source locators. |
| A typed busy error became generic unavailable | Existing bounded AUTO_BUSY cause survives the actual foreground boundary; arbitrary exception text remains withheld. |

NO_COLOR/software structural/hostile-input checks and the implementation-owner's
wording review are separate from human readability acceptance. Actual laptop
comprehension, full-document reading view and desktop UAT have **not** been observed.
