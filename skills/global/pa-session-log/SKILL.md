---
name: pa-session-log
description: >
  Session logging standard for all PA agents. Covers workspace tiers, artifact
  finalization, the session log template (with self-rated session rating), session
  continuity, registry integration, consistency rules, and tags taxonomy.
pa-tier: 2
pa-inject-as: shared-skill
---

# Session Logging

Every agent (including team manager and sub-agents) MUST log their session.

## Workspace Storage Tiers

| Tier | Path | Lifetime | Purpose |
|------|------|----------|---------|
| **Ephemeral workspace** | ~/Documents/ai-usage/deployments/<deploy-id>/ | Per-run | Scratch space, drafts |
| **Persistent artifacts** | ~/Documents/ai-usage/agent-teams/<team_name>/artifacts/ | Survives deployments | Final deliverables |
| **Historical logs** | ~/Documents/ai-usage/sessions/YYYY/MM/agent-team/ | Permanent | Session logs |

**Key rule — save then attach:** Save deliverables to `agent-teams/<team_name>/artifacts/` FIRST,
then attach via `pa ticket update <id> --doc-ref`. Never use `deployments/` paths in `--doc-ref`.

## Artifact Finalization (REQUIRED before status handoff)

Before advancing a ticket to `pending-approval` or `review-uat`, complete these steps in order:

1. Save deliverable to `~/Documents/ai-usage/agent-teams/<team_name>/artifacts/YYYY-MM-DD-<name>.md`
2. Add doc_ref: `pa ticket update <id> --doc-ref "[type]:agent-teams/<team_name>/artifacts/YYYY-MM-DD-<name>.md"`
3. Advance ticket (only after steps 1 and 2)

**Why this order matters:** Advancing first and saving later risks leaving the ticket pointing to nothing if the session is interrupted. Always: save → attach → advance.

> If you forgot: run `pa ticket update <id> --doc-ref [type:]<path>` retroactively. The CLI warns and adds the `needs-doc-ref` tag automatically if this step is skipped.

## Session Log Location

Save to: `~/Documents/ai-usage/sessions/YYYY/MM/agent-team/`

Agent sessions go in the `agent-team/` subfolder. Never write to the month root.

## File Naming

`YYYY-MM-DD-<deployment_id>-<team_name>--<agent_name>--<TICKET-ID>--<topic>.md`

Include ticket ID when working on a ticket. Omit for non-ticket sessions.

## Session Log Template

**Identity fields:** Pull `deployment_id`, `team_name`, `agent_name`, and `ticket_id` from the `<deployment-context>` block in your deployment primer. These are the authoritative source — do not guess or fabricate identity values.

**Session ID for non-ticket sessions:** Use `deployment_id` (e.g., `d-cd730a`) as the Session ID. The deployment ID IS the session identifier — it is unique, verifiable, and already injected as `$PA_DEPLOYMENT_ID`. Do not generate a separate 6-char hash.

```markdown
# AI Session Log

> Session ID: <deployment_id>
> Date: YYYY-MM-DD HH:MM
> Deployment: <deployment_id>
> Agent: <agent_name>
> Team: <team_name>
> Mode: autonomous
> Rating Source: agent
> Parent: <parent agent name>
> Role: <role description>
> Ticket: <ticket_id or "none">

## Timeline
- HH:MM — Started: <objective>
- HH:MM — <milestone>
- HH:MM — Completed / Failed

## What Happened
<2-5 bullet points>

## Results
- **Status:** Success / Partial / Failed
- **Workspace:** ~/Documents/ai-usage/deployments/<deployment_id>/<agent_name>/
- **Outputs:** <files created or modified — include paths; for skill updates, include the skill file path>
- **Errors:** <errors or "None">

## What I Learned
- <insight>

## Session Rating

> Rating Source: agent
> Score each dimension using the **KPI Rating Guidelines** section below.

| Dimension    | Score | Self-Evaluation Basis                    |
| ------------ | ----- | ---------------------------------------- |
| Productivity | N/5   | Tasks completed vs. planned scope        |
| Quality      | N/5   | Verification results, errors encountered |
| Efficiency   | N/5   | Iterations needed, retries, rework       |
| Insight      | N/5   | New patterns or edge cases encountered   |

**Overall: N/5**

## Work Quality Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| First-pass result | pass / fail / N/A | Did work pass review without being sent back? |
| Rework cycles | 0 | Times ticket bounced back (review-uat → implementing) |
| Downstream clarifications | 0 | Clarification requests from consumers of this output |
| Revision tags | none | Any `rework` or `revision` tags on the ticket |
| Post-delivery follow-ups | 0 | New tickets/work spawned after this ticket was closed |
| Scope creep source | N/A | `new-requirement` / `under-specified` / `none` |

> **N/A** is valid for: first delivery (no review yet), non-ticket work, or housekeeping tasks.
> For **skill-update sessions**, first-pass result is `pass` if the skill was updated and working correctly. Rework cycles apply if the skill required fixes after initial write.
> Update this section on subsequent deployments when review feedback arrives.
>
> **Scope creep source** — when follow-up work is needed, classify why:
> - `new-requirement` — genuinely new need that wasn't foreseeable at requirements time
> - `under-specified` — the original requirements missed this; should have been caught earlier
> - `none` — no follow-up work needed

## Self-Improvement
### What could be improved?
- <something in the skill, workflow, or tools that was inefficient, unclear, or broken>

### Why?
- <root cause — why did this happen? what is the gap?>

### How to fix it?
- <concrete, actionable suggestion — e.g., "add retry logic to file-upload step", "split Phase 3 into two steps">

### Scope
- `skill` / `team` / `infra` / `prompt`

## Follow-up Tasks
- [ ] <if any>

## Tags
`autonomous` `team:<team_name>` `agent:<agent_name>` `deployment:<deployment_id>` `<domain-tags>`
```

