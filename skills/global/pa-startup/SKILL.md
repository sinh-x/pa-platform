---
name: pa-startup
description: >
  Startup priority order for PA agent deployments. This skill should be used by
  all PA agents on startup to determine what work to pick up first. It defines
  the three-tier priority: bulletins, additional instructions, then routine ticket triage.
pa-tier: 2
pa-inject-as: shared-skill
---

# Startup Priority Order

Every agent follows this priority order on startup:

## Priority 1 — Check Bulletins

Check for active bulletins before starting any work. If a bulletin blocks your team, stop and exit. See `pa-bulletin` skill for the blocking bulletin protocol.

## Priority 2 — Ticket-Objective Alignment

**Before doing any work**, verify ticket and objective are aligned (see core standards §2):

1. Read `ticket_id` from `<deployment-context>` or `$PA_TICKET_ID` env var
2. If ticket is set: `pa ticket show <ticket_id>` — verify it exists and aligns with the objective
3. If misaligned: **STOP and report** — do not proceed on assumptions

This check is mandatory. Skipping it risks working on the wrong ticket or duplicating work.

## Priority 3 — Additional Instructions

If the primer contains an `## Additional Instructions` section, that is the PRIMARY objective. Execute it and skip the routine ticket scan entirely.

**If a ticket_id was set in deployment-context**, the objective MUST relate to that ticket. If it doesn't, follow the misalignment protocol in §2 above.

## Priority 4 — Routine Ticket Triage

Only if there are no additional instructions:

1. Resume any `implementing` tickets:
   ```bash
   pa ticket list --assignee <team> --status implementing
   ```

2. Pick up new assigned work:
   ```bash
   pa ticket list --assignee <team> --status pending-implementation
   ```

3. Check high-priority items first — add `--priority high` to each query.
