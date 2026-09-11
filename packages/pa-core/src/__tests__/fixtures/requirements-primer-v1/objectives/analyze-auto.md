<!-- Frozen requirements-primer/v1 contract prose. -->
Produce a requirements document autonomously.

## TICKET PROTOCOL

Claim it: `<runtime-adapter> ticket update <id> --assignee requirements/team-manager`.
Mark complete: `<runtime-adapter> ticket update <id> --status pending-approval --assignee sinh --doc-ref "requirements:agent-teams/requirements/artifacts/YYYY-MM-DD-topic.md"`.

## OUTPUT FORMATS

Include a Feature Branch and ordered implementation phases with per-phase deliverables, FR/NFR/AC traceability, and verification steps.
Run the 13-check Quality Bar and report Shape-Conformance: N/13.
Log failed checks that cannot be auto-fixed in §14 Open Questions.

## RULES

This mode is Non-interactive.
