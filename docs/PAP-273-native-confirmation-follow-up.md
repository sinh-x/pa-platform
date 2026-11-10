# PAP-273 follow-up: native confirmation and branch bridge

Implementation base: clean ticket worktree `9146808187a8e889d08246fa894491657c7f571c`.
Current request authorizes implementation, committed by phase, followed by a new
trial suffix. No install, config activation, remote mutation or real-ticket effect
is performed by source tests.

## Requirements and scope

Native approval: d-199e82 `PAP-273-native-approval-draft-r001.md`, SHA-256
`7f236a6ad667e595e4a952a9405fa876e9c56212e6ffc9eb30754dd63dab0d39`;
subsequent approval comment `c-20261110002734582`. One native TUI interaction may
itself be the final decision; no attestation of earlier chat or second final
confirmation. JSON path/schema and command spelling are implementation designs.

Branch behavior approval: `c-20261110003010197`; formalization
`PAP-273-branch-bridge-requirements-r001.md`, SHA-256
`12c6fc9fc0602473f7fc79e7f0c408b0130166fc11d2afcb778b9d8d104e6279`.
Approval covers the preceding behavior proposal, not native exact-byte approval
of later elaboration. The bridge observes existing links through existing owners;
no branch/resource preparation, silent repair, custody or launch rights.

Historical r006, approved earlier amendment, v1/v2 sessions and issued decisions
retain their original meaning. PAPC-077 owns external process/composition changes;
PAP-285 owns selected-config/provenance design.

## Phases and source validation

1. A1: native registry event version, finite scopes, deterministic immutable JSON,
   ticket reference/comment reconciliation, unchanged consumer protections.
2. A2: new explicit fresh Pi profile, single native interaction, same service for
   model tool and operator slash command, exact caller/source/CAS checks.
3. A3: read-only existing-owner branch verification with specific findings.
4. A4: focused regression/recovery/tamper/dispatch cases, typecheck/build,
   verifier ownership/completions, source qualification report and trial suffix.

Focused commands: core build before source adapter tests; then
`node --import=tsx --test packages/pa-core/src/__tests__/document-*.test.ts packages/pi-pa/src/__tests__/document-*.test.ts`.
Keep prior broad failure/timeouts and installed qualification gaps separate.
Use explicit bounded timeouts for broad checks; no required skip is a pass.

## A1 delivered

The existing append-only document journal now accepts explicit
`pa-document-confirmation/v1` events. New actions `confirm` and `confirm-revoke`
require a native confirmation-capable host; retained v1/v2 cannot acquire it.
Scopes are content, publish, publish-and-queue; consumers check them natively.
A content-only decision cannot publish or queue. Revocation is append-only and
does not erase prior JSON or completed effects.

The durable issued event is also the JSON/linkage intent. Exact retry identity
includes immutable subject, original journal revision, scope/operation and revoke
target. Lost file/ticket replies reuse the issued decision without another UI;
status/show exposes original request coordinates. Changed requests need current
CAS and a fresh native review. The JSON is a deterministic UTF-8 pretty-JSON
representation with trailing newline, no own digest in its hashed bytes, under
`agent-teams/requirements/artifacts/approvals/<ticket>/<decisionId>.json`.
Registry/evidence remain authority, not file possession, hashes or ticket status.

File publication is absent-only with complete/fsynced pending bytes before a
no-replace hard link; exact native pending inode/prefix recovery handles
interruption. Aliases, foreign hardlinks and conflicting bytes reject. Ticket
links and deterministic comments use existing TicketStore APIs/mutex and require
readback. Historical primary refs are unchanged. No cross-store physical
atomicity is claimed. Managed-agent boundary, not hostile same-UID isolation.

Actual A1 results: core build and all core document tests passed, **52 passed,
zero failed/skipped**. Initial TypeScript errors (TicketStore method name and
union narrowing) were fixed before that passing run. Synthetic native callbacks
are source fixtures, not real operator approval, installed qualification or UAT.

## A2 delivered

New opt-in `document_profile: pa-document-confirmation/v3` records immutable
start `requirements-document-confirmation/v3` only for eligible fresh foreground
Pi requirements/analyze. It keeps bounded workspace/presentation capabilities.
V1 paged review and V2 unavailable capture remain unchanged; neither current
config nor tool JSON upgrades old sessions. New native actions are `confirm`
(sha256, original expectedRevision, scope) and `confirm-revoke` (sha256,
original expectedRevision, decisionId). `/pa-approve <strict JSON>` invokes that
same native service, not a subprocess/receipt or a separate approval mechanism.

