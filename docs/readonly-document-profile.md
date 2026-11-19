# Native read-only document profile

PAP-318 introduces an explicit **new-start** contract: `document_profile: pa-readonly-document/v1`. It is Pi/PPA-only. This document and the example below are inert authoring guidance, not selected PAPC configuration, qualification, activation, installed verification or human acceptance.

## Ownership and versions

PAPC owns public team/mode names, descriptive agent roles, selected agents, objectives, workflow meaning, prompts, resources, provider/model pairs and capability selections. Runtime owns validation, committed resource capture, canonical repository/process admission, effective role, attribution and finite operation implementations. There is no team-name allowlist for this profile. A descriptive agent `role` is prompt text, not native authority.

| Selection | Binding | Native session marker | Public identity |
| --- | --- | --- | --- |
| Historical requirements policy | `pa-mode-capability-binding/v1` | `requirements-document-policy/v1` | Fixed `requirements/analyze` |
| Historical public Analyst policy | `pa-mode-capability-binding/v2` | `requirements-document-policy/v1` | Fixed `analyst/analyze` |
| Explicit new profile | `pa-mode-capability-binding/v3` | `readonly-document-policy/v1` | Exact selected team/mode |

Historical bindings keep `pa-document-policy/v1`. Neither their shape, fixed identity, policy, serialization order nor retained-session semantics are reinterpreted as v3. Unsupported versions fail rather than falling back. A v3 binding with a historical session marker (or the reverse) fails authentication. Editing configuration cannot upgrade an existing session.

V3 derives the fixed effective team `requirements`, mode `analyze`, and audit actor `requirements/analyze` natively. Configuration cannot set any of these, a root, permission, approval or outcome. Environment/registry retain the actual public identity. Generic CLI/API ticket writers do not acquire effective-role privilege from a v3 public name, including a name spelling a historical privileged team. Only authenticated, selected finite owners receive their existing effective-role context.

## Strict configuration tree

Use `teams/<name>.yaml` in the committed selected PAPC source. A team using this contract has only `pa-readonly-document/v1` deploy modes. Unknown fields, profiles, capabilities, duplicate IDs, alias/merge object graphs, malformed types and invalid paths reject. YAML uses JSON-schema semantics. No new executable YAML grammar is introduced.

Public team, mode and agent names match `[a-z][a-z0-9_-]{0,63}`. They are not permission selectors. Existing separately owned protected/native-only launch routes are not overridden by this contract.

Supported fields:

- Team: required `name`, `agents`, `deploy_modes`; optional `description`, `objective`, `default_mode`, `global_docs`, `variables`, `context`, `model`, `timeout`, `terse_mode`.
- Agent: required `name`, `role`; optional `instruction`, `skill`, `model`.
- Mode: required `id`, `label`, `objective`, `document_profile`, `capability_policy`; optional `agents`, `skills`, `global_docs`, `project_guides`, `provider`, `model`, `phone_visible`, `mode_type`, `solo`, `timeout`, `require_ticket`.
- Skill entry: exactly `name` and `inject-as` (`global-skill`, `shared-skill`, or `reference`). Skill names resolve to `skills/global/<name>/SKILL.md`.
- Policy: exactly `version: pa-mode-capabilities/v1` and `allow: [...]`. Empty means no tools; no defaults or inheritance.
- `context`: optional `organization`, `notes`. `variables`: up to 64 uppercase template keys matching `[A-Z][A-Z0-9_]{0,63}`, with nonempty text values. These are not environment or authority overrides.
- `project_guides`: exact registered repository keys mapped to resource-path arrays. Only the selected repository's list is captured. Keys match `[a-z][a-z0-9._-]{0,127}`.

An explicitly configured provider/model pair must contain both nonempty fields. Booleans are actual booleans; timeouts are positive safe integers; `mode_type` is `housekeeping`, `work`, or `interactive`. Collections have at most 64 entries. Duplicate team-agent, mode, selected-agent and skill names reject. Selected agents must exist. Unselected agents' instruction files are not loaded. `default_mode`, when present, must exist. Without it, each launch must explicitly select a mode; a profile-only team has no unbound generic/default launch route.

Resources use relative ASCII paths with letters, digits, `_`, `.`, `/` and `-`; no empty, `.`, `..`, `.git`, absolute or escaping components. Paths are at most 1024 characters and 16 components. A mode objective is a required resource, never an inline/fallback objective. Instructions, global docs, selected project guides and skills are captured with transitive local Markdown links/images/reference definitions and supported explicit root resource locators. No network fetch or command follows a link. Unsupported/ambiguous local link encodings reject.

The native `CommittedConfigSource` compares exact physical working bytes to committed objects and rechecks revision/physical identity. Missing, dirty, changed, symlinked, multiply linked or foreign-selection resources fail. The graph is at most 128 resources; the existing source owner also bounds each file to 1 MiB and total reads to 16 MiB. Team YAML and serialized binding are each at most 64 KiB. Configuration paths do not introduce a new model-facing filesystem root.

Composition reads only the captured snapshot. All selected skill bodies, including reference-only bodies, are hash-bound in the primer; v3 supplies no mutable paths to Pi's independent skill loader. Native admission rechecks the source after asynchronous preparation and before releasing the actual foreground child.

## Finite capabilities

`READONLY_DOCUMENT_CAPABILITIES` is the fixed v1 support inventory, not a default selection:

