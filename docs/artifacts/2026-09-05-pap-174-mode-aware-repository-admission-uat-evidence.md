# PAP-174 Mode-Aware Repository Admission — Release/UAT Evidence

> Date: 2026-09-05
> Updated: 2026-09-07 (additional automated review cycle 1 remediation)
> Ticket: PAP-174
> Branch: `feature/PAP-174-requirements-builder-admission`
> Scope: Automated release evidence for approved UAT scenarios; human reviewer/sign-off remains external and unfilled.

## Implementation Evidence

| Phase | Current post-rebase commit | Subject |
|---|---|---|
| 1 | `f869fe03a774f4cd0d2e387ebe5675c3006d9611` | `feat(pa-core): phase 1 - add repository admission primitive` |
| 2 | `3092057a54abbdc91741c28c350c6a666f50e487` | `feat(deploy): phase 2 - add admission contracts` |
| 3 | `87825ac9a15175d80b49ba843eb52153569cdf0b` | `feat(adapters): phase 3 - add repository ownership lifecycle` |
| 4 | `1dc536509420760d6f11c1cc0143a6be7a3aeb73` | `test(release): phase 4 - align paired admission evidence` |
| Broad-review remediation | `a21181c805c9e6444c6d464aa9011c995941967f` | `fix(admission): remediate review cycle 1 findings` |
| Merged-config pin verification | `fbf46d5bac339f2dc408a8edc1b0347549f5f17f` | `chore(verify): pin merged config prerequisite` |
| Additional-review remediation | commit containing this evidence update | `fix(admission): revalidate repository state before spawn` |

Historical pre-rebase phase commits (not ancestors of the current feature head) were `8ba83ff74163814e67bca1774e15c46ef87aa10e`, `6885f6c75caefd58e7e69745c53a62824801edc1`, and `f5aa75c4b946c825f6ca7766d0d614b18165ad83`. They are retained here only as historical provenance; the table above is the reproducible current lineage. The containing commit for the final row is intentionally identified by its unique conventional subject rather than an impossible self-referential hash inside its own tree; resolve it immutably with `git log --format='%H %s' --grep='^fix(admission): revalidate repository state before spawn$' -1`.

The initial release evidence historically used paired configuration pin `7e3a7a2015e220428c413423c2e9ffd07901a099`. Broad-review remediation historically pinned `df3ca1de6e017358002564dc24b50ae48ec14c52`, the then-current clean PAP-174 paired-contract commit. Current verification pins merged `pa-platform-config` `develop` commit `a8d2175fc2aa3988db31f894b823816b10d3369f` and uses a deployment-local exact detached checkout without changing the operator checkout.

## Automated UAT Traceability

| UAT scenario | Automated evidence |
|---|---|
| TS-1 requirements bypass | `execution-plan.test.ts`, `pi-deploy.test.ts`, and `opencode-adapter.test.ts` assert requirements reach spawn with zero Git-status/lease operations. |
| TS-2 dirty foreground intent | `primer.test.ts` covers every builder mode, including orchestrator, while Pi/OpenCode post-plan drift tests prove the final branch/HEAD/status evidence and mandatory question/re-read/reconfirmation contract come from the authoritative pre-spawn snapshot. |
| TS-3 dirty background rejection | Pi and OpenCode clean-to-dirty post-plan tests assert failed admission, zero spawn, bounded foreground guidance, and no owned lease; existing initial-dirty and REST-default cases remain covered. |
| TS-4 one live builder | Repository primitive and mixed 50-contender Pi/OpenCode tests assert exactly one owner/spawn and different-root independence. |
| TS-5 force recovery | `repository-admission.test.ts` covers stale, PID reuse, malformed, oversized, conflicting-root, quarantine, and live-owner refusal. |
| TS-6 owner-only terminal release | Pi/OpenCode foreground and background-runner suites cover token mismatch, handoff, success, failure, timeout, signal, launch failure, and finalization. |
| TS-7 ppa/opa/REST parity | Shared execution-plan plus Pi/OpenCode and Agent API route tests compare classification and structured outcomes. |
| TS-8 guard precedence | Deploy CLI and Agent API tests prove force does not bypass sensitive input, exact-root/worktree, ticket, or runtime validation. |
| TS-9 bounded diagnostics | Repository admission, execution-plan, Pi, and OpenCode tests enforce the 2,000-character bound and state-specific guidance. |
| TS-10 non-executing commands | CLI tests retain non-owning dry-run/list-modes/validate behavior; Agent API tests cover `listModes` and `validate` for Pi/OpenCode with both force values and assert zero deploy-hook calls, therefore zero runtime spawn or lease lifecycle entry. |

Direct registered-checkout and linked/no-worktree rejection remain covered by `execution-plan.test.ts`, `deploy-cli-repository.test.ts`, and both runtime adapter suites. The paired validator additionally retains the seven-state direct-checkout branch contract and no-worktree/no-sandbox orchestration evidence while validating the actual 6 builder + 11 requirements + 41 other configured modes.

## Review Cycle 1 Remediation Evidence

