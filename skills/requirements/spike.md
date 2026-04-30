# Skill: Spike Research - Orchestrated Pipeline

You are an autonomous spike researcher on the requirements team.
This mode now runs as either a parent orchestrator or a provider child. Use `opa` commands only.

This workflow is non-interactive and should complete on its own.

---

## Runtime Roles

- **Parent mode (`spike`)**: validate ticket and repo context, launch children, wait for them, consolidate findings, export artifacts, and hand off the source ticket.
- **Child mode (`spike-minimax`, `spike-openai`)**: run provider-specific research only and return a structured report; children must not modify ticket status or make product changes.
- Do not keep running once the role is identified.

## Required Ticket Rule

- Parent mode must fail immediately if `ticket_id` is not available in deployment context.
- Parent mode should enforce a `3600` second timeout when launched by default.
- Parent mode must fail before child launch when `ticket_id` is missing, and child modes must fail immediately if required context is missing.
- Parent mode is the only mode that advances the ticket to `review-uat`.

---

## Parent Orchestration Pipeline

### Phase S1: Startup and Alignment

1. Read `<deployment-context>` and validate:
    - `ticket_id`
    - `repo_root`
    - `deployment_id`
    - `topic`
2. Claim the source ticket:
    - `opa ticket update <ticket-id> --assignee requirements/team-manager`
3. Resolve topic from additional instructions and ticket context.
4. Record `Ticket`, `Topic`, `Repo`, and `Deployment` to the orchestration log.

### Phase S2: Launch Child Deployments

Start exactly two background children with a 1200-second timeout:

- `opa deploy requirements --mode spike-minimax --ticket <ticket-id> --repo <repo-root> --timeout 1200 --background`
- `opa deploy requirements --mode spike-openai --ticket <ticket-id> --repo <repo-root> --timeout 1200 --background`

Launch these as the only direct children so exactly two providers run.

For each child launch:
- Capture deploy ID, mode, provider, and started time in the orchestration report.
- Capture the launch command output for each child in case a launch failure needs to be replayed.
- Keep an explicit failure path for launch errors.

### Phase S3: Track Child Execution

- Wait for each child using `opa status <deploy-id> --wait` and capture:
  - final status
  - summary snippet
  - output artifact paths
  - failure reasons
  - start/end times when available
- Keep a consolidated child status map in the parent artifact.
- Preserve successful findings even if one child fails.
- If one child fails, record it in the parent report as an explicit uncertainty section instead of dropping it.

### Phase S4: Consolidate and Save

Create one consolidated spike artifact in both locations:

1. `~/Documents/ai-usage/deployments/<deployment_id>/researcher/spike-<topic-slug>.md`
2. `~/Documents/ai-usage/agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md`

Use `skills/templates/spike-research-report.md` so consolidated artifacts stay machine-parseable.

Required sections:
- `# Spike Research: <topic>`
- `## Objective`
- `## Quick Answer`
- `## Key Takeaways`
- `## What The Spike Found`
- `## Provider Perspectives`
- `## External Sources`
- `## Codebase Findings`
- `## Contradictions Or Uncertainties`
- `## Recommended Follow-Up`
- `## Open Questions`
- `## Resources Used`
- `## Retrieval Notes`

Include provider-specific findings for both MiniMax and OpenAI; explicitly note missing or failed child runs.

### Save and attach docs

1. Consolidate one spike artifact in both locations:
   - `~/Documents/ai-usage/deployments/<deployment_id>/researcher/spike-<topic-slug>.md`
   - `~/Documents/ai-usage/agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md`
2. Attach the consolidated spike report to the source ticket before any status change:
   - `opa ticket update <ticket-id> --doc-ref "spike:agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md"`
3. Export the retrieval note and attach it as evidence:
   - `opa ticket update <ticket-id> --doc-ref "attachment:learning-management/areas/spike-research/YYYY-MM-DD-<topic-slug>.md"`
4. If a child fails, still finalize with clear partial findings.

### Learning-management export

Write one note under:
`/home/sinh/git-repos/sinh-x/tools/learning-management/areas/spike-research/YYYY-MM-DD-<topic-slug>.md`
with retrieval-focused frontmatter and all required sections.
Use `skills/templates/spike-learning-note.md` for the exact frontmatter and required structure.
Use a retrieval-oriented frontmatter, including `type: spike-research`.

Attach it as learning evidence:
`opa ticket update <ticket-id> --doc-ref "attachment:learning-management/areas/spike-research/YYYY-MM-DD-<topic-slug>.md"`

### Handoff

- Add comment first (after both doc_refs are attached), summarizing:
   - ticket ID
   - parent outcome (`success`, `partial`, or `failed`)
   - child statuses and deploy IDs
   - any child launch or completion failures
   - both child deploy IDs
   - artifact and learning paths

Then advance the source ticket:
`opa ticket update <ticket-id> --status review-uat --assignee sinh --doc-ref "spike:agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md"`

---

## Child Research Pipeline

### Phase C1: Input and Scope

1. Validate `ticket_id`, `repo_root`, and topic from context.
2. Log the provider name from active mode.

### Phase C2: Research

- Explore code and run web research where useful.
- Record findings as two buckets:
  - `External Sources`
  - `Codebase Findings`

### Phase C3: Provider Report

Create `~/Documents/ai-usage/deployments/<deployment_id>/researcher/spike-child-<provider>-<topic-slug>.md` with:
- Topic and objective
- Research summary
- Source links
- Confidence rating
- Uncertainties and recommendations

### Phase C4: Parent handoff payload

- Keep output deterministic and easy to parse (provider name, status, paths).
- Do not change parent ticket status from child mode.

---

## Quality Rules

- Read first, then write.
- Ground external findings in repository context.
- If web search fails, continue with codebase findings and state the fallback.
- Always use `opa` CLI in commands and comments.
- Before status changes, confirm required doc_ref entries were attached.
