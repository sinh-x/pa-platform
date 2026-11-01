# Ordinary local development — PAP-268 work in progress

This is a source capability record, **not installed policy or ticket completion**.
The canonical implementation branch is `feature/PAP-268-scoped-local-development`,
starting at `2acdc1fd59a799dd5ce611727c3949144b475e63` (package 0.1.149).

## Code-only CI and manual integration

Per the operator's explicit CI scope decision, PR CI runs `corepack pnpm test:code`
without installing Nix, entering a Nix shell or building a Nix package. The
separate Nix packaging workflow is triggered only manually or on release `main`
pushes, never by PRs or integration `develop` pushes. Typecheck,
TypeScript build, code tests, paired source validation and completion checks remain
in CI. Core tests run serially so the existing 500 ms dashboard p95 assertion is
not measured against other concurrent test files; its threshold is unchanged.

The shared code runner prints explicit inventories of deferred manual integration
files: Pi ordinary local-development, project-command-contract, prepared-native,
pi-deploy and the full workflow-runtime entry, plus core artifact manifest/render/session
suites. These native/deployment and immutable review-renderer cases need a qualified
runtime; they are neither passing tests nor hidden skips in the code-only lane.

PAP-273 integrates the retained `2d4de24` portable/native split with the native
cases kept directly in the original full entry. Its explicit portable replacement
is `pi-workflow-code-cases.ts`: public read/decision transport, publication/queue,
revocation, coordinator and bootstrap cases still run in code-only CI. The full
`pi-workflow-runtime.test.ts` imports those portable cases and unconditionally
registers all 16 native baseline/materialization, matrix, source and restart cases.
It remains the local/installed-verifier matrix entry. The helper is not named
`*.test.ts`, so the full suite does not discover it a second time. No test-name
filter, environment-dependent skip, weakened executable allowlist or unconfined
fallback selects this boundary. The code runner prints both entries; missing,
stale or ambiguous replacement inventory fails. All other source test files are
included automatically by discovery, including new code tests.
`corepack pnpm test` still runs the complete suite
in the supported environment as a **separate manual integration gate**. Installed
smoke and independent review/UAT also remain separate. Green code-only CI does
not replace any of these results or certify runtime acceptance. Existing optional
external/installed skips remain explicitly reported by their owning suites.

## Baseline transport slice

The ordinary direct Pi launcher now resolves `ordinary-task-baseline/v1` from
one primary `requirements` document attached to its own ticket. It validates
repository key/physical root, ticket, feature branch, exact full base and the
referenced own-ticket operator decision. The observed contract includes source
and decision digests. It is not a CLI/agent/environment SHA override or a new
ownership ledger. It does not grant source-execution permission.

The approved source preamble uses `Handoff Type: fresh` / `Approved Base SHA`,
or `Handoff Type: amendment` / `Retained Base SHA`, never both. It contains one
`Review Approval Evidence` reference (`TICKET#c-...`, the canonical ticket-comment
form, or the comment ID). The decision producer's complete comment is exactly:

```text
Approve TICKET REPO_KEY PHYSICAL_ROOT FEATURE_BRANCH exact base FULL_SHA; source requirements:agent-teams/requirements/artifacts/FILE.md.
```

`from exact base` is also accepted. Existing richer requirements-producer
whole-pair approvals do **not** need replacement decisions: the native reader
recognizes their finite initial sign-off format, authenticates the exact immutable
reviewed requirements preview path/raw SHA named in the original operator comment,
and compares its repo/ticket/branch/handoff/full-base tuple with the promoted task.
Hash, tuple, source/preview alias or explicit rejection mismatches deny. Mere
keyword mentions in discussion cannot authorize a baseline. Operator authorship
is required; tool parameters cannot manufacture it. PAPC-068's existing real
signed source was observed read-only resolving the correct original base, without
any source/checkout/approval mutation. Routine phases/checks/repairs/commits need
no additional human decision.

For planned branches, a divergent configured integration tip stops before
permit/checkout acquisition. For materialized branches, compare immutable
historical base instead; later integration advances do not rewrite history.
Immediately before branch selection, under the existing repository transaction,
reread the source/decision and configured evidence and reject digest drift.
Dirty/unknown checkout work and existing repository holders are rejected before
branch creation. The live ordinary launcher records its exact materialization
intent in the **existing capacity slot**, fsynced under the existing repository
transaction. Git compare-and-create (`update-ref` with an absent expected ref)
records a native operation marker in the branch reflog before checkout. The same
live authenticated owner can reconcile interruption after ref creation or before
ticket publication, checking the retained intent/marker/exact base and creating
the branch only once. Independently created branches, changed intent, unknown
reflog proof and different/dead holders are not adopted/reset/reclaimed. No new
ledger or retrospective receipt is introduced. Optional preparation retains its
separate contract/reconciliation; legacy split-mode contracts are not upgraded. No fallback launch follows an ordinary denial.

