---
name: pa-cli
description: >
  OPA CLI reference for all agents. This skill should be used by all PA agents
  to understand the available opa commands, ticket subcommands, bulletin subcommands,
  and enum values. Provides a quick reference for day-to-day agent operations.
pa-tier: 2
pa-inject-as: shared-skill
---

# OPA CLI Reference

All agents have access to the `opa` CLI for PA platform workflow and deployment commands. `opa` is the default OpenCode deployment adapter and invokes the shared `pa-core` command set. Use `pa-core serve` for Agent API server lifecycle; `opa` does not own the server lifecycle.

## Commands

| Command | Purpose | Key Flags |
|---------|---------|-----------|
| `opa teams [name]` | Show team workflow status; detail with name | `--all` |
| `opa board` | Show kanban board grouped by status — scoped to current repo by default | `--project`, `--all`, `--assignee` |
| `opa deploy <team>` | Deploy an agent team through the default OpenCode adapter | `--objective`, `--objective-file`, `--content-file`, `--mode`, `--dry-run`, `--background`, `--ticket`, `--repo`, `--team-model`, `--agent-model`, `--validate`, `--provider` |
| `opa status [deploy-id]` | Show deployment status | `--running`, `--team`, `--wait`, `--report`, `--artifacts`, `--activity`, `--recent`, `--today` |
| `opa health [category]` | System health check: deployment health, agent behavior, compliance, infrastructure | `--json`, `--days`, `--since`, `--primer-summary`, `--history` (category: `deployments` \| `agents` \| `tickets` \| `compliance` \| `schedules` \| `infrastructure`) |
| `opa schedule <spec> <repeat> [times...]` | Schedule a team with systemd timers | — |
| `opa timers` | List scheduled timers | — |
| `opa remove-timer <team-name>` | Remove a scheduled timer | — |
| `opa repos list` | List repository registry | — |
| `pa-core serve` | Start, stop, restart, and inspect the core-owned Agent API server | `--port`, `--host`, `--background`, `--cors`, `--force` |
| `opa ticket <sub>` | Manage tickets (see §Ticket) | — |
| `opa bulletin <sub>` | Manage bulletins (see §Bulletin) | — |
| `opa registry <sub>` | Manage deployment registry (see §Registry) | — |
| `opa trash <sub>` | Soft-delete PA project files (see §Trash) | — |

Daily planning, requirements analysis, ideas, and reports are handled through tickets plus `opa deploy <team> --mode <mode>` workflows rather than restored as required direct `daily`, `requirements`, `idea`, or `report` CLI commands.

`opa status <deploy-id> --wait` polls until the deployment reaches a terminal status. It uses the deployment's recorded timeout by default; set `PA_STATUS_WAIT_TIMEOUT` to override the wait duration for that command only.

### `opa board` — CWD-Aware Scoping

`opa board` defaults to the current repository's project if you're in a git repo registered in `repos.yaml`. Use flags to override:

- **No flags** — show tickets for current repo's project (error if outside registered repo)
- **`--all`** — show all projects (equivalent to old behavior)
- **`--project <input>`** — filter by project, with flexible resolution:
  - Exact key: `opa board --project pa`
  - Prefix (case-insensitive): `opa board --project PA`
  - Path basename: `opa board --project personal-assistant`
- **`--assignee <name>`** — further filter by assignee (works with any of above)

**Examples:**

```bash
# In ~/git-repos/sinh-x/tools/personal-assistant/ repo:
opa board                         # Shows PA tickets (CWD-detected)
opa board --assignee sinh         # PA tickets assigned to sinh
opa board --all                   # All projects' tickets

# Outside registered repos or to override CWD:
opa board --project PA            # PA tickets (prefix resolved)
opa board --project avodah --all  # --all takes precedence, shows all projects
opa board --all --assignee sinh   # All projects, assigned to sinh
```

## Ticket Subcommands

