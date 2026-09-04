# Runtime-Neutral Configuration

`pa-core` owns shared configuration parsing, state, Agent API routes, and server lifecycle behavior. Runtime adapters provide runtime-specific spawning, deploy hooks, model/provider resolution, and tool descriptions.

Team YAML files are active shared configuration and should remain structurally compatible with the frozen PA team YAMLs. Existing mode IDs and fields such as `provider` are preserved in the team files for compatibility and migration traceability.

## Registered Repository and Branch Contract

Every deployment resolves a repository key or exact configured path to one
immutable execution plan before primer generation or runtime spawn. When
`--repo` is omitted, PA may infer identity from the registered checkout or a
nested directory within it. Runtime CWD, `PA_REPO`, primer evidence, memory
roots, and registry evidence all use the exact configured root. Explicit
non-registered paths, aliases, independent clones, and linked Git working trees
fail before runtime spawn with a bounded corrective diagnostic.

Repository admission has no per-mode access class, PA lock, repository sandbox,
checkout ownership, or runtime write-protection wrapper. Multiple deployments
may be admitted for the same registered root, and PA does not serialize them or restore Git state at
terminal handling. Agents and operators remain responsible for respecting mode
mutation boundaries and coordinating concurrent edits.

Before implementation edits, determine the exact ticket branch and apply this
branch gate:

| Registered checkout state | Outcome |
|---|---|
| Already on the exact ticket branch | Proceed. |
| Clean `develop`, equal to `origin/develop`, exact ticket branch absent | Create the exact ticket branch from `develop`, then proceed. |
| Clean `develop`, equal to `origin/develop`, exact ticket branch present | Check out the exact ticket branch, then proceed. |
| Dirty `develop` | Stop unchanged. |
| `develop` ahead, behind, or diverged from `origin/develop` | Stop unchanged. |
| Release branch or unrelated branch | Stop unchanged. |
| Detached HEAD | Stop unchanged. |

The create and check-out outcomes are the only branch mutations authorized by
this gate. Every stop occurs before project-file mutation or runtime spawn; do
not stash, reset, repair, relocate, or select another checkout. The gate does
not remove the race between independently admitted deployments.

The primer contains exactly one authoritative `## Additional Instructions`
section. CLI/evaluator overrides appear there; the configured team or mode
objective remains under `## Objective`. Mode-level project guides use a
`project_guides` map keyed by canonical repository key:

```yaml
deploy_modes:
  - id: implement
    project_guides:
      pa-platform:
        - docs/pa-platform-agent-guide.md
```

## Flat Runtime Configuration

Active team YAML has one runtime-neutral schema: each `deploy_modes[]` entry may
set flat `provider` and `model` fields. The fields must be supplied together or
omitted together. Team-level and mode-level runtime maps are removed and are
rejected with the offending YAML path; they must not be added to active config.

```yaml
name: builder
description: Build team
objective: "..."
deploy_modes:
  - id: implement
    label: Implement
    provider: openai
    model: openai/gpt-5.6-sol
```

An intentionally provider/model-absent mode delegates both values to the
selected adapter's documented default. A provider-only or model-only mode is
invalid and fails before spawn. `ppa deploy builder --validate` parses every
mode and reports the configured/default pair counts.

### Resolution precedence and adapter boundaries

The shared resolver combines explicit CLI values with the selected flat mode
pair: `--provider` and `--model` (with deprecated `--team-model` as the model
alias) take precedence over `deploy_modes[].provider` and
`deploy_modes[].model`, then the selected adapter supplies its default for an
absent pair. A single CLI field may combine with the other field from the mode
or adapter default. The adapter then validates/maps the pair and returns one
immutable effective result used for command arguments, environment, activity,
dry-run output, and registry metadata.

| Adapter | Default and mapping boundary |
|---|---|
| ppa | Defaults to `openai` / `openai/gpt-5.6-sol`, normalized for Pi as `openai-codex` / `gpt-5.6-sol`; incompatible pairs warn and fall back. |
| opa | Defaults to `ollama-cloud` / `ollama-cloud/deepseek-v4-pro`; provider-specific model mapping remains in the OpenCode adapter. |
| cpa | Defaults to `anthropic` / `claude-opus-4-7`; non-Anthropic pairs warn and fall back to the Claude default. |
| dpa | Defaults to `deepseek-v4-pro`; Droid receives its flat model identifier and adapter-specific provider handling. |

