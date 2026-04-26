---
name: pa-communication
description: >
  Communication patterns for PA agent teams. This skill should be used by all PA
  agents to understand how to communicate with team managers, Sinh, and cross-team.
  It covers the standard communication channels, when to use ticket comments vs.
  review-request tickets, FYI tickets, and the living document convention for requirements docs.
pa-tier: 2
pa-inject-as: shared-skill
---

# Communication

## Standard Communication Channels

- **Agents → Team manager:** Report results via SendMessage or task completion
- **Agents → Agents:** Only if the team objective requires direct coordination
- **Team manager → Sinh (routine):** Add completion comment on the working ticket — NOT a separate file or ticket
- **Team manager → Sinh (deliverable):** Create review-request ticket pointing to artifact in `agent-teams/<team>/artifacts/`
- **All cross-team communication:** Via tickets (FYI, review-request types)
- Always include your `agent_name` and `team_name` in ticket titles, summaries, and comments

## Ticket-Centric Output Flow

When completing work on a ticket, output goes in TWO places:

1. **Brief completion comment on the ticket (REQUIRED):**
   ```bash
   pa ticket comment <ticket-id> --author <agent-name> --content "Completed: <1-2 sentence summary>. Session log: sessions/YYYY/MM/agent-team/<session-log-filename.md>"
   ```

2. **Full session log file (REQUIRED):** Save to `sessions/YYYY/MM/agent-team/` with ticket ID in filename. See `pa-session-log` skill for the full template.

## Delivering Key Deliverables

When work produces a **deliverable** with lasting value (requirements doc, migration plan, analysis report):

1. Save to `agent-teams/<team>/artifacts/YYYY-MM-DD-<descriptive-name>.md`
2. Create review-request ticket with `--doc-ref` pointing to the artifact

```bash
pa ticket create \
  --project personal-assistant \
  --title "Review: <descriptive-topic>" \
  --type review-request \
  --assignee <downstream-team-or-sinh> \
  --priority high \
  --estimate M \
  --doc-ref "[type]:agent-teams/<team>/artifacts/YYYY-MM-DD-<descriptive-name>.md" \
  --summary "<what was built; what Sinh needs to review; what happens if approved>"
```

**Use this flow for:** requirements docs, implementation plans, analysis reports, any output needing human review.

**Do NOT use for:** routine session completions — add a ticket comment instead.

## FYI Tickets (Informational Notifications)

For non-actionable information that Sinh or another team should know:

```bash
pa ticket create \
  --project personal-assistant \
  --title "FYI: <descriptive-topic>" \
  --type fyi \
  --assignee <recipient-team-or-sinh> \
  --priority low \
  --estimate XS \
  --summary "<brief informational content — what happened, why it is relevant>"
```

## Plan Draft Tickets (Daily Planning)

For daily/weekly plans emitted by the planner team:

```bash
pa ticket create \
  --project personal-assistant \
  --title "Daily Plan: YYYY-MM-DD" \
  --type plan-draft \
  --assignee sinh \
  --priority normal \
  --estimate XS \
  --doc-ref "daily/YYYY/MM/YYYY-MM-DD-plan.md" \
  --summary "<goals and time budget summary>"
```

## Deprecated Patterns

The following patterns are **deprecated** and should NOT be used:

- **Inbox file routing** — Writing markdown files to `~/Documents/ai-usage/agent-teams/<team>/inbox/` or `sinh-inputs/inbox/`. Use the ticket system instead.
- **Standalone work-report files** — All reporting happens through ticket comments and linked artifacts. Do NOT write standalone work-report files to `sinh-inputs/inbox/`.

## Living Document Convention

Requirements documents produced by the requirements team are **living documents** — builders update them during implementation to reflect actual progress.

### What Gets Updated

- `§4 In Scope` — items checked off with `[!NOTE]` verification callouts as they are implemented
- `§10 Acceptance Criteria` — items checked off with `[!NOTE]` callouts when satisfied, or `[!CAUTION]` when not verifiable

### What Does NOT Change

§1–§3, §5–§9, §11–§13. §12 Implementation Plan phases use the existing `- [ ] Phase N` → `- [x] Phase N` convention (unchanged).

### Update Patterns

**Verified item:**
```markdown
- [x] Item

> [!NOTE] **Implementation Note** (<agent>, <deployment_id>, <date>)
> Verified: <evidence>.
```

**Unverified item:**
```markdown
- [ ] Item

> [!CAUTION] **Not Verified** (<agent>, <deployment_id>, <date>)
> Could not verify: <reason>.
```

**Purpose:** When Sinh opens a requirements doc at `review-uat`, the checked/unchecked items and verification callouts provide immediate UAT evidence — no need to cross-reference commit logs.

For full protocol, see the builder skill's Living Document Protocol section.