The trusted extension's custom terminal screen provides overview, complete
immutable document tabs and optional technical/companion-link tabs. Tab/scrolling
is reading, not page acknowledgements. One selection records approve, changes,
reject or cancel; default selection is Cancel. No typed hash, preceding-chat
attestation or second final approval. Caller/source/journal checks run after UI.
No-UI/RPC/retained-profile/abort cases fail without approval. Terminal controls
and bidi-control text are neutralized in this new view. Local UID/TUI remains
managed-agent provenance, not independent human identity or hostile-UID isolation.

Actual A2 checks: core build + adapter direct typecheck passed; new native UI,
command/tool equivalence, rejection/abort/caller and dispatch tests **9 passed,
zero failed/skipped**. UI keyboard events are disposable synthetic test inputs,
not genuine human approval or visual/readability UAT. Shared command messages
lead with decision/linkage outcomes; failures preserve possible partial issuance
and route same-request inspection, not blind retries or duplicate approvals. The complete document
family after A2 passed **81/81, zero skips**.

## A3 delivered

New V3-only `pa_document branch-inspect(ticket)` consumes the ticket's existing
linkedBranches, registered physical identity, exact branch/base/head, Treehouse
status/select-existing, existing Git snapshot/metadata policy, and protected
lock-free repository ownership observers. No generic inspection path calls the
existing mutex-taking custody inspectors, acquire/prepare/materialize/refresh,
launch or ticket-write services. Capacity/execution remains deferred to actual
launch owners; `launchReady` and `authorityGranted` are always false.

Findings distinguish missing/foreign/multiple/invalid/planned linkage, base,
current HEAD (including descendant advancement without inferred new intent),
lease absence/ambiguity/unavailability, physical worktree mismatch, branch
mismatch, live owner conflict, unproven owner evidence and mid-observation drift.
Successful observations re-read current Git, lease, protected authority and
link/queue facts. Mutable facts must still be rechecked at selection/launch;
there is no reusable permission token or automatic baseline/branch repair.

Actual A3 tests: core build passed; **8 tests passed, zero failed/skipped**, using
real disposable Git worktrees, existing native live-owner acquisition for fixture
setup, and a bounded Treehouse status fixture that refuses allocation commands.
Before/after filesystem (including directories/modes/hashes), ticket and lease
snapshots remain unchanged by inspection. This proves source owner composition,
not a real installed Treehouse/config pair or foreground handoff acceptance.

## A4 recovery/integration qualification and trial label

Added actual process-death checks immediately after native registry issuance,
complete file publication, ticket reference and ticket comment boundaries. Fresh
processes reconcile the original request without another synthetic UI, duplicate
decision, file replacement, reference or comment. Partial pending-file prefixes
and the published-but-still-hardlinked boundary also recover only exact native
bytes/inodes. Changed bytes, aliases and foreign supplied receipt fields reject.
Supersession records explicitly reference the prior decision and disclose that
lifecycle in the UI; revocation/old superseded readback never advertises current
authority. Registry append validates request identity, interaction uniqueness and
lifecycle references. Receipt effects explicitly deny execution/launch/UAT.

A disposable default-entry test uses real registry/process incarnation anchors
and the actual module registration, model tool, native custom UI callback,
immutable representation and operator command. Its start events and keystrokes
are fixture-generated: **not a real foreground deployment or human approval**.
Concurrent identical tool/command requests share one native in-flight operation;
competing different requests conflict. Strict action-shape validation precedes
that sharing, so an extra caller field cannot piggyback on an issued outcome.
Durable CAS remains authority across processes; no cross-process UI deduplication
or hostile same-UID isolation is claimed.

The branch bridge now reads exact unaliased raw ticket evidence as well as the
existing normalized owner view, matching selection's refusal of missing explicit
state/head and conflicting legacy SHA. Legacy compatibility normalization cannot
silently create new verified facts. Later Git/lease/ticket/ownership observations
are still not grants and never prepare/relink/change the approved baseline.

### Source obligations / case owners

All new cases retain their source owner; the old installed case inventory is not
replaced by a numerical same-count substitution.

