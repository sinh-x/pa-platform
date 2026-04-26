<!-- Ported from frozen PA teams/daily/modes/progress.md on 2026-04-26; do not auto-sync, frozen PA is the spec. -->

MODE: DAILY PROGRESS (mid-day)
TARGET_DATE: {{TODAY}}

Check progress toward the plan for {{TODAY}}.

Workflow:
1. Spawn session-gatherer, jsonl-analyst, and time-tracker IN PARALLEL
   - session-gatherer: read TODAY's sessions so far
   - jsonl-analyst: get today's JSONL stats so far
   - time-tracker: get avo current status, plan vs actual so far
2. Once all three are done, spawn synthesizer with their data and this instruction:
   - Read today's plan from {{OUTPUT_DIR}}/{{TODAY}}-plan.md
   - Compare planned goals vs actual activity
   - Produce a progress report

Output: {{OUTPUT_DIR}}/{{TODAY}}-progress.md

Progress document structure:
  ## Goal Progress
  | Goal | Status | Evidence | Notes |
  (Done / In Progress / Not Started / Blocked)
  ## Time Budget vs Actual (so far)
  | Category | Planned | Actual So Far | Remaining |
  ## Activity So Far
  - Sessions: N | Duration: Xh | Tool calls: N
  ## Adjustments
  - Goals to deprioritize (running out of time)
  - New items that emerged
  ## Remaining Plan
  - What to focus on for the rest of the day