| Subcommand | Purpose | Flags |
|-----------|---------|-------|
| `ticket create` | Create a ticket | `--project` `--title`* `--type`* `--priority`* `--estimate`* `--assignee`* `--summary` `--doc-ref` `--tags` `--from` `--to` `--actor` |
| `ticket update <id>` | Update ticket fields | `--status` `--assignee` `--priority` `--tags` `--blocked-by` `--doc-ref` `--doc-ref-primary` `--remove-doc-ref` `--estimate` `--actor` |
| `ticket list` | List/filter tickets | `--project` `--status` `--assignee` `--priority` `--type` `--tags` `--exclude-tags` `--search` |
| `ticket show <id>` | Show full ticket details | — |
| `ticket attach <id>` | Attach a file as doc_ref | `--file`* `--actor` |
| `ticket comment <id>` | Add a comment | `--author`* `--content`* |

### Ticket Examples

For `ticket create`, `--project` is optional when running inside a registered repo: the command infers project from the current working directory. Use `--project` explicitly to override this inference. Outside a registered repo, `--project` is required.

See **`pa-ticket-workflow` skill** — Appendix: Ticket CLI Examples for the full reference:
- Discovery & search
- Claiming & starting work
- While working (comments, blocking)
- Handoff & completion
- Creating tickets
- Doc-ref management
- Common errors & pitfalls
- Doc-ref format reference

## Bulletin Subcommands

| Subcommand | Purpose | Flags |
|-----------|---------|-------|
| `bulletin create` | Create a blocking bulletin | `--title`* `--block`* `--except` `--message` |
| `bulletin list` | List active bulletins | — |
| `bulletin resolve <id>` | Deactivate a bulletin | — |

### Bulletin Examples

```bash
# Check for blockers on startup (always do this first)
opa bulletin list

# Create a bulletin that blocks all teams
opa bulletin create \
  --title "Schema migration in progress — do not deploy" \
  --block all \
  --message "Wait for PA-100 to complete before deploying any team."

# Create a bulletin that blocks specific teams, exempting maintenance
opa bulletin create \
  --title "Builder paused for audit" \
  --block builder,requirements \
  --except maintenance

# Resolve after the issue is cleared
opa bulletin resolve B-007
```

## Registry Subcommand

Agents use `opa registry complete` to write their completion marker at shutdown, and `opa registry update` to record a post-completion correction if extra work is done after the initial marker.

| Subcommand | Purpose | Flags |
|-----------|---------|-------|
| `registry complete <deploy-id>` | Write completion marker | `--status`* `--summary` `--log-file` `--rating-source` `--rating-overall` `--rating-productivity` `--rating-quality` `--rating-efficiency` `--rating-insight` `--fallback` |
| `registry update <deploy-id>` | Record post-completion correction | `--status` `--summary` `--log-file` `--note` `--rating-source` `--rating-overall` `--rating-productivity` `--rating-quality` `--rating-efficiency` `--rating-insight` |
| `registry show <deploy-id>` | Show event timeline + computed status | — |
| `registry list` | List recent deployments | `--team` `--status` `--limit` |
| `registry search <query>` | FTS5 full-text search | `--limit` |
| `registry analytics` | Deployment analytics views | `--view` (`daily` \| `teams` \| `ratings`) |
| `registry clean` | Detect orphaned deployments | — |
| `registry sweep` | Resolve orphaned deployments with fallback completion | — |

> **Deprecated alias:** `opa registry amend <deploy-id>` is a deprecated alias for `opa registry update` (supports `--summary` and `--log-file` only). It still works today but will be removed ~2026-07-22. Prefer `update` in all new documentation and scripts.

`--status` values: `success` `partial` `failed`
`--rating-source` values: `agent` `system` `user` (rating source; defaults to `agent` when any rating option is provided)
Rating values (`--rating-overall`, `--rating-productivity`, `--rating-quality`, `--rating-efficiency`, `--rating-insight`) must be between 0 and 5.

