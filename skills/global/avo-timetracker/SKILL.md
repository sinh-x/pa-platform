---
name: avo-timetracker
description: Task management and time tracking using the avo (Avodah) CLI. This skill should be used when the user wants to create tasks, start/stop timers, log time, check work summaries, plan daily time, or manage projects via the avo command. Triggers include phrases like "track time", "start working on", "log time", "create task", "what did I do today", "how much time", "avo", "time tracking", "worklog", "stop timer", "pause timer", "plan my day", "daily plan", "set due date", "categorize task".
source: /home/sinh/.claude/skills/avo-timetracker/SKILL.md
---

# Avo Timetracker

Manage tasks and track time using the `avo` CLI (Avodah - Worklog tracking from the command line). Located at `/home/sinh/.nix-profile/bin/avo`.

## Core Concepts

- **Tasks**: Work items that can be local or synced from Jira. Each has a short ID (first 8 hex chars), a title, and optional project/category/estimate.
- **Timer**: One timer runs at a time. It can be started, paused, resumed, stopped, or cancelled.
- **Worklogs**: Time entries logged against tasks, either via timer (start/stop) or manual entry (`worklog add`).
- **Projects**: Optional grouping for local tasks.
- **Plans**: Daily time budgets by category and/or specific tasks.

## Full CLI Reference

### Global

| Command | Description |
|---|---|
| `avo` | Runs `avo status` (dashboard) |
| `avo --version` / `avo -v` | Show version |
| `avo <command> --help` | Help for any command |

### Timer

| Command | Description |
|---|---|
| `avo start [task]` | Start timer. Positional arg is task ID or title. Omit for interactive picker. |
| `avo start [task] -n "note"` | Start with a work note |
| `avo stop` | Stop timer, log worklog |
| `avo stop -m "comment"` | Stop with worklog description |
| `avo stop -d` | Stop and mark task done |
| `avo pause` | Pause running timer |
| `avo resume` | Resume paused timer |
| `avo cancel` | Cancel timer (no worklog logged) |

### Task (`avo task <subcommand>`)

| Command | Description |
|---|---|
| `avo task add <title>` | Create task |
| `avo task add <title> -p <project-id>` | Create under project |
| `avo task add <title> --due 2026-03-01` | Create with due date |
| `avo task add <title> --cat Working` | Create with category |
| `avo task list` | List active tasks |
| `avo task list -a` / `--all` | Include completed tasks |
| `avo task list --deleted` | Show only soft-deleted tasks |
| `avo task list -l` / `--local` | Only local tasks (no Jira) |
| `avo task list -s jira` | Filter by source (`jira` or `github`) |
| `avo task list -p <id>` | Filter by project |
| `avo task list --profile work` | Filter by Jira profile |
| `avo task show <id>` | Show task details |
| `avo task done <id>` | Mark task done |
| `avo task undone <id>` | Revert done → active |
| `avo task delete <id>` | Soft-delete (prompts if has worklogs) |
| `avo task delete <id> -f` | Force delete (skip worklog check) |
| `avo task undelete <id>` | Restore soft-deleted task |
| `avo task due <id> 2026-03-01` | Set due date |
| `avo task due <id> clear` | Clear due date |
| `avo task cat <id> Working` | Set category |
| `avo task cat <id> clear` | Clear category |
| `avo task note <id>` | View description/notes |
| `avo task note <id> "text"` | Set description |
| `avo task note <id> -a "text"` | Append timestamped note |
| `avo task note <id> -f path` | Set description from file |
| `avo task note <id> --clear` | Clear description |

**Important**: The subcommand is `cat` not `category`. Use `avo task cat`, not `avo task category`.

### Worklog (`avo worklog <subcommand>`)

| Command | Description |
|---|---|
| `avo worklog list` | List recent worklogs (default 10) |
| `avo worklog list -n 20` | List last 20 worklogs |
| `avo worklog add` | Interactive worklog entry |
| `avo worklog add -t <task-id> -d 1h30m -m "comment"` | Add with task, duration, message |
| `avo worklog add -t <task-id> -s 9:00 -d 2h` | Add with explicit start time |
| `avo worklog delete <id>` | Delete a worklog (prompts for confirmation) |
| `echo "y" \| avo worklog delete <id>` | Delete with auto-confirmation |
| `avo worklog edit <id>` | Interactive edit |
| `avo worklog edit <id> -d 3h` | Change duration |
| `avo worklog edit <id> -s 10:00` | Change start time |
| `avo worklog edit <id> -m "new note"` | Change description |

**Note**: There is no `avo worklog show` subcommand. Use `avo worklog list` and grep. `avo worklog delete` prompts for confirmation — use `echo "y" | avo worklog delete <id>` for scripting.

### Project (`avo project <subcommand>`)

| Command | Description |
|---|---|
| `avo project add <title>` | Create project |
| `avo project add <title> -i "🚀"` | Create with icon |
| `avo project list` | List active projects |
| `avo project list -a` | Include archived |
| `avo project show <id>` | Show project details |
| `avo project delete <id>` | Delete project |

