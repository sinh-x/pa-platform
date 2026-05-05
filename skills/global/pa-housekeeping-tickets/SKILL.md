---
name: pa-housekeeping-tickets
description: >
  Ticket housekeeping operations for PA agent teams in housekeeping mode. This skill
  should be used by housekeeping mode agents to perform stale ticket checks, pending
  review monitoring, backlog awareness, and board cleanup operations. For core ticket
  workflow (claim, update, handoff), see pa-ticket-workflow.
pa-tier: 2
pa-inject-as: shared-skill
---

# Ticket Housekeeping

Agents in housekeeping mode check the ticket system for their team's health rather than scanning inbox folders.

## On Startup (MANDATORY for Housekeeping Mode)

**1. Create workspaces**

```bash
mkdir -p ~/Documents/ai-usage/agent-teams/<team_name>/artifacts
mkdir -p ~/Documents/ai-usage/deployments/<deployment_id>/<agent_name>/
```

**2. Check in-progress tickets (stale check)**

```bash
pa ticket list --assignee <team-name> --status implementing
```

For each ticket in `implementing` state that has not been updated in >3 days, add a stale comment:

```bash
pa ticket comment <ticket-id> --content "Stale check: this ticket has been in 'implementing' for >3 days with no updates. Is work still active?"
```

**3. Check pending review tickets**

```bash
pa ticket list --assignee sinh --type review-request --status review-uat
```

For each review ticket >3 days old, create a reminder FYI:

```bash
pa ticket create \
  --title "FYI: Pending review >3 days — <ticket-id>" \
  --type fyi \
  --assignee sinh \
  --priority normal \
  --estimate XS \
  --summary "Ticket <ticket-id> has been waiting for Sinh's review for >3 days: <ticket-title>"
```

**4. Check pending-implementation backlog for your team**

```bash
pa ticket list --assignee <team-name> --status pending-implementation
```

Note awareness of pending work. Then run the board cleanup checks below.

**4a. Board Cleanup**

For each `pending-implementation` ticket:

- **Inbox-sweep artifacts** (tagged `inbox-sweep`): check if already done or has a duplicate → cancel with cross-ref comment
- **Misrouted tickets**: verify `--project` matches the repo via `pa repos list` → recreate in correct project + cancel original
- **Missing `doc_refs`**: if summary is too thin to execute → add `backlog` tag with comment

**5. Check for active bulletins**

```bash
pa bulletin list
```

Note any active bulletins in the housekeeping report, especially if they affect this team's operations.

**6. Begin main housekeeping work**

## Ongoing Ticket Claim/Release Protocol

When picking up a ticket for multi-step work:

```
Ticket in 'pending-implementation' state
  ↓
Agent claims it
  → pa ticket update <id> --status implementing --assignee <team>/<agent>
  → begin work

Agent work completes
  → pa ticket update <id> --status review-uat --assignee sinh
  → add completion comment on the ticket

Agent work fails / aborts
  → keep current status; add blocked tag: pa ticket update <id> --tags blocked
  → pa ticket comment <id> --content "BLOCKED: <reason>. Waiting on: <dependency>"
  → create FYI ticket for Sinh explaining the failure
```

## Rules

- Always claim (set to `implementing`) before starting work — never work on a `pending-implementation` ticket without claiming
- Never leave a ticket in `implementing` state without a comment when you stop — add a comment if interrupted
- Short single-step work that completes in one action: `pending-implementation → review-uat --assignee sinh` directly, no `implementing` step needed
- `blocked` is a tag, not a status — use `--tags blocked` + comment protocol instead

## When a Task Cannot Be Completed

- Keep the ticket's current status — do NOT change it to `blocked`
- Add `blocked` tag: `pa ticket update <id> --tags blocked`
- Add a comment explaining what's blocking it: `pa ticket comment <id> --content "BLOCKED: <reason>. Waiting on: <dependency or decision>"`
- Create a separate task ticket for whoever can unblock you
- When unblocked: remove `blocked` tag, add a comment noting what resolved the block

## Routing Fields (ticket-based)

All cross-team documents now use ticket fields instead of inline `From:` / `To:` metadata.

| Old field | New equivalent |
|-----------|---------------|
| `From: <team> / <agent>` | `--summary` includes agent identity; ticket audit log records actor |
| `To: <team>` | `--assignee <recipient-team>` on the ticket |
| `Type: work-report` | `--type work-report` |
| `Type: review-request` | `--type review-request` |
| `Type: fyi` | `--type fyi` |

**Self-validation (mandatory):** Before creating any ticket, verify `--assignee` and `--title` are populated and meaningful. A ticket without a clear recipient assignee is unroutable.
