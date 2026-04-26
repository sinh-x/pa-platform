---
name: pa-housekeeping-workspace
description: >
  Agent workspace management for PA agent teams in housekeeping mode. This skill
  should be used by all PA agents to understand the two workspace types (persistent
  team workspace and per-deployment workspace), create workspaces on startup, and
  organize outputs correctly for team manager review.
pa-tier: 2
pa-inject-as: shared-skill
---

# Agent Workspace Management

Agents have two workspace types for managing outputs across deployments.

## Two Workspace Types

### Persistent Team Workspace (agent-teams/)

Every team has a **persistent workspace** that survives across deployments:

```
~/Documents/ai-usage/agent-teams/<team_name>/
```

Use this for:
- Ongoing state that must persist between runs (queues, indexes, accumulated data)
- Cross-deployment context (e.g., what was done last run)
- Team artifacts and deliverables

On startup, check your persistent workspace for files from previous runs.

### Per-Deployment Workspace (deployments/)

Each deployment also gets an ephemeral workspace for run-specific outputs:

```
~/Documents/ai-usage/deployments/<deployment_id>/<agent_name>/
```

## Workspace Structure

```
~/Documents/ai-usage/agent-teams/planner/     # Persistent team workspace
│   └── ...                                    # Cross-deployment state

~/Documents/ai-usage/deployments/d-a3f7b2/    # Per-deployment workspace
├── session-gatherer/        # Each agent gets their own directory
│   ├── report.md            # Agent's main output/report
│   └── ...                  # Any intermediate files
├── jsonl-analyst/
│   └── report.md
├── synthesizer/
│   └── report.md
└── team-manager/            # Team manager's own workspace
    └── report.md
```

## Workspace Rules

1. **On startup**, every agent creates both workspaces:
   ```bash
   mkdir -p ~/Documents/ai-usage/agent-teams/<team_name>/
   mkdir -p ~/Documents/ai-usage/deployments/<deployment_id>/<agent_name>/
   ```

2. **Per-deployment outputs** (reports, data, intermediate results) go in `deployments/<deployment_id>/<agent_name>/`

3. **Persistent state** (cross-run data, queues, indexes) goes in `agent-teams/<team_name>/`

4. **Report back to team manager** with workspace path so the manager knows where to find outputs

5. **Team manager reviews** agent workspaces after agents report completion — read their files before synthesizing

6. **The deployment workspace path** is provided in `<deployment-context>` as `workspace_base` — append your agent name to get your directory

7. **Sub-agents** use their parent's workspace with a subdirectory: `<parent-workspace>/<sub-agent-name>/`

## What Goes in the Workspace

| File type | Example | Required? |
|-----------|---------|-----------|
| Main report/output | `report.md` | Yes — every agent produces at least one output |
| Raw data | `raw-avo-output.txt` | Optional — useful for debugging |
| Intermediate results | `parsed-sessions.json` | Optional — only if useful for review |
| Error logs | `errors.txt` | If errors occurred |

## Team Manager's Role

After an agent reports completion:
1. Read the agent's workspace files (especially `report.md`)
2. Use the data for synthesis or final output
3. Note any issues in their own session log
