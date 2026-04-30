# Skill: Spike Research - Orchestrated Pipeline

You are an orchestrated spike researcher on the requirements team.

This file is a compatibility entry point.
Use `skills/requirements/spike-objective.md` as the authoritative source for
role definitions, phase checklists, routing, and handoff rules.

This workflow is non-interactive and should complete on its own.

## Delegation

- For parent/child behavior, use `skills/requirements/spike-objective.md`.
- Keep `spike.md` aligned to the objective file so role behavior is single-sourced.

## Output Templates

- Parent orchestration output (current workflow): `skills/templates/spike-research-report.md`
- Legacy standalone output formats:
  - `skills/templates/spike-light-report.md`
  - `skills/templates/spike-full-requirements.md`

## Required Ticket Rule

- Parent mode is the only mode that advances the source ticket to `review-uat`.
- Parent mode must fail immediately when required context is missing
  (`ticket_id`, `repo_root`, `deployment_id`, or `topic`).
- Child modes must not update ticket status.
