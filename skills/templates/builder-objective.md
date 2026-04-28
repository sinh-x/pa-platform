# Template: Builder Objective

> **Template:** builder-objective
> **Version:** 1.0
> **Last Updated:** 2026-04-28
> **Used by:** Builder orchestrator at implementation handoff
> **Produces:** Structured objective for builder implement mode
> **Consumed by:** Builder implement mode

## Purpose

Structured format for orchestrator-to-builder handoff, containing the exact context needed to execute one implementation phase.

## When to Use

- When orchestrator launches a builder implement deployment.
- When composing the objective for each implementation phase.

## Template

```markdown
Phase N of <item-filename>: <phase description from checklist>

## Scope
<List the section 4 In Scope items this phase addresses, as checkboxes.>

## Requirements
### Functional
| # | Requirement | Priority | Notes |
|---|---|---|---|
| F1 | ... | Must | ... |

### Non-Functional
| # | Requirement | Priority | Notes |
|---|---|---|---|
| NF1 | ... | Must | ... |

## Acceptance Criteria
<List the section 10 acceptance criteria items that become verifiable after this phase, as checkboxes.>
Note `(partial - full verification after Phase M)` if AC spans multiple phases.

## Verification
<Ordered list of verification steps for this phase.>

## Context
- Repo: <repo_path>
- Branch: <feature_branch already checked out by orchestrator; implement verifies only>
- Plan: <path to plan document>
- Prior phases completed: <list of completed phase numbers, or none>
- Dependencies: <any section 7 items or prior-phase outputs this phase needs>
```

## Guidance Notes

- Include only requirements, non-functional requirements, and acceptance criteria relevant to this phase.
- Always include all Must priority non-functional requirements as baseline context.
- If an acceptance criterion spans multiple phases, include it in the earliest phase where it is partially testable.
- If a phase has no mapped acceptance criteria, explicitly write `No acceptance criteria mapped to this phase`.
- Use opencode-safe runtime instructions and `opa` commands when command examples are needed.

## What the Next Stage Needs

- **Builder implement mode** needs: exact scope, repo, expected branch, verification commands, and dependencies.
- **Orchestrator** remains responsible for branch creation and switching; implement mode only verifies.
- **Future deployments** need prior phase outputs and artifact paths named explicitly.
