# Requirements document capabilities (PAP-283)

Status: runtime implementation in progress; not installed qualification or human acceptance. PAPC process/composition is a separate dependent phase. Existing `pa-review-bundle/v1` and pinned workflow decisions retain their original owners and semantics.

## P1 contract and session boundary

`pa-document-package/v1` identifies an exact ordered member inventory, canonical repository, ticket, immutable package/revision, predecessor and finite publish/optional queue effects. It requires one brief, requirements and UAT; additional named specifications may be Markdown, plain text or opaque PNG/JPEG with a description. Informative references are labelled metadata, never fetched or treated as approved specifications. Members are all approval-relevant and required. No branch, command catalogue, workflow step, source-writing or execution permission exists in this subject.

Limits: 64 members, 1 MiB per textual member, 8 MiB per image, 16 MiB total, 64 KiB reconstructed metadata and raw request. Sources are confined to `agent-teams/requirements/artifacts/{drafts,reviews}/` under the native artifact root. Publication destinations are derived under `agent-teams/requirements/artifacts/packages/<ticket>/<packageId>/rNNN/`; public input cannot choose them.

The Pi launcher selects `requirements-document-capabilities/v1` only for fresh, unpinned foreground requirements/analyze launches without inherited builder admission or selection-only worktree intent. An immutable started event records this selection. Authentication independently rechecks running registry identity, canonical root, process incarnation/lineage, foreground session and absence of builder/resource custody. An environment variable or model statement cannot select the route. Retained launches remain pinned. Capability selection does not establish installed runtime/config qualification or rewrite PAPC instructions.

## Compatibility and error inventory

Document operations use local `DOCUMENT_INPUT`, `DOCUMENT_SOURCE`, `DOCUMENT_STALE`, `DOCUMENT_AUTHORITY`, `DOCUMENT_CONFLICT`, `DOCUMENT_UNCERTAIN`, `DOCUMENT_UNAVAILABLE` failures. These do not project a session-wide stop. Unsafe protected effects remain blocked; independent discussion/read/drafting is not settled or approved by any tool result.

Legacy workflow parsers, approvals and publication are not imported as document decisions. New protected effects must check retained controlling state and resource custody through existing owners. No migration, history rewrite, allocation, resource return, builder launch, install, push or merge is part of this route.
