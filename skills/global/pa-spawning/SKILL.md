---
name: pa-spawning
description: >
  Sub-agent spawning protocol for PA agent teams. This skill should be used by
  any agent that needs to spawn sub-agents via the Agent tool. It defines the
  required identity context that must be passed to each sub-agent.
pa-tier: 2
pa-inject-as: shared-skill
---

# Spawning Sub-Agents

When spawning a sub-agent via the Agent tool, pass identity context in the prompt:

```
You are agent "<sub-agent-name>" on team "<team_name>" (deployment: <deployment_id>).
Your parent is: <your-agent-name>.
Your workspace: ~/Documents/ai-usage/deployments/<deployment_id>/<your-agent-name>/<sub-agent-name>/
You follow the global standards from skills/global/standards.md.

Current ticket: <ticket-id> (or "none" if no assigned ticket for this deployment)

Your task: <task description>
```

## Required Fields to Pass

- `deployment_id`
- `team_name`
- `parent` (your own agent name)
- `workspace` path for the sub-agent
- `ticket_id` — the current ticket being worked on (if any)
- A clear name for the sub-agent

## Sub-Agent Inheritance

Sub-agents inherit all global standards. Remind them of the key ones:
- Log their work (session logging)
- Use real identity in logs
- Report results back to parent
