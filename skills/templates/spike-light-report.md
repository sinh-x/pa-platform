# Template: Spike Light Report

> **Template:** spike-light-report
> **Version:** 1.0
> **Last Updated:** 2026-04-30
> **Used by:** Legacy spike workflow compatibility
> **Produces:** Compact spike report artifact

## Template

```markdown
# Spike Report: {{TOPIC}}

> **Date:** {{DATE}}
> **From:** requirements / researcher
> **To:** sinh
> **Deployment:** {{DEPLOYMENT_ID}}
> **Type:** review-request
> **Format:** light-spike

## Topic

{{TOPIC_SUMMARY}}

## Research Summary

{{RESEARCH_SUMMARY}}

## Codebase Findings

**Confidence:** {{CODEBASE_CONFIDENCE}}

- **Integration points:** {{INTEGRATION_POINTS}}
- **Existing patterns to follow:** {{EXISTING_PATTERNS}}
- **Dependencies in use:** {{DEPENDENCIES}}
- **Files read:** {{FILES_READ}}

## External Findings

**Confidence:** {{EXTERNAL_CONFIDENCE}}

- {{EXTERNAL_FINDING_1}}
- {{EXTERNAL_FINDING_2}}
- {{EXTERNAL_FINDING_3}}

## Complexity Assessment

{{COMPLEXITY_ASSESSMENT}}

## Recommendations

- [ ] {{RECOMMENDATION_1}}
- [ ] {{RECOMMENDATION_2}}
- [ ] {{RECOMMENDATION_3}}

## Open Questions

> These require interactive follow-up before implementation:

- ? {{OPEN_QUESTION_1}}
- ? {{OPEN_QUESTION_2}}

## What Sinh Needs To Do

- [ ] Review findings — are key areas covered?
- [ ] Answer open questions to unblock next steps
- [ ] Decide: proceed to full requirements session or defer

## Suggested Next Steps

- If proceed: run `opa deploy requirements --mode spike --ticket "{{TICKET_ID}}" --repo "{{REPO_ROOT}}"`
- If defer: move to ideas for future triage
```

## Usage Notes

- Keep `## From:` and `## To:` semantics explicit in output.
- Keep section confidence explicit for `Codebase Findings` and `External Findings`.
- Use this template only when a compact feasibility-oriented spike is sufficient.
