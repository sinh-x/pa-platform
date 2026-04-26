<!-- Ported from frozen PA teams/daily/modes/end-review.md on 2026-04-26; do not auto-sync, frozen PA is the spec. -->

MODE: DAILY END — PHASE 2: REVIEW (interactive)
TARGET_DATE: {{TODAY}}

Interactive end-of-day review: present gathered findings to Sinh, reconcile time tracking gaps, confirm tomorrow's priorities, then produce the final daily summary.

Workflow:
1. Check for gather report:
   - Read {{READY_MARKER}} (check if gaps_detected: true/false)
   - Read {{GATHER_REPORT}}
   - If NOT found: offer to run Phase 1 first OR proceed with live gather (spawn gatherers now)
2. Read today's plan from {{OUTPUT_DIR}}/{{TODAY}}-plan.md (if exists)
3. Present findings to Sinh — show a compact summary:
   === Daily End Review — {{TODAY}} ===
   Sessions: N | JSONL time: Xh | Tracked: Xh | Coverage: Z%
   Goals completed: N/M (XX%)
   Gaps detected: yes/no

   (Show untracked windows if any)

4. If tracking gaps exist, walk through them interactively:
   - For each untracked window, ask: "Window [HH:MM–HH:MM, Xh]: which task? (task ID or description, or 'skip')"
   - On task given: run /home/sinh/.nix-profile/bin/avo worklog add -t <task> -d <duration> -m "<description>"
   - Confirm: "Logged Xh to <task>"
   - Continue until all gaps resolved or Sinh says 'done' or 'skip all'

5. Show open items / carried-forward todos from gather report
   - Ask: "What are tomorrow's top priorities?" (offer data-driven suggestions)
   - Accept Sinh's input — these become the confirmed priorities

6. Once Sinh says "ready", "done", or "synthesize":
   - Spawn synthesizer with ALL gathered data + Sinh's confirmed priorities
   - Pass these inputs:
     a. Session report (from gather report)
     b. JSONL stats (from gather report)
     c. Avo report (from gather report, updated after any new worklogs)
     d. Sinh's confirmed priorities for tomorrow
   - Instruction to synthesizer: "Produce final daily summary. Tomorrow's Priorities = Sinh's confirmed list (not auto-generated). Include all data from gather report."

7. After synthesizer completes, clean up:
   - Move {{READY_MARKER}} → {{DAILY_INBOX}}/done/
   - Move {{GATHER_REPORT}} → {{DAILY_INBOX}}/done/

Output: {{OUTPUT_DIR}}/{{TODAY}}-daily.md

  ## Day at a Glance
  | Metric | Value |
  (sessions, duration, tracked time, tool calls, done items, completion rate, teams deployed)

  ## Goal Completion
  | Goal | Status | Evidence |
  Goal completion: N/M (XX%)

  ## Time Tracking
  Plan vs actual by category, time gaps

  ## What Got Done
  ### Human Work (grouped by project)
  ### Agent Work (grouped by team)

  ## What I Learned
  ### From Human Sessions
  ### From Agent Teams
  ### Cross-Cutting Insights

  ## Self-Improvement (from self-improvement team)
  Read from self-improvement team daily extract: `agent-teams/self-improvement/daily/YYYY-MM-DD-extract.md`

  ## Deductions & Observations
  - Productivity patterns (peak hours, session lengths)
  - Tool & workflow insights
  - Recurring issues (across sessions and days)
  - Progress trends (vs previous days)

  ## Open Items (Carried Forward)
  Consolidated from all sessions

  ## Tomorrow's Priorities
  1. [ ] Priority — reasoning from today's data
  2. [ ] Priority — reasoning
  3. [ ] Priority — reasoning

  ## Stats Deep Dive
  Token usage, tool histogram, model distribution, projects, activity timeline

Note: "Tomorrow's Priorities" section MUST use Sinh's confirmed priorities from Step 5, not auto-generated guesses.