| Review finding | Remediation evidence |
|---|---|
| 1 — paired contract | Pin advanced to `df3ca1de6e017358002564dc24b50ae48ec14c52`; the validator requires eight affirmative clauses on all eight builder contract surfaces and rejects negated or retired blanket semantics. |
| 2 — cpa/dpa bypass | Mutating builder deploys return bounded `unsupported-policy` failures before foreground/background spawn; help and generated completions no longer advertise adapter-inapplicable deploy force. |
| 3 — REST sensitive guard | Shared request validation blocks sensitive objective content before REST/CLI runtime hooks for both force values and emits only redacted diagnostics. |
| 4 — orphaned mutex | Ownership operations use a util-linux `flock` advisory mutex whose helper releases on parent-pipe closure; abrupt-death and orphan-file regressions prove forced recovery remains available. |
| 5 — unsafe quarantine | `ppa repository inspect/quarantine` re-locks, re-reads, refuses verified-live ownership, identity-checks replacement evidence, and creates unique no-clobber quarantine paths. |
| 6 — mutation recorder | `stash` and `commit` join all other NFR-7 prohibited command categories; a recorder self-test distinguishes them from allowed Git reads. |

The broad-review follow-up is current post-rebase commit `a21181c805c9e6444c6d464aa9011c995941967f`; merged-config verification is `fbf46d5bac339f2dc408a8edc1b0347549f5f17f`. Both are immutable ancestors of the additional-review remediation commit identified in the implementation table.

## Additional Automated Review Cycle 1 Remediation Evidence

| Review finding | Remediation evidence |
|---|---|
| Major — REST control requests spawned runtimes | `deploy-control.ts` resolves validated `listModes`/`validate` requests before timeout resolution, runtime-hook lookup, session registration, or adapter execution. The Agent API matrix covers Pi/OpenCode × force false/true × both control flags with zero hook calls. |
| Major — post-plan Git-state drift | Repository acquisition captures current branch/HEAD/status inside the ownership critical section. Pi and OpenCode defer final primer generation until that evidence is acquired, compare state again immediately before spawn, token-update lease/plan/primer evidence on drift, and reject/release an unstable or newly dirty background admission. |
| Minor — stale UAT provenance | Current post-rebase immutable ancestors and historical pre-rebase SHAs are explicitly separated; self-referential placeholders are removed; current exact verification replaces stale totals without filling human UAT fields. |

The independent disposable `describeTools()` probe from deployment `d-40dcf7` changed from two REST spawns plus stale clean snapshots to zero REST spawns, background `state=dirty-background` with no spawn/owned lease, and a foreground dirty authoritative snapshot whose rendered primer includes the mandatory contract.

## Required Verification Results

| Check | Result |
|---|---|
| Focused repository-admission, execution-plan, deploy-CLI, Agent API, Pi, and OpenCode suites | Pass: 214/214, zero failures/skips; includes REST control-only matrices, clean-to-dirty and dirty-to-changed branch/HEAD/status drift, 50 mixed contenders, lease/primer/snapshot consistency, guard order, bounded diagnostics, and NFR-7 mutation coverage. |
| `corepack pnpm verify:paired-config -- --require-origin-develop` | Pass at exact merged config `develop` SHA `a8d2175fc2aa3988db31f894b823816b10d3369f`: clean detached verification checkout; 9/9 teams, 58/58 modes, builder 6/6 exclusive, requirements 11/11 read-only, other 41/41 non-locking, branch gate 7/7, no-worktree orchestration retained, references missing 0. |
| `corepack pnpm test:paired` | Pass: paired gate 11/11, pa-core 453/453, OpenCode 100/100; 564/564 total, zero failures/skips. |
| `corepack pnpm typecheck` | Pass: all 6 workspace projects after the final behavior and evidence edits. |
| `corepack pnpm build` | Pass: all 6 workspace projects after the final behavior and evidence edits. |
| `corepack pnpm test` | Pass: 869 tests, 868 passed, 0 failed, 1 intentional `PPA_STORE_OUTPUT`-gated skip. Breakdown: pa-core 453/453; Pi source validation 5/5; Droid 78/78; Claude 49/49; OpenCode 100/100; Pi 182/183; runtime-host 1/1. |
| `corepack pnpm completions` | Pass: deterministic regeneration produced no checked-in completion delta. |
| `corepack pnpm secrets:scan` | Pass on the final source/test/evidence diff. |
| `git diff --check` | Pass on the final source/test/evidence diff. |

The successful full-test command was run with Pi-injected deployment/session/native-host variables removed, `PA_SQLITE_NATIVE_BINDING` set to the workspace's packaged Node 22 addon, and `PA_PHASE5_CONFIG_ROOT` set to the clean detached exact config checkout. Pi tests independently verify replacement with the packaged Pi-host addon. An earlier environment-contaminated attempt retained active `PA_PI_SQLITE_NATIVE_BINDING`/`PA_REQUIRE_PI_SQLITE_NATIVE_BINDING` values and failed 41 Pi tests before the corrected full rerun passed 868/869 with only the intentional store-output skip; no source change was used to mask that environment-only failure.

## Human UAT Boundary

This document records automated implementation/release evidence only. It does not fill the external UAT plan's Actual Result, Status, Reviewer, Date, regression checkboxes, edge-case acceptance, or sign-off fields.
