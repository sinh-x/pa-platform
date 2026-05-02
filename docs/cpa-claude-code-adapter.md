# cpa — Claude Code Runtime Adapter

`cpa` is the Claude Code runtime adapter for `pa-platform`, parallel to `opa`. It lives in `packages/claudecode-pa/` and exposes the `cpa` binary that drives PA deployments through Anthropic's `claude` CLI.

## When to use

| Adapter | Runtime | Provider | Default model |
|---|---|---|---|
| `opa` | OpenCode | openai/minimax (per team YAML) | `sonnet` |
| `cpa` | Claude Code | `anthropic` only | `claude-opus-4-7` |

Use `cpa` when you want the deployment to run inside a Claude Code session: the primer is delivered to `claude`, tool activity is streamed into `activity.jsonl` via `~/.claude/settings.json` hooks, and session resume is keyed off `session-id-claude.txt`.

## Common commands

```bash
cpa --version                                  # prints `cpa <pkg-version>`
cpa deploy <team> --dry-run                    # write primer.md, no claude spawn
cpa deploy <team>                              # foreground TUI (inherited stdio)
cpa deploy <team> --background                 # detached; writes session id + activity
cpa deploy <team> --resume <deploy-id>         # passes --resume <session-id> to claude
cpa deploy <team> --list-modes                 # list mode IDs from team YAML
cpa deploy <team> --validate                   # parse + check team config without spawning
```

`cpa` reuses `pa-core`'s shared CLI surface for everything else (`cpa ticket …`, `cpa registry …`, `cpa bulletin …`, `cpa status …`, etc.).

## Provider and model resolution

```
--model > --team-model > deploy_modes[].model (team YAML) > $PA_CPA_DEFAULT_MODEL > claude-opus-4-7
```

`--provider` accepts `anthropic` (or omitted). Any other value — including a YAML-set `provider: openai` for a `cpa` deploy — fails fast with `Unsupported cpa provider: <value>. Supported providers: anthropic`.

## Hook installer + sensitive-content masking

`cpa` ships a settings.json hook installer (`installPaClaudeHooks`) that idempotently merges `PreToolUse`, `PostToolUse`, and `Stop` entries into `~/.claude/settings.json`, pointing at a vendored handler at `~/.claude/hooks/pa-activity.mjs`. The handler:

- appends `tool.execute.before` / `tool.execute.after` / `session.stop` JSONL records to `PA_ACTIVITY_LOG`;
- applies sensitive-content masking using `~/.claude/hooks/sensitive-patterns.conf` (built-in fallback patterns when the file is absent);
- never echoes the payload on stdout, so the executed command remains exactly what Claude Code sent — masking is applied to the activity log only.

Re-running the installer is idempotent: deduplication is by handler command path, and pre-existing user hooks under unrelated keys are preserved.

## Session resume + cross-runtime guard

A `cpa` deploy writes `session-id-claude.txt` after the first stream-json `system.init` event. `cpa deploy --resume <id>` reads that file and passes `--resume <session-id>` to `claude` (positional prompt argument follows). If only `session-id-opencode.txt` is present, the resume errors with `cannot resume: deploy <id> was launched by opencode; use 'opa deploy --resume <id>'`.

## Packaging

The Nix flake produces `result/bin/cpa` alongside `result/bin/opa` and `result/bin/pa-core`, and installs `share/fish/vendor_completions.d/cpa.fish` next to `opa.fish`. Both adapters share the `pa-core` symlink so the on-disk closure overhead is minimal (≤ ~2 MB).

## Verification snapshot

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm completions
nix build .#default && ls result/bin/cpa
```

The first four return 0 in CI; `nix build` is gated to environments with network/Nix access.

## Related

- Requirements: `agent-teams/requirements/artifacts/2026-05-02-cpa-claude-code-adapter.md`
- UAT plan: `agent-teams/requirements/artifacts/2026-05-02-cpa-claude-code-adapter-uat.md`
- Source: `packages/claudecode-pa/` (cli, deploy, adapter, plugins, tests)
