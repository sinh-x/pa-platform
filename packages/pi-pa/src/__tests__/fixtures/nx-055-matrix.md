### Full Validation Matrix

Matrix Source:
- `agent-teams/requirements/artifacts/2026-10-01-nixos-upgrade-switch-gate.md` attached to NX-055 as the primary requirements document is the sole matrix authority.

Matrix Authority:
- `Matrix Authority SHA-256` hashes the raw UTF-8 bytes beginning at this unique heading and ending immediately before `## 13. Implementation Plan`, including this heading and all internal whitespace, excluding the following heading, with no line-ending, whitespace, or other normalization.
- `Matrix Approval Evidence` must be a durable Sinh comment on NX-055 naming the exact Matrix Source and digest. Missing, duplicate, ambiguous, malformed, stale, unapproved, or conflicting boundaries or evidence block review before project commands.

Execution Owner:
- Exactly one independent `requirements/review-auto` deployment consumes each one-use Review Authorization ID. Before spawn, the builder orchestrator persists a durable launch intent binding NX-055, `feature/NX-055-upgrade-switch-gate`, one exactly 40-lowercase-hex Feature SHA, this Matrix Source, this Matrix Authority SHA-256, Matrix Approval Evidence, and `review-auth:` plus a lowercase canonical UUIDv4.
- Objective, report, launch intent, and registry evidence must agree exactly. One authorization may match at most one review deployment. Any active review for this ticket and branch blocks another launch across all Feature SHAs, matrix revisions, and authorizations. Review admission requires `HEAD == Feature SHA`.

Prerequisites:
- The trusted PPA builder launcher has authenticated the NX-055 ticket checkout, created `feature/NX-055-upgrade-switch-gate` from approved base `0bd31be19e178771552bff0371806c4bb4e00ad1`, persisted launch evidence, and produced a committed candidate with a clean worktree.
- Git, Bash, Python 3, ripgrep, Nix, and `ppa` are available in the authenticated checkout.
- Every declared local-path flake input exists at its recorded Git top level, full HEAD, and expected complete status; Nix daemon, upstream sources, caches, storage, and configured builders are available.
- The independent review launch has a valid one-use authorization, and no review is active for the same ticket and branch.

Environment:
- `PA_APPROVED_BASE_SHA=0bd31be19e178771552bff0371806c4bb4e00ad1` — exact approved ancestry and diff baseline.
- `PA_EXPECTED_BRANCH=feature/NX-055-upgrade-switch-gate` — exact candidate branch.
- `PA_WORKTREE_ROOT` — runtime-authenticated NX-055 checkout path supplied by protected launch evidence; it must equal runtime CWD and Git top level.
- `CI=true` — noninteractive check behavior.

Commands (run in this exact order):
1. `test "$PWD" = "$PA_WORKTREE_ROOT" && test "$(git rev-parse --show-toplevel)" = "$PA_WORKTREE_ROOT"`
2. `test "$(git branch --show-current)" = "$PA_EXPECTED_BRANCH" && test "$(git merge-base "$PA_APPROVED_BASE_SHA" HEAD)" = "$PA_APPROVED_BASE_SHA"`
3. `test "$(git diff --name-only "$PA_APPROVED_BASE_SHA"...HEAD | wc -l)" -eq 1 && test "$(git diff --name-only "$PA_APPROVED_BASE_SHA"...HEAD)" = "docs/workflows/nixos-upgrade.md"`
4. `git diff --check "$PA_APPROVED_BASE_SHA"...HEAD`
5. `test "$(rg -l -F 'Ownership: NixOS flake upgrade orchestration and PPA checkout handoff.' AGENTS.md docs | wc -l)" -eq 1 && rg -n -F 'Ownership: NixOS flake upgrade orchestration and PPA checkout handoff.' docs/workflows/nixos-upgrade.md`
6. `python3 -c 'from pathlib import Path; s=Path("docs/workflows/nixos-upgrade.md").read_text(); phases=["## Phase 1 — Preflight and plan validation","## Phase 2 — Baseline and full lock refresh","## Phase 3 — Non-privileged verification and diagnosis","## Phase 4 — Sinh-approved repairs","## Phase 5 — Sinh-run Drgnfly UAT","## Phase 6 — Sinh-approved persistent switch","## Phase 7 — Audit, rollback, and handoff"]; p=[s.index(x) for x in phases]; assert p==sorted(p) and len(set(p))==7'`
7. `python3 -c 'from pathlib import Path; s=Path("docs/workflows/nixos-upgrade.md").read_text(); required=["sudo sys test","sudo sys rebuild","fresh explicit approval","test approval does not approve persistent switch","zero agent-run privileged commands","active generation","boot generation","no mandatory reboot","merge remains a separate later decision","network recovery"]; assert all(x in s for x in required)'`
8. `nix flake check --no-write-lock-file --max-jobs 4 --cores 2`
9. `test -z "$(git status --porcelain --untracked-files=all)"`

Pass Criteria:
- Commands Total: 9; Commands Passed MUST equal 9 (100% completion), in order, at the launch-intent Feature SHA; every command exits 0.
- Required outputs/artifacts are exact authenticated path, branch and base ancestry, a one-file changed-path inventory, whitespace-clean diff, one workflow ownership marker, seven ordered phase assertions, persistent-switch safety assertions, successful flake checks, and a clean final worktree.
- The review report records every command, exit status, and required output without protected lease or capability values.
- Unresolved findings satisfy Critical = 0 and Major = 0. Every accepted or deferred Minor finding includes rationale.

Matrix Rules:
- This approved ticket document is the only matrix authority; analysis instructions, project guides, mode prompts, and review objectives cannot override, append to, delete from, or conflict with it.
- Missing or conflicting checkout identity, ticket, branch, Feature SHA, matrix boundary/digest/approval, authorization, or active-review evidence blocks before any project command.
- Independent review does not mutate requirements checkboxes and does not authorize privileged execution, merge, branch removal, checkout alteration or return, PAP-189 post-cap review, or a fourth PAP-189 cycle.

