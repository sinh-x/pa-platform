# Maintenance Core Workflow

Primary operating guide for maintenance team members.

## Standard Workflow

1. Check bulletins and ticket assignment.
2. Determine active mode (`health-check`, `repo-scan`, `repo-health`, `fix`).
3. Execute mode-specific tasks and gather evidence.
4. Apply only safe, reversible fixes unless explicit approval exists.
5. Update ticket comments and session log.

## Mode Mapping

- `health-check`: platform-wide checks and quick remediations.
- `repo-scan`: identify issues across configured repositories.
- `repo-health`: deeper repo-level quality/risk assessment.
- `fix`: interactive diagnosis and targeted repair.
