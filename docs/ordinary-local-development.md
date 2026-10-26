# Ordinary local development — PAP-268 work in progress

This is a source capability record, **not installed policy or ticket completion**.
The canonical implementation branch is `feature/PAP-268-scoped-local-development`,
starting at `2acdc1fd59a799dd5ce611727c3949144b475e63` (package 0.1.149).

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
reconciliation: no forced release or terminal claim is performed.

## Validated project commands (source capability)

A registered repository can select `projectCommands: { manifest: checks.json,
sha256: <exact digest> }` in its operator-managed configuration. The manifest is
`project-command-contract/v1`, with exactly `effects: [project-read,
isolated-temp-write]` and an ordered `checks` array. Each check names `id`, an
exact root-owned executable, literal `argv`, literal application `environment`,
explicit file-level `readPaths`, content-hashed script/dependency `prerequisites`, `timeoutSeconds` (max 1800)
and `maximumOutputBytes` (max 16 MiB). No model argument selects or replaces this
contract. Manifest/registration/script drift denies dispatch; an existing
execution descriptor cannot silently adopt a different command digest.

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
Existing unregistered legacy PA check contracts are not retroactively upgraded.

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
never supplies authority. Native diagnostic identity derives from actual failed
command/exit/output content, without process IDs, time or prose. Remedy identity
comes from real successful scoped write/edit byte changes after failure. Only new
native evidence plus rationale can qualify as progress; repeating identical
output with different prose increments the existing three-consecutive-no-progress
stop across reload/replan. The first failure and every result remain immutable.

`pa_execution` action `report` returns concise native Markdown and a reference to
the complete durable report. It lists historical commands/candidates/exits/output
refs, original failure, repair evidence, current HEAD, remaining risks and first
unproven action. Work state, live process, staged completion and terminal
settlement are distinct. Reporting cannot grant source authority, clear an
operation barrier, reset limits or release a live holder. The bounded reading
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
