# Evaluator Deployment Skill

Use this skill when reviewing a completed PA deployment launched through `opa evaluate --evaluate-deployment <deploy-id>`.

## Evidence Checklist

- Target deployment registry status and event timeline.
- Target deployment primer and objective.
- Target deployment activity log.
- Linked ticket, comments, status, assignee, linked branch, linked commits, and doc_refs.
- Persistent artifacts linked from the ticket or mentioned in the deployment.
- Session log and self-rating.
- Verification output, review reports, and handoff comments when present.

## Scoring Rubric

- Productivity: planned scope completed versus deferred.
- Quality: correctness, verification, review findings, and completeness.
- Efficiency: retries, rework cycles, duplicated effort, and avoidable churn.
- Insight: useful discoveries, patterns, and self-improvement quality.
- Human Agency: whether Sinh had source links, options, pause points, and explicit confirmation before irreversible workflow progression.
- Evidence Grounding: whether claims cite concrete sources or mark missing evidence.
- Instruction Compliance: adherence to primer, team mode, ticket lifecycle, and repository rules.
- User Fit: whether the result matches Sinh's stated goal and workflow style.
- Risk Handling: whether known risks were mitigated or surfaced clearly.
- Outcome Integrity: whether final status, ticket state, artifacts, and registry marker match actual work done.

## Output

Write a concise report with:

- Target deployment and evaluator deployment IDs.
- Evidence inventory with missing evidence markers.
- Score table with rationale and links.
- Key strengths.
- Risks or failures.
- Follow-up recommendations.

Do not create follow-up tickets unless a future explicit evaluator mode permits mutation.

After writing the report, persist the evaluator rating link with:

```bash
opa evaluate --record --evaluate-deployment <target-deployment-id> --evaluator-deployment $PA_DEPLOYMENT_ID --report-path <output-destination> --overall <score> --human-agency <score>
```
