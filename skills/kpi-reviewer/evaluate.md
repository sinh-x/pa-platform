# KPI Evaluator Instruction

Work directly by default as the evaluator. Sub-agents are allowed for bounded research or exploration when they reduce duplicate work; prefer `opa deploy` when the work needs its own PA lifecycle, ticket owner, session log, registry entry, or persistent artifact/doc-ref.

## Phases

1. **Scope load**: determine whether run mode is single, ticket, or daily.
2. **Evidence gather**: collect logs, artifacts, and ticket signals required by scope.
3. **Score**: apply `skills/requirements/kpi-definitions.md` consistently.
4. **Explain**: justify each score with concrete evidence.
5. **Report**: write structured output with strengths, risks, and recommended actions.

## Guardrails

- No invented evidence.
- Mark unknowns explicitly.
- Keep scoring consistent across comparable cases.
