# Template: Requirements

> **Template:** requirements
> **Version:** 4.1
> **Last Updated:** 2026-05-02
> **Used by:** Requirements team analyze modes
> **Produces:** Requirements document and implementation checklist
> **Consumed by:** Builder team and UAT reviewers

## Purpose

Canonical requirements document template for pa-platform requirements analysis. Uses FR table / NFR table format to mirror old `pa requirements` output. Use this template when producing a requirements artifact that will be attached to a ticket and handed to builder.

## When to Use

- When starting requirements analysis from an assigned ticket.
- When producing a requirements document for an approved idea, feature, bug, or task.
- When an analyze-mode skill says to use the standard checklist.

## Template

```markdown
# Requirements: <title>

> Date: YYYY-MM-DD
> Author: <team>/<agent>
> Status: Draft / Approved
> Deployment: <deployment_id>
> Repository: <repo_path or N/A with reason>
> Ticket: <ticket-id or none>
> Feature Branch: feature/<ticket-id>-<topic-slug> or N/A with reason
> Shape-Conformance: N/13

## 1. Title
<Short human-readable title.>

## 2. Summary
<What is being requested, why it matters, and the expected outcome.>

## 3. Goals / Non-Goals

Goals:
- <what this feature/change aims to achieve>

Non-Goals:
- <what this feature/change explicitly does NOT aim to achieve>

## 4. In Scope

- <item 1>
- <item 2>

## 5. Out of Scope

- <item 1>
- <item 2>

## 6. Functional Requirements

Required: include at least one real Functional Requirement row with non-placeholder content, or write `N/A - <one-sentence reason>` if no functional requirements apply. Do not leave placeholder rows in saved documents.

| # | Requirement | Priority | Notes |
|---|-------------|----------|-------|

## 7. Non-Functional Requirements

Required: include at least one Non-Functional Requirement row and at least one quantitative row with a numeric budget, named standard, or measurable threshold. If the work is purely structural with no runtime impact, write exactly `N/A — purely structural change with no runtime impact` instead of table rows.

| # | Requirement | Priority | Notes |
|---|-------------|----------|-------|

## 8. Dependencies

- <Named dependency and status, or N/A with reason>

## 9. Stakeholders

- <User, reviewer, downstream team, or affected system>

## 10. Acceptance Criteria

- [ ] AC1: Given <context>, when <action>, then <observable result>.
- [ ] AC2: Given <context>, when <action>, then <observable result>.

## 11. Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---:|---:|---|
| <risk> | High / Medium / Low | High / Medium / Low | <mitigation or open question> |

## 12. Technical Approach

Files and areas to inspect or modify:
- `<path>`: <why it matters>

Existing patterns to reuse:
- <pattern>

Reuse Analysis:
- Identify existing modules, data sources, templates, commands, or patterns to extend before proposing new ones. If rejecting reuse, state why.

Flow:
- <implementation or analysis flow>

## 13. Implementation Plan

Feature branch:
- `feature/<ticket-id>-<topic-slug>`

Recommended order:
- [ ] Phase 1 - <short title>
  - Deliverables: <specific files, commands, or behavior changes>
  - Traceability: <FR/NFR/AC IDs this phase addresses>
  - Verification: <phase-specific checks such as typecheck, targeted tests, build, completions>
- [ ] Phase 2 - <short title>
  - Deliverables: <specific files, commands, or behavior changes>
  - Traceability: <FR/NFR/AC IDs this phase addresses>
  - Verification: <phase-specific checks such as typecheck, targeted tests, build, completions>

Effort estimate:
- Size: XS / S / M / L / XL
- Estimated implementation sessions: <N>
- Key files: `<paths>`

## 14. Open Questions

<Open questions, blockers, or items needing clarification. N/A if none.>

## 15. Impact Analysis

<Change surface, downstream consumers, risk level. N/A with reason if originating ticket had no doc_refs.>

Blast Radius:
- Estimated LoC touched: <number or bounded estimate>
- Existing modules extended: <count and names>
- New modules created: <count and names, or 0>
- Rewrite justification: <required if replacing or rewriting an existing module; otherwise N/A with reason>

## 16. Follow-up / Future Work

<Deferred work or None>

## Class Profile Checklist (required)

Choose exactly one profile based on the Classification Record class.

For `software-dev`:

### Software Profile
- [ ] Product behavior/system change is explicit and implementable
- [ ] Code surface and impacted modules are named
- [ ] FR/NFR mapping includes software verification expectations
- [ ] Acceptance criteria map to software behavior pass/fail outcomes
- [ ] Verification checklist includes required repository checks for changed files

For `data-analysis/dashboard-pipeline`:

### Data Understanding
- [ ] Data entities, sources, and lineage boundaries are identified
- [ ] Metric definitions, dimensions, and aggregation semantics are defined
- [ ] Data quality assumptions and caveats are captured

### Pipeline Validation
- [ ] Pipeline/query steps are listed with validation points
- [ ] Correctness checks cover joins/filters/aggregations/time windows
- [ ] Output integrity checks are defined for dashboards/reports/tables

### PAP-048 Compatibility
- [ ] Requirements language is explicitly compatible with PAP-048 semantics
- [ ] Route and verification language does not conflict with PAP-048 data mode direction

## Class-Specific Verification Gates (required)

`software-dev` gate:
- [ ] Software profile section present and complete
- [ ] FR/NFR/AC entries include software-verifiable checks
- [ ] Verification steps include software checks (typecheck/build/test/runtime as applicable)

`data-analysis/dashboard-pipeline` gate:
- [ ] Data profile sections present (`Data Understanding`, `Pipeline Validation`, `PAP-048 Compatibility`)
- [ ] FR/NFR/AC entries include data-verifiable checks
- [ ] Verification steps include data/pipeline validation checks
- [ ] PAP-048 compatibility statement is explicit and non-conflicting

## Classification Record (required before scope finalization)

- Class: `software-dev` | `data-analysis/dashboard-pipeline` (choose exactly one)
- Rationale Step 1 (primary deliverable): <brief rationale>
- Rationale Step 2 (dominant verification type): <brief rationale or N/A if Step 1 was sufficient>
- Deterministic route anchor: <single class-to-route mapping, no ambiguous fallback>
- PAP-048 compatibility note (required for data class): <statement or N/A for software-dev>

## Handoff Routing Map (required)

Record exactly one deterministic route based on the selected class.

| Class | Route (team/mode) | Required handoff format |
|---|---|---|
| `software-dev` | `builder/implement` | Include repo path, feature branch, ordered implementation phases, FR/NFR/AC traceability, and repo verification checks for changed files. |
| `data-analysis/dashboard-pipeline` | `builder/data-analysis` (PAP-048 compatible semantics) | Include Data Understanding, Pipeline Validation, PAP-048 Compatibility, and explicit data/pipeline verification checks. |

Rules:
- Exactly one row is active for the document's selected class.
- No "decide later", fallback, or dual-route output is allowed.
- For data class, include explicit PAP-048 compatibility statement and avoid conflicting mode terminology.
```

