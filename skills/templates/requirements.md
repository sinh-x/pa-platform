# Template: Requirements

> **Template:** requirements
> **Version:** 4.0
> **Last Updated:** 2026-05-01
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

| # | Requirement | Priority | Notes |
|---|-------------|----------|-------|
| F1 | <requirement text> | Must / Should / Could | <context or rationale> |
| F2 | <requirement text> | Must / Should / Could | <context or rationale> |

## 7. Non-Functional Requirements

| # | Requirement | Priority | Notes |
|---|-------------|----------|-------|
| NF1 | <requirement text> | Must / Should / Could | <context or rationale> |
| NF2 | <requirement text> | Must / Should / Could | <context or rationale> |

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

## 16. Follow-up / Future Work

<Deferred work or None>
```

## 17. Guidance Notes

- Every section must be addressed. If a section does not apply, write `N/A` with a one-sentence reason.
- Keep `## 10. Acceptance Criteria` and `## 13. Implementation Plan` phase items as checkboxes. Builder updates these during implementation.
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
