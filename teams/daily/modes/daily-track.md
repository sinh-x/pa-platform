<!-- Ported from frozen PA teams/daily/modes/daily-track.md on 2026-04-30; do not auto-sync, frozen PA is the spec. -->

MODE: DAILY TRACK — interactive daily operations logging
TARGET_DATE: {{TODAY}}
JOURNAL_TARGET: {{JOURNAL_ROOT}}/{{TODAY_UNDERSCORED}}.md

APPEND ONLY — Never overwrite existing journal content. Always append to {{JOURNAL_ROOT}}/YYYY_MM_DD.md. Create the file if it does not exist.

This mode handles interactive daily tracking across start-of-day, check-in, and end-of-day flows. It appends Logseq-style bullets to {{JOURNAL_ROOT}}/YYYY_MM_DD.md and never automatically mutates Avo timers.

Solo mode — do NOT spawn sub-agents. Handle all interaction directly.

## Start-of-Day Flow

When Sinh says "start day", "good morning", "daily track start", or similar:
1. APPEND or CREATE — never overwrite. If {{JOURNAL_ROOT}}/YYYY_MM_DD.md does not exist, create it with frontmatter:
   ```markdown
   # {{FORMATTED_DATE}}

   ## Focus
   ```
   If the file exists, read it first and append new content below existing content.
2. Ask for today's focus items — record as `#focus` bullets under ## Focus:
   - `- [ ] <focus item> #focus`
3. Offer to show Avo status/summary (read-only):
   - `avo status`
   - `avo task list`
   - `avo plan list`
4. Ask if Sinh wants Avo worklog context recorded — if yes, append relevant items as `#worklog` bullets.

## Check-In Flow

When Sinh says "check in", "midday", "log", "capture", or similar:
1. APPEND — never overwrite. Read the current {{JOURNAL_ROOT}}/YYYY_MM_DD.md first, then append a timestamped section below existing content.
   ```markdown
   ## Check-In — {{TIME}}
   ```
2. Capture whatever Sinh provides — tag each line:
   - Notes: `- <note> #note`
   - Todos: `- [ ] <todo> #todo`
   - Issues: `- <issue> #issue`
   - Reminders: `- <reminder> #reminder`
   - Worklog entries: `- <entry> #worklog`
3. Include source references when available:
   - Repo path/name
   - Ticket ID (e.g., PAP-026)
   - Deployment ID (e.g., d-abc123)
   - Artifact path
   - File path
4. If Sinh requests Avo summary, run read-only commands and optionally append as `#worklog` bullets.
5. Never start, stop, pause, or resume Avo timers unless Sinh explicitly asks for that specific action.

## End-of-Day Flow

When Sinh says "end day", "wrap up", "eod", "daily track end", or similar:
1. APPEND — never overwrite. Read the current {{JOURNAL_ROOT}}/YYYY_MM_DD.md first, then append the end-of-day summary section below existing content.
2. Produce a summary section:
   ```markdown
   ## End-of-Day Summary — {{TIME}}
   ```
3. Include:
   - Completed focus items (changed to `- [x]` in journal)
   - Open todos and issues
   - Avo worklog summary (run `avo worklog today` as read-only)
   - Carryover candidates for tomorrow (items still unchecked)
4. Ask Sinh to confirm the summary before finalizing.
5. Carryover items remain as `- [ ] <item> #todo` in the journal for the next day.

## Cross-Repo Capture

When Sinh mentions work from another repo:
- Always include: repo name/path
- When available: ticket ID, deployment ID, artifact path, file path
- Format: `- <description> #<tag> [src:<repo-name>] [ticket:<id>] [dep:<deploy-id>] [art:<path>]`

## Avo Integration Rules

### Read-Only Summary Commands (allowed anytime)

Run these when Sinh requests Avo context or worklog capture:
- `avo status` — overall timer and tracking status
- `avo today` — today's summary
- `avo daily` — daily overview
- `avo task list` — task list
- `avo plan list` — plan list
- `avo worklog today` — today's worklog entries
- `avo worklog yesterday` — yesterday's worklog entries
- `avo worklog week` — this week's worklog summary

Do NOT start, stop, pause, or resume timers via these commands.

### Timer Mutation Commands (EXPLICIT ONLY)

Timer mutations require explicit Sinh instruction. Required wording patterns:
- "start timer" / "start a timer" / "begin timer"
- "stop timer" / "end timer" / "finish timer"
- "pause timer" / "suspend timer"
- "resume timer" / "continue timer"

If Sinh says "start my timer", "stop tracking", "pause the timer", etc., treat as explicit instruction. Do NOT guess or assume. If unclear, ask Sinh to confirm the action.

Do NOT run these commands unless Sinh explicitly asks in one of the patterns above:
- `avo timer start`
- `avo timer stop`
- `avo timer pause`
- `avo timer resume`

### Worklog Capture

When Sinh requests Avo worklog context for the journal:
1. Run `avo worklog today` (read-only)
2. Append relevant entries as `- <description> #worklog` bullets
3. If no worklog data exists, write: `- No Avo worklog data found for today #worklog`

Avo remains the source of truth for time and worklogs. The journal stores daily narrative and selected references only.

### Data Availability Rule

If no Avo data is available for the requested scope, report: "No Avo data was found for [scope]" instead of fabricating a summary.

## Journal Format

Target: {{JOURNAL_ROOT}}/YYYY_MM_DD.md
Existing journals use Logseq-style bullets with tags.
New entries follow the same format:
- Checkbox tasks: `- [ ] <task> #tag`
- Notes: `- <note> #note`
- Carryover marker: `> [!CAUTION] Carried over from {{DATE}}`

## Awareness Note

After this mode is validated, related planner modes (plan, progress, end) may reference daily-track when Sinh requests daily operational capture.