Public `ORDINARY_BASELINE_*` stops identify the action, evidence owner and
supported reconciliation without echoing source bodies or authority tokens.
Post-acquisition denials may retain their existing permit/lease for owning
reconciliation: no forced release or terminal claim is performed. In particular,
unstarted-launch cleanup cannot delete a slot once ordinary materialization intent
has been published: a ref may already exist despite an interrupted call. Only the
same live owner can reconcile that intent/result; a missing start event is not
proof that resources are absent or safe to release.

## Finite requirements sign-off compatibility (PAP-269)

The consumer supports the two exact simple sentences above and these **anchored,
case-sensitive** retained whole-pair producer families (`d-HEX` is six lowercase
hex digits; `rNNN` is the exact source revision). These are grammars, not keywords:

| Family | Decision opening | Requirements preview binding |
| --- | --- | --- |
| Existing standard | `Explicit [standalone ]foreground PA sign-off in d-HEX: I selected Approve exact pair and matrix for TICKET rNNN.` | `Reviewed requirements[ source]: FULL_PATH, raw SHA-256 HASH` (semicolon also supported) |
| Existing owner-directed | Same opening with `I selected "Approve this exact pair" for owner-directed TICKET rNNN.` | Same full-path clause |
| WAW-016 | `Explicit PA sign-off from interactive deployment d-HEX: Approve rNNN pair and exact matrix.` then `I approve the complete TICKET requirements revision rNNN and companion UAT,` | `Reviewed requirements: FULL_PATH, raw SHA-256 HASH` |
| TTL-012 | `APPROVED in standalone PA sign-off, deployment d-HEX: complete requirements/UAT pair rNNN.` | `Requirements source FINAL_REF reviewed as reviews/TICKET/rNNN/requirements.md raw SHA-256 HASH` |
| TTL-014 | `Final standalone PA sign-off in d-HEX. Sinh selected Approve exact rNNN pair and matrix after complete whole-document Markdown requirements and sixteen-scenario UAT review was offered.` (scenario-count word/number is variable) | `Reviewed revision rNNN requirements raw SHA-256 HASH` |

For every rich family, the one canonical preview is
`agent-teams/requirements/artifacts/reviews/TICKET/rNNN/requirements.md`.
Only TTL-012 expands the exact shortened `reviews/...` locator, under the fixed
artifacts directory. Only TTL-014 derives the locator from the exact reviewed
revision; it never searches files or chooses by hash/latest date. Each family
requires one `Matrix Source: FINAL_REF` (TTL-014 combines this as `Requirements
Source and Matrix Source FINAL_REF.`). Matrix execution/readiness is not added
as an ordinary-baseline prerequisite.

All adapters converge on the same own-ticket, exact `sinh` author, unique primary
source/comment, preview raw SHA-256 and preview/promoted tuple checks. Both source
and preview retain bounded (1 MiB), fatal UTF-8, regular-file/no-follow reads.
Preview revision must agree. Numeric retained review hashes, when present, must
also agree; external-record descriptions are not substituted hashes. Every
present authoritative repository/root/ticket/handoff/branch/base clause must be
unique and equal. Legacy rich producers may bind these through their preview;
WAW/TTL-014 require explicit tuples. TTL-012 additionally requires its compact
`Handoff fresh, canonical REPO root ROOT, approved base SHA, exact branch BRANCH,
planned/create.` tuple (amendment/retained/materialized/reuse is also finite).

