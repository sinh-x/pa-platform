---
name: pa-registry
description: >
  Deployment registry management for PA agent teams. This skill should be used
  by team managers to write completion markers after all agents finish and log
  their sessions. It covers who writes to the registry, when, and with what status values.
pa-tier: 2
pa-inject-as: shared-skill
---

# Deployment Registry

The deployment registry tracks all team deployments in a **SQLite database** (WAL mode).

## Registry File Location

- **Database:** `~/Documents/ai-usage/deployments/registry.db` (SQLite, WAL mode)

## Registry Events

There are 5 event types written to the registry:

| Event | Who writes it | When |
|-------|--------------|------|
| `started` | `deploy.ts` (automatic) | Before agent launches |
| `pid` | `deploy.ts` (automatic) | After background launch |
| `completed` | **Team manager** (you) | After all work + logging done |
| `updated` | **Team manager** (you) | After post-completion corrections |
| `crashed` | `deploy.ts` shell wrapper | If agent exits non-zero |

### Event Fields (RegistryEvent TypeScript interface)

All events share these common fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deployment_id` | string | Yes | Unique deployment identifier (e.g., `d-abc123`) |
| `team` | string | Yes | Team name (e.g., `planner`, `builder`, `requirements`) |
| `event` | string | Yes | Event type: `started`, `pid`, `completed`, `updated`, or `crashed` |
| `timestamp` | string | Yes | ISO 8601 timestamp (e.g., `2026-04-07T10:30:00+07:00`) |
| `pid` | number | No | Process ID (written with `pid` event) |
| `status` | string | No | Completion status: `success`, `partial`, or `failed` (written with `completed` event) |
| `summary` | string | No | One-line summary of what was done (written with `completed` event) |
| `log_file` | string | No | Path to the session log file |
| `primer` | string | No | Primer filename used for this deployment |
| `agents` | string[] | No | List of agent names that were spawned |
| `models` | Record<string,string> | No | Model configuration (e.g., `{ "team-manager": "opus" }`) |
| `error` | string | No | Error message (written with `crashed` event) |
| `exit_code` | number | No | Process exit code (written with `crashed` event) |
| `ticket_id` | string | No | Associated ticket ID (e.g., `PA-042`) |
| `provider` | string | No | Model provider (e.g., `anthropic`) |
| `rating` | Rating | No | Self-evaluation ratings (written with `completed` event) |
| `objective` | string | No | Deployment objective/goal |
| `repo` | string | No | Repository key or path basename |

### Rating Sub-object

When ratings are provided (via `pa registry complete --rating-*` flags), the `rating` field contains:

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | Rating source: `agent`, `system`, or `user` |
| `overall` | number | Overall rating (0-5) |
| `productivity` | number | Productivity rating (0-5, optional) |
| `quality` | number | Quality rating (0-5, optional) |
| `efficiency` | number | Efficiency rating (0-5, optional) |
| `insight` | number | Insight rating (0-5, optional) |

## Who Writes to the Registry

> [!CAUTION]
> **Never modify registry.db directly.** Always use `pa registry` CLI commands. Direct database modifications bypass the application's safety checks and can corrupt the registry.

**Background mode note:** In background deployments, crash events are pre-written to JSON files by `deploy.ts` before launching the agent. If the agent crashes, the shell wrapper reads the pre-written crash JSON and appends it to the registry. No inline bash JSON construction is used.

## Completion Marker (Team Manager Only)

After all agents finish and all session logs are written, the team manager writes:

```bash
pa registry complete <DEPLOYMENT_ID> \
  --status <success|partial|failed> \
  --summary "<one-line summary>" \
  [--log-file <path>] \
  [--rating-source <agent|system|user>] \
  [--rating-overall <0-5>] \
  [--rating-productivity <0-5>] \
  [--rating-quality <0-5>] \
  [--rating-efficiency <0-5>] \
  [--rating-insight <0-5>]
```

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `<deploy-id>` | Yes | Deployment ID (e.g., `d-abc123`) |
| `--status` | Yes | Completion status: `success`, `partial`, or `failed` |
| `--summary` | Yes | One-line summary of what was accomplished |
| `--log-file` | No | Path to the session log file |
| `--rating-source` | No | Who provided the rating: `agent`, `system`, or `user` (default: `agent`) |
| `--rating-overall` | No | Overall rating 0-5 |
| `--rating-productivity` | No | Productivity rating 0-5 |
| `--rating-quality` | No | Quality rating 0-5 |
| `--rating-efficiency` | No | Efficiency rating 0-5 |
| `--rating-insight` | No | Insight rating 0-5 |

> [!NOTE]
> If no `--rating-*` flags are provided, a warning is printed to stderr reminding you to consider adding ratings for analytics purposes.

### Status Values

- `success` — all tasks completed without errors
- `partial` — some tasks completed, some failed or skipped
- `failed` — critical failure, objective not met

**Individual agents do NOT write to the registry.** Only the team manager writes the completion marker.

## Post-Completion Updates

If user interaction or follow-up work occurs after the completion marker was written, record the update via `pa registry update`:

```bash
pa registry update <DEPLOYMENT_ID> \
  --status <success|partial|failed> \
  --summary "<updated one-line summary>" \
  [--log-file <path>] \
  [--note "<free-text annotation>"] \
  [--rating-source <agent|system|user>] \
  [--rating-overall <0-5>] \
  [--rating-productivity <0-5>] \
  [--rating-quality <0-5>] \
  [--rating-efficiency <0-5>] \
  [--rating-insight <0-5>]
```

`pa registry update` appends a new `updated` event to the deployment's event stream (the original `completed` event is preserved). See `pa-session-log` skill for guidance on updating session logs with `[UPDATED]` markers when extra work is done after the initial completion marker.

> **Deprecated alias:** `pa registry amend` is a deprecated alias for `pa registry update`. It still works today but will be removed ~2026-07-22. Prefer `update` in all new documentation and scripts.

In addition to the deployment registry, all work items are tracked as tickets. See `pa-ticket-workflow` skill for details.

## Examples

### Complete a deployment with ratings

```bash
pa registry complete d-abc123 \
  --status success \
  --summary "Implemented Phase 2 - mtime cache and validation" \
  --rating-source agent \
  --rating-overall 4 \
  --rating-productivity 5 \
  --rating-quality 4
```

### Complete without ratings (warning will appear)

```bash
pa registry complete d-xyz789 \
  --status partial \
  --summary "Phase 3 blocked by dependency"
```

### Complete a skill-update deployment (no ticket)

```bash
pa registry complete d-cd730a \
  --status success \
  --summary "Updated handnote-combiner skill: added Obsidian wiki-link format, skeleton-file handling, screenshot filename guidance" \
  --rating-source agent \
  --rating-overall 5 \
  --rating-productivity 5 \
  --rating-quality 5 \
  --rating-efficiency 5 \
  --rating-insight 4
```

> For skill-update deployments (no ticket): set `--status success` and describe the specific changes in `--summary`. The `objective` field in the registry captures the original deployment objective; `summary` captures what was actually delivered.

### List recent deployments

```bash
pa registry list --team planner --limit 10
pa registry list --status running
```

### Search deployments (FTS5 full-text search)

```bash
pa registry search "migration"
pa registry search "builder phase" --limit 5
```

### View analytics

```bash
pa registry analytics                    # all views
pa registry analytics --view daily       # deployments per day
pa registry analytics --view teams       # team activity
pa registry analytics --view ratings     # rating trends
```

