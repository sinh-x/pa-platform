# Runtime-Neutral Configuration

`pa-core` owns runtime-agnostic configuration and state. Runtime adapters provide runtime-specific spawning, hooks, model/provider defaults, and tool descriptions.

Team YAML files should describe team behavior, modes, agents, skills, and objective files. They should not require Claude Code or opencode-specific tools directly.

Mode objective files under `teams/<team>/modes/*.md` are active configuration. `pa-core` reads them during primer generation and applies template variables such as `{{TODAY}}`, `{{DEPLOY_ID}}`, and `{{TEAM_NAME}}`.

Examples belong under `docs/examples/`, not under active config directories.
