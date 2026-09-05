# PAP-174 Mode-Aware Repository Admission — Release/UAT Evidence

> Date: 2026-09-05
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

The paired configuration pin is `7e3a7a2015e220428c413423c2e9ffd07901a099` (approved PAPC-007). Verification uses a disposable clone outside the pa-platform repository, detached at that exact SHA, with a zero-entry status. The existing operator pa-platform-config checkout is not changed.

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

## Required Verification Results

| Check | Result |
|---|---|
| Focused paired validator | Pass: 9/9 tests, including 58-mode matrix, seven-state direct checkout, and no-worktree/no-sandbox retention. |
| Focused admission/runtime regressions | Pass: 14/14 selected tests across pa-core, ppa, opa, cpa, and dpa; includes requirements bypass, builder-exclusive key/path plans, 50 mixed contenders, and linked-worktree rejection. |
| `corepack pnpm verify:paired-config` | Pass at exact clean config SHA: 9/9 teams, 58/58 modes, builder 6/6 exclusive, requirements 11/11 read-only, other 41/41 non-locking, branch gate 7/7, no-worktree orchestration retained. |
| `corepack pnpm typecheck` | Pass: all 6 workspace projects. |
| `corepack pnpm build` | Pass: all 6 workspace projects. |
| `corepack pnpm test` | Pass: 841 tests total; 840 passed, 0 failed, 1 intentional skip (pa-core 443/443; cpa 49/49; dpa 77/77; opa 98/98; ppa 172 passed + 1 skipped; runtime-host 1/1). |
| `corepack pnpm completions` | Pass: deterministic regeneration; only the genuine deploy `--force` entries changed across five Fish completion files. |
| `corepack pnpm secrets:scan` | Pass. |
| `git diff --check` | Pass. |

The test command was run with Pi-injected deployment/session variables removed and `PA_SQLITE_NATIVE_BINDING` set to the packaged Node 22 addon; Pi tests independently verify replacement with the packaged Pi-host addon. This prevents the active Pi session's Node 24 binding and execution-mode metadata from contaminating Node 22 test processes.

## Human UAT Boundary

This document records automated implementation/release evidence only. It does not fill the external UAT plan's Actual Result, Status, Reviewer, Date, regression checkboxes, edge-case acceptance, or sign-off fields.