```text
document.package       document.handoff        document.local-review
document.workspace     ticket.read-comment     ticket.intake
capability.discover    bulletin.read           registry.read
status.read            template.draft          human.question
session.todo           context.read            web.public-read
ticket.status          ordinary.bash           ordinary.read
ordinary.edit          ordinary.write
```

Unknown IDs reject. `workflow.request` and `decision.request` are not supported by this profile even though other runtime contracts provide them. Future registry additions do not automatically enter this profile. `document.local-review` requires both `document.package` and `document.handoff`. Select at most one of `context.read` and `ordinary.read`. Duplicate capability IDs reject; validated selections are sorted, frozen sets. Tools are the exact canonical union of selected implementations; aliases, reloads, delegation and direct calls cannot add omitted tools.

Existing native action schemas and effect boundaries remain authoritative. Package, handoff, ticket intake/status, workspace and public web operations keep their existing finite scope, CAS, consent, recovery, lifecycle and source checks. A profile is not builder/source/Git/resource authority. Explicit ordinary tools retain the existing local content/path checks and mutable ai-usage authoring semantics; they do not confer a repository-writer role or a new sandbox guarantee.

Report modes receive **only** their selected capabilities. No mode name implicitly enables `pa_handoff`, publication, branch completion or queueing. PAPC can select report tools without the handoff capability. Ticket intake preserves original IDs/content for replay and does not reassociate the primary ticket; the separately selected handoff intake owner retains its single-association rule. Supplied tickets retain their native ownership/lifecycle checks.

## Launch and session constraints

Only a fresh, unpinned, independent foreground process at the registered canonical primary root is supported. Managed/inherited, background, force, pinned/resume, rogue and ticket-worktree routes remain excluded. No writer or foreign/linked root becomes admissible by renaming configuration. Existing requirements, Builder, protected review, resume and OPA contracts are not replaced.

The native launch binds selected public identity, configuration root/revision, team resource digest, exact resource closure/digests, registered repository key, profile, effective identity and policy. Registry launch serialization must equal the parsed canonical binding. Session authentication checks launch/status agreement, actual environment/CWD/root agreement, exact process incarnation/lineage and deployment directory. Native owners, not model input or environment aliases, derive attribution. Existing start gates, source checks and prompt-file transport remain in charge.

## Inert PAPC example

This is **not** a file to install or activate. All referenced resources must first exist in a committed, separately qualified PAPC selection.

```yaml
name: evidence-lab
description: Config-owned document investigation.
agents:
  - name: investigator
    role: Evidence-backed diagnosis without implementation
    instruction: docs/evidence-lab/investigate.md
default_mode: diagnose
deploy_modes:
  - id: diagnose
    label: Diagnose
    agents: [investigator]
    objective: docs/evidence-lab/diagnose-objective.md
    document_profile: pa-readonly-document/v1
    capability_policy:
      version: pa-mode-capabilities/v1
      allow: [context.read, ticket.intake, capability.discover, human.question]
    require_ticket: false
    global_docs: [docs/evidence-lab/report-policy.md]
    project_guides:
      example: [docs/evidence-lab/example-guide.md]
```

PAPC can define analyst/analyze, analyst/investigate and analyst/research using the same contract. Diagnosis without implementation, sourced comparisons/recommendations and feeding analyze are PAPC prompt/output policy, not runtime branches. Analyze may explicitly select handoff facilities; investigate/research need not. Adding, editing or renaming an ordinary profile team/mode, agent, objective, resource or capability selection requires committed PAPC changes and requalification, not runtime source changes.

## Validation and evidence

Runtime owners expose `ModeCapabilityError.code`: `CAPABILITY_POLICY_INVALID` (malformed schema/tree/limits), `CAPABILITY_UNKNOWN` (unknown implementation), `CAPABILITY_PROFILE` (unsupported route/profile/operation selection), `CAPABILITY_BINDING` (unproven immutable selection), `CAPABILITY_OMITTED` (unselected operation), or `CAPABILITY_UNAVAILABLE` (implementation/environment unavailable). Path/identity checks may report `CAPABILITY_BINDING` for malformed names. The committed source owner separately exposes `SelectedConfigError.kind`: `identity`, `resource`, `drift`, or `limit`. The deployment boundary renders fixed bounded capability guidance without resource bodies; inspect typed source failures through the owning API/test seam, not new caller authority fields. There is no new CLI grammar.

Provider-free source checks:

- `packages/pa-core/src/__tests__/readonly-document-profile.test.ts`: strict schema, committed three-mode selection, exact graph/content/tools, PAPC-only add/edit/rename and dirty/alias/drift negatives.
- `packages/pi-pa/src/__tests__/readonly-document-profile.test.ts`: one production adapter, inert real foreground processes, three modes both ticketless and supplied-ticket, exact >635831-byte primer digests, bounded kernel arguments, real process anchors/tools/intake, config-only revisions/rename and pre-release source drift.
- `analyst-identity-session.test.ts`, `analyst-identity-ticket.test.ts`, `analyst-identity-origin.test.ts`: retained v2 and explicit v3 native finite handoff/status/origin/continuation checks, no generic privilege and no session-version relabeling.
- `execution-plan.test.ts`: public privileged-role spelling still yields read-only admission; noncanonical roots, aliases, unsupported runtime and excluded starts reject.

These fixtures do not activate production PAPC, use a provider/live ticket, install a package, establish hosted CI/review, or supply human UAT. Those remain separate owners and evidence layers.
