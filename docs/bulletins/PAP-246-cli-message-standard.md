# Repository Announcement: Explain CLI Outcomes and Next Steps

> Repository: pa-platform · Ticket: PAP-246
> Informational repository document only — not an active PA bulletin or deployment block.

## Audience and action

Agents and maintainers designing, changing or reviewing human-facing PPA/OPA messages in this repository should follow the [CLI message standard](../cli-message-standard.md). [Repository-agent instructions](../../CLAUDE.md) now point to it.

For future independently authorized message changes, read the standard's agent procedure and use its applicable review checklist. Provide before/after examples and focused evidence for the affected message categories. No immediate action is needed for untouched messages.

## What the standard covers

Messages should explain what happened, the consequence for the user's task, and what to do next—or that no action is needed. The scope includes success, progress, information/help, warnings and failures, not just deployment blockers.

The standard owns the detailed rules for bounded blocker explanations, real causes, next actors, action impact/approval prerequisites and safe retry conditions. Advice is not permission or recovery execution. Existing machine-readable output, exit/status/stream behavior, authority gates and private-output/audit policy remain separate contracts.

This announcement does not expand the standard. It is **not a bulk rewrite, CLI/API feature implementation, builder handoff, infrastructure repair or instruction to acquire/return a checkout**. Changes outside the documentation rollout require their own scope and authority.

## Publication status and limits

This announcement is committed with the repository documentation. It is not registered in the live PA bulletin store, does not block teams, and makes no claim of automatic primer delivery. Repository-local instructions are adopted in CLAUDE.md; external managed `project_guides` selection is unchanged.

The inspected bulletin CLI supports team-blocking notices (`--block` is required), with no repository-scope or explicit informational/nonblocking option. The bulletin model has no repository/audience field. Do not fabricate a field, use a fake team, or publish a global blocker to simulate this announcement. Any later live distribution must use an owner-supported repository-only, nonblocking channel and record its actual receipt separately; this document is not that receipt.

See the [rollout record](../PAP-246-documentation-rollout.md) for source provenance, commits, checks and remaining boundaries.
