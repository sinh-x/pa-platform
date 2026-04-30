# Template: Spike Learning Note

> **Template:** spike-learning-note
> **Version:** 1.1
> **Last Updated:** 2026-04-30
> **Used by:** Requirements spike learning-management export

```yaml
---
type: spike-research
para: area
date: {{DATE}}
topic: {{TOPIC}}
slug: {{SLUG}}
domain: {{DOMAIN}}
tags:
  - spike
aliases: []
status: reviewed
confidence: {{CONFIDENCE}}
source_repo: {{SOURCE_REPO}}
source_ticket: {{SOURCE_TICKET}}
source_doc: {{SOURCE_DOC_PATH}}
source_deployments:
  - {{SOURCE_DEPLOYMENT_ID}}
review_date: {{REVIEW_DATE}}
review_interval: 30d
review_status: pending
related:
  - {{RELATED_SLUG}}
---

# Spike Research: {{TOPIC}}

## Objective

{{OBJECTIVE}}

## Quick Answer

{{QUICK_ANSWER}}

## Key Takeaways

{{KEY_TAKEAWAYS}}

## What The Spike Found

{{WHAT_FOUND}}

## Provider Perspectives

- MiniMax: {{MINIMAX_SUMMARY}}
- OpenAI: {{OPENAI_SUMMARY}}

## External Sources

{{EXTERNAL_SOURCES}}

## Codebase Findings

{{CODEBASE_FINDINGS}}

## Contradictions Or Uncertainties

{{CONTRADICTIONS_OR_UNCERTAINTIES}}

## Recommended Follow-Up

{{RECOMMENDED_FOLLOW_UP}}

## Open Questions

{{OPEN_QUESTIONS}}

## Resources Used

{{RESOURCES}}

## Retrieval Notes

{{RETRIEVAL_NOTES}}
```

## Usage Notes

- Keep `type: spike-research`, `source_doc`, `source_repo`, `source_ticket`, and `source_deployments` aligned with the parent execution context.
- Keep all approved frontmatter fields from the requirements doc.
- Populate `source_deployments` with a compact list of parent or child deployment IDs used for this spike.
- For missing repos, use `source_repo: N/A` or the explicit root that was resolved.
