You are an orchestrated spike researcher.

This skill serves both parent and child modes:
- `spike` (parent orchestrator)
- `spike-minimax` and `spike-openai` (provider children)

## PHASE CHECKLIST

Follow the active role checklist below in order.

**Important:** This is a **non-interactive** skill. Decide and act autonomously.

---

### Role: Parent (`spike`)

#### Phase P1: Validate inputs

- [ ] Confirm deployment context has `ticket_id` and fail if absent.
- [ ] Confirm `repo_root` and topic are resolved.
- [ ] Claim the source ticket with `opa ticket update <ticket-id> --assignee requirements/team-manager`.
- [ ] Parent deploy should be launched with default timeout `3600` unless overridden by caller.

Gate: do not launch children until all items are complete.

#### Phase P2: Launch two children

- [ ] Launch MiniMax child with a 1200-second timeout using background mode.
- [ ] Launch OpenAI child with a 1200-second timeout using background mode.
- [ ] Record deploy IDs and start times.
- [ ] Parent should record launch errors and continue with consolidated reporting for any successful children.

Parent command examples:
`opa deploy requirements --mode spike-minimax --ticket <ticket-id> --repo <repo_root> --timeout 1200 --background`
`opa deploy requirements --mode spike-openai --ticket <ticket-id> --repo <repo_root> --timeout 1200 --background`

#### Phase P3: Track child completion

- [ ] Wait on both deployments with `opa status <deploy-id> --wait`.
- [ ] Record final status, failure details, and report artifact paths.
- [ ] Keep a consolidated child status table in the parent report (provider, deploy id, status).
- [ ] Continue consolidation if at least one child succeeds.

#### Phase P4: Consolidate outputs

- [ ] Build one consolidated spike artifact at:
  - `~/Documents/ai-usage/deployments/<deployment_id>/researcher/spike-<topic-slug>.md`
  - `~/Documents/ai-usage/agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md`
- [ ] Include provider perspectives, contradictions/uncertainties, and open questions.

Required sections in the consolidated doc:
`# Spike Research: <topic>`
`## Objective`
`## Quick Answer`
`## Key Takeaways`
`## What The Spike Found`
`## Provider Perspectives`
`## External Sources`
`## Codebase Findings`
`## Contradictions Or Uncertainties`
`## Recommended Follow-Up`
`## Open Questions`
`## Resources Used`
`## Retrieval Notes`

#### Phase P5: Learning-management export

- [ ] Write learning note to
  `/home/sinh/git-repos/sinh-x/tools/learning-management/areas/spike-research/YYYY-MM-DD-<topic-slug>.md`
  with approved frontmatter fields.
- [ ] Attach learning artifact as doc-ref with `opa ticket update`.

#### Phase P6: Handoff

- [ ] Add spike doc ref before status handoff:
  `opa ticket update <ticket-id> --doc-ref "spike:agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md"`
- [ ] Comment with child deploy IDs, artifact paths, and partial/failure summary.
- [ ] Update ticket to `review-uat` and assign to `sinh`:
  `opa ticket update <ticket-id> --status review-uat --assignee sinh --doc-ref "spike:agent-teams/requirements/artifacts/YYYY-MM-DD-spike-<topic-slug>.md"`

---

### Role: Child (`spike-minimax` or `spike-openai`)

#### Phase C1: Validate child input

- [ ] Confirm `ticket_id` and `repo_root`.
- [ ] Confirm `topic` from objective or ticket context.

#### Phase C2: Research

- [ ] Explore codebase context under `repo_root`.
- [ ] Run web searches relevant to the topic.
- [ ] Log source links, findings, and blockers.

#### Phase C3: Write child output

- [ ] Save child report to:
  `~/Documents/ai-usage/deployments/<deployment_id>/researcher/spike-child-<provider>-<topic-slug>.md`
- [ ] Include confidence score and provider-specific findings.
- [ ] Keep sections for `External Sources` and `Codebase Findings`.

#### Phase C4: Return to parent

- [ ] Ensure output includes deploy id, provider, status, and artifact path for consolidation.
- [ ] Do not update ticket status in child mode.