### Plan (`avo plan <subcommand>`)

`avo plan` with no subcommand runs `avo plan list`.

| Command | Description |
|---|---|
| `avo plan add <category> -d 6h` | Add category budget for today |
| `avo plan add <category> -d 4h --day 2026-03-01` | Add for specific day |
| `avo plan list` | Show plan-vs-actual for today |
| `avo plan list --day 2026-03-01` | Show for specific day |
| `avo plan remove <category>` | Remove category from today |
| `avo plan remove <category> --day 2026-03-01` | Remove from specific day |
| `avo plan task <task-id>` | Add task to day plan |
| `avo plan task <task-id> -e 2h` | Add with time estimate |
| `avo plan task <task-id> --day 2026-03-01` | Add for specific day |
| `avo plan untask <task-id>` | Remove task from plan |
| `avo plan cancel <task-id>` | Cancel planned task (stays visible) |
| `avo plan uncancel <task-id>` | Un-cancel planned task |

All plan subcommands accept `--day YYYY-MM-DD` (defaults to today).

### Jira (`avo jira <subcommand>`)

`avo jira` with no subcommand runs `avo jira status`.

| Command | Description |
|---|---|
| `avo jira init` | Generate credentials template at `~/.config/avodah/jira_credentials.json` |
| `avo jira setup` | Configure Jira connection (interactive) |
| `avo jira setup --profile work` | Setup from named profile |
| `avo jira status` | Show sync status, linked tasks, pending worklogs |
| `avo jira sync` | 2-way sync all issues |
| `avo jira sync PROJ-123` | Sync single issue (positional arg, NOT `--issue`) |
| `avo jira sync --profile work` | Sync with specific profile |
| `avo jira sync -D 7` / `--days 7` | Only sync issues updated in last N days |
| `avo jira sync --dry-run` | Preview changes |
| `avo jira sync --no-interactive` | Skip conflict prompts |

**Important**: Issue key is a positional argument. Use `avo jira sync AG-123`, NOT `avo jira sync --issue AG-123`.

### Reports

| Command | Description |
|---|---|
| `avo status` | Full dashboard: timer, today, tasks, plan |
| `avo today` | Today's work summary |
| `avo daily` | Daily report: worklogs, tasks, plan vs actual |
| `avo daily 2026-03-01` | Daily report for specific date |
| `avo week` | Current week summary |
| `avo week 2026-03-01` | Week containing that date |
| `avo week 2026-03-01 2026-03-07` | Custom date range |

## Input Formats

### Duration
`30m`, `1h`, `1h30m`, `2h 15m`

### Time
`9:00`, `14:30`, `2026-02-15T09:00`, `yesterday 14:00`

### Date
`YYYY-MM-DD` (e.g., `2026-03-01`)

### ID Resolution
All IDs support prefix matching (first 8 hex chars). If ambiguous, CLI lists matches. Exact match wins over prefix.

## Common Gotchas

These are **real errors from past sessions** — avoid them:

1. **Wrong cwd**: `dart run mcp/bin/avo.dart` must run from the project root `/home/sinh/git-repos/sinh-x/tools/avodah`. Use `avo` binary directly instead.
2. **`avo task category` doesn't exist** — use `avo task cat`.
3. **`avo worklog show` doesn't exist** — use `avo worklog list` and grep.
4. **`avo jira sync --issue KEY` doesn't exist** — issue key is a positional arg: `avo jira sync KEY`.
5. **`dart build mcp/bin/avo.dart` is wrong** — correct: `cd mcp && dart build cli --target bin/avo.dart`.
6. **`dart compile exe` doesn't work** — use `dart build cli` (build hooks required).
7. **`avo worklog delete` prompts for confirmation** — scripted deletion requires `echo "y" | avo worklog delete <id>`.
8. **`avo task add` has no estimate option** — estimates are set when adding to plan: `avo plan task <id> -e 2h`, not when creating the task.

## Key Files

- Binary: `/home/sinh/.nix-profile/bin/avo`
- Dev entry point: `mcp/bin/avo.dart` (run with `dart run mcp/bin/avo.dart` from project root)
- Config: `~/.config/avodah/config.json`
- Jira credentials: `~/.config/avodah/jira_credentials.json`
- Database: `~/.local/share/avodah/avodah.db`

## Best Practices When Using This Skill

- **Never start/stop/pause/resume timers automatically.** Timer control is the user's responsibility. Only run timer commands if the user explicitly asks.
- Help create tasks when the user asks — run `avo task add "title"` and report back the task ID.
- Use the short 8-char ID form for all commands.
- When listing tasks for the user, format the output clearly — show ID, title, and logged time.
- If the user asks "what did I do today/this week", use `avo today` or `avo week`.
- For Jira-linked tasks, prefer using the Jira key for identification in conversation but use the avo ID for commands.
- Prefer using the `avo` binary directly over `dart run mcp/bin/avo.dart`.