`--agent-model` is rejected because per-agent overrides belong to PAP-148.
`--team-model` remains a warning-emitting compatibility alias for `--model`
until PAP-147 removes it. Warnings identify incompatible pairs and the
command-facing fallback, and pass the existing diagnostic redaction checks.

Runtime selection is handled by the adapter CLI (`opa`, `cpa`, `dpa`, or
`ppa`). Adapter defaults do not cross-inherit: an absent pair under `ppa` uses
OpenAI Sol, not a Pi-local model or another adapter's default. Use
`pa-core serve` for the Agent API server lifecycle; adapters provide deployment
execution hooks only.

Team YAML and mode objective files should not require Claude Code, OpenCode,
Droid, or Pi-specific tools directly. Runtime-specific tool guidance is
injected by `pa-core` primer generation from the active adapter's metadata.

Mode objective files under the operator config repo's `teams/<team>/modes/*.md`
are active configuration. `pa-core` reads them during primer generation and
applies template variables such as `{{TODAY}}`, `{{DEPLOY_ID}}`, and
`{{TEAM_NAME}}`.

Examples belong under `docs/examples/`, not under active config directories.

Use `pa-core serve` for the Agent API server lifecycle. Adapters provide deployment execution hooks; they should not own the server lifecycle.

Team YAML and mode objective files should not require Claude Code or opencode-specific tools directly. Runtime-specific tool guidance is injected by `pa-core` primer generation from the active adapter's runtime metadata.

Mode objective files under the operator config repo's `teams/<team>/modes/*.md` are active configuration. `pa-core` reads them during primer generation and applies template variables such as `{{TODAY}}`, `{{DEPLOY_ID}}`, and `{{TEAM_NAME}}`.

Examples belong under `docs/examples/`, not under active config directories.

## Operator Config Directory

Normal operator deployments should use `config_dir` from `~/.config/sinh-x/pa-platform/config.yaml` as the PA configuration base:

```yaml
config_dir: ~/git-repos/sinh-x/tools/pa-platform-config
```

With `config_dir` set, PA resolves active configuration from that base by default:

- Team YAML: `<config_dir>/teams/*.yaml`
- Team objectives, agent instructions, and managed global docs referenced as `teams/...`, `skills/...`, or `docs/...`: `<config_dir>/<reference>`
- Shared injected skills: `<config_dir>/skills/global/<skill-name>/SKILL.md`

`PA_PLATFORM_HOME`, `PA_PLATFORM_TEAMS`, and `PA_PLATFORM_SKILLS` remain supported as explicit test or development overrides. Prefer `config_dir` for normal operator use so `opa teams`, `opa deploy`, deploy routing, and validation see the same file tree.

Manual migration for Sinh/operator setups:

1. Create the external config base, for example `~/git-repos/sinh-x/tools/pa-platform-config`.
2. Copy or update active config in that base: `teams/`, `skills/`, and any managed `docs/` references you rely on.
3. Set `config_dir` in `~/.config/sinh-x/pa-platform/config.yaml` to the external base.
4. Run `opa teams` to confirm team discovery reads the external `teams/` directory.
5. Run `opa deploy builder --validate` to catch missing objectives, instructions, global docs, or shared skills. Validation reports the reference, context, attempted resolved path, and team config path.
6. Run a dry-run such as `opa deploy requirements --mode analyze --dry-run` and inspect the generated primer if you need to confirm injected skills and instructions came from the external base.

The pa-platform source repository no longer stores active `teams/` or `skills/` directories. Keep operator configuration changes in the external config repo, and keep source-code changes in pa-platform.

## Automatic Evaluator Launch Gate

Automatic post-registry evaluator launch instructions in generated primers are gated by `evaluation.auto_launch_enabled`.

Default behavior (disabled):

- If `evaluation.auto_launch_enabled` is missing or `false`, generated primers for non-evaluator teams omit automatic evaluator launch instructions.
- Disabled mode produces zero automatic evaluator deployments and zero evaluator-launch failure events caused by this gate.

Enabled example:

```yaml
evaluation:
  auto_launch_enabled: true
```