| Requirements | Source owner(s) / actual disposition |
|---|---|
| FR/AC-01,02,03 | `packages/pi-pa/src/__tests__/document-confirmation-native.test.ts` (10 tests) and `document-confirmation-entry.test.ts` (1): native single-screen outcomes, full document/technical tabs, narrow Unicode/safety, no UI/RPC/retained/abort/caller negatives, shared command/tool entry and bounded diagnostics |
| FR/AC-04–09 | `packages/pa-core/src/__tests__/document-confirmation.test.ts` (18): exact scope/subject/native authority, deterministic JSON/ticket readback, source/caller/revision drift, supersession/revocation, imports/tampering/alias rejection and prefix/hardlink recovery |
| FR/AC-07 | `packages/pa-core/src/__tests__/document-confirmation-process.test.ts` (4), fixture worker `document-confirmation-worker.ts`: actual process exit at registry/file/ref/comment boundaries, no second UI/duplicate effect |
| FR-B/AC-B01–06 | `packages/pi-pa/src/__tests__/document-branch.test.ts` (8) and core `document-branch-interface.test.ts` (1): actual Git worktrees and native owner observers, planned/materialized/legacy-incomplete/conflicting/foreign/head/base/lease/active-owner/race cases, zero inspection mutations |
| FR/AC-10 and installed AC-B06 | **NOT RUN**: exact installed pair, actual normal foreground tool/command/branch trial, independent review and human UAT remain separate |

The final source document family has **100 passed, zero failed/skipped**: 42 new
follow-up cases plus the existing 58-case source family. This is source +
disposable native mechanics evidence, not installed or human acceptance.

Actual final commands (logs under ai-usage
`deployments/d-977df3/artifacts/PAP-273-native-followup/`):

- `corepack pnpm typecheck`: exit 0.
- `corepack pnpm build`: exit 0.
- Full focused `document-*.test.ts` core/Pi family: exit 0, 100/100, zero skips.
- `node --test scripts/dev/verify_document_runtime.test.mjs scripts/dev/run_code_tests.test.mjs`:
  exit 0, 12/12, zero skips. This exercises the **retained v1** 45-anchor/13-entry
  source-built verifier mechanics, not a new installed V3 qualification result.
- `corepack pnpm completions`: exit 0, no completion diff.
- Source `ppa --version` and `opa --version`: `0.1.158-pap273.6`.
- Four release manifests match; independent runtime-host version is unchanged.
- Sensitive staged scan is required before each phase/final label commit.

Preserved failed run: adding explicit supersession metadata moved one tested
phrase below the initial viewport, causing five UI assertions; the fixed screen
keeps the single-final-decision header and no-execution footer always visible.
A fixture commit also left an asynchronous Git maintenance lock between snapshots,
causing one zero-mutation assertion. Fixture Git setup now disables its own
optional maintenance; production inspection already used existing maintenance/
fsmonitor control flags. `document-supersession-failed.log` retains the 92-pass/
6-fail attempt; the subsequent full 100-pass run does not rewrite it.

Touched blocker messages use fixed typed native causes and one bounded five-field
envelope, not raw exceptions or inferred permissions. Before: V2 capture says
attested-host unavailable, and bridge unsupported. After: **V3 only** offers the
native-confirmation protocol, reports actual native-UI absence/retained-action
misuse accurately, and exposes branch-inspect findings. V1/V2 are intentionally
unchanged. Operator success distinguishes decision, revocation, inactive historical
readback and verified linkage; incomplete linkage preserves possible issuance.
Human readability/visual review remains unperformed.

### Rollout / remaining gates

The new trial suffix is **0.1.158-pap273.6** across root/core/Pi/OpenCode manifests;
runtime-host remains independently versioned. Version labeling does not update an
installation or qualify source provenance. Build the clean final label commit as
an exact Git revision, and verify installed `packageVersion` **and** `sourceSha`.
The earlier `.5` installation's `unversioned-dirty-source` remains historical and
is not retrospectively accepted. No lockfile, Nix dependency hash or config pin is
changed by this label.

A fresh normal requirements/analyze run must deliberately select the complete
compatible PAPC instruction closure with `pa-document-confirmation/v3`. Source
support alone neither selects it nor upgrades an existing V1/V2/resumed session.
PAPC-077 must integrate/review process/primer/template guidance against the actual
interfaces; PAP-285 selected-config/provenance ownership is unchanged.

The old 62-ID installed verifier remains V1-only; a V3 installed/default-entry
qualifier and exact joint config/runtime qualification are outstanding. Complete
aggregate/portable suites, current hosted CI and independent review were **not
rerun or passed here**; prior live-config assertion failures and Pi/full-suite
timeouts in the earlier phase report remain open, not waived by focused success.
No real-ticket native approval/JSON/publication/queue, application data operation,
Nix build/install/activation/reload, external config edit, resource preparation,
builder spawn, remote push/merge/release, affected-ticket retry, primary-ref
replacement, checkout return or product-UAT acceptance was performed. PAP-273's
administrative queue/history are unchanged.
