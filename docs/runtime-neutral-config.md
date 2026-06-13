# Runtime-Neutral Configuration

`pa-core` owns shared configuration parsing, state, Agent API routes, and server lifecycle behavior. Runtime adapters provide runtime-specific spawning, deploy hooks, model/provider resolution, and tool descriptions.

Team YAML files are active shared configuration and should remain structurally compatible with the frozen PA team YAMLs. Existing mode IDs and fields such as `provider` are preserved in the team files for compatibility and migration traceability.

## Runtime-Aware Configuration (runtimes block)

Team and mode YAML can carry an optional `runtimes:` block that provides per-runtime overrides for model, provider, autonomy, and timeout. Generic/shared settings (agents, skills, objective, mode_type, solo, global_docs) stay at the top level and apply to all runtimes.

```yaml
# Team-level example
name: builder
description: Build team
agents: [...]
objective: "..."
runtimes:
  droid:
    model: deepseek-v4-pro
    autonomy: high
  opencode:
    provider: ollama-cloud
    model: deepseek-v4-pro
  claude:
    model: claude-opus-4-7
```

```yaml
# Mode-level example
deploy_modes:
  - id: implement
    label: Implement
    objective: ...
    runtimes:
      droid:
        model: gpt-5.5
      opencode:
        provider: minimax
```

### Per-Adapter Precedence

Each adapter resolves model/provider/autonomy from its own runtime block, ignoring other runtimes' hints:

| Adapter | Resolution order |
|---|---|
| dpa | CLI flags > mode `runtimes.droid` > team `runtimes.droid` > `PA_DPA_DEFAULT_MODEL` > platform `defaults.droidcode` > `deepseek-v4-pro` |
| opa | CLI flags > mode `runtimes.opencode` > team `runtimes.opencode` > legacy flat fields > provider defaults |
| cpa | CLI flags > mode `runtimes.claude` > team `runtimes.claude` > legacy flat fields > `PA_CPA_DEFAULT_MODEL` > `claude-opus-4-7` |

### Back-Compat

When `runtimes:` is absent, all adapters behave identically to the pre-runtimes era (byte-for-byte unchanged for opa and cpa; dpa defaults to `deepseek-v4-pro` instead of the legacy provider-to-premium map).

Runtime selection is handled by the adapter CLI:

- `cpa` (`@pa-platform/claudecode-pa`) interprets shared team config for Claude Code execution. Implemented; default model `claude-opus-4-7`; `--provider` accepts only `anthropic`. See `docs/cpa-claude-code-adapter.md` for the operator overview.
- `opa` (`@pa-platform/opencode-pa`) is the OpenCode adapter and interprets shared team config for opencode execution. Default provider is `ollama-cloud` with default model `ollama-cloud/deepseek-v4-pro`. Supported providers: `minimax`, `openai`, `deepseek`, `ollama-cloud`, `opencode-go`.
- Adapter config decides how provider/model hints are mapped, overridden, or ignored for that runtime.

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
