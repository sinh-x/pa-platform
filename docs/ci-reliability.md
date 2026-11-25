# CI reliability and check delivery

## Incident and audit

PAP-293 follows PAP-289 PR [#170](https://github.com/sinh-x/pa-platform/pull/170).
Both [push](https://github.com/sinh-x/pa-platform/actions/runs/43032718613) and
[PR](https://github.com/sinh-x/pa-platform/actions/runs/43032784504) runs failed
installing fish because Ubuntu package hosts could not be resolved. Candidate
`5e42890c44a9a256aa6884c3550b6ca381801fad` was merged by an explicit, one-time
operator exception, not a standing waiver. The source checks that ran passed;
fish syntax and timing did not run and were not passes.

The push job took 22m17s: code tests took 14m53s, then package provisioning took
6m01s before failing. These are different costs. The separate local full-suite
600-second timeout (exit 124) is incomplete manual evidence, not a passing suite.

The current repository has evolved since that incident: hosted CI checks only
this repository and its disposable pairing fixtures. It does not fetch the
operator configuration repository. Exact selected-config and config-first
checks remain operator-local, not implied by those fixtures.

## Chosen provisioning design

Use the explicit `ubuntu-24.04` runner family, Node 22 and the package-manager
version from `package.json` (`pnpm@10.28.0`). Pin fish and fish-common to Ubuntu
Noble's `3.7.0-1` package version. Provision before expensive source checks.
Use only the runner's configured, authenticated Ubuntu apt repositories; do not
rewrite mirrors, disable signature checks, add PPAs, download arbitrary binaries
or silently accept another installed fish version.

The helper runs at most two update/install attempts with one five-second
backoff. Each apt command has a 90-second deadline and five-second kill grace;
apt network timeouts are 15 seconds, nested retries are disabled and lock waiting
is bounded. `APT::Update::Error-Mode=any` rejects partially failed/stale updates.
Only a successful update permits installation. Install exact fish/fish-common
with `--no-install-recommends` (xsel is not needed for completion checks), then
verify both package versions and the actual executable version. Exhaustion or
verification mismatch fails as infrastructure provisioning, never source success.
The workflow step budget is eight minutes, including version verification.

This pins the runner distribution and tested fish version, not the hosted image
revision or all transitive apt packages. Security/version changes require an
explicit pin review. Missing pinned packages fail closed; they do not select
latest. A long-lived snapshot/container adds its own maintenance and registry
failure surface and is not needed for this bounded repair.

Keep setup-node's pnpm-store cache keyed by the lockfile and frozen-lockfile
installation. A cache hit never substitutes for dependency installation. Do not
cache apt indexes or privileged installed trees: stale indexes, trust boundaries
and image coupling outweigh the small fish-install saving. No unbounded package
or source-test retries are introduced.

## Event and coverage design

Run ordinary CI for every PR targeting `main` or `develop` (including drafts and
forks), and pushes to `main`/`develop`. Remove feature-push runs rather than query
PR state with credentials or share cancellation keys between push and PR events.
Feature branches without a PR use local checks; open a draft PR for hosted checks.
A PR checks GitHub's merge ref; record its exact head, base and checked-out SHA
separately. Conflicted PRs cannot produce a successful merge-ref check.

Use workflow/event/PR-number/head-SHA/merge-SHA concurrency for PR runs. Only
duplicate runs of the same head and merge candidate share a cancellation group.
A stale merge ref for the same head also remains isolated. Different revisions
remain independent so manually rerunning a stale head cannot cancel the current
head's only check. Integration/release pushes use unique run IDs so every
integration commit is checked without cancelling another event's only check. No path filters, draft exclusions, job-level conditional skips,
`continue-on-error` or source-test parallelization weaken coverage. Keep job ID
`test` stable for required-check configuration. Retain serial code suites and
unchanged timing thresholds; moving provisioning earlier avoids wasting a full
source run on an unavailable package source.

Every check keeps a named step and finite budget. Code tests have 60 minutes
within a 90-minute job: the growing current suite exceeded a 25-minute local
caller budget, so the historical 15-minute incident timing is not a current
upper bound. No partial or timed-out suite is a pass. An always-run summary
records event/run attempt/head/base/checkout identity and each step's actual
outcome. A skipped/cancelled/missing check remains unverified, not passed. Setup
failures and source-check failures are separate rows; a source failure is not
necessarily a proven defect until diagnosed. No environment dump, credentials,
private endpoints or test-output artifacts are added.

## Preserved qualification boundaries

Ordinary CI remains Nix-free. Nix packaging stays manual or release-`main` only;
`nix-build.yml` is not a PR dependency. Its floating installer action and hosted
image are existing packaging supply-chain follow-ups, not silently repinned by
this source-CI repair. `version-bump.yml` retains merged-PR-to-develop admission,
serialized execution, exact PR/merge-SHA rerun marker and deterministic four-file
version edits. It is not a release or tag workflow.

Retain typecheck, build, all code-only suites, repository-owned pairing/config-first
fixtures, generated-completion diff, actual fish syntax for all three completion
files and completion timing. The code runner's printed manual integration
inventory and portable/native split remain unchanged. Full `corepack pnpm test`,
exact operator-local `verify:paired-config -- --require-origin-develop` and
`test:paired`, immutable sandbox, installed smoke, selected-host qualification,
independent review and human UAT remain separate mandatory gates where applicable.

PAP-289 process fixtures must still execute real fixed curl/Python with isolated
transport, preserve development-only versus Nix-pinned labels and avoid real
private/metadata endpoints. This change does not alter those fixtures, protected
owners, credentials, runtime provenance or installed selections.

## Merge policy and infrastructure exceptions

Require a successful `CI` / `test` check for the exact current PR merge candidate,
not a green push for the same branch or a historical head. Review event, head/base,
checked-out SHA, run attempt and every required step outcome. A required check that
is queued, conflicted, cancelled, missing or skipped is not merge-ready. Do not
use skip-CI trailers, path filters or `continue-on-error` to manufacture success.
After a base change, obtain a fresh merge-candidate run before merging. If merge
queues are adopted later, add and validate `merge_group` coverage first.

Read-only owner-settings inspection on 2026-11-25 found no classic protection on
`develop` or `main`. The active **Protect main** ruleset required PRs and blocked
deletion/non-fast-forward, but contained no required status checks or bypass
actors. These observations are not enforcement and can change independently.
The repository owner should select the stable `test` context from the GitHub
Actions app as required for `develop` and `main`, decide whether current-base
checks are mandatory, and trial a draft PR with a missing/failing check before
relying on the rule. Keep the context name unique across workflows. No protection,
credential, administrator bypass or ruleset change is made by this ticket's code.

For infrastructure failures, retain the original failed run and named step;
inspect the apt attempt exits, timeout and package versions. A successful bounded
recovery remains visible in the logs. After exhaustion, correct the package
source/runner condition or review the pin, then rerun the same candidate. A pin
or source change is a new candidate requiring all checks, not an alternate
unreviewed binary or a completion-check skip.

An exceptional merge requires a separate attributable operator decision bound
to the PR, exact head/base or merge candidate, failed run/attempt/step, reason,
scope/expiry and owning follow-up. State which checks passed, failed and never
ran, plus any separately obtained manual evidence and its limitations. Preserve
the original failure and the later rerun as distinct records. An exception neither
changes the result to green nor creates a standing bypass; an agent cannot grant
it. PAP-289's exception remains specific to PR #170.

## Implementation verification boundary

The isolated provisioning tests exercise two-attempt DNS/package failure,
recovery, deadline and installed-version mismatch using fake transports. They
are not real DNS outage or privileged apt-install evidence. Workflow tests
exercise actual YAML event/concurrency expressions, including a stale-head rerun,
and check retained commands, budgets, summaries and bump guards. Independent
review identified the stale-head cancellation defect; the corrected groups bind
the PR head and merge candidate rather than assuming that the newest run always
has the newest code.

Local typecheck, build, root/core/OpenCode tests, pairing fixtures, completion
generation/diff, runtime-host tests and real fish 4.9.3 syntax/timing were observed.
Those local fish results do not qualify the hosted 3.7.0 pin. The initial whole
code-only run exceeded its 25-minute caller budget; a separate Pi run exceeded
40 minutes and contained a local-source-security assertion failure. Frozen
installation corrected stale local dependencies and the shell-exit assertion then
passed, but a focused FIFO subprocess watchdog still failed. Later post-review
typecheck/build/pairing runs also exceeded their caller limits, and the existing
portable-runtime subprocess check failed; earlier passes do not certify this
final candidate. No test was deleted, reclassified or weakened in response.
Independent follow-up review confirmed the concurrency repair and passed all
16 provisioning/workflow checks, while retaining these qualification gaps.
Full code-only, full manual/installed and hosted-candidate qualification remain
unproven until complete successful runs. No PR is opened on this evidence.
Administrative command evidence is retained with deployment d-fd125a, not
substituted by this maintained policy document.

## Reference contracts

- [Ubuntu Noble fish package](https://packages.ubuntu.com/noble/shells/fish)
  and [fish-common](https://packages.ubuntu.com/noble/shells/fish-common).
- [apt-get options](https://manpages.debian.org/testing/apt/apt-get.8.en.html),
  including update error mode; network timeout/retry settings are apt configuration.
- [GitHub PR events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
  and [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
- [Ordinary local development](ordinary-local-development.md) and
  [release process](release-process.md) own the retained manual boundaries.
