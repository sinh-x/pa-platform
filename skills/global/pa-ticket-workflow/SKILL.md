---
name: pa-ticket-workflow
description: >
  Ticket workflow management for PA agent teams. This skill should be used by all
  PA agents to interact with work items through the ticket system. It covers ticket
  lifecycle, claim protocol, status transitions, and the one-ticket-per-work-item rule.
pa-tier: 2
pa-inject-as: shared-skill
---

# Ticket Workflow

Agents interact with work exclusively through the ticket system — not inbox files.

## Check for Assigned Work on Startup

1. Resume in-progress work first (high-priority first):
   ```bash
   pa ticket list --assignee <team-name> --status implementing --priority high
   pa ticket list --assignee <team-name> --status implementing
   ```

2. Pick up new assigned work:
   ```bash
   pa ticket list --assignee <team-name> --status pending-implementation --priority high
   pa ticket list --assignee <team-name> --status pending-implementation
   ```

3. Requirements team: check for elaboration work:
   ```bash
   pa ticket list --assignee requirements --status requirement-review
   ```

## Claim a Ticket

Always use team-qualified `<team>/<agent>` format for `--assignee` (e.g., `builder/team-manager`). Bare agent names are deprecated.

```bash
pa ticket update <ticket-id> --status implementing --assignee <team>/<agent-name>
```

## Update as You Work

### When blocked

Keep current status, add blocked TAG + comment:
```bash
pa ticket update <ticket-id> --tags blocked
pa ticket comment <ticket-id> --content "BLOCKED: <reason>. Waiting on: <dependency or decision>."
```
When unblocked: update tags without blocked, add resolution comment.

### When implementation is complete

Builder / sprint-master → UAT review. Always include `--doc-ref` pointing to the implementation artifact:
```bash
pa ticket update <ticket-id> --status review-uat --assignee sinh \
  --doc-ref "implementation:agent-teams/<team>/artifacts/YYYY-MM-DD-<topic>.md"
```

### When requirements are complete

Requirements team → approval gate. Always include `--doc-ref` pointing to the requirements document:
```bash
pa ticket update <ticket-id> --status pending-approval --assignee sinh \
  --doc-ref "requirements:agent-teams/requirements/artifacts/YYYY-MM-DD-<topic>.md"
```

## Doc-Ref Requirement on Handoff

Always set `--doc-ref` when advancing to `pending-approval` or `review-uat`. This ensures downstream teams and Sinh can access the full context.

If you advance without `--doc-ref` and the ticket has no `doc_refs` already:
- The CLI prints a warning to stderr (transition still succeeds — soft enforcement)
- The `needs-doc-ref` tag is automatically added to the ticket
- Sprint-master monitors `needs-doc-ref` tickets during triage and escalates

Add the document retroactively if you forgot:
```bash
pa ticket update <ticket-id> --doc-ref "[type:]path/to/doc.md"
```

**Mark the key document as primary (★)** — it gets a star in the ticket display:
- For requirements handoffs: mark the requirements doc as primary
- For implementation handoffs: mark the implementation artifact as primary
```bash
pa ticket update <ticket-id> --doc-ref "requirements:agent-teams/requirements/artifacts/YYYY-MM-DD-topic.md" --doc-ref-primary
```

## Create Tickets for Discovered Work

When identifying follow-up work or issues during a task:
```bash
pa ticket create \
  --project personal-assistant \
  --title "<title>" \
  --type task \
  --assignee <team> \
  --priority normal \
  --estimate <XS|S|M|L|XL> \
  --summary "<description of the work needed>"
```

## One Ticket Per Work Item

**Core rule:** Every piece of work has ONE ticket. All lifecycle tracking happens on that ticket via comments and status transitions.

**Do NOT create separate tickets for:**
- Decision notifications ("Decision Notification: Approved ...")
- Waiting-for-response tracking ("Waiting: ... Review Request")
- Review-request tracking when an existing ticket already exists
- Status change announcements ("Tracking: ... Awaiting Review")

**Instead, on the existing ticket:**
1. Add a comment describing the event: `pa ticket comment <id> --author <agent> --content "..."`
2. Advance the status: `pa ticket update <id> --status <next-status> --assignee <next-owner>`
3. Link artifacts: `pa ticket update <id> --doc-ref <path>`

**When to create a NEW ticket:**
- Genuinely new, independent work items discovered during your task
- FYI notifications about cross-cutting issues (not tied to an existing ticket)
- Spike research initiated by an agent with no existing ticket

## Appendix: Ticket CLI Examples

> This section is the authoritative reference for `pa ticket` commands. For general `pa` CLI help, see `pa-cli` skill.

### Discovery & Search

