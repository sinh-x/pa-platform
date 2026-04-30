# Template: Spike Full Requirements

> **Template:** spike-full-requirements
> **Version:** 1.0
> **Last Updated:** 2026-04-30
> **Used by:** Legacy spike workflow compatibility
> **Produces:** Full 13-section requirements-style document

## Template

```markdown
# Requirements: {{TOPIC}}

> **Date:** {{DATE}}
> **Author:** requirements / researcher
> **Status:** Draft
> **Deployment:** {{DEPLOYMENT_ID}}
> **Repository:** {{REPO_ROOT}}

## 1. Context & Background
**Confidence:** {{CONFIDENCE_1}}

{{CONTEXT_AND_BACKGROUND}}

## 2. Problem Statement
**Confidence:** {{CONFIDENCE_2}}

{{PROBLEM_STATEMENT}}

## 3. Goals & Success Criteria
**Confidence:** {{CONFIDENCE_3}}

- Goal 1: {{GOAL_1}}
- Goal 2: {{GOAL_2}}
- Goal 3: {{GOAL_3}}

Success looks like: {{SUCCESS_CRITERIA_SUMMARY}}

## 4. Scope
**Confidence:** {{CONFIDENCE_4}}

### In Scope
- {{IN_SCOPE_ITEM_1}}
- {{IN_SCOPE_ITEM_2}}

### Out of Scope
- {{OUT_OF_SCOPE_ITEM_1}}
- {{OUT_OF_SCOPE_ITEM_2}}

## 5. Users & Stakeholders
**Confidence:** {{CONFIDENCE_5}}

- **{{STAKEHOLDER_ROLE}}** — {{STAKEHOLDER_IMPACT}}

## 6. Requirements
**Confidence:** {{CONFIDENCE_6}}

### Functional

| # | Requirement | Priority | Confidence | Notes |
|---|-------------|----------|------------|-------|
| F1 | {{FUNCTIONAL_1}} | Must/Should/Could | {{CONF_FUNCTIONAL_1}} | {{NOTES_FUNCTIONAL_1}} |
| F2 | {{FUNCTIONAL_2}} | Must/Should/Could | {{CONF_FUNCTIONAL_2}} | {{NOTES_FUNCTIONAL_2}} |

### Non-Functional

| # | Requirement | Priority | Confidence | Notes |
|---|-------------|----------|------------|-------|
| NF1 | {{NONFUNCTIONAL_1}} | Must/Should/Could | {{CONF_NF_1}} | {{NOTES_NF_1}} |
| NF2 | {{NONFUNCTIONAL_2}} | Must/Should/Could | {{CONF_NF_2}} | {{NOTES_NF_2}} |

## 7. Dependencies & Prerequisites

- [ ] {{DEPENDENCY_1}}
- [ ] {{DEPENDENCY_2}}

## 8. Technical Approach
**Confidence:** {{CONFIDENCE_8}}

### Files to create
- **{{FILE_TO_CREATE}}** — {{FILE_TO_CREATE_PURPOSE}}

### Files to modify
- **{{FILE_TO_MODIFY}}** — {{FILE_TO_MODIFY_PURPOSE}}

### How it flows

{{ARCHITECTURE_FLOW}}

### Existing patterns reused
- {{EXISTING_PATTERN_1}}
- {{EXISTING_PATTERN_2}}

## 9. Risks & Unknowns

{{RISKS_SUMMARY}}

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| {{RISK_1}} | {{RISK_1_IMPACT}} | {{RISK_1_LIKELIHOOD}} | {{RISK_1_MITIGATION}} |
| {{RISK_2}} | {{RISK_2_IMPACT}} | {{RISK_2_LIKELIHOOD}} | {{RISK_2_MITIGATION}} |

### Open Questions

- [ ] {{OPEN_QUESTION_1}}
- [ ] {{OPEN_QUESTION_2}}

## 10. Acceptance Criteria
**Confidence:** {{CONFIDENCE_10}}

- [ ] AC1: {{AC1}}
- [ ] AC2: {{AC2}}
- [ ] AC3: {{AC3}}

## 11. Effort Estimate
**Confidence:** {{CONFIDENCE_11}}

- Size: {{SIZE}}
- Estimated sessions: {{ESTIMATED_SESSIONS}}
- Key files to touch: {{KEY_FILES}}

## 12. Implementation Plan
**Confidence:** {{CONFIDENCE_12}}

### Steps
1. {{IMPLEMENTATION_STEP_1}}
2. {{IMPLEMENTATION_STEP_2}}
3. {{IMPLEMENTATION_STEP_3}}

### Order of Operations
1. {{ORDER_OF_OPERATIONS_1}}
2. {{ORDER_OF_OPERATIONS_2}}
3. {{ORDER_OF_OPERATIONS_3}}

## 13. Follow-up / Future Work

- {{FOLLOW_UP_ITEM_1}}
- {{FOLLOW_UP_ITEM_2}}

## What Sinh Needs To Do

- [ ] Review requirements — are all sections accurate?
- [ ] Flag missing requirements or acceptance criteria
- [ ] Answer open questions
- [ ] Approve to route to builder, or request interactive follow-up

## Suggested Next Steps

- If approved: assign ticket to builder for implementation
- If clarification needed: rerun `opa deploy requirements --mode spike --ticket "{{TICKET_ID}}" --repo "{{REPO_ROOT}}"`
```

## Usage Notes

- Keep all 13 numbered sections in this order for compatibility with downstream parsers.
- Keep acceptance criteria checkboxes (`- [ ] ACn`) so builder can track completion.
- This template is legacy/review-compatible; use `spike-research-report.md` for the current parent-only orchestrated spike artifact.
