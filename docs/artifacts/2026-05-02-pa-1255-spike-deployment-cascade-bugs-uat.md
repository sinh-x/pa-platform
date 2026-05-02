# Requirements: Fix Spike Deployment Cascade Bugs

> **Date:** 2026-05-02
> **Author:** requirements / researcher
> **Status:** Draft
> **Deployment:** d-8ae46f, d-9b174a (LM-064 spike research)
> **Ticket:** PA-1255
> **Repository:** /home/sinh/git-repos/sinh-x/tools/pa-platform

## 1. Context & Background

**Confidence:** 0.92

The spike research deployment for LM-064 (OpenCode Go low-cost coding models) produced 9 deployments instead of the expected 3-5. Two parallel `spike` parent deployments launched within 77 seconds of each other (d-8ae46f and d-9b174a). Each parent then launched `spike-minimax` and `spike-openai` children as expected. However, the `spike-minimax` child of d-8ae46f (d-cf0f4b) itself launched two grandchild deployments (d-0a5294 and d-72f9a4), creating a 3-level cascade.

Root cause analysis of all 9 deployments reveals three distinct bugs:

### Bug 1: Child Modes Incorrectly Execute Parent Phase P2 Spawning

All three modes (`spike`, `spike-minimax`, `spike-openai`) reference the same objective file `skills/requirements/spike-objective.md`. That file contains both Phase P (parent orchestrator) and Phase C (child researcher) sections. The primer renders the full objective file content for every mode without role-based filtering, so `spike-minimax` and `spike-openai` children see the "Launch two children" checklist item and act on it.

**Evidence:**
- `teams/requirements.yaml:137,157,177` — all three modes point to the same `objective: skills/requirements/spike-objective.md`
- `packages/pa-core/src/primer/index.ts:63-70` — `resolveConfiguredObjective` reads the entire file; no role-based content filtering
- `skills/requirements/spike-objective.md:104-128` — child role section (Phase C) is in the same file as parent section (Phase P)

### Bug 2: No Idempotency Guard for Spike Deployments

The phone launched `spike` mode once (success), then launched again 77s later (d-9b174a). No mechanism prevented or detected this duplicate launch. `validateDeployRequestFields` in `packages/pa-core/src/deploy/control.ts:55` validates field formats but performs no idempotency check — it has no concept of "is there already a `spike` deployment running for this ticket?"

### Bug 3: Spike Child Modes Miss Reddit/Community Research

Both spike children timed out or failed to capture Reddit/community sentiment about OpenCode Go. The MiniMax child timed out after 1200s without producing a report. The OpenAI child completed but did not include Reddit research. Public community opinions remain uncaptured per the spike report's own "Open Questions" section.

---

## 2. Problem Statement

**Confidence:** 0.95

### Bug 1 Impact
Child deployments (`spike-minimax`, `spike-openai`) launch their own children when they should only perform research and return a report. This wastes compute (extra grandchild deployments), creates confusing multi-level nesting, and breaks the intended orchestration model where the parent spike coordinates exactly two provider children.

### Bug 2 Impact
When a user or system launches a `spike` deployment for a ticket that already has an active `spike` deployment, two parent orchestrators run in parallel. Both will claim the ticket, both will launch children, and both will attempt to write consolidated reports. The second deployment races against the first, creating duplicate artifacts, conflicting status updates, and wasted resources.

### Bug 3 Impact
The spike research workflow is supposed to capture a complete picture of a topic including public community sentiment. When web research fails to reach Reddit, Hacker News, or other forums, the spike produces an incomplete picture. Sinh specifically wanted to know "what is the community saying about OpenCode Go?" — that question is unanswered.

---

## 3. Goals & Success Criteria

- **Goal 1:** Spike child modes (`spike-minimax`, `spike-openai`) must never launch sub-deployments. They research and return a report to the parent only.
- **Goal 2:** A `spike` deployment for a ticket that already has an active `spike` deployment for that same ticket must fail fast with a clear error message, not launch a duplicate orchestrator.
- **Goal 3:** Spike children must reliably complete Reddit/community web research within the 1200s timeout, or produce a partial report with explicit uncertainty about missing community sentiment.

Success looks like: exactly 3 deployments per spike run (1 parent + 2 children), no grandchild cascade, duplicate spike launches blocked, community research captured or marked as an explicit uncertainty.

---

## 4. Scope

### In Scope

- Separate objective files for `spike-minimax` and `spike-openai` that contain only Phase C (child researcher) behavior, with Phase P (parent orchestrator) content removed or conditionally excluded
- An idempotency check in the deploy path that detects if a `spike` deployment for the same ticket is already running, and fails with a descriptive error before launching
- Spike child mode improvement: ensure Reddit/community research is attempted and completed within timeout, or explicitly marked as missing with uncertainty
- Regression test coverage for Bug 1 and Bug 2

### Out of Scope

- Phone UX changes (per user instruction)
- Changes to non-spike deploy modes
- Changes to the `opa deploy` command-line interface beyond adding the idempotency guard
- Changes to the `teams/requirements.yaml` structure (only objective file references change)

