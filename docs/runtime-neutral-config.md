# Runtime-Neutral Configuration

`pa-core` owns shared configuration parsing, state, Agent API routes, and server lifecycle behavior. Runtime adapters provide runtime-specific spawning, deploy hooks, model/provider resolution, and tool descriptions.

Team YAML files are active shared configuration and should remain structurally compatible with the frozen PA team YAMLs. Existing mode IDs and fields such as `provider` are preserved in the team files for compatibility and migration traceability.

Runtime selection is handled by the adapter CLI:

- `cpa` (`@pa-platform/claudecode-pa`) interprets shared team config for Claude Code execution. Implemented; default model `claude-opus-4-7`; `--provider` accepts only `anthropic`. See `docs/cpa-claude-code-adapter.md` for the operator overview.
- `opa` (`@pa-platform/opencode-pa`) is the OpenCode adapter and interprets shared team config for opencode execution. Default provider is `deepseek` with default model `deepseek/deepseek-v4-pro`. Supported providers: `minimax`, `openai`, `deepseek`.
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
