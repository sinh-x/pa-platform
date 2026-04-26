<!-- Ported from frozen PA teams/daily/modes/plan.md on 2026-04-26; do not auto-sync, frozen PA is the spec. -->

MODE: DAILY PLAN (morning) — SOLO (no sub-agents)
TARGET_DATE: {{TODAY}}

Create the daily plan for {{TODAY}}. You do this YOURSELF — do NOT spawn any sub-agents.

Workflow (you do all steps directly):
1. Check for user notes at {{INPUT_NOTES}}
   - If the file exists, read it FIRST — these are Sinh's personal notes, priorities, or instructions for today
   - Incorporate these notes as HIGH PRIORITY items in the plan
   - The notes may contain specific goals, meetings, reminders, or overrides to the usual workflow
2. Read yesterday's daily summary (end-of-day) from {{OUTPUT_DIR}}/ — look for the most recent *-daily.md
   - Extract 'Tomorrow's Priorities' as today's starting goals
   - Extract 'Open Items (Carried Forward)' as carryover todos
   - If no daily summary exists, check for recent session logs in ~/Documents/ai-usage/sessions/{{YEAR}}/{{MONTH}}/
3. Check your team inbox at ~/Documents/ai-usage/agent-teams/daily/inbox/
   - Read any files — these are context documents routed by sprint-master
   - Incorporate relevant context into the plan
   - After processing, move each file to inbox/processed/
4. [RPM CONTEXT — opt-in] Check for RPM blocks at {{RPM_BLOCKS}}
   - If the file exists: read it and apply skills/rpm/context.md to build "Today's RPM Focus" section
   - Filter: status=active AND (horizon=weekly OR horizon=project)
   - Build RPM Focus section for the plan document (see Plan document structure below)
   - If the file does not exist: skip silently — do not mention RPM
5. Get current avo task list and status:
   - Run: /home/sinh/.nix-profile/bin/avo task list
   - Run: /home/sinh/.nix-profile/bin/avo plan list
   - Run: /home/sinh/.nix-profile/bin/avo status
6. Use avo to plan the day's tasks:
   - Based on goals from steps 1-4, schedule tasks with avo:
     /home/sinh/.nix-profile/bin/avo plan task <task-id> -e <duration>
   - If RPM blocks exist: prioritize tasks that map to active RPM results
   - Prioritize P0 first, then P1, P2, etc.
   - Do not over-schedule — respect realistic time budget
   - If a goal has no matching avo task, note it for Sinh to create
7. Write the daily plan as a DRAFT for Sinh to review when he's ready

Output:
1. Save plan draft file to: {{OUTPUT_DIR}}/{{TODAY}}-plan-draft.md
2. Create a plan-draft ticket so Sinh sees it in his ticket queue:
   pa ticket create \
     --project personal-assistant \
     --title "Daily Plan: {{TODAY}}" \
     --type plan-draft \
     --assignee sinh \
     --priority normal \
     --estimate XS \
     --doc-ref "daily/{{YEAR}}/{{MONTH}}/{{TODAY}}-plan-draft.md" \
     --summary "<goals summary and time budget — 1-2 sentences>"

IMPORTANT: This is a DRAFT — it runs at 05:00 before Sinh is awake.
- Save to {{OUTPUT_DIR}}/ (the daily folder) as *-plan-draft.md (not -plan.md)
- Add a header: ## DRAFT — Review and adjust when ready
- Include a checklist at the top for quick review:
  - [ ] Goals look right
  - [ ] Time budget is realistic
  - [ ] No missing priorities
  - [ ] Avo plan looks right
- Add a ## Next Steps section at the bottom explaining:
  1. Review and adjust goals/time budget above
  2. Finalize by renaming to {{OUTPUT_DIR}}/{{TODAY}}-plan.md (or ask pa to finalize)
  3. Optionally add notes for tomorrow at {{INPUT_NOTES}} before going to bed
- Sinh will review this draft and finalize it himself

Plan document structure:
  ## User Notes (if {{INPUT_NOTES}} exists)
  (Sinh's own notes for the day, verbatim or summarized)
  ## Today's RPM Focus (ONLY if {{RPM_BLOCKS}} exists)
  (active RPM blocks — results and active MAP items; see skills/rpm/context.md)
  | ID | Area | Horizon | Result |
  ## Today's Goals (from user notes + yesterday's priorities + new items)
  | # | Goal | Source | Priority |
  ## Avo Day Plan
  (output of avo plan list after scheduling)
  ## Time Budget
  | Category | Planned | Notes |
  ## Open Items Carried Forward
  - [ ] item (from session/date)
  ## Today's Task List
  (from avo task list — each task labeled with RPM result ID or [UNALIGNED] if rpm-blocks.yaml exists)
  | # | Task | Priority | Est. | RPM |
