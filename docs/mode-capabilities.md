# Config-owned Pi document capabilities (PAP-289)

Status: source implementation candidate, **not installed, qualified or activated**.
Audience: runtime/PAPC maintainers and independent reviewers. Product authority is
PAP-289's published `pap-289-config-capabilities/r006` requirements and UAT package.
This page documents the source contract, not a replacement approval or matrix.

## Selection and compatibility

Only a fresh foreground, unpinned, non-resumed Pi `requirements/analyze` start can
select `document_profile: pa-document-policy/v1`. It requires `capability_policy`
with exactly `version: pa-mode-capabilities/v1` and `allow: [...]`. Selection is
replacement, not additive; `[]` grants no model-selectable tools. Native lifecycle
and operator commands are not model tool grants. No other role/adapter migrates.
Present invalid policies reject; retained absent-policy v1/v2/v3 routes keep their
old contracts. OPA rejects this Pi-only selection rather than ignoring it.

The launcher reads committed `teams/requirements.yaml` using
`CommittedConfigSource`, requires the loaded mode and committed selection to
agree, and rechecks source drift before native start. The immutable execution plan
and registry `started.mode_capability_binding` record config revision, raw resource
SHA-256, path, profile, policy version and canonical sorted selected IDs. The new
native start marker is `requirements-document-policy/v1`. Neither an environment
claim nor possession of serialized binding data authenticates a caller.

On every invocation, the existing document owner authenticates live registry,
canonical root, process incarnation/lineage and session. The immutable binding must
match the status projection and canonical serialization. Tool exposure and exact
execution selection use the same resolver. `tool_call` guards built-ins and nested
SDK calls; custom `execute` wrappers also guard direct calls. Aliases/namespaces do
not grant access. Config edits/reload do not replace native launch selection.
This is not hostile-same-UID isolation. Existing path, secret, workspace, native
confirmation/publication/queue, custody and cleanup checks remain authoritative.

## Closed inventory

All IDs below support only the new policy profile. The registry describes trusted
in-package implementations; it supplies **no default role selection**. Existing
TypeBox schemas and native action parsers remain request/result owners; config
cannot replace them with paths, modules, commands, headers or authority fields.

| ID | Exact tool | Action/schema and intrinsic owner |
| --- | --- | --- |
| `document.package` | `pa_document` | `document-native.ts`; package grammar, v3 confirmation owner |
| `document.workspace` | `pa_workspace` | `document-workspace.ts`; bounded workspace grammar; no network |
| `ticket.read-comment` | `pa_ticket` | `ticket-tool.ts`; read/show/list/comment and ticket owner |
| `bulletin.read` | `pa_bulletin` | list active bulletins |
| `registry.read` | `pa_registry` | show/list bounded registry data |
| `status.read` | `pa_status` | one deployment status |
| `template.draft` | `pa_template` | list/show/render/validate, unsigned selected-template owner |
| `human.question` | `question` | human question; never native protected approval |
| `session.todo` | `todo` | session-local task lifecycle |
| `context.read` | `read` | existing canonical project/artifact/config path and content guards |
| `web.public-read` | `pa_web_read` | reserved narrow public reader; unavailable until reader integration |

A configuration preserving the full baseline explicitly lists the first ten IDs.
For example (synthetic, not an instruction to edit active config):

```yaml
- id: analyze
  document_profile: pa-document-policy/v1
  capability_policy:
    version: pa-mode-capabilities/v1
    allow: [document.package, document.workspace, ticket.read-comment, bulletin.read,
            registry.read, status.read, template.draft, human.question, session.todo,
            context.read]
```

Unknown/duplicate IDs, wildcards, tool-name aliases, null/wrong/extra fields,
unsupported profiles/versions, duplicate YAML keys and merge-key inheritance reject.
The selected resource is at most 64 KiB UTF-8; policies have at most 64 unique IDs,
each at most 128 ASCII characters. The finite current registry is smaller than the
upper bound: a 64-element array of unknown IDs still rejects. New IDs require a
runtime implementation, not a config override.

## Verification and rollout boundaries

Focused source tests: `mode-capabilities.test.ts`,
`mode-capability-session.test.ts`, registry/plan/team and retained document tests.
They use disposable native registries/process evidence and synthetic tool/UI seams.
They are not an installed foreground session, human readability review or UAT.

PAPC must review this exact schema/profile, preserve the complete baseline and
provide matching selected instructions in its separately admitted repository.
The same qualified runtime must demonstrate reader-on/off in separately authorized
new starts, without a rebuild. Current sessions must stay unchanged. No active pin,
installation, public-egress activation, remote push/PR or checkout return is
performed by this source change. Independent review, hosted CI, installed tests,
human clarity/usefulness/UAT and explicit adoption remain separate obligations.

Before: the retained document hook described a fixed artifact/ticket tool route.
After: selected-route blockers distinguish malformed/unknown policy, unsupported
profile, unavailable implementation, unproven binding and omitted capability.
They use fixed, plain, bounded five-field guidance from `modeCapabilityDiagnostic`;
formatting performs no probes/effects and never echoes raw config or errors. Existing
retained messages and machine contracts are unchanged. The registry binding fields
are intentional additive machine-contract changes, not wording-only alterations.
