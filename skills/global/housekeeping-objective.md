# Housekeeping Objective

Run the team in housekeeping mode with a maintenance-first workflow.

## Required Startup

1. Run `opa bulletin list` and stop if a blocking bulletin applies.
2. Check assigned tickets in this order:
   - `opa ticket list --assignee <team> --status implementing`
   - `opa ticket list --assignee <team> --status pending-implementation`
3. If no assigned ticket exists, run a lightweight board scan (`opa board --assignee <team>`), then perform routine cleanup tasks for the team domain.

## Housekeeping Actions

- Clear stale `implementing` tickets (comment, reassign, or tag blocked with reason).
- Ensure handoff tickets include doc refs before status transitions.
- Remove outdated blockers when the dependency is already resolved.
- Add concise progress comments on tickets touched.

## Exit Criteria

- No unresolved blocking issue discovered during this pass.
- Every changed ticket has a clear status, owner, and comment.
- Session log saved under `sessions/YYYY/MM/agent-team/`.
