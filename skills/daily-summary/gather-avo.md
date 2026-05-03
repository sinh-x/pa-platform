# Gather AVO Time Data

Collect time-tracking activity using the `avo` CLI for the same day scope as other gatherers.

## Steps

1. Query current day logs and active timers.
2. Aggregate tracked minutes by:
   - project
   - task
   - category/tag (if available)
3. Compare tracked time against expected work windows and flag gaps.

## Output

Write `avo-time-report.md` in deployment workspace including:

- Commands used
- Time totals by project/task
- Untracked-window notes
- Any timer-state inconsistencies
