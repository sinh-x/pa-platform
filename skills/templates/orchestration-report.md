# Template: Orchestration Report

> **Template:** orchestration-report
> **Version:** 1.0
> **Last Updated:** 2026-04-28
> **Used by:** Builder orchestrator as the living cross-phase report
> **Produces:** Orchestration report artifact
> **Consumed by:** Sinh, future orchestrator runs, and aggregators

## Purpose

The orchestration report records every sub-deployment launched by the orchestrator, the review/fix cycle state, and the final outcome. It is the primary handoff artifact on success paths and the handoff artifact on partial or failure paths.

## When to Use

- Create at the start of an orchestrated ticket.
- Update on each sub-deployment launch, completion, cycle transition, and phase boundary.
- Finalize before advancing a ticket to `review-uat`.
- Attach on partial or failure exits so Sinh can see the current state.

## Template

```markdown
### Orchestration Report: <topic>

> Ticket: <id> | Started: <ts> | Last updated: <ts>
> Status: in-progress | success | partial | failed

### Summary

<One paragraph covering goal, scope, and completion definition.>

Repo: <repo_path>
Branch: <feature_branch>
PR: <PR URL, populated after PR creation>

### Timeline
- <HH:MM> - Phase 0 (repo resolution) orchestrator started <deploy-id>
- <HH:MM> - Phase 4.1 (<brief scope>) launched <deploy-id>
- <HH:MM> - Phase 4.1 (<brief scope>) completed <deploy-id> success
- <HH:MM> - Phase 6 orchestration complete - ticket advanced to review-uat

### Sub-Deploys
| Phase | Deploy ID | Mode | Status | Severity |
|---|---|---|---|---|
| 4.1 (<brief scope>) | d-abc123 | builder/implement | success | - |

> Severity: C=Critical, M=Major, Mn=Minor, I=Info

### Cycles
Current: 1 / 3

### Remaining Findings (latest review)
- Critical (0): -
- Major (0): -
- Minor (0): -
- Info (0): -

### Sub-Deploy IDs
- Implementation: <ids>
- Review: <ids>
- Fix: <ids>

### Resume Hint
Next: <next action, or COMPLETE - no resume needed>

### Orchestrator Runs
- <deploy-id>: started <ts>, status <status>, reason <reason if terminal>

### Session Log
sessions/YYYY/MM/agent-team/<session-log-filename>.md
```

## Guidance Notes

- `Status:` must be exactly `in-progress`, `success`, `partial`, or `failed`.
- Populate `Repo:`, `Branch:`, and `PR:` near the top so reviewers can cold-read the artifact.
- Keep timeline entries one line each and use verifiable timestamps when available.
- Use the fixed remaining-findings format so future tools can parse the report.
- On terminal exit, write the session log first, then populate `### Session Log`.
- Attach with `opa ticket update <id> --doc-ref "orchestration:agent-teams/builder/artifacts/YYYY-MM-DD-report.md"` before handoff.

## What the Next Stage Needs

- **Sinh** needs a scannable summary, PR link when available, latest findings, and an actionable last timeline entry.
- **Future orchestrator runs** need cycle count, sub-deploy IDs, and a clear resume hint.
- **Aggregators** need stable headings and status values.
