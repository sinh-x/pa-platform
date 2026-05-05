---
name: pa-bulletin
description: >
  Bulletin awareness and blocking protocol for PA agent teams. This skill should
  be used by all PA agents on startup and during work to check for active bulletins
  that may block the team. Active bulletins are also injected into primers under
  the `## Active Bulletins` section.
pa-tier: 2
pa-inject-as: shared-skill
---

# Bulletin Awareness

Check for active bulletins before starting the main objective.

## Check for Active Bulletins

```bash
pa bulletin list
```

Active bulletins are also injected into primers under `## Active Bulletins` — read that section on startup.

## Blocking Bulletin Protocol

If a bulletin blocks your team (`block: all` or your team name in `block:`) and you are NOT listed in `except:`:

1. **Do not proceed with the main objective**
2. Create a FYI ticket noting the block:
   ```bash
   pa ticket create \
     --title "FYI: Deployment blocked by bulletin — <bulletin title>" \
     --type fyi \
     --assignee sinh \
     --priority high \
     --estimate XS \
     --summary "Deployment <deployment_id> blocked by active bulletin: <bulletin title>. Team: <team_name>. No work performed."
   ```
3. Write the completion marker (failed status) and exit.
