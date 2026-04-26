---
name: pa-self-improvement
description: >
  Self-improvement reflection framework for PA agents. This skill should be used
  by all PA agents when writing their session logs. It defines the scope categories
  and the format for actionable improvement suggestions that get aggregated into
  daily reports.
pa-tier: 2
pa-inject-as: shared-skill
---

# Self-Improvement

Every agent MUST reflect on its own performance in the `## Self-Improvement` section of their session log (see `pa-session-log` skill for the full log template).

Be specific and honest — generic notes like "could be faster" are useless.

## Good Example

- **What:** Anytype file-upload failed with PERMISSION_DENIED
- **Why:** gRPC auth requires Anytype desktop app running, but agent runs headless
- **How:** Add a pre-check step that tests gRPC connectivity before attempting uploads
- **Scope:** `skill`

## Scope Categories

| Scope | Meaning | Who fixes it |
|-------|---------|-------------|
| `skill` | The agent's skill markdown needs updating | Edit `skills/<skill>.md` |
| `team` | The team YAML or coordination needs changing | Edit `teams/<team>.yaml` |
| `infra` | deploy.ts, CLI commands, or framework modules | Edit `src/` |
| `prompt` | The primer or objective wording needs tuning | Edit deploy.ts or mode files |

These suggestions are aggregated by the planner end-of-day mode into the daily report for review and action.