When enabled, non-evaluator team primers include post-registry instructions to run background evaluation, and runtime auto-launch paths remain limited to at most one evaluator launch per deployment completion path.

## Orchestration Sub-Deploy Launch Convention (FR-8)

When an orchestrator spawns builder/implement sub-deploys, the launch template SHOULD default to `--background` and SHOULD omit `--provider` (let the team/mode YAML resolve the provider). This keeps sub-deploys detached, non-interactive, and provider-agnostic so the operator's team config is the single source of truth for provider/model.

Canonical template:

```bash
opa deploy builder --mode implement --background --ticket <id> --objective-file <path>
```

Notes:

- `--background` is the default for orchestrated sub-deploys so the child deployment writes its session id and activity log without blocking the orchestrator's foreground loop.
- Omit `--provider` unless the orchestrator needs to override the flat team-mode `provider` for a specific run. Provider overrides are rare and should be intentional.
- `--ticket <id>` links the sub-deploy to its work item for traceability.
- `--objective-file <path>` supplies the phase objective; the orchestrator writes this file before launching the sub-deploy and the implement agent reads it as the `## User Objective` block of its primer.
- This is a documentation-level convention. Enforcing it inside the orchestrator mode-instruction content is tracked as a separate follow-up (see PAP-110 / OQ-3).

## Project Agent Guide Injection & Primer Signals

`pa-core` primer generation applies three de-noising behaviors to keep primers signal-first and consistent across runtimes. All are implemented in `packages/pa-core/src/primer/index.ts`.

### Placeholder-Template Skip

`global_docs` and selected `project_guides` that are placeholder-only templates are skipped instead of injected, so a primer never carries an unfilled `<project-name>`/`<Convention Title>` guide. When a guide is skipped, the primer lists it as `- <path> (skipped: placeholder-only template)` rather than injecting its body.

A `global_docs` file is treated as a placeholder-only template when **all** of the following hold:

1. It does not contain the force-include comment `<!-- pa: keep-content -->` (this always wins — see below).
2. It contains at least 3 angle-bracket tokens matching `<[A-Za-z]...>` (e.g. `<Convention Title>`).
3. Any one of: it self-identifies as a template (a `# Template:` heading or a `> **Template:**` blockquote — the colon is required, so a prose title like `# Template Engine Conventions` does NOT self-identify); OR it has no Markdown headings; OR every heading contains a placeholder token.

Author controls (place either comment anywhere in the guide body):

| Comment | Effect |
|---|---|
| `<!-- pa: keep-content -->` | Force-include — always inject the full body, even if it looks like a placeholder template. |
| `<!-- pa: skip-placeholder-template -->` | Force-skip — always treat the file as a placeholder template and skip it. |

Known limitation (accepted): the token match also matches legitimate generic/HTML angle syntax (`Array<string>`, `<div>`). A heading-less prose doc containing 3+ such tokens can therefore be falsely classified as a placeholder and skipped. Real project guides almost always carry filled headings, so this is a narrow edge; if a genuine heading-less guide is affected, add `<!-- pa: keep-content -->` to force injection.

### Memory-Doc Pointer Mode

Runtimes that load repo memory docs natively (`opencode`, `claude`) receive **path pointers** instead of full re-injected bodies:

```
<memory-doc path="...">
[pointer: loaded natively by <runtime> — see file at this path]
</memory-doc>
```

`droid` retains full memory-doc injection pending confirmation of native memory-doc loading (PAP-110 / OQ-1). This keeps large `CLAUDE.md`/`AGENTS.md` tails out of opencode/claude primers while preserving discoverability.

### Primer Size Signal

Every generated primer ends with a machine-readable size line:

```
<!--pa:primer-size lines=<n> chars=<n> mode=<id> budget=<n> over=<true|false>-->
```

- `lines` / `chars` — the primer's real line and character counts (including the size line itself).
- `mode` — the deploy mode id (or `default`).
- `budget` — the per-mode line budget; `over=true` when `lines > budget`.
- The signal is warning-only — it never blocks or truncates a deployment.

Per-mode line budgets (`PRIMER_LINE_BUDGET`):

| Mode | Budget (lines) |
|---|---|
| orchestrator, analyze | 1200 |
| review, review-auto | 1000 |
| implement | 800 |
| default (unlisted modes) | 1200 |
