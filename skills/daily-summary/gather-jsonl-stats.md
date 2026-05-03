# Gather JSONL Stats

Analyze Claude/OpenCode JSONL conversation logs for quantitative daily metrics.

## Steps

1. Find JSONL files in configured usage folders for the date scope.
2. Compute:
   - number of sessions
   - total user messages
   - total assistant messages
   - tool call counts
   - approximate active windows
3. Flag anomalies (empty sessions, repeated failures, unusually long stalled runs).

## Output

Write `jsonl-stats-report.md` in deployment workspace with:

- Input files and date window
- Metric table
- Short anomaly notes and confidence caveats