---

## 5. Users & Stakeholders

- **Sinh** — primary user running spike deployments from phone or desktop. Expects ~3-5 deployments per spike, no cascading grandchild spawns, no duplicate parents.
- **PA agents** — receive primer with only their role-relevant phase checklist; less confusion during execution.
- **Builder team** — receives cleaner spike artifacts with complete community research for downstream implementation work.

---

## 6. Requirements

### Functional

| # | Requirement | Priority | Confidence | Notes |
|---|-------------|----------|------------|-------|
| F1 | `spike-minimax` mode primer renders only Phase C content (child researcher role) | Must | 0.95 | Cannot contain "Launch two children" checklist item |
| F2 | `spike-openai` mode primer renders only Phase C content (child researcher role) | Must | 0.95 | Same as F1 |
| F3 | `spike` mode primer renders only Phase P content (parent orchestrator role) | Must | 0.95 | Cannot contain child-specific "Explore codebase" and "Run web searches" as primary directive |
| F4 | Duplicate spike deploy guard: `opa deploy requirements --mode spike --ticket <id>` fails with clear error if a `spike` deployment for the same ticket is already active | Must | 0.92 | Check registry for active deployments with matching ticket_id and mode prefix "spike" |
| F5 | Spike child modes attempt Reddit/community research and complete it within 1200s | Must | 0.85 | If not completed, mark explicitly as uncertainty in report |
| F6 | New objective files stored at `skills/requirements/spike-child-minimax-objective.md` and `skills/requirements/spike-child-openai-objective.md` | Must | 0.95 | Or equivalent file names; replaces shared `spike-objective.md` reference |
| F7 | Regression tests for F1, F2, F3 (primer content filtering) and F4 (idempotency guard) | Must | 0.90 | Added to existing primer.test.ts and/or new test file |

### Non-Functional

| # | Requirement | Priority | Confidence | Notes |
|---|-------------|----------|------------|-------|
| NF1 | Deployment count per spike run must be exactly 3 (1 parent + 2 children) | Must | 0.95 | No grandchild deployments |
| NF2 | Spike child timeout remains 1200s | Should | 0.98 | Changing this would affect other modes |
| NF3 | No performance regression on primer generation for non-spike modes | Should | 0.95 | Existing tests must still pass |

---

## 7. Dependencies & Prerequisites

- [ ] `teams/requirements.yaml` must be updated to point `spike-minimax` and `spike-openai` modes to the new child-specific objective files
- [ ] `packages/pa-core/src/primer/index.ts` — review if any role-filtering logic exists or needs to be added (currently none, file is rendered verbatim)
- [ ] Registry database must be queryable for active deployments by ticket_id and mode prefix — confirm existing query supports this or needs extension
- [ ] Learning-management repo path for spike artifacts remains: `~/Documents/ai-usage/agent-teams/requirements/artifacts/`

---

## 8. Technical Approach

### Files to create

- **`skills/requirements/spike-child-minimax-objective.md`** — Phase C only (lines 104-128 of existing spike-objective.md, cleaned up). Contains: Phase C1 validate input, Phase C2 research (including Reddit), Phase C3 write child output, Phase C4 return to parent.
- **`skills/requirements/spike-child-openai-objective.md`** — Same as above but for OpenAI provider.
- **`packages/pa-core/src/__tests__/spike-idempotency.test.ts`** — Regression test for duplicate spike deploy guard.

### Files to modify

- **`teams/requirements.yaml`** — Update `spike-minimax` and `spike-openai` mode entries to point to the new child-specific objective files instead of `skills/requirements/spike-objective.md`.
- **`packages/pa-core/src/deploy/control.ts`** — Add idempotency check function that queries registry for active spike deployments matching the ticket_id.
- **`packages/pa-core/src/cli/core-command.ts`** or **`packages/pa-core/src/deploy/control.ts`** — Wire the idempotency check into `validateDeployRequestFields` or a new pre-deploy validation step.

### How it flows

1. User launches `opa deploy requirements --mode spike --ticket LM-064`
2. `runDeployCommand` calls `validateDeployRequestFields` → new idempotency check runs against registry
3. If active spike deploy exists for same ticket → fail with `Cannot deploy spike: active deployment d-XXXXX already running for ticket LM-064`
4. If no conflict → deployment proceeds, primer generated with mode-specific objective file
5. Parent `spike` mode loads `spike-objective.md` (Phase P + Phase C in full, role filtering by checklist order)
6. Child `spike-minimax` loads `spike-child-minimax-objective.md` (Phase C only — no "Launch children" section exists)
7. Child `spike-openai` loads `spike-child-openai-objective.md` (Phase C only)

### Existing patterns reused

- `validateDeployRequestFields` pattern for field validation returning `{ request } | { error }`
- `selectDeployMode` in `deploy.ts` for mode selection from team config
- Primer test pattern in `primer.test.ts` for content assertion
- Registry FTS5 search for active deployment detection

---