### Registry Examples

```bash
# Write a success completion marker (team manager calls this at shutdown)
opa registry complete d-769bf8 \
  --status success \
  --summary "PA-959 pa-cli skill audit complete. Updated SKILL.md with examples and missing commands." \
  --log-file ~/Documents/ai-usage/sessions/2026/03/agent-team/2026-03-26-abc123-builder--team-manager--PA-959--pa-cli-audit.md

# Write a partial completion marker
opa registry complete d-769bf8 --status partial --summary "Completed phases 1-3, phase 4 skipped due to missing data."

# Write a failed completion marker
opa registry complete d-769bf8 --status failed --summary "Could not access target repo. Permissions error."

# Write a completion marker with session rating (from pa-session-log self-evaluation)
opa registry complete d-769bf8 \
  --status success \
  --summary "Skill consolidation complete. Merged pa-session-log into ai-usage-log." \
  --log-file ~/Documents/ai-usage/sessions/2026/03/agent-team/2026-03-26-35fb9f-builder--team-manager--skill-consolidation.md \
  --rating-source agent \
  --rating-overall 3.75 \
  --rating-productivity 4 \
  --rating-quality 4 \
  --rating-efficiency 3 \
  --rating-insight 4

# Record a post-completion update after follow-up work
opa registry update d-769bf8 \
  --status success \
  --summary "Skill consolidation complete. Follow-up: fixed edge case in Phase 2." \
  --note "User requested tweak after initial completion marker"
```

## Trash Subcommands

Use `opa trash move` instead of deleting PA project files (skills, teams, objectives, modes). Trashed files are retained for 30 days.

| Subcommand | Purpose | Flags |
|-----------|---------|-------|
| `trash move <path>` | Soft-delete a file | `--reason`* `--actor` `--type` |
| `trash list` | List trashed items | `--status` `--type` `--search` |
| `trash show <id>` | Show full trash entry details | — |
| `trash restore <id>` | Restore to original path | `--force` `--actor` |
| `trash purge` | Delete items older than N days | `--days` (default: 30) `--dry-run` `--actor` |

`--type` values: `skill` `team` `objective` `mode` `other`

### Trash Examples

```bash
# Soft-delete a skill file
opa trash move packaged pa-platform skills/old-skill/SKILL.md \
  --reason "Replaced by pa-cli skill" \
  --actor builder/team-manager \
  --type skill

# List all trashed items
opa trash list

# Restore a trashed item
opa trash restore T-003

# Preview what purge would delete (dry run)
opa trash purge --days 30 --dry-run
```

## Enum Values

### `--status` (tickets)

`idea` `requirement-review` `pending-approval` `pending-implementation` `implementing` `review-uat` `done` `rejected` `cancelled`

### `--type` (tickets)

`feature` `bug` `task` `review-request` `work-report` `fyi` `idea` `question`

### `--priority`

`critical` `high` `medium` `low`

### `--estimate`

`XS` `S` `M` `L` `XL`

## Project Keys

The `--project` flag accepts canonical keys from `repos.yaml`. Resolution order:
1. **Exact key** — e.g., `pa`, `avodah`, `ai-usage-log`
2. **Prefix match** — e.g., `PA`, `AVO`, `AUL` (case-insensitive)
3. **Path basename** — e.g., `personal-assistant`, `avodah`

Common keys: `pa` (PA·), `avodah` (AVO·), `ai-usage-log` (AUL·), `nixos` (NX·), `dot-files` (DOT·)

Run `opa repos list` to see all configured project keys.

## Assignee Convention

Always use `<team>/<agent>` format: `builder/team-manager`, `requirements/researcher`.
- Bare team names (e.g., `builder`) are valid for team-level assignment.
- `sinh` needs no prefix.
- Bare agent names (e.g., `team-manager`) are deprecated — always qualify with team.

`*` Required flag