Descriptive intent and execution boundaries cannot introduce another decision.
Only the family's documented plan restatement is removed before rejecting extra
approval/rejection/revocation/conditional clauses. Administrative approval metadata,
approval-bound final review, `This is not implementation authorization`, `No source
implementation ... is authorized` and `Plan approval is not executed UAT or
application acceptance` are plan/execution boundaries, not denied plan decisions.
Examples that **reject** include a discussion prepended to a valid decision,
`I do not approve this pair`, `Rejected`, `Only if ...`, two source/preview/tuple
clauses, an aliased preview and a wrong ticket/revision/hash/base. The retained
PAPC-068 standard producer's compact `Handoff: builder/orchestrator; canonical
REPO at ROOT; fresh planned/create; BRANCH from exact base SHA;` tuple is also
validated when present. Its exact `Approve the exact eleven-command matrix and
all eight paired UAT scenarios as plans, not results.` restatement (reviewed
counts may vary), administrative approval/status/hash/link metadata wording and
complete non-launch/non-UAT-success boundary remain supported. This is not
permission for a second decision or conflicting compact tuple. Later explicit
same-ticket operator withdrawals bound to the selected comment/source or referring
to this approval reject; uncertain ordering/binding fails closed. Unrelated policy
discussion grants nothing and does not revoke a decision.

Additive diagnostic subcodes retain the `ORDINARY_BASELINE_APPROVAL_REJECTED`
family: `_UNSUPPORTED_PRODUCER` identifies a producer/consumer contract gap owned
by pa-platform/PAP-269 with requirements-producer coordination under PAPC-068;
`_INVALID_EVIDENCE` identifies conflicting/invalid authority, and `_WITHDRAWN`
identifies applicable withdrawal. `ORDINARY_BASELINE_CONFIG_MISMATCH` still means
changed configured integration base, never a formatting issue. Every public stop
has Condition/Source/Reason/Correction/Resume Action, is bounded below 2,000
characters and omits approval bodies/tokens. Preserve signed history: do not rewrite
artifacts, demand unchanged-facts approval, substitute a SHA or retry unchanged.

Disposable built-consumer qualification (no materialization or launcher):

```sh
node scripts/dev/verify_ordinary_approval_compatibility.mjs --module packages/pa-core/dist/tickets/materialization.js
```

It reports the physical module path/SHA-256 and every required case, isolates
PA/config/tickets/artifacts/Git in a temporary directory, and verifies evidence/ref
preservation. Source and candidate-built results are **not** selected installed
success. After separately authorized packaging/selection, the same driver can
qualify the exact selected installed module path. No installation, live WAW/TTL
retry, new checkout/link write, independent review, CI or human UAT is implied.
PAPC-068 owns future producer changes; unknown formats need an explicit compatible
contract/test change, not a prose-permission fallback or structured-only migration.

## Validated project commands (source capability)

Ordinary source phases require a registered `projectCommands: { manifest: checks.json,
sha256: <exact digest> }` in the repository's operator-managed configuration. The manifest is
`project-command-contract/v1`, with exactly `effects: [project-read,
isolated-temp-write]` and an ordered `checks` array. Each check names `id`, an
exact root-owned executable, literal `argv`, literal application `environment`,
explicit file-level `readPaths`, content-hashed script/dependency `prerequisites`, `timeoutSeconds` (max 1800)
and `maximumOutputBytes` (max 16 MiB combined across stdout/stderr). No model argument selects or replaces this
contract. Manifest/registration/script drift denies dispatch; an existing
execution descriptor cannot silently adopt a different command registration.
The registration fingerprint is retained across reload; manifest/script/toolchain
validation is deferred to source/check boundaries so an invalid contract or
unavailable containment cannot block authenticated startup observations and own
partial/failed Markdown reporting. Reporting cannot repair or activate that
contract, and changed registration still denies command/commit authority after
reload; it cannot silently adopt a new command contract.

The native bash tool matches the exact rendered command (`node 'scripts/test.cjs'`,
for example), but executes the pinned argv directly, not that text through an
arbitrary shell. Plans must retain all contract checks in order. Unknown commands,
additional environment/CWD inputs and shell suffixes are denied. Explicit program,
argv, CWD and environment evidence accompanies actual stdout/stderr/exit records.

This v1 Linux/Nix profile requires trusted installed Bubblewrap and working
unprivileged namespace isolation. It exposes `/nix/store` and only explicitly
listed regular project inputs plus pinned script prerequisites read-only at the
exact linked-project CWD, not the entire checkout. Other project files, Git
metadata, ambient credentials/authority/environment and host account/service paths
are absent. Inputs are bounded to 1 MiB each and validated against the existing
sensitive filename/path/content policy before dispatch. A fresh `/tmp` and HOME
and new network/PID/IPC/user namespaces isolate temporary writes and networking.
Project writes and external network effects cannot inherit the check grant.
Builds may write temporary artifacts and emit their results to captured output;
project-tree build outputs, external services, other host layouts and unrestricted
checks are unsupported by v1, not silently run outside confinement. Missing
containment is a toolchain-owner prerequisite denial, never an install/host-change
or unconfined fallback. The runner retains process-group/timeout/output evidence.
Missing registration produces `EXECUTION_PROJECT_CONTRACT_REQUIRED` before a
source plan, writer selection or source dispatch; the fixed legacy PA vocabulary
is not an ordinary task fallback. Existing journals remain readable and own
startup/partial reporting stays available. This does not rewrite historical
records or upgrade already-running processes; separately admitted optional/
prepared compatibility retains its own contract.

## Bounded Git controls and checked-content commits

Ordinary Git controls use the trusted Git executable and literal argv, without
ambient credential/authority variables. The metadata-only fsmonitor optimization
is disabled; executable relevant hooks, affected clean/process/smudge filters,
commit signing and custom maintenance hooks are not covered by this v1 profile.
`EXECUTION_GIT_EFFECTS_UNSUPPORTED` stops the dependent Git step without deleting,
rewriting or silently disabling configured quality hooks. Qualifying those actual
effects belongs to the repository/runtime owner, not a repeated source approval.
Branch/ref/checkout extension checks precede ordinary materialization mutations.
Even read-only Git status can invoke filters: affected opaque drivers deny that
observation rather than inheriting a read grant. Own partial reporting still works
and labels unavailable Git/check scope unknown, never empty or unchanged.

Native check intents bind the content and modes of every declared input and
pinned prerequisite, including inputs not represented by a dirty-file inventory.
Before commit, all named results must match the current inputs; affected staged
paths must equal the actual checked working bytes and modes. Filter/line-ending
normalization or index substitution cannot inherit passes for different bytes.
The native intent retains a NUL-safe index fingerprint; actual commit results,
local completion and phase evidence compare it to the real committed tree.
Missing historical attestation is not upgraded into new phase authority. A
mismatch preserves the actual work/commit and barriers for owning reconciliation;
there is no reset, hook bypass, rewritten history or invented passing receipt.

## Same-holder phases, repair and Markdown

`pa_execution` now supports explicit `advance` with a next plan and an evidence
reference from `observe` kind `phase`. The native producer requires idle operation
custody, no unresolved failure, a clean current candidate, and a successful local
commit preceded by every named current-content check. Plain `plan` cannot change
phase IDs; advancement cannot change source paths/checks or reuse a completed
phase ID. Journal replay preserves lineage, original failure events, deadline,
replacement/review accounting and the no-progress stop. No independent acceptance
or optional rich-report receipt is inferred.

`observe` kind `recovery` optionally accepts a bounded `rationale`. This prose
never supplies authority. One initial native diagnosis is bound to the immutable original failed
command/exit/output content, without process IDs, retry log timestamps or prose.
Later volatile output alone is not progress; further progress requires new native
source-change/remedy evidence. Remedy identity
comes from real successful scoped write/edit byte changes after failure. Only new
native evidence plus rationale can qualify as progress; repeating identical
output with different prose increments the existing three-consecutive-no-progress
stop across reload/replan. The first failure and every result remain immutable.

`pa_execution` action `report` returns concise native Markdown and a reference to
the complete durable report. It lists historical commands/candidates/exits/output
refs, original failure, bounded whole-buffer-redacted failure reading excerpts,
repair evidence, current HEAD, remaining risks and first unproven action. Work state, live process, staged completion and terminal
settlement are distinct. Reporting pins physical roots/Git-pointer identity before Git
observations, uses fenced/control-sanitized reading excerpts, distinguishes the
native process exit/timeout/abort/output-limit/settlement from wrapper/check
failure, withholds incomplete channel prefixes rather than exposing partial
secrets, and does not require full-diff or rich-view generation. Reporting cannot grant source authority, clear an operation
barrier, reset limits or release a live holder. The bounded reading
view explicitly labels truncation; full native evidence is retained. Browser,
HTML, Obsidian and machine-certified closure are not ordinary prerequisites.

## Verification and remaining work

Disposable core and actual source-built ordinary-launch tests use real Git,
ticket storage and native custody. Provider spawn and Treehouse status are
simulated and labelled. Optional activation/grants remain absent. Existing SDK
startup/reporting and single-phase fail/repair/commit regressions are retained.
The new integration file additionally runs real non-PA test/build processes in
confinement, preserves an exit-2 failure, performs SDK repair/rechecks and a local
commit. It verifies read-only project/hidden host effects and exact process
metadata. It now completes two same-holder SDK phases, native diagnosis, repair/rechecks,
local commits and Markdown-only reports, with reload and phase-replay negatives.
A separate real-launch case reaches the no-progress stop without deleting failure
history. This is developer/source evidence, not full independent AC1–AC8 UAT.

Still required before PAP-268 completion:

- Complete cross-scenario AC1–AC8 independent acceptance and human UAT.
- Paired independent acceptance of PAPC-068 instructions and selected source pin
  (developer pairing now uses the config-owned direct-only/scoped-local checker
  and actual generated primers, not retired implement-borrower requirements).
- Full nine-command independent matrix, CI and human UAT, separately attributed.

Selected developer config pin is `b6f409187eed204ba9969982c937f177f282db3c`
(PAPC-068's checked local source commit). The original runtime pin was
`f51d1edc27858ae14ac5a21aa37304c1a6c6dd10`; `42aa9267a0618cdb7a92b31dd3418df137326c81`
was the companion's implementation base, not that original runtime pin. Source
pair validation is separate from independent/installed qualification. No config
source mutation, installation, live adoption, product-checkout repair, push,
merge or release.
