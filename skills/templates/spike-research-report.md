# Template: Spike Research Report

> **Template:** spike-research-report
> **Version:** 1.1
> **Last Updated:** 2026-04-30
> **Used by:** Requirements spike parent (`requirements` -> `spike`)
> **Produces:** Consolidated spike artifact in deployment and requirements artifact paths

## Template

```markdown
# Spike Research: {{TOPIC}}

## Objective

- Ticket: {{TICKET_ID}}
- Repo: {{REPO_ROOT}}
- Deployment: {{DEPLOYMENT_ID}}
- Parent status: {{STATUS}}

## Quick Answer

{{QUICK_ANSWER}}

## Key Takeaways

{{KEY_TAKEAWAYS}}

## What The Spike Found

{{FINDINGS_SUMMARY}}

## Provider Perspectives

- MiniMax: {{MINIMAX_PERSPECTIVE}}
- OpenAI: {{OPENAI_PERSPECTIVE}}

## External Sources

- [source] {{URL}} — {{NOTES}}

If no web sources were available, state: `No external sources were collected.`

## Codebase Findings

{{CODEBASE_FINDINGS}}

## Contradictions Or Uncertainties

{{CONTRADICTIONS_OR_UNCERTAINTIES}}

## Recommended Follow-Up

{{FOLLOW_UP_ACTIONS}}

## Open Questions

{{OPEN_QUESTIONS}}

## Sub-Deploy Reports

| Provider | Deploy ID | Status | Artifact Path | Failure or Uncertainty Note |
| --- | --- | --- | --- | --- |
| MiniMax | `{{MINIMAX_DEPLOY_ID}}` | {{MINIMAX_STATUS}} | `{{MINIMAX_ARTIFACT_PATH}}` | {{MINIMAX_FAILURE_OR_UNCERTAINTY}} |
| OpenAI | `{{OPENAI_DEPLOY_ID}}` | {{OPENAI_STATUS}} | `{{OPENAI_ARTIFACT_PATH}}` | {{OPENAI_FAILURE_OR_UNCERTAINTY}} |

## Resources Used

- Sub-deploy outputs are expected above and in `/spike-child-*` child artifacts.
- Include links to any external references and evidence used by each child run.

## Retrieval Notes

{{RETRIEVAL_NOTES}}
```

## Usage Notes

- Keep the headings exactly as shown; downstream tooling scans these sections.
- Add child-specific rows even when a provider fails so partial success remains auditable.
- Include one uncertainty/failure note for every failed or timed-out child.
- Finalize this artifact before changing ticket status.
- Keep `## What The Spike Found`, `## Contradictions Or Uncertainties`, and `## Provider Perspectives` populated even for partial runs.