```bash
# List all tickets for a project
pa ticket list --project avodah

# Find a specific ticket by ID (use --search, not --ids)
pa ticket list --search "AVO-012" --project avodah
pa ticket list --search "deploy" --project avodah

# Filter by status/assignee/priority
pa ticket list --assignee builder --status implementing
pa ticket list --assignee builder --status pending-implementation --priority high

# Exclude blocked tickets
pa ticket list --exclude-tags blocked --assignee builder --status implementing
```

### Claiming & Starting Work

```bash
# Claim a ticket (assignee uses team-qualified format)
pa ticket update PA-042 --status implementing --assignee builder/team-manager

# Keep existing assignee, just update status (don't re-assign)
pa ticket update PA-042 --status implementing
```

### While Working

```bash
# Add a progress comment
pa ticket comment PA-042 --author builder/team-manager --content "Phase 1 complete. Starting phase 2."

# Mark as blocked (ALWAYS add comment explaining why)
pa ticket update PA-042 --tags blocked
pa ticket comment PA-042 --author builder/team-manager --content "BLOCKED: waiting on PA-041 to merge."

# Unblock when resolved
pa ticket update PA-042 --remove-tags blocked
pa ticket comment PA-042 --author builder/team-manager --content "Unblocked: PA-041 merged."
```

### Handoff & Completion

```bash
# Handoff to UAT review (builder/sprint-master → sinh)
# Always include --doc-ref pointing to the implementation artifact
pa ticket update PA-042 --status review-uat --assignee sinh \
  --doc-ref "implementation:agent-teams/builder/artifacts/2026-03-26-fix.md"

# Handoff requirements to approval gate (requirements → sinh)
pa ticket update PA-042 --status pending-approval --assignee sinh \
  --doc-ref "requirements:agent-teams/requirements/artifacts/2026-03-26-spec.md"

# Mark done (for bug fixes, chores, one-off tasks)
pa ticket update PA-042 --status done --assignee builder
```

### Creating Tickets

```bash
# Create a regular task
pa ticket create \
  --project pa \
  --title "Fix login flow" \
  --type task \
  --priority medium \
  --estimate S \
  --assignee requirements \
  --summary "Description of the work needed"

# Create a review-request ticket (for deliverables needing human review)
# IMPORTANT: Always include --doc-ref pointing to the artifact
pa ticket create \
  --project personal-assistant \
  --title "Review: pa ticket show crash on old tickets" \
  --type review-request \
  --assignee builder \
  --priority high \
  --estimate S \
  --doc-ref "agent-teams/requirements/artifacts/2026-03-26-pa-ticket-show-fix.md" \
  --summary "pa ticket show crashes with TypeError on tickets with missing blockedBy field."
```

### Doc-Ref Management

```bash
# Add a doc-ref retroactively (do this BEFORE advancing status)
pa ticket update PA-042 --doc-ref "implementation:agent-teams/builder/artifacts/2026-03-26-fix.md"

# Make a doc-ref primary
pa ticket update PA-042 --doc-ref-primary "implementation:agent-teams/builder/artifacts/2026-03-26-fix.md"

# Remove a doc-ref
pa ticket update PA-042 --remove-doc-ref "implementation:agent-teams/builder/artifacts/2026-03-26-old.md"
```

### Common Errors & Pitfalls

```bash
# "unknown option --ids": use --search instead to find by ID
pa ticket list --search "AVO-012" --project avodah

# "unknown command get": the command is "show", not "get"
pa ticket show PA-042

# ticket show crashes on old tickets: if ticket.show crashes, fall back to list + search
pa ticket list --search "AVO-012" --project avodah  # works as fallback

# Always read stderr: pa CLI prints warnings to stderr even on success (e.g., doc_ref reminders)
# Check stderr after every pa ticket command for actionable guidance
```

### Doc-Ref Format Reference

```
[type:]path
```

| Type prefix | Meaning | When to use |
|-------------|---------|-------------|
| (none) | generic attachment | Default, works for anything |
| `requirements:` | Requirements doc | When handoff is to requirements review |
| `implementation:` | Implementation artifact | When handoff is to UAT/build review |
| `attachment:` | File attachment | For logs, screenshots, data files |

Examples:
```bash
--doc-ref "requirements:agent-teams/requirements/artifacts/2026-03-26-spec.md"
--doc-ref "implementation:agent-teams/builder/artifacts/2026-03-26-fix.md"
--doc-ref "agent-teams/builder/artifacts/2026-03-26-log.txt"  # no type = generic
```

### Primary Doc-Ref (★)

One doc-ref can be marked as **primary** — it gets a ★ marker in the ticket display and is considered the "main" document.

**Mark the requirements doc as primary** when adding a doc-ref:
```bash
pa ticket update PA-042 --doc-ref "requirements:agent-teams/requirements/artifacts/2026-03-26-spec.md" --doc-ref-primary
```

`--doc-ref-primary` is a boolean flag — it marks the just-added doc-ref as primary. It does NOT take a path argument.

Only ONE doc-ref can be primary at a time. Setting a new primary removes the ★ from the previous one.
