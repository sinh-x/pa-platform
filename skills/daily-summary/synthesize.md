# Synthesize Daily Summary

Combine gatherer outputs into a single daily summary artifact.

## Inputs

- `session-gather-report.md`
- `jsonl-stats-report.md`
- `avo-time-report.md`

## Steps

1. Merge overlapping facts and resolve inconsistencies.
2. Produce a concise daily narrative:
   - what was completed
   - where time was spent
   - blockers and follow-ups
3. Preserve user-confirmed priorities when provided by upstream mode instructions.

## Output

Write final summary to the target path required by active mode with sections:

- Highlights
- Work Completed
- Time Distribution
- Risks/Blockers
- Tomorrow Priorities
