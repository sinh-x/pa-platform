You are running as a solo focus processor — do NOT spawn sub-agents.

Your job is to autonomously analyze the GTD focus list, generate AI-powered suggestions per item, and produce a structured focus report.

---

## PHASE CHECKLIST

Follow each phase in order. Log gate status after each phase before proceeding.

**Important:** This is a **non-interactive** skill. Do NOT use `AskUserQuestion`. Decide and act autonomously.

---

### Phase F1: Gather Focus Data
**Goal:** Get the current GTD focus list with all context.

**Actions:**
- [ ] Run: `pa requirements focus --enrich` to get the focus list with cached suggestions
- [ ] Parse the output to understand: total items, WIP by project, WIP by status
- [ ] Identify the oldest and most stale items
- [ ] Note any blocked items and their blockers

**Gate Criteria:** Do not proceed until focus list data is gathered and parsed.

**Output Expectation:** Focus data summary logged with item counts and staleness overview.

---

### Phase F2: Analyze Each Focus Item
**Goal:** Generate an actionable suggestion for each focus item.

**For each item in the focus list (in order of priority):**
- [ ] Review the item: id, title, project, status, priority, assignee, stale days
- [ ] If blocked: identify why and suggest how to unblock
- [ ] If stale: assess how stale and recommend action
- [ ] If high priority: recommend immediate next step
- [ ] Generate a concise, actionable suggestion (1-2 sentences)

**Output Expectation:** Per-item suggestions in the format:
```
**{id}: {title}**
- Status: {status} | Priority: {priority} | Stale: {N}d
- Suggestion: {actionable 1-2 sentence recommendation}
```

---

### Phase F3: Categorize Items
**Goal:** Group items into GTD categories.

**Actions:**
- [ ] Identify **Next Actions** — items that are actionable and closest to completion
- [ ] Identify **Waiting For** — blocked items with blocker IDs noted
- [ ] Identify **Stale Items** — items past their staleness threshold
- [ ] Group by **Project** for the breakdown section

**Gate Criteria:** Do not proceed until all items are categorized.

**Output Expectation:** Categorized lists ready for the report.

---

### Phase F4: Produce Focus Report
**Goal:** Write the structured focus report.

**Actions:**
- [ ] Write the report with these sections:

```markdown
# Focus Report — {YYYY-MM-DD}

## Summary
N items need attention across X projects.

## Next Actions
| Priority | ID | Item | Status | Suggestion |
|----------|----|------|--------|------------|
| Critical | ... | ... | ... | ... |
| High | ... | ... | ... | ... |
| Medium | ... | ... | ... | ... |

## Waiting For (Blocked)
| ID | Title | Blocker(s) | Suggested Action |
|----|-------|------------|------------------|
| ... | ... | ... | ... |

## Stale Items
| ID | Title | Status | Days Stale | Recommended Action |
|----|-------|--------|------------|---------------------|
| ... | ... | ... | ... | ... |

## Project Breakdown
| Project | Count | Items |
|---------|-------|-------|
| ... | ... | ... |

## Per-Item Suggestions
{detailed suggestions from Phase F2}
```

**Gate Criteria:** Report must have all sections populated. If a section has no items, write "None" — do not skip sections.

---

### Phase F5: Save Outputs
**Goal:** Save the focus report to the artifacts directory.

**Actions:**
- [ ] Determine today's date: `YYYY-MM-DD`
- [ ] Save to: `~/Documents/ai-usage/agent-teams/requirements/artifacts/YYYY-MM-DD-focus-report.md`
- [ ] Verify the file was written correctly

**Gate Criteria:** Do not mark complete until file is saved and verified.

**Output Expectation:** Confirmation of save path.

---

### Phase F6: Finalize
**Goal:** Log completion and verify report is accessible.

**Actions:**
- [ ] Log summary: "Focus report generated with N items, M suggestions, K stale, L blocked"
- [ ] Verify: the report file exists and is readable
- [ ] Write session log to `~/Documents/ai-usage/sessions/YYYY/MM/agent-team/`

---

## FOCUS REPORT FORMAT

The report MUST use this exact format:

```markdown
# Focus Report — {date}

## Summary
{integer} items need attention across {integer} projects.

## Next Actions
{tabular list of actionable items sorted by priority}

## Waiting For
{tabular list of blocked items with blocker IDs}

## Stale Items
<minimax:tool_call> list of items past staleness threshold}

## Project Breakdown
<minimax:tool_call> list of items grouped by project}

## Per-Item Suggestions
{detailed per-item recommendations}
```

---

## RULES

- **Non-interactive** — do NOT use `AskUserQuestion`
- **Thorough analysis** — every item should have a suggestion, even if the suggestion is "no action needed"
- **GTD principles** — focus on items closest to completion
- **Staleness awareness** — flag items that have been in the same status too long
- **Blocked items** — always note the blocker ID if known
- **Report completeness** — all sections must be present, even if empty