## KPI Rating Guidelines

These are the authoritative scoring anchors for the Session Rating. All agents MUST use these when self-evaluating. Rate honestly and evidence-based — never inflate scores. Scores feed into daily quality reports and trend analysis.

### Productivity — Tasks completed vs. planned scope

| Score | Anchor | Example |
|-------|--------|---------|
| 5 | All planned tasks completed + bonus work delivered | Finished all 3 phases and proactively fixed a related bug |
| 4 | All planned tasks completed | Completed the full objective as specified |
| 3 | Core tasks done, some deferred | Finished phases 1-2 but deferred phase 3 |
| 2 | Significant tasks incomplete | Only completed 1 of 3 planned phases |
| 1 | Objective not achieved | Could not produce the expected deliverable |

### Quality — Correctness, completeness, and verification

| Score | Anchor | Example |
|-------|--------|---------|
| 5 | Zero errors, all verifications pass, exceeds spec | Tests pass, type checks clean, output reviewed and polished |
| 4 | Minor issues only, all key verifications pass | One small formatting issue, but all tests and checks pass |
| 3 | Core deliverable correct, some gaps | Main output works but missing edge case handling |
| 2 | Notable errors or missing verifications | Deliverable has bugs or was not verified before handoff |
| 1 | Major errors, deliverable unusable | Output fundamentally broken or wrong approach taken |

### Efficiency — Iterations, retries, and rework needed

| Score | Anchor | Example |
|-------|--------|---------|
| 5 | First-pass success, no rework | Straight-through execution, no retries or backtracking |
| 4 | Minor iteration on 1-2 items | One small fix after initial attempt, otherwise smooth |
| 3 | Some rework needed, 1 retry cycle | Had to redo a phase or retry a failed approach once |
| 2 | Significant rework, multiple retries | Multiple failed attempts before finding the right approach |
| 1 | Extensive rework, wasted effort | Most time spent on dead ends or repeated failures |

### Insight — New patterns, edge cases, or learnings discovered

| Score | Anchor | Example |
|-------|--------|---------|
| 5 | Novel discovery that improves the system | Found a cross-cutting pattern that should change a skill/workflow |
| 4 | Useful finding documented for future use | Identified an edge case and documented it in Self-Improvement |
| 3 | Standard observations, nothing new | Routine work, no surprises or novel findings |
| 2 | Missed obvious patterns | Failed to notice a relevant pattern that was visible in the data |
| 1 | No reflection or awareness | No Self-Improvement section or purely generic observations |

### Work Quality Modifiers

The **Work Quality Metrics** table captures objective signals that MUST influence your scores. Apply these rules when self-rating:

