# KPI Definitions — Requirements Team

> **Version:** v1
> **Date:** 2026-03-26
> **Author:** builder (based on PA-982 requirements doc)
> **Status:** Active

## Overview

Three-tier KPI framework for evaluating requirements team deployments:
1. **Output Quality** — Does the artifact meet standards?
2. **Process Adherence** — Did the agent follow the required phases?
3. **Downstream Impact** — Did the output enable effective implementation?

---

## Scoring Scale

All criteria use a 1–5 scale with anchor descriptions:

| Score | Label | Anchor Description |
|-------|-------|-------------------|
| 5 | Exceptional | Far exceeds standard; sets new benchmark; consistently goes above and beyond |
| 4 | Strong | Meets all standards; some aspects exceed; minor room for improvement |
| 3 | Adequate | Meets core standards; some gaps but acceptable for deployment |
| 2 | Weak | Falls short on several aspects; significant remediation needed |
| 1 | Poor | Fails to meet basic standards; not deployable without major rework |

**Soft gate rule:** Scores of 2 or below indicate gate criteria not met. Agents log the score but continue with a warning rather than halting.

---

## Tier 1: Output Quality

Measures whether the requirements artifact itself is well-formed, complete, and actionable.

### OQ-1: Section Completeness
**What:** All 13 sections of the standard checklist are present and substantive.
**Scoring:**
- 5: All 13 sections present, each with thorough, detailed content
- 4: All 13 sections present, most with substantive content
- 3: All 13 sections present, some shallow or N/A without justification
- 2: Missing or severely underdeveloped 3+ sections
- 1: Less than 8 sections present

### OQ-2: Requirement Clarity
**What:** Requirements are specific, unambiguous, and actionable for builders.
**Scoring:**
- 5: Every requirement is specific with measurable outcomes; no ambiguity
- 4: Most requirements are clear; minor vagueness in 1-2 items
- 3: Core requirements are clear but some are vague or high-level
- 2: Several requirements are too vague to implement directly
- 1: Most requirements are vague or statement of intent rather than spec

### OQ-3: Acceptance Criteria Quality
**What:** Acceptance criteria are testable and provide clear "done" signals.
**Scoring:**
- 5: Every AC is directly verifiable; clear pass/fail conditions
- 4: Most ACs are verifiable; minor gaps in 1-2
- 3: Core ACs are verifiable; others are observational rather than testable
- 2: Several ACs are vague or not independently verifiable
- 1: ACs are missing or purely aspirational

### OQ-4: Scope Definition
**What:** In-scope and out-of-scope items are clearly delineated.
**Scoring:**
- 5: Explicit in/out lists with clear boundaries; no ambiguity
- 4: Clear scope with minor edge cases undefined
- 3: Basic scope defined but some important exclusions missing
- 2: Scope is fuzzy; in-scope and out-of-scope overlap or conflict
- 1: No clear scope definition

### OQ-5: Technical Grounding
**What:** Technical approach is grounded in actual codebase exploration.
**Scoring:**
- 5: Extensive codebase exploration; references specific files, patterns, APIs
- 4: Good exploration; references files and patterns appropriately
- 3: Basic exploration; mentions relevant areas but not deeply
- 2: Minimal exploration; technical approach feels assumptions rather than findings
- 1: No codebase exploration evident

---

## Tier 2: Process Adherence

Measures whether the agent followed the required phases and protocols.

### PA-1: Phase Sequence Compliance
**What:** Agent completed phases in the required order.
**Scoring:**
- 5: All phases completed in sequence with logged gate status for each
- 4: All phases completed; minor sequence deviation in non-critical areas
- 3: Core phases completed; 1-2 phases skipped or done out of order
- 2: Multiple phases skipped or significantly out of order
- 1: No discernible phase structure

### PA-2: Gate Criteria Satisfaction
**What:** Agent satisfied gate criteria before proceeding to next phase.
**Scoring:**
- 5: All gate criteria explicitly satisfied and logged
- 4: All gates passed; documentation of some could be clearer
- 3: Core gates passed; some gate documentation missing
- 2: Several gates skipped or passed without meeting criteria
- 1: Gates ignored entirely

