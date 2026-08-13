# CLI Reference

Complete reference for the pa-platform command-line interface. The runtime-neutral core is exposed as `pa-core` (package `@pa-platform/pa-core`), and the OpenCode adapter ships the `opa` binary (package `@pa-platform/opencode-pa`). `opa` wraps `runCoreCommand` from pa-core with the OpenCode adapter hooks, so every command documented here behaves identically under `pa-core` and `opa` except where noted.

> **Source of truth:** `packages/pa-core/src/cli/commands/` (command implementations) and `packages/pa-core/src/cli/core-command.ts` (dispatch). `opa`-specific provider defaults live in `packages/opencode-pa/src/adapter.ts`.
> **Last updated:** 2026-08-13

## Table of Contents

- [Conventions](#conventions)
- [Global Flags](#global-flags)
- [Command Index](#command-index)
- [status](#status)
- [deploy](#deploy)
- [evaluate](#evaluate)
- [serve (start / stop / restart / serve-status)](#serve-start--stop--restart--serve-status)
- [schedule](#schedule)
- [remove-timer](#remove-timer)
- [board](#board)
- [branch](#branch)
- [teams](#teams)
- [registry](#registry)
- [ticket](#ticket)
- [bulletin](#bulletin)
- [health](#health)
- [trash](#trash)
- [codectx](#codectx)
- [timers](#timers)
- [signal](#signal)
- [semantic](#semantic)
- [repos](#repos)
- [Subcommand Count Summary](#subcommand-count-summary)

---

## Conventions

- **Binary:** Use `opa <command>` (OpenCode adapter, default) or `pa-core <command>` (runtime-neutral core). Both dispatch to the same `runCoreCommand` implementation.
- **Help:** Every command accepts `--help` / `-h` (and bare `help` for most). With no arguments, most commands print their help text.
- **Boolean flags** are presence-only (`--flag`); **value flags** require the next argument to be a non-flag value (`--flag value`).
- **Exit codes:** `0` on success, `1` on error (error message written to stderr).
- **Project resolution:** Commands that take `--project` resolve via `repos.yaml` (see [Configuration](./configuration.md)). When run inside a registered repo, `--project` is optional (CWD-detected).
- **Assignee convention:** Use `<team>/<agent>` (e.g. `builder/team-manager`); `sinh` needs no prefix.
- **Sanitization:** Free-text inputs (ticket titles, summaries, comments, bulletin titles/messages) are sanitized for control/invalid characters; warnings are printed to stderr when characters are removed.

## Global Flags

| Flag | Behavior |
|------|----------|
| `--help`, `-h` | Print help for the current command/subcommand and exit 0. |
| `--version`, `-V` | (`opa` only) Print `opa <version>` and exit 0. `pa-core` does not implement a version flag. |

## Command Index

19 top-level commands are dispatched by `runCoreCommand` (the four serve-lifecycle verbs `serve` / `stop` / `restart` / `serve-status` are grouped as one "serve" command with four actions):

| # | Command | Subcommands | Summary |
|---|---------|-------------|---------|
| 1 | [status](#status) | — | Show deployment status and activity |
| 2 | [deploy](#deploy) | — | Deploy a team configuration |
| 3 | [evaluate](#evaluate) | — | Evaluate a completed deployment |
| 4 | [serve](#serve-start--stop--restart--serve-status) | start, stop, restart, status | Start/stop/restart/status the Agent API server |
| 5 | [schedule](#schedule) | — | Schedule a recurring deployment timer (systemd) |
| 6 | [remove-timer](#remove-timer) | — | Remove a scheduled timer |
| 7 | [board](#board) | — | Display the project board |
| 8 | [branch](#branch) | create, validate | Manage feature branches |
| 9 | [teams](#teams) | — | List teams or show team details |
| 10 | [registry](#registry) | list, show, complete, update, search, analytics, clean, sweep | Manage the deployment registry |
| 11 | [ticket](#ticket) | list, show, create, update, comment, attach, move, delete, archive, unarchive, check-refs, subticket | Manage tickets |
| 12 | [bulletin](#bulletin) | list, create, resolve | Manage bulletins |
| 13 | [health](#health) | — | Show system health report |
| 14 | [trash](#trash) | list, move, show, restore, purge | Manage soft-deleted files |
| 15 | [codectx](#codectx) | analyze, refresh, summary, status, query, exists | Manage code context graphs |
| 16 | [timers](#timers) | — | List active systemd timers |
| 17 | [signal](#signal) | collect | Manage Signal note-to-self collection |
| 18 | [semantic](#semantic) | rebuild, refresh, query, briefing | Semantic briefing and search |
| 19 | [repos](#repos) | list | List registered repositories |

> **Note on count:** The dispatch in `core-command.ts` routes 22 distinct command names. The four serve-lifecycle verbs (`serve`, `stop`, `restart`, `serve-status`) are grouped here as a single "serve" command with four actions, yielding the 19 top-level commands referenced in the requirements plan. Each verb is documented individually below for clarity.

---

## status

Show deployment status and activity. With no deploy-id, lists deployments; with a deploy-id, shows details or a sub-view.

**Usage:** `status [deploy-id] [options]`

**Options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--running` | — | Show only currently running deployments (live PIDs) |
| `--today` | — | Show deployments started today |
| `--wait` | — | Wait for a deployment to finish (requires `deploy-id`) |
| `--report` | — | Show the work report for a deployment (standalone) |
| `--artifacts` | — | List workspace files for a deployment (standalone) |
| `--activity` | — | Show activity timeline for a deployment |
| `--verbose` | — | Include noise events in activity output (requires `--activity`) |
| `--team <name>` | team name | Filter deployments by team |
| `--recent <n>` | positive int | Show only the N most recent deployments |

**Combinator rules:**
- `--wait` requires a `deploy-id`; `--wait` implies `--activity`.
- `--verbose` requires `--activity`.
- `--report` and `--artifacts` are standalone and not combinable with `--wait`, `--activity`, or each other.

**Wait timeout:** Resolved from the deployment's `effective_timeout_seconds` (falling back to `DEFAULT_DEPLOY_TIMEOUT_SECONDS` = 1800), overridable via `PA_STATUS_WAIT_TIMEOUT`. Poll interval: 10s. If the recorded PID is dead while status is still `running`, a `crashed` registry event is appended.

**Examples:**
```bash
opa status
opa status d-abc123
opa status d-abc123 --activity
opa status d-abc123 --wait
opa status --running
opa status --today
opa status --team builder --recent 5
```

**Environment:** `PA_STATUS_WAIT_TIMEOUT` (positive integer seconds between 60 and 7200) overrides the wait timeout.

---

## deploy

Deploy a team configuration. Generates a primer and invokes the runtime adapter (opencode by default).

**Usage:** `deploy <team> [options]`

**Positional:**
- `<team>` — Team name (required). Must match a team config in `teams/`.

**Mode flags:**

| Flag | Value | Description |
|------|-------|-------------|
| `--background` | — | Run detached/headless |
| `--dry-run` | — | Generate primer and plan without invoking opencode |
| `--list-modes` | — | Print available deploy modes for the team |
| `--validate` | — | Validate team config (including skill references) without deploying |

**Deployment options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--mode <mode>` | mode ID | Deploy mode ID (required for actual deployment) |
| `--objective <text>` | string | Inline objective override |
| `--objective-file <path>` | file path | Read objective from a (guarded) local file |
| `--evaluate-deployment <id>` | deploy-id | Generate evaluator primer objective for a completed deployment |
| `--repo <path>` | path | Override repository path |
| `--ticket <id>` | ticket id | Associate deployment with a ticket |
| `--timeout <seconds>` | int (60–7200) | Override deployment timeout |
| `--resume <id>` | deploy-id | Resume a prior deployment |
| `--autonomy <low\|medium\|high>` | level | Override autonomy level (default: medium) |

**Provider options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--provider <name>` | provider | Model provider (`minimax`, `openai`, `deepseek`, `ollama-cloud`, `opencode-go`). Default: `ollama-cloud` |
| `--model <name>` | model | Override default model |
| `--team-model <name>` | model | Override team-level model |
| `--agent-model <name>` | model | Override agent-level model |

**Removed flags:** `--interactive` and `--direct` were removed; foreground TUI is the default. Passing either returns an error directing the user to `--background` or `--dry-run`.

**Timeout resolution:** Defaults to `DEFAULT_DEPLOY_TIMEOUT_SECONDS` (1800); validated against `MIN_DEPLOY_TIMEOUT_SECONDS` (60) and `MAX_DEPLOY_TIMEOUT_SECONDS` (7200). `--timeout` must be an integer in that range.

**Examples:**
```bash
opa deploy builder --mode implement --background
opa deploy builder --dry-run --mode implement
opa deploy builder --list-modes
opa deploy builder --validate
opa deploy builder --mode implement --ticket PAP-132 --repo ./pa-platform
opa deploy builder --mode implement --provider deepseek --model deepseek/deepseek-v4-pro
```

**`opa`-specific:** The OpenCode adapter resolves provider default models from `OPA_*_MODEL` env vars (see [Configuration](./configuration.md)).

---

## evaluate

Launches the dedicated evaluator team in `deployment-review` mode, or records an evaluator result for a completed deployment.

**Usage:**
```
evaluate --evaluate-deployment <deploy-id> [options]
evaluate <deploy-id> [options]
```

A positional `<deploy-id>` matching `d-[a-z0-9]{6}` is shorthand for `--evaluate-deployment`.

**Options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--evaluate-deployment <id>` | deploy-id | Target completed deployment to evaluate (required) |
| `--background` | — | Run detached/headless |
| `--dry-run` | — | Generate evaluator primer without invoking opencode |
| `--ticket <id>` | ticket id | Associate evaluator run with a ticket |
| `--repo <path>` | path | Repository context for memory docs |
| `--timeout <seconds>` | int (60–7200) | Override evaluator deployment timeout |
| `--provider <name>` | provider | Model provider |
| `--model <name>` | model | Override model |
| `--team-model <name>` | model | Override team-level model |
| `--agent-model <name>` | model | Override agent-level model |
| `--record` | — | Store evaluator result for the target deployment |
| `--evaluator-deployment <id>` | deploy-id | Evaluator deployment ID for `--record` (defaults to `PA_DEPLOYMENT_ID`) |
| `--report-path <path>` | path | Evaluator report path for `--record` |
| `--overall <0-5>` | number | Overall evaluator score for `--record` |

**Metric score flags (require `--record`, values `0`–`5`):**

`--productivity`, `--quality`, `--efficiency`, `--insight`, `--human-agency`, `--evidence-grounding`, `--instruction-compliance`, `--user-fit`, `--risk-handling`, `--outcome-integrity`.

**Combinator rules:**
- `--record` only supports `--evaluate-deployment`, `--evaluator-deployment`, `--report-path`, and score flags.
- `--evaluator-deployment`, `--report-path`, and score flags require `--record`.
- `--background` and `--dry-run` are mutually exclusive.

**Validation:** Repo specifier must be a safe name/path (no `..`); ticket ID must match `^[A-Z][A-Z0-9]+-[0-9]+$`; provider/model names are validated against safe character sets.

**Examples:**
```bash
opa evaluate d-abc123 --background
opa evaluate --evaluate-deployment d-abc123 --dry-run
opa evaluate d-abc123 --record --evaluator-deployment d-ef4567 --overall 4 --human-agency 3.5
```

**Environment:** `PA_DEPLOYMENT_ID` is used as the evaluator deployment id for `--record` when `--evaluator-deployment` is omitted.

---

## serve (start / stop / restart / serve-status)

Manage the Agent API server lifecycle. The four verbs are dispatched separately by `runCoreCommand` but share the `serve` command implementation. `serve` with a nested `stop`/`restart`/`status` first argument is also accepted (e.g. `opa serve stop`).

**Defaults:** host `127.0.0.1`, port `9848` (constants `DEFAULT_SERVE_HOST` / `DEFAULT_SERVE_PORT`). PID file: `<dataDir>/pa-core-serve.pid` (see [Server Lifecycle](./server-lifecycle.md)).

### start

**Usage:** `serve [--port <port>] [--host <host>] [--background] [--cors] [--force] [--dev]`

| Flag | Value | Description |
|------|-------|-------------|
| `--port <port>` | int 1–65535 | Listen port (default 9848) |
| `--host <host>` | host | Bind host (default `127.0.0.1`) |
| `--background` | — | Detach; write PID file |
| `--cors` | — | Enable CORS middleware |
| `--force` | — | Kill an existing instance using the same port |
| `--dev` | — | Activate dev mode (binary resolution consults `PA_OPENCODE_BINARY`) |

### restart

**Usage:** `restart [--port <port>] [--host <host>] [--background] [--cors] [--dev]`

Supports the same flags as `start`. `--force` is accepted but ignored — `restart` always stops any existing instance first, then starts (equivalent to `stop` + `start`). The usage line omits `--force` because it has no effect.

### stop

**Usage:** `stop [--port <port>] [--host <host>]`

Only `--host` and `--port` are accepted (other flags return an error). Kills the PID recorded in the PID file and removes it.

### serve-status

**Usage:** `serve-status [--port <port>] [--host <host>]`

Only `--host` and `--port` are accepted. Prints whether the server is running and the recorded PID/port.

**Dev mode:** Activated by `--dev` or the `PA_DEV_MODE` env var (truthy: `"1"`, `"true"`, `"yes"`). Dev mode only affects binary resolution; it does not disable auth, CORS, or capacity limits.

**Examples:**
```bash
opa serve
opa serve --background --cors
opa serve --port 9000 --host 0.0.0.0
opa stop
opa restart --dev
opa serve-status
```

**Environment:** `PA_DEV_MODE`, `PA_OPENCODE_BINARY` (dev-mode binary override).

---

## schedule

Schedule a recurring deployment timer via systemd user timers. Also creates the paired `.service` unit.

**Usage:** `schedule <spec> [repeat] [times...] [options]`

**Positional:**
- `<spec>` — Schedule spec. Forms:
  - `<team>` — deploy a team (e.g. `builder`)
  - `<team>:<mode>` — deploy a team in a mode (e.g. `builder:implement`)
  - `daily:<plan|progress|end>` — daily planner lifecycle
  - `signal:collect` — signal collection (special-cased to every 2 hours)
- `[repeat]` — `hourly` | `daily` | `weekly` | `monthly` (default: `daily`)
- `[times...]` — trigger times in `HH:MM` (default: `09:00`)

**Options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--time <HH:MM>` | time | Trigger time(s), repeatable |
| `--repeat <hourly\|daily\|weekly\|monthly>` | enum | Repeat frequency (default: `daily`); also accepted as the second positional argument |
| `--command <path>` | path | Override the pa command path |
| `--dry-run` | — | Print what would be done without executing |

**Calendar mapping:** `daily` → `*-*-* HH:MM:00`; `weekly` → `Mon *-*-* HH:MM:00`; `monthly` → `*-*-01 HH:MM:00`; `hourly` → `hourly`. `signal:collect` ignores times and runs every 2 hours.

**Command resolution:** `PA_COMMAND` → `PA_CORE_BIN` → `PA_BIN/pa` → `pa-core`.

**Examples:**
```bash
opa schedule builder daily 09:00
opa schedule daily:plan daily --time 08:00
opa schedule builder:implement daily --time 06:00 --time 18:00
opa schedule builder --dry-run
```

**Environment:** `PA_COMMAND`, `PA_CORE_BIN`, `PA_BIN`, `XDG_CONFIG_HOME` (systemd user dir).

---

## remove-timer

Remove a scheduled systemd timer and its paired service unit.

**Usage:** `remove-timer <name> [options]`

**Positional:**
- `<name>` — Timer name, with or without the `pa-` prefix (auto-prefixed).

**Options:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Print what would be done without executing |
| `--yes` | Confirm removal (required for actual removal) |

Non-dry-run removal requires `--yes`. Stops and disables the timer, removes the `.timer` and `.service` files, and reloads the systemd daemon.

**Examples:**
```bash
opa remove-timer builder --dry-run
opa remove-timer pa-builder --yes
```

---

## board

Display the project board with ticket columns. CWD-aware: defaults to the current repo's project when inside a registered repo.

**Usage:** `board [options]`

**Options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--project <name>` | project key | Show board for a specific project |
| `--assignee <name>` | assignee | Filter tickets by assignee |
| `--all` | — | Show all tickets across all projects, including backlog and archived |
| `--include-archived` | — | Show archived tickets alongside non-archived (keeps current project scope) |

**Project resolution:** `--all` disables project scoping; `--project` resolves via `repos.yaml` (exact key, prefix, or path basename); otherwise CWD is detected. If not in a registered repo and neither `--all` nor `--project` is given, returns an error listing available projects.

**Default exclude tags:** `backlog` and `archived` (unless `--all` or `--include-archived`). Ticket types `fyi` and `work-report` are always excluded from the board view.

**Color:** Enabled when stdout is a TTY and `NO_COLOR` is unset.

**Examples:**
```bash
opa board
opa board --project pa-platform
opa board --assignee sinh
opa board --all
opa board --include-archived
```

---

## branch

Manage feature branches. Subcommands: `create`, `validate`.

### branch create

**Usage:** `branch create <ticket-id>... --topic <slug>`

Creates and checks out a feature branch from `develop` (or `origin/develop`) using the configured `featureBranchPattern` (default `feature/<ticket>-<topic>`).

**Arguments:**
- `<ticket-id>...` — one or more ticket IDs (warns if a ticket is not found; required)
- `--topic <slug>` — kebab-case topic (required)

**Behavior:** Resolves the current repo from CWD; builds the branch name from the repo's pattern; refuses if the branch already exists; checks out `develop` (fetching `origin/develop` if absent) and creates the new branch.

### branch validate

**Usage:** `branch validate`

Validates the current branch against the configured branch pattern. Returns exit 0 if it matches; otherwise prints a warning (distinguishing base branches `main`/`develop` from non-conforming feature branches) and still returns 0.

**Examples:**
```bash
opa branch create PAP-132 --topic api-documentation
opa branch create PAP-132 PAP-133 --topic refactor
opa branch validate
```

---

## teams

List agent teams and their status, or show details for a specific team.

**Usage:** `teams [name] [options]`

**Positional:**
- `[name]` — team name; when omitted, lists all teams.

**Options:**

| Flag | Description |
|------|-------------|
| `--all` | Include backlog and archived tickets in the board |
| `--json` | Output as JSON |

**Detail view (with name):** Prints the team's board (with running deployments) and runtime status. **List view (no name):** Prints a table of teams with model, per-column ticket counts, and most recent running deployment.

**Examples:**
```bash
opa teams
opa teams builder
opa teams --all
opa teams --json
```

---

## registry

Manage the deployment registry. Subcommands: `list`, `show`, `complete`, `update` (alias `amend`), `search`, `analytics`, `clean`, `sweep`.

### registry list

**Usage:** `registry list [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--json` | — | Output as JSON |
| `--team <name>` | team | Filter by team |
| `--status <status>` | status | Filter by status: `running`, `success`, `partial`, `failed`, `crashed`, `dead`, `unknown` |
| `--since <date>` | ISO 8601 | Filter by start date |
| `--limit <n>` | positive int | Limit results (default 20) |

### registry show

**Usage:** `registry show <deploy-id> [--json]`

Shows details and event count for a deployment. `--json` outputs the deployment record as JSON.

### registry complete

**Usage:** `registry complete <deploy-id> [options]`

Writes a `completed` registry event with a final status.

| Flag | Value | Description |
|------|-------|-------------|
| `--status <status>` | `success` \| `partial` \| `failed` | Completion status (required) |
| `--summary <text>` | string | Summary of results |
| `--log-file <path>` | path | Path to log file |
| `--fallback` | — | Skip if a terminal event already exists |
| `--rating-* <n>` | 0–5 | Rating values (see below) |

**Rating flags:** `--rating-source` (`agent` \| `system` \| `user`, defaults to `agent`), `--rating-overall`, `--rating-productivity`, `--rating-quality`, `--rating-efficiency`, `--rating-insight` (each 0–5).

### registry update

**Usage:** `registry update <deploy-id> [options]`

Appends an `updated` registry event. `amend` is a deprecated alias (prints a warning). Requires at least one field.

| Flag | Value | Description |
|------|-------|-------------|
| `--status <status>` | `success` \| `partial` \| `failed` | Update status |
| `--summary <text>` | string | Update summary |
| `--log-file <path>` | path | Update log file path |
| `--note <text>` | string | Add a note |
| `--rating-* <n>` | 0–5 | Rating values (same set as `complete`) |

### registry search

**Usage:** `registry search <query> [--limit <n>]`

Full-text search across deployment IDs, teams, summaries, notes, and objectives. `<query>` cannot be empty. `--limit` defaults to 20.

### registry analytics

**Usage:** `registry analytics [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--view <name>` | `daily` \| `teams` \| `ratings` | View type (default: all) |
| `--team <name>` | team | Filter by team |
| `--since <date>` | ISO 8601 | Filter by start date |

**Views:** `daily` (deployments per day with success counts), `teams` (team activity), `ratings` (self + evaluator rating trends with human-agency metric).

### registry clean

**Usage:** `registry clean [options]`

Find and optionally mark orphaned running deployments as crashed.

| Flag | Value | Description |
|------|-------|-------------|
| `--mark-dead` | — | Actually mark orphans as `crashed` (dry-run by default) |
| `--dry-run` | — | Explicit dry-run (default behavior) |
| `--threshold <hours>` | positive number | Age threshold in hours (default 6) |

### registry sweep

**Usage:** `registry sweep [--fix] [--dry-run]`

Resolve orphaned `running` deployments with no live PID by writing fallback `completed` (status `partial`) markers. `--fix` writes; without it, dry-run only.

**Examples:**
```bash
opa registry list --team builder --status running
opa registry show d-abc123 --json
opa registry complete d-abc123 --status success --summary "Done"
opa registry complete d-abc123 --status partial --fallback
opa registry update d-abc123 --note "Follow-up needed"
opa registry search failed --limit 10
opa registry analytics --view ratings
opa registry clean --threshold 12 --mark-dead
opa registry sweep --fix
```

---

## ticket

Manage tickets. Subcommands: `list`, `show`, `create`, `update`, `comment`, `attach`, `move`, `delete`, `archive`, `unarchive`, `check-refs`, `subticket`.

### ticket list

**Usage:** `ticket list [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--project <key>` | project | Filter by project key |
| `--status <status>` | status | Filter by status: `idea`, `requirement-review`, `pending-approval`, `pending-implementation`, `implementing`, `review-uat`, `done`, `rejected`, `cancelled` |
| `--assignee <name>` | assignee | Filter by assignee |
| `--priority <priority>` | priority | Filter by priority: `low`, `medium`, `high`, `critical` |
| `--type <type>` | type | Filter by type: `feature`, `bug`, `task`, `review-request`, `work-report`, `fyi`, `idea`, `question` |
| `--search <text>` | text | Full-text search across title and summary |
| `--tags <csv>` | csv | Comma-separated tags to match (ticket must include all) |
| `--exclude-tags <csv>` | csv | Comma-separated tags to exclude |
| `--archived` | — | Show only tickets tagged `archived` (composable) |
| `--json` | — | Output as JSON |

### ticket show

**Usage:** `ticket show <id> [--json]`

### ticket create

**Usage:** `ticket create [options]`

**Required flags:** `--title`, `--type`, `--priority`, `--estimate`, `--assignee`.

| Flag | Value | Description |
|------|-------|-------------|
| `--project <key>` | project | Project key (optional inside a registered repo) |
| `--title <text>` | string | Ticket title (required) |
| `--type <type>` | type | Ticket type (required) |
| `--priority <priority>` | priority | Priority (required) |
| `--estimate <size>` | `XS`\|`S`\|`M`\|`L`\|`XL` | Estimate (required) |
| `--assignee <name>` | assignee | Assignee (required) |
| `--summary <text>` | string | Summary |
| `--description <text>` | string | Description |
| `--status <status>` | status | Initial status (default `idea`) |
| `--from <text>` | string | From context |
| `--to <text>` | string | To context |
| `--tags <csv>` | csv | Tags |
| `--doc-ref <type:path>` | doc ref | Add a doc_ref (primary) |
| `--actor <name>` | actor | Actor name for history (default `pa-core`) |

### ticket update

**Usage:** `ticket update <id> [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--status <status>` | status | New status |
| `--assignee <name>` | assignee | New assignee |
| `--priority <p>` | priority | Priority |
| `--tags <csv>` | csv | Comma-separated tags (replaces existing) |
| `--blocked-by <csv>` | csv | Comma-separated blocked-by ticket ids |
| `--estimate <size>` | estimate | Estimate (`XS`–`XL`) |
| `--title <text>` | string | New title |
| `--summary <text>` | string | New summary |
| `--description <text>` | string | New description |
| `--doc-ref <type:path>` | doc ref | Add a doc_ref (optionally with `--doc-ref-primary`) |
| `--doc-ref-primary` | — | Mark the added doc_ref as primary |
| `--remove-doc-ref <path>` | path | Remove a doc_ref by path |
| `--linked-branch <repo\|branch\|sha>` | pipe-sep | Add a linked branch |
| `--remove-linked-branch <repo>` | repo | Remove a linked branch by repo |
| `--linked-commit <repo\|sha\|msg\|author\|ts>` | pipe-sep | Add a linked commit |
| `--remove-linked-commit <sha>` | sha | Remove a linked commit by sha |
| `--archive` | — | Archive the ticket (requires terminal status) |
| `--actor <name>` | actor | Actor name for history |

### ticket comment

**Usage:** `ticket comment <id> --author <name> (--content <text> | --content-file <path>)`

`--author` is required. Exactly one of `--content` or `--content-file` is required.

### ticket attach

**Usage:** `ticket attach <id> --file <path> [--actor <name>]`

Attaches a file as a doc_ref. `--file` is required; `--actor` defaults to `pa-core`.

### ticket move

**Usage:** `ticket move <id> --project <name> [--actor <name>]`

Moves a ticket to another project (its ID may change). `--project` is required.

### ticket delete

**Usage:** `ticket delete <id> [--force] [--yes] [--actor <name>]`

Soft-delete by default (sets status to `cancelled`). `--force` performs a hard-delete and requires `--yes` in non-interactive mode.

### ticket archive

**Usage:** `ticket archive <id> [--actor <name>]`

Adds the `archived` tag. Only terminal-status tickets (`done`, `rejected`, `cancelled`) can be archived; otherwise returns an error.

### ticket unarchive

**Usage:** `ticket unarchive <id> [--actor <name>]`

Removes the `archived` tag. No-op if not archived.

### ticket check-refs

**Usage:** `ticket check-refs --project <name>`

Checks all `doc_refs` for tickets in a project and reports orphaned paths (URL refs are skipped). `--project` is required. Returns exit 1 if any orphans are found.

### ticket subticket

**Usage:** `ticket subticket <subcommand> <parent-id> [sub-id] [options]`

Subcommands: `create`, `list`, `update`, `complete`.

#### subticket create

**Usage:** `ticket subticket create <parent-id> --title <text> [--summary <text>] [--assignee <name>] [--priority <p>] [--estimate <size>] [--actor <name>]`

`--title` is required. Priority defaults to `medium`; estimate defaults to `S`.

#### subticket list

**Usage:** `ticket subticket list <parent-id>`

Lists sub-tickets (id, status, priority, title) and a count.

#### subticket update

**Usage:** `ticket subticket update <parent-id> <sub-id> [options]`

Options: `--status`, `--assignee`, `--title`, `--summary`, `--priority`, `--estimate`, `--actor`.

#### subticket complete

**Usage:** `ticket subticket complete <parent-id> <sub-id>`

Marks a sub-ticket as `done`.

**Examples:**
```bash
opa ticket list --project pa-platform --status implementing
opa ticket show PAP-132
opa ticket create --project pa --title "Fix bug" --type bug --priority high --estimate S --assignee sinh
opa ticket update PAP-132 --status implementing --assignee builder/team-manager
opa ticket update PAP-132 --doc-ref "requirements:agent-teams/builder/req.md"
opa ticket comment PAP-132 --author sinh --content "Looks good"
opa ticket attach PAP-132 --file ./report.md
opa ticket move PAP-132 --project other-project
opa ticket delete PAP-132 --force --yes
opa ticket archive PAP-132
opa ticket check-refs --project pa-platform
opa ticket subticket create PAP-120 --title "Sub task"
opa ticket subticket list PAP-120
opa ticket subticket complete PAP-120 ST-001
```

---

## bulletin

Manage bulletins for team notification and blocking. Subcommands: `list`, `create`, `resolve`.

### bulletin list

**Usage:** `bulletin list [--json]`

Lists active bulletins.

### bulletin create

**Usage:** `bulletin create --title <text> --block <teams> [--except <teams>] [--message <text>]`

| Flag | Value | Description |
|------|-------|-------------|
| `--title <text>` | string | Bulletin title (required) |
| `--block <teams>` | `all` or csv | Teams to block (required) |
| `--except <teams>` | csv | Teams to exclude from the block |
| `--message <text>` | string | Bulletin body message |

### bulletin resolve

**Usage:** `bulletin resolve <id>`

Deactivates an active bulletin by its ID (e.g. `b-001`).

**Examples:**
```bash
opa bulletin list
opa bulletin create --title "Maintenance" --block all --message "System down"
opa bulletin create --title "Docs" --block builder,requirements --except maintenance
opa bulletin resolve b-001
```

---

## health

Show system health report with scores and findings by category.

**Usage:** `health [category] [options]`

**Positional:**
- `[category]` — one of: `deployments`, `agents`, `tickets`, `compliance`, `schedules`, `infrastructure`.

**Options:**

| Flag | Value | Description |
|------|-------|-------------|
| `--days <n>` | positive int | Number of days to analyze |
| `--since <iso>` | ISO date | Start analysis from this date |
| `--json` | — | Output as JSON |
| `--primer-summary` | — | Output a compact primer-ready summary |
| `--history` | — | Show recent health snapshot history |

**Hidden flag:** `--save` persists the generated report as a health snapshot.

**Output:** Default prints overall score (`<score>/100 <label>`) and per-category scores/finding counts. `--history` lists recent snapshots (timestamp, overall score, category scores). Score labels (`healthy`/`warning`/`unhealthy`) and category weights are configurable via `health.yaml` (see [Configuration](./configuration.md)).

**Examples:**
```bash
opa health
opa health deployments
opa health --days 14
opa health --since 2026-06-01
opa health --json
opa health --history
```

---

## trash

Manage soft-deleted files. Subcommands: `list`, `move`, `show`, `restore`, `purge`. Trashed items are retained for 30 days by default.

### trash list

**Usage:** `trash list [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--status <status>` | status | Filter by status |
| `--type <type>` | type | Filter by file type: `skill`, `team`, `objective`, `mode`, `other` |
| `--search <query>` | query | Search by keyword |
| `--json` | — | Output as JSON |

### trash move

**Usage:** `trash move <path> --reason <text> --yes [--actor <name>] [--type <type>]`

Soft-delete a file or directory. `--reason` and `--yes` are required.

### trash show

**Usage:** `trash show <id> [--json]`

### trash restore

**Usage:** `trash restore <id> [--force]`

Restores to the original location; `--force` overwrites existing files.

### trash purge

**Usage:** `trash purge [--days <n>] [--dry-run]`

Permanently purges entries older than `--days` (default 30). `--dry-run` previews.

**Examples:**
```bash
opa trash list --type file --json
opa trash move ./temp.log --reason "Cleanup" --yes
opa trash show t-001
opa trash restore t-001 --force
opa trash purge --days 30 --dry-run
```

---

## codectx

Manage code context graphs. Subcommands: `analyze`, `refresh`, `summary`, `status`, `query`, `exists`.

### codectx analyze / refresh

**Usage:** `codectx analyze [repo-path]` / `codectx refresh [repo-path]`

Analyzes a repository (defaults to CWD), saves the graph, and prints a summary. `refresh` is an alias that prints "Refreshed" instead of "Analyzed".

### codectx summary

**Usage:** `codectx summary [repo]`

Prints the stored graph summary for `repo` (defaults to CWD). Errors if no graph exists.

### codectx status

**Usage:** `codectx status [repo]`

Prints whether a graph exists, its generation timestamp, node count, and edge count. Returns exit 1 if no graph exists.

### codectx query

**Usage:**
```
codectx query <repo> <type> [target]
codectx query <type> <target> <repo>   # legacy order
```

`<type>` is one of: `exports`, `file`, `function` (alias `fn`), `class`.

- `exports` — list all exports (no target needed).
- `file <path>`, `function <name>`, `class <name>` — requires `<target>`.

The legacy argument order (`<type> <target> <repo>`) is auto-detected when the first arg matches a known query type.

### codectx exists

**Usage:** `codectx exists [repo]`

Prints `yes`/`no` and returns exit 0/1.

**Examples:**
```bash
opa codectx analyze ./pa-platform
opa codectx summary ./pa-platform
opa codectx status ./pa-platform
opa codectx query ./pa-platform exports
opa codectx query ./pa-platform function main
opa codectx query ./pa-platform class TicketStore
opa codectx exists ./pa-platform
```

---

## timers

List active systemd timers for scheduled deployments.

**Usage:** `timers [--json]`

Reads systemd user timers and prints their names/next triggers. `--json` outputs JSON.

**Examples:**
```bash
opa timers
opa timers --json
```

---

## signal

Manage Signal note-to-self collection. Subcommand: `collect`.

### signal collect

**Usage:** `signal collect [options]`

| Flag | Value | Description |
|------|-------|-------------|
| `--dry-run` | — | Show what would be extracted without writing |
| `--skip-route` | — | Extract notes but skip routing |
| `--reprocess` | — | Reprocess existing raw notes (clears previous routed entries unless `--dry-run`) |
| `--conversation-id <id>` | conversation id | Override the Note to Self conversation |

**Behavior:** Reads collector state, finds the Note to Self conversation (or uses the override), extracts new messages since the last run, writes raw note files, and routes them (unless `--skip-route`). `--reprocess` re-routes existing raw notes.

**Examples:**
```bash
opa signal collect
opa signal collect --dry-run
opa signal collect --skip-route
opa signal collect --reprocess
opa signal collect --conversation-id <id>
```

---

## semantic

Semantic briefing and search over indexed knowledge sources. Subcommands: `rebuild`, `refresh`, `query`, `briefing`.

### semantic rebuild / refresh

**Usage:** `semantic rebuild` / `semantic refresh`

Rebuilds the semantic candidate index and prints source counts by type. `refresh` is an alias.

### semantic query

**Usage:** `semantic query <query> [--top-k=<n>]`

Queries semantic candidates (reflections + system). `--top-k` defaults to 5; must be a positive number.

### semantic briefing

**Usage:** `semantic briefing <query>`

Generates and renders a semantic briefing bundle for `<query>` (top 5), then prints the write-guard status (allowed, or blocked with a reason referencing safe keywords: `ticket`, `doc`, `status`, `branch`, `registry`, `doc-ref`).

**Examples:**
```bash
opa semantic rebuild
opa semantic query "deploy workflow" --top-k=10
opa semantic briefing "startup context refresh"
```

---

## repos

List registered repositories. Subcommand: `list`.

### repos list

**Usage:** `repos list [--json]`

Lists repositories from `repos.yaml` (name, path, prefix, branch config). `--json` outputs JSON.

**Examples:**
```bash
opa repos list
opa repos list --json
```

---

## Subcommand Count Summary

| Command | Subcommand count | Subcommands |
|---------|------------------|-------------|
| status | 0 (flag-driven sub-views) | — |
| deploy | 0 (flag-driven modes) | — |
| evaluate | 0 (flag-driven) | — |
| serve | 4 actions | start, stop, restart, status |
| schedule | 0 (flag-driven) | — |
| remove-timer | 0 (flag-driven) | — |
| board | 0 (flag-driven) | — |
| branch | 2 | create, validate |
| teams | 0 (flag-driven) | — |
| registry | 8 (+1 alias) | list, show, complete, update (alias amend), search, analytics, clean, sweep |
| ticket | 12 (incl. subticket) | list, show, create, update, comment, attach, move, delete, archive, unarchive, check-refs, subticket |
| ticket subticket | 4 | create, list, update, complete |
| bulletin | 3 | list, create, resolve |
| health | 0 (flag-driven) | — |
| trash | 5 | list, move, show, restore, purge |
| codectx | 6 | analyze, refresh, summary, status, query, exists |
| timers | 0 (flag-driven) | — |
| signal | 1 | collect |
| semantic | 4 | rebuild, refresh, query, briefing |
| repos | 1 | list |
| **Total** | **46** (50 counting `ticket subticket` sub-subcommands) | |

All commands and flags above are derived from `packages/pa-core/src/cli/commands/` and `packages/pa-core/src/cli/core-command.ts`. The `opa` binary (`packages/opencode-pa/src/cli.ts`) delegates to `runCoreCommand` with OpenCode adapter hooks; no additional `opa`-only subcommands exist beyond the provider model resolution documented under [deploy](#deploy) and in [Configuration](./configuration.md).