| Metric | Impact on scores |
|--------|-----------------|
| **First-pass fail** (work sent back for revision) | Cap **Quality** at 3; cap **Efficiency** at 3 |
| **1 rework cycle** | Reduce **Quality** by 1; reduce **Efficiency** by 1 |
| **2+ rework cycles** | Cap **Quality** at 2; cap **Efficiency** at 2 |
| **Downstream clarifications (1-2)** | Reduce **Quality** by 1 |
| **Downstream clarifications (3+)** | Cap **Quality** at 2 |
| **Rework/revision tags on ticket** | Cap **Overall** at 3 regardless of dimension scores |
| **Post-delivery follow-ups (1-2, `new-requirement`)** | No score impact — genuinely new needs are not a quality failure |
| **Post-delivery follow-ups (1-2, `under-specified`)** | Reduce **Quality** by 1 on the *originating* session |
| **Post-delivery follow-ups (3+, `under-specified`)** | Cap **Quality** at 2 on the *originating* session |

These are caps and reductions, not automatic scores. Start with your honest self-assessment, then apply the modifiers. If your work hasn't been reviewed yet (first delivery), use N/A and rate based on your own verification.

**Retroactive updates:** When follow-up work reveals scope creep, update the Work Quality Metrics on the *original* session log (use `[UPDATED]` marker). This ensures the originating session's score reflects real-world outcomes, not just initial self-assessment.

### Overall Score

Compute as the **rounded average** of the 4 dimensions, then apply any Work Quality caps. If one dimension is dramatically lower (2+ points below the others), note it explicitly — the overall score should reflect the weakest link, not hide it.

### KPI Threshold Tags

| Overall Score | Tag | Meaning |
|---------------|-----|---------|
| >= 4 | `kpi:strong` | Exceeds standards |
| 3 | `kpi:adequate` | Meets core standards |
| <= 2 | `kpi:warn` | Below standards — review recommended |

Add the appropriate KPI tag to both the session log `## Tags` section and the registry entry.

## How to Save

```bash
mkdir -p ~/Documents/ai-usage/sessions/$(date +%Y)/$(date +%m)/agent-team
# Filename uses deployment_id instead of random hash
# With ticket ID (preferred when working on a ticket):
filename="$(date +%Y-%m-%d)-${PA_DEPLOYMENT_ID}-<team_name>--<agent_name>--<TICKET-ID>--<topic>.md"
# Without ticket ID (non-ticket-driven work):
filename="$(date +%Y-%m-%d)-${PA_DEPLOYMENT_ID}-<team_name>--<agent_name>--<2-word-topic>.md"
```

## When to Log

| Role | When |
|------|------|
| Sub-agent | Before returning results to parent |
| Agent | After all tasks done, before shutdown |
| Team manager | After all agents done + completion marker |

## Post-Completion Updates

If you complete a ticket (write completion marker + advance to `review-uat`) but then do **additional work after the marker was written** (e.g., extra debugging, follow-up fixes, user clarifications):

1. **Update the session log** — add `[UPDATED]` marker and describe what was done:
   ```markdown
   ## What Happened
   - [UPDATED] Follow-up work after completion marker: <description>

   ## Results
   - **Status:** Success (updated)
   ```

2. **Record the update** — run `pa registry update <deploy-id> --status <success|partial|failed> --summary "<updated summary>" [--note "<annotation>"]` to append an `updated` event that reflects the final status. (Legacy alias `pa registry amend` still works but is deprecated; removal ~2026-07-22.)

This ensures the session log and registry accurately reflect all work done, not just the initial scope.

When a ticket spans multiple deployments (e.g., multi-phase work), update the existing session log rather than creating a new one.

Mark new content with `[NEW]` so aggregators and Sinh can quickly spot what changed:

```markdown
## What I Learned
- [x] Prior insight (from previous deployment)
- [x] **[NEW]** New pattern discovered in phase 2
```

### Timeline Timestamps

**MUST come from verifiable sources.** Use in this priority order:

1. `pa status $PA_DEPLOYMENT_ID --activity` — agent activity timeline for the current deployment
2. Raw activity file: `~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/activity.jsonl` (if available)
3. Tool call timestamps from your own execution trace
4. Explicit clock checks via `date`

**NEVER fabricate or guess timestamps.** If no source is available, use relative ordering (`Step 1`, `Step 2`) instead of clock times.

> `PA_DEPLOYMENT_ID` is injected as an environment variable by the deploy system. Use it directly rather than hardcoding the deployment ID.

## Ticket-Centric Output Flow

When completing work on a ticket, output goes in TWO places:

**1. Brief completion comment on the ticket (REQUIRED):**

```bash
pa ticket comment <ticket-id> --author <agent_name> --content "Completed: <1-2 sentence summary>. Session log: sessions/YYYY/MM/agent-team/<session-log-filename.md>"
```

Sprint-master reads these comments for daily digest aggregation.

**2. Full session log file (REQUIRED):**

Save to `sessions/YYYY/MM/agent-team/` with ticket ID in filename.

## Delivering Key Deliverables

For work that produces a **deliverable** with lasting value (requirements doc, migration plan, analysis report) — not just a routine completion:

**Step 1 — Save deliverable to team artifacts:**

```bash
cp ~/Documents/ai-usage/deployments/<deploy_id>/<agent_name>/<output>.md \
   ~/Documents/ai-usage/agent-teams/<team_name>/artifacts/YYYY-MM-DD-<descriptive-name>.md
```

**Step 2 — Create a review-request ticket:**

```bash
pa ticket create \
  --title "Review: <descriptive-topic>" \
  --type review-request \
  --assignee <downstream-team-if-approved> \
  --priority high \
  --estimate M \
  --doc-ref "[type]:agent-teams/<team_name>/artifacts/YYYY-MM-DD-<descriptive-name>.md" \
  --summary "<what was built; what Sinh needs to review; what happens if approved>"
```

Use this flow for: requirements docs, implementation plans, analysis reports, any output needing human review.
Do NOT use for: routine session completions — add a ticket comment instead (see Ticket-Centric Output Flow above).

**Do NOT write standalone work-report files to `sinh-inputs/inbox/`.** That protocol is deprecated. All reporting happens through ticket comments and linked artifacts.

## On Failure

Still log. Document what failed, what error occurred, and what was attempted. Self-rate accordingly (usually 1–2 overall).

## Registry Integration

When writing the completion registry entry, include the session rating so `pa status <deploy-id>` can surface it:

```bash
pa registry complete $PA_DEPLOYMENT_ID \
  --status success \
  --summary "<1-sentence summary>" \
  --log-file ~/Documents/ai-usage/sessions/YYYY/MM/agent-team/<filename>.md \
  --rating-source agent \
  --rating-overall N \
  --rating-productivity N \
  --rating-quality N \
  --rating-efficiency N \
  --rating-insight N
```

Use `status: "failed"` and lower scores on failure. The `rating.source` field is always `"agent"` for autonomous sessions.

## Consistency Rules

### MUST (violation = broken log)

- Title is always `# AI Session Log`
- Header: one field per line in blockquote, no bold on field names, 24h datetime combined in one `Date:` field
- Header MUST include `Mode: autonomous` and `Rating Source: agent`
- Session ID: actual 6-char hash, never a placeholder
- `## Session Rating` and `## Work Quality Metrics` sections are REQUIRED in every log
- **Timestamps in Timeline MUST come from verifiable sources** — activity log via `pa status $PA_DEPLOYMENT_ID --activity`, raw `activity.jsonl`, or `date`. NEVER fabricate.
- Registry entry MUST include `rating` object on completion

### SHOULD (strong recommendation)

- Use `[NEW]` markers when updating a log across multiple deployments
- Self-rate honestly using the **KPI Rating Guidelines** anchors — scores inform aggregated daily quality reports
- Include `kpi:<level>` and `rating:<N>` tags in both session log and registry entry
- Include 2-word topic in filename for human scanability

### MAY (agent discretion)

- Add sub-sections inside `## What Happened` for complex work
- Skip `## Follow-up Tasks` if there are none (omit section entirely)

## Tags Taxonomy

Standard tags for session logs and registry entries:

| Category | Examples |
|----------|---------|
| **Mode** | `autonomous` `interactive` |
| **Team** | `team:builder` `team:maintenance` `team:requirements` |
| **Agent** | `agent:team-manager` `agent:mechanic` `agent:researcher` |
| **Deployment** | `deployment:<deploy-id>` |
| **Domain** | `skill-update` `ticket-work` `housekeeping` `health-check` `codebase` |
| **Outcome** | `success` `partial` `failed` `blocked` |
| **KPI** | `kpi:strong` `kpi:adequate` `kpi:warn` `rating:N` |
| **Skill** | `skill:handnote-combiner` `skill:pa-ticket-workflow` (when updating a specific skill) |

Always include: `autonomous`, `team:<name>`, `agent:<name>`, `deployment:<id>`.
Add domain, outcome, and KPI tags as relevant. The `rating:N` tag uses the overall score (e.g., `rating:4`).