### PA-3: Repo Context Compliance
**What:** Agent restricted exploration to the specified repo_root.
**Scoring:**
- 5: All file operations within repo_root; proper use of scoping rules
- 4: All operations within scope; minor off-limit reference
- 3: Mostly within scope; some files outside without justification
- 2: Significant files explored outside scope
- 1: No evidence of scope awareness

### PA-4: Output Protocol Adherence
**What:** Agent saved artifacts to all 3 required destinations.
**Scoring:**
- 5: Saved to workspace, artifacts, AND linked via doc_ref on ticket
- 4: Saved to all 3; minor doc_ref timing issue
- 3: Saved to 2 of 3 destinations; 1 missing
- 2: Saved to only 1 destination
- 1: Output not saved or not retrievable

### PA-5: Interactive Mode Fidelity (analyze/review only)
**What:** Agent properly engaged with user through AskUserQuestion.
**Scoring:**
- 5: All decisions confirmed with user; no assumptions made
- 4: User engaged appropriately; minor self-decisions that should have been user-confirmed
- 3: Adequate engagement; some key decisions made without user input
- 2: Agent made significant decisions without user; frequent assumptions
- 1: No evidence of user interaction; pure assumption mode

---

## Tier 3: Downstream Impact

Measures whether the requirements enabled effective implementation downstream.

### DI-1: Builder Clarification Requests
**What:** Number of clarification tickets/comments from builder team.
**Scoring:**
- 5: Zero clarification requests; builder proceeded directly to implementation
- 4: 1-2 minor clarifications; no blocking issues
- 3: Several clarifications needed; some scope questions
- 2: Many clarifications; significant gaps in requirements
- 1: Requirements unusable without major rework; multiple clarification cycles

### DI-2: Scope Creep During Implementation
**What:** Amount of new requirements discovered during builder phase.
**Scoring:**
- 5: No new scope items; implementation matched requirements exactly
- 4: Minor scope adjustments; 1-2 items added with justification
- 3: Some scope creep; several items that should have been in original scope
- 2: Significant scope creep; large portions should have been captured
- 1: Requirements fundamentally incomplete; major rework needed

### DI-3: Implementation Accuracy
**What:** Degree to which implementation matched the documented requirements.
**Scoring:**
- 5: Implementation faithfully matches all requirements; all ACs met
- 4: Implementation matches with minor deviations; ACs mostly met
- 3: Core requirements met; some deviation from spec
- 2: Significant deviation; some core requirements not addressed
- 1: Implementation does not match requirements; wrong approach

### DI-4: Rework/Revision Tags
**What:** Number of rework or revision tags added to tickets post-review.
**Scoring:**
- 5: No rework tags; approved on first pass
- 4: 1-2 minor revisions; no rework tags
- 3: Several revisions; 1 rework tag
- 2: Multiple revision cycles; several rework tags
- 1: Requirements fundamentally wrong; extensive rework needed

---

## Per-Mode Rubrics

### Analyze Mode Specific Criteria

| Criterion | What It Measures |
|-----------|------------------|
| AM-1: Problem Understanding | Agent correctly identified the core problem through questioning |
| AM-2: User Alignment | Agent confirmed understanding with user before proceeding |
| AM-3: Codebase Validation | Agent verified assumptions before documenting |
| AM-4: Risk Surface | Agent surfaced risks and open questions proactively |
| AM-5: 13-Section Completeness | All sections of the requirements doc are present and substantive |

### Review Mode Specific Criteria

| Criterion | What It Measures |
|-----------|------------------|
| RM-1: Area Coverage | Agent covered all selected review areas thoroughly |
| RM-2: Finding Severity Accuracy | Severity ratings match the actual impact of findings |
| RM-3: Evidence Quality | All findings supported by code snippets, test output, or direct observation |
| RM-4: Recommendation Actionability | Recommendations are specific and implementable |
| RM-5: Testing Verification | Agent ran appropriate local tests and reported results |

### Spike Mode Specific Criteria

| Criterion | What It Measures |
|-----------|------------------|
| SM-1: Topic Resolution | Agent correctly resolved the research topic from available inputs |
| SM-2: Research Depth | Agent explored codebase and web comprehensively |
| SM-3: Complexity Assessment Validity | Decision (light spike vs full doc) was appropriate for topic |
| SM-4: Confidence Calibration | Confidence levels match actual certainty of findings |
| SM-5: Self-Sufficiency | Agent made good autonomous decisions without user guidance |

