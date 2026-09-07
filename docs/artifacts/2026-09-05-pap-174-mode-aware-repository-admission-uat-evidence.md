# PAP-174 Mode-Aware Repository Admission — Release/UAT Evidence

> Date: 2026-09-05
> Updated: 2026-09-07 (review cycle 1 remediation)
> Ticket: PAP-174
> Branch: `feature/PAP-174-requirements-builder-admission`
> Scope: Automated release evidence for approved UAT scenarios; human reviewer/sign-off remains external and unfilled.

## Implementation Evidence

| Phase | Commit | Subject |
|---|---|---|
| 1 | `8ba83ff74163814e67bca1774e15c46ef87aa10e` | `feat(pa-core): phase 1 - add repository admission primitive` |
| 2 | `6885f6c75caefd58e7e69745c53a62824801edc1` | `feat(deploy): phase 2 - add admission contracts` |
| 3 | `f5aa75c4b946c825f6ca7766d0d614b18165ad83` | `feat(adapters): phase 3 - add repository ownership lifecycle` |
| 4 | _this release-evidence commit_ | `test(release): phase 4 - align paired admission evidence` |

The initial release evidence used paired configuration pin `7e3a7a2015e220428c413423c2e9ffd07901a099`. Review-cycle-1 remediation pinned `df3ca1de6e017358002564dc24b50ae48ec14c52`, the then-current clean PAP-174 paired-contract commit. This continuation pins merged `pa-platform-config` `develop` commit `a8d2175fc2aa3988db31f894b823816b10d3369f`; verification uses local and origin `develop` at that exact SHA without changing the operator checkout.

## Automated UAT Traceability

| UAT scenario | Automated evidence |
|---|---|
| TS-1 requirements bypass | `execution-plan.test.ts`, `pi-deploy.test.ts`, and `opencode-adapter.test.ts` assert requirements reach spawn with zero Git-status/lease operations. |
| TS-2 dirty foreground intent | `primer.test.ts` covers every builder mode, including orchestrator, with branch/HEAD/count evidence and question/re-read instructions. |
| TS-3 dirty background rejection | Pi, OpenCode, and Agent API tests assert failed admission, zero spawn, bounded foreground guidance, and no lease. |
| TS-4 one live builder | Repository primitive and mixed 50-contender Pi/OpenCode tests assert exactly one owner/spawn and different-root independence. |
| TS-5 force recovery | `repository-admission.test.ts` covers stale, PID reuse, malformed, oversized, conflicting-root, quarantine, and live-owner refusal. |
| TS-6 owner-only terminal release | Pi/OpenCode foreground and background-runner suites cover token mismatch, handoff, success, failure, timeout, signal, launch failure, and finalization. |
| TS-7 ppa/opa/REST parity | Shared execution-plan plus Pi/OpenCode and Agent API route tests compare classification and structured outcomes. |
| TS-8 guard precedence | Deploy CLI and Agent API tests prove force does not bypass sensitive input, exact-root/worktree, ticket, or runtime validation. |
| TS-9 bounded diagnostics | Repository admission, execution-plan, Pi, and OpenCode tests enforce the 2,000-character bound and state-specific guidance. |
| TS-10 non-executing commands | CLI tests prove dry-run/list-modes/validate do not acquire, transfer, quarantine, release, or spawn. |

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

The coherent follow-up is recorded as `_this review-cycle-1 remediation commit_`; the external remediation artifact records its immutable SHA after publication.

## Required Verification Results

| Check | Result |
|---|---|
| Focused paired validator | Pass: 11/11 tests, including affirmative/negated semantics, retired-contract rejection, 58-mode matrix, seven-state direct checkout, and no-worktree/no-sandbox retention. |
| Focused admission/API/CLI regressions | Pass: 158 tests, 156 passed and 2 fixture-dependent skips; includes 50 mixed contenders, abrupt mutex death, orphan recovery, safe quarantine races, REST redaction, CLI quarantine, and all NFR-7 mutation categories. |
| Focused adapter regressions | Pass: cpa 49/49 and dpa 78/78, including bounded no-spawn builder-policy rejection. |
| `corepack pnpm verify:paired-config -- --require-origin-develop` | Pass at exact merged config `develop` SHA `a8d2175fc2aa3988db31f894b823816b10d3369f`: 9/9 teams, 58/58 modes, builder 6/6 exclusive, requirements 11/11 read-only, other 41/41 non-locking, branch gate 7/7, no-worktree orchestration retained. |
| `corepack pnpm typecheck` | Pass: all 6 workspace projects (preserved full-run evidence after the final behavior edits). |
| `corepack pnpm build` | Pass: all 6 workspace projects (preserved full-run evidence after the final behavior edits). |
| `corepack pnpm test` | Pass: pa-core 451/451, pi 5/5, dpa 78/78, cpa 49/49, and opa 74/74 after paired-contract alignment. |
| `corepack pnpm completions` | Pass: deterministic regeneration with unchanged diff hash; repository subcommand entries generated for all binaries and adapter-inapplicable cpa/dpa deploy-force entries removed. |
| `corepack pnpm secrets:scan` | Pass after review-cycle-1 remediation. |
| `git diff --check` | Pass after review-cycle-1 remediation. |

The test command was run with Pi-injected deployment/session variables removed and `PA_SQLITE_NATIVE_BINDING` set to the packaged Node 22 addon; Pi tests independently verify replacement with the packaged Pi-host addon. This prevents the active Pi session's Node 24 binding and execution-mode metadata from contaminating Node 22 test processes.

## Human UAT Boundary

This document records automated implementation/release evidence only. It does not fill the external UAT plan's Actual Result, Status, Reviewer, Date, regression checkboxes, edge-case acceptance, or sign-off fields.