## 9. Risks & Unknowns

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| R1: Child modes still see parent content via shared skills (pa-startup, etc.) that include spawn/dispatch logic | High | Low | Skills are operational procedures, not objective content. Phase content is isolated in objective files only. |
| R2: Idempotency check queries stale registry state | Medium | Low | Registry writes are synchronous; use `opa registry list --status running` query or direct SQLite check |
| R3: New objective files drift out of sync with each other | Low | Medium | Keep both child objective files identical except provider name in header; add test assertion |
| R4: Existing tests break because they assume shared objective file | Low | Low | Tests reference specific mode + objective file content; update assertions for new file paths |
| R5: Reddit research still times out even with improved guidance | Low | Medium | Mark as explicit uncertainty in child report; add note in parent consolidation |

### Open Questions

- [ ] O1: Should the idempotency check also block `spike-minimax`/`spike-openai` direct launches for a ticket that has an active `spike` parent, or only block duplicate `spike` parents?
- [ ] O2: Should the child mode objective files be auto-generated from the parent file (e.g., via a build step), or maintained manually as separate files?
- [ ] O3: How should the "Reddit/community research" requirement be verified? Should there be a specific web search command or pattern in the child output checklist?

---

## 10. Acceptance Criteria

- [ ] AC1: `opa deploy requirements --mode spike-minimax --ticket TEST-001 --repo /tmp/test` produces a primer that does NOT contain the string "Launch two children" or equivalent spawn command
- [ ] AC2: `opa deploy requirements --mode spike-openai --ticket TEST-001 --repo /tmp/test` produces a primer that does NOT contain the string "Launch two children" or equivalent spawn command
- [ ] AC3: `opa deploy requirements --mode spike --ticket TEST-001 --repo /tmp/test` produces a primer that DOES contain "Launch two children" and Phase P content
- [ ] AC4: `opa deploy requirements --mode spike --ticket LM-064` fails immediately with an idempotency error when LM-064 already has an active spike deployment running
- [ ] AC5: Running `opa deploy requirements --mode spike --ticket NEW-TICKET --repo /tmp/test` twice in quick succession produces exactly one success and one idempotency failure (not two successes)
- [ ] AC6: Spike child report contains explicit section for community/Reddit research findings (or explicit note that it was not completed)
- [ ] AC7: All existing primer tests pass after the change (no regression)
- [ ] AC8: New idempotency regression test passes

---

## 11. Effort Estimate

**Confidence:** 0.80

- Size: M
- Estimated sessions: 2-3
- Key files to touch:
  - `skills/requirements/spike-child-minimax-objective.md` (new)
  - `skills/requirements/spike-child-openai-objective.md` (new)
  - `teams/requirements.yaml` (update 2 mode entries)
  - `packages/pa-core/src/deploy/control.ts` (add idempotency check)
  - `packages/pa-core/src/__tests__/spike-idempotency.test.ts` (new)
  - `packages/pa-core/src/__tests__/primer.test.ts` (update assertions for spike child modes)

---

## 12. Implementation Plan

### Steps

1. **Create child-specific objective files** — Extract Phase C content from `spike-objective.md` into two new files: `spike-child-minimax-objective.md` and `spike-child-openai-objective.md`. Clean up section headers so each file is self-contained and clearly for child-only use.
2. **Update `teams/requirements.yaml`** — Change `spike-minimax` mode `objective` from `skills/requirements/spike-objective.md` to `skills/requirements/spike-child-minimax-objective.md`. Same for `spike-openai`.
3. **Add idempotency check in `control.ts`** — Write a function `detectActiveSpikeDeployment(ticketId: string): string | undefined` that queries the registry for active deployments with matching ticket_id and mode starting with "spike". Wire it into `validateDeployRequestFields` or a new pre-deploy validation step.
4. **Add regression test `spike-idempotency.test.ts`** — Test that duplicate spike deploy for same ticket fails with descriptive error; test that non-spike modes are not affected.
5. **Update primer tests** — Update or add assertions for spike child modes confirming "Launch two children" is absent from their primers.
6. **Verify with typecheck, build, and test** — Run `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm test` to confirm no regressions.

### Order of Operations

1. Steps 1-2 (objective files + YAML update) — enables immediate manual testing
2. Step 3 (idempotency) — depends on understanding registry query API
3. Steps 4-5 (tests) — can proceed in parallel with step 3
4. Step 6 (verification) — final gate

---

## 13. Follow-up / Future Work

- Consider auto-generating child objective files from a shared source template via build step to prevent drift
- Spike child mode could benefit from a pre-flight web search checklist that specifically targets Reddit, HN, and Twitter/X before general web search, to improve community sentiment capture
- Evaluate whether the idempotency check should extend to other orchestrated modes (analyze-auto, focus, etc.)

---

## What Sinh Needs To Do

- [ ] Review requirements — are all sections accurate?
- [ ] Flag missing requirements or acceptance criteria
- [ ] Answer open questions O1, O2, O3
- [ ] Approve to route to builder for implementation, or request interactive follow-up

## Suggested Next Steps

- If approved: assign ticket PA-1255 to builder for implementation
- If clarification needed: request interactive requirements session with Sinh
