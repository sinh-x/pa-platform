# Gather Sessions

Collect today's session-level activity from `~/Documents/ai-usage/sessions/`.

## Steps

1. Identify the date scope (default: today in local timezone).
2. Read matching session logs across `agent-team/` and personal entries.
3. Extract per-session facts:
   - team/agent
   - ticket ID
   - status (success/partial/failed)
   - key outcomes and blockers
4. Produce a structured summary table plus bullet highlights.

## Output

Write `session-gather-report.md` in deployment workspace containing:

- Source files scanned
- Coverage window
- Session totals by outcome
- Notable wins, risks, and carry-over work
