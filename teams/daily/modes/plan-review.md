<!-- Ported from frozen PA teams/daily/modes/plan-review.md on 2026-04-26; do not auto-sync, frozen PA is the spec. -->

MODE: DAILY PLAN — REVIEW (interactive)
TARGET_DATE: {{TODAY}}

Finalize today's plan draft through interactive review with Sinh. You do this YOURSELF — do NOT spawn any sub-agents.

Workflow:
1. Check for draft at {{DRAFT_PATH}}
   - If found: read it and present it
   - If NOT found: read yesterday's daily summary + current avo tasks and create a quick draft inline
2. [RPM CONTEXT — opt-in] If {{RPM_BLOCKS}} exists and the draft does NOT already have a "## Today's RPM Focus" section:
   - Read rpm-blocks.yaml and apply skills/rpm/context.md to inject the RPM Focus section
   - Insert it between "## User Notes" and "## Today's Goals"
3. Present the draft to Sinh section by section:
   - Show "## Today's RPM Focus" (if present) — ask: "Are these the right results to focus on today?"
   - Show "## Today's Goals" — ask: "Do these goals look right? Anything to add or remove?"
   - Show "## Time Budget" — ask: "Is this realistic?"
   - Show any open items / carryovers
4. Accept corrections in plain conversation:
   - "change goal X" → update it
   - "add <goal>" → add to goals list
   - "adjust time for <category> to <amount>" → update time budget
   - "looks good" / "done" → proceed to finalize
5. Update avo plan if needed:
   - Run: /home/sinh/.nix-profile/bin/avo plan list (show current)
   - If Sinh wants changes: /home/sinh/.nix-profile/bin/avo plan task <task-id> -e <duration>
6. Write final plan to {{OUTPUT_DIR}}/{{TODAY}}-plan.md
7. Draft is already in the daily folder ({{OUTPUT_DIR}}) — no move needed.
8. Confirm: "Plan finalized → {{OUTPUT_DIR}}/{{TODAY}}-plan.md"

Final plan document structure:
  ## Today's RPM Focus (ONLY if {{RPM_BLOCKS}} exists)
  | ID | Area | Horizon | Result |
  ## Today's Goals
  | # | Goal | Source | Priority |
  ## Avo Day Plan
  (output of avo plan list after any changes)
  ## Time Budget
  | Category | Planned | Notes |
  ## Open Items Carried Forward
  - [ ] item (from session/date)
  ## Today's Task List
  (from avo task list — each task labeled with RPM result ID or [UNALIGNED] if rpm-blocks.yaml exists)
  | # | Task | Priority | Est. | RPM |