---

## KPI Report Template

```markdown
# KPI Report: <deployment-id> / <ticket-id>

> **Date:** YYYY-MM-DD
> **Evaluator:** kpi-reviewer
> **Mode:** analyze | review | spike
> **Overall Score:** X/5

## Summary

| Tier | Score | Status |
|------|-------|--------|
| Output Quality | X/5 | ✅ Strong / ⚠️ Adequate / ❌ Weak |
| Process Adherence | X/5 | ✅ Strong / ⚠️ Adequate / ❌ Weak |
| Downstream Impact | X/5 | ✅ Strong / ⚠️ Adequate / ❌ Weak |

## Tier 1: Output Quality

| Criterion | Score | Notes |
|-----------|-------|-------|
| OQ-1: Section Completeness | X/5 | ... |
| OQ-2: Requirement Clarity | X/5 | ... |
| OQ-3: Acceptance Criteria Quality | X/5 | ... |
| OQ-4: Scope Definition | X/5 | ... |
| OQ-5: Technical Grounding | X/5 | ... |
| **Tier Average** | **X/5** | |

## Tier 2: Process Adherence

| Criterion | Score | Notes |
|-----------|-------|-------|
| PA-1: Phase Sequence Compliance | X/5 | ... |
| PA-2: Gate Criteria Satisfaction | X/5 | ... |
| PA-3: Repo Context Compliance | X/5 | ... |
| PA-4: Output Protocol Adherence | X/5 | ... |
| PA-5: Interactive Mode Fidelity | X/5 | ... |
| **Tier Average** | **X/5** | |

## Tier 3: Downstream Impact

| Criterion | Score | Notes |
|-----------|-------|-------|
| DI-1: Builder Clarification Requests | X/5 | ... |
| DI-2: Scope Creep During Implementation | X/5 | ... |
| DI-3: Implementation Accuracy | X/5 | ... |
| DI-4: Rework/Revision Tags | X/5 | ... |
| **Tier Average** | **X/5** | |

## Mode-Specific Scores

| Criterion | Score | Notes |
|-----------|-------|-------|
| [AM|RM|SM]-1: ... | X/5 | ... |
| ... | ... | ... |
| **Mode Average** | **X/5** | |

## Strengths
- ...

## Areas for Improvement
- ...

## Recommendations
- ...

## Evidence Sources
- Session log: sessions/YYYY/MM/agent-team/<file>
- Artifact: agent-teams/requirements/artifacts/<file>
- Ticket history: PA-XXX comments
```

---

## Scoring Examples

### Example: Strong Analyze Mode Output (4/5 overall)

```
OQ-1: 4 — All 13 sections present, content thorough
OQ-2: 4 — One requirement slightly vague ("robust error handling")
OQ-3: 5 — Every AC directly verifiable with clear pass/fail
OQ-4: 4 — Scope clear, one edge case undefined
OQ-5: 4 — Good codebase exploration, 6 files referenced

PA-1: 5 — All 6 phases completed in sequence
PA-2: 4 — All gates passed, one gate documentation slightly brief
PA-3: 5 — All exploration within repo_root
PA-4: 4 — Saved to all 3, doc_ref added 2 min after advance
PA-5: 4 — One minor decision made without user confirmation

Overall: 4/5 — Strong output, minor documentation gaps
```

### Example: Weak Spike Output (2/5 overall)

```
OQ-1: 2 — Only 9 sections present; §7, §10, §11 missing
OQ-2: 2 — Requirements are high-level statements, not specs
OQ-3: 1 — No acceptance criteria defined
OQ-4: 2 — In-scope/out-of-scope not delineated
OQ-5: 3 — Mentioned 2 files but no specifics

PA-1: 2 — Phases S1, S3, S5 only; skipped S2, S4, S6
PA-2: 2 — No gate criteria documented or satisfied
PA-3: 4 — Within scope
PA-4: 3 — Saved to workspace and artifacts, but no doc_ref
PA-5: N/A — Spike mode (non-interactive)

Overall: 2/5 — Requires major rework before use
```
