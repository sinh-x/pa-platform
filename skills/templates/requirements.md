# Template: Requirements

> **Template:** requirements
> **Version:** 2.0
> **Last Updated:** 2026-04-28
> **Used by:** Requirements team analyze modes
> **Produces:** Requirements document and implementation checklist
> **Consumed by:** Builder team and UAT reviewers

## Purpose

Canonical 13-section requirements checklist for pa-platform requirements analysis. Use this template when producing a requirements artifact that will be attached to a ticket and handed to builder.

## When to Use

- When starting requirements analysis from an assigned ticket.
- When producing a requirements document for an approved idea, feature, bug, or task.
- When an analyze-mode skill says to use the standard 13-section checklist.

## Template

```markdown
# Requirements: <title>

> Date: YYYY-MM-DD
> Author: <team>/<agent>
> Status: Draft / Approved
> Deployment: <deployment_id>
> Repository: <repo_path or N/A with reason>
> Ticket: <ticket-id or none>

## 1. Title
<Short human-readable title.>

## 2. Summary
<What is being requested, why it matters, and the expected outcome.>

## 3. Goals and Non-Goals
Goals:
- <Goal 1>
- <Goal 2>

Non-goals:
- <Boundary 1>
- <Boundary 2>

## 4. In Scope
- [ ] <Concrete in-scope item 1>
- [ ] <Concrete in-scope item 2>

## 5. Out of Scope
- <Concrete out-of-scope item and reason>
- <Concrete out-of-scope item and reason>

## 6. Users and Stakeholders
- <User, reviewer, downstream team, or affected system>

## 7. Dependencies and Prerequisites
- <Named dependency and status, or N/A with reason>

## 8. Technical Approach
Files and areas to inspect or modify:
- `<path>`: <why it matters>

Existing patterns to reuse:
- <pattern>

Flow:
- <implementation or analysis flow>

## 9. Risks
| Risk | Impact | Likelihood | Mitigation |
|---|---:|---:|---|
| <risk> | High / Medium / Low | High / Medium / Low | <mitigation or open question> |

## 10. Acceptance Criteria
- [ ] AC1: Given <context>, when <action>, then <observable result>.
- [ ] AC2: Given <context>, when <action>, then <observable result>.

## 11. Open Questions
- None, or list each unresolved question with `[BLOCKING]` or `[NON-BLOCKING]`.

## 12. Impact Analysis
Expected impacted surfaces:
- <surface or N/A with reason>

Downstream consumers:
- <consumer or N/A with reason>

Risk level:
- High / Medium / Low, with reason.

## 13. Implementation Plan and Follow-up
Recommended order:
- [ ] Phase 1 - <description>
- [ ] Phase 2 - <description>

Effort estimate:
- Size: XS / S / M / L / XL
- Estimated implementation sessions: <N>
- Key files: `<paths>`

Follow-up:
- <deferred work or None>
```

## Guidance Notes

- Every section must be addressed. If a section does not apply, write `N/A` with a one-sentence reason.
- Keep `## 4. In Scope`, `## 10. Acceptance Criteria`, and `## 13. Implementation Plan and Follow-up` phase items as checkboxes. Builder updates these during implementation.
- Acceptance criteria must be observable pass/fail statements. Avoid vague terms unless they have a measurable definition.
- If the originating ticket has `doc_refs`, fill `## 12. Impact Analysis` with change surface, downstream consumers, and risk level.
- Use `opa ticket` commands in opencode deployments. Do not depend on external Claude Code skill folders.

## What the Next Stage Needs

- **Builder** needs: repo path, branch, scope, acceptance criteria, implementation phases, and verification steps.
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
