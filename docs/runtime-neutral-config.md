# Runtime-Neutral Configuration

`pa-core` owns shared configuration parsing, state, Agent API routes, and server lifecycle behavior. Runtime adapters provide runtime-specific spawning, deploy hooks, model/provider resolution, and tool descriptions.

Team YAML files are active shared configuration and should remain structurally compatible with the frozen PA team YAMLs. Existing mode IDs and fields such as `provider` are preserved in the team files for compatibility and migration traceability.

Runtime selection is handled by the adapter CLI:

- `cpa` interprets shared team config for Claude Code execution.
- `opa` is the default OpenCode adapter and interprets shared team config for opencode execution.
- Adapter config decides how provider/model hints are mapped, overridden, or ignored for that runtime.

Use `pa-core serve` for the Agent API server lifecycle. `opa` should provide deployment execution hooks; it should not own the server lifecycle.

Team YAML and mode objective files should not require Claude Code or opencode-specific tools directly. Runtime-specific tool guidance is injected by `pa-core` primer generation from the active adapter's runtime metadata.

Mode objective files under `teams/<team>/modes/*.md` are active configuration. `pa-core` reads them during primer generation and applies template variables such as `{{TODAY}}`, `{{DEPLOY_ID}}`, and `{{TEAM_NAME}}`.

Examples belong under `docs/examples/`, not under active config directories.