## 17. Guidance Notes

- Every section must be addressed. If a section does not apply, write `N/A` with a one-sentence reason.
- The requirements document has 16 numbered document sections. Shape-Conformance is a deterministic pass/fail count across 13 Quality Bar checks. Use `N/13`; do not apply weighting.
- Intake classification is a hard gate: assign exactly one class (`software-dev` or `data-analysis/dashboard-pipeline`) before Phase 2 scope work begins.
- For ambiguous requests, use two-step triage: (1) primary deliverable, then (2) dominant verification type.
- Handoff must include one deterministic class-to-route mapping; ambiguous fallback is not allowed.
- Handoff Routing Map is mandatory and must resolve to one route (`builder/implement` or `builder/data-analysis`) based on class.
- Keep `## 10. Acceptance Criteria` and `## 13. Implementation Plan` phase items as checkboxes. Builder updates these during implementation.
- Class profile and verification gates are mandatory: every doc must include exactly one active profile (`software-dev` or `data-analysis/dashboard-pipeline`) and class-specific verification gates.
- For `data-analysis/dashboard-pipeline`, include explicit `Data Understanding`, `Pipeline Validation`, and `PAP-048 Compatibility` subsections.
- Every implementation-bound requirements document MUST name the feature branch and include an ordered phase checklist. Each phase MUST include deliverables, traceability to FR/NFR/AC IDs, and phase-specific verification steps.
- Acceptance criteria must be observable pass/fail statements. Avoid vague terms unless they have a measurable definition.
- Use `opa ticket` commands in opencode deployments. Do not depend on external Claude Code skill folders.

## 18. What the Next Stage Needs

- **Builder** needs: repo path, branch, scope (FR/NFR tables), acceptance criteria, implementation phases, and verification steps.
- **Sinh / UAT reviewer** needs: testable acceptance criteria, risks, caveats, and explicit deferred work.
- **Future agents** need: doc_refs on the ticket and enough impact context to resume without re-discovering the whole task.

## Doc-Ref Types

When attaching documents to tickets via `--doc-ref`, use these type prefixes:

| Type | Use for | Example |
|---|---|---|
| `requirements` | Requirements documents | `--doc-ref "requirements:agent-teams/requirements/artifacts/YYYY-MM-DD-topic.md"` |
| `uat` | UAT test plans | `--doc-ref "uat:agent-teams/requirements/artifacts/YYYY-MM-DD-topic-uat.md"` |
| `implementation` | Implementation artifacts | `--doc-ref "implementation:agent-teams/builder/artifacts/YYYY-MM-DD-topic.md"` |
| `orchestration` | Orchestration reports | `--doc-ref "orchestration:agent-teams/builder/artifacts/YYYY-MM-DD-report.md"` |
| `session` | Session logs | `--doc-ref "session:sessions/YYYY/MM/agent-team/YYYY-MM-DD-log.md"` |
| `attachment` | Generic attachments | `--doc-ref "attachment:path/to/file.pdf"` |

Use `--doc-ref-primary` to mark the primary doc_ref, typically the requirements document before approval and the implementation artifact before UAT handoff.
