# pa-platform

Runtime-neutral core library and adapter foundation for PA agent-team workflows.

`pa-platform` extracts shared PA state, API, CLI, registry, ticket, bulletin, document, health, codectx, signal, team, and primer logic into `packages/pa-core`. Runtime adapters such as `cpa` and `opa` provide execution hooks without duplicating core behavior. `opa` is the OpenCode deployment adapter; `cpa` is the Claude Code adapter (anthropic-only); `pa-core` still owns runtime-neutral server lifecycle behavior.

## Packages

| Package | Description |
|---|---|
| `@pa-platform/pa-core` | Runtime-neutral PA core library, shared CLI dispatcher, and Agent API app |
| `@pa-platform/opencode-pa` | OpenCode adapter that provides the `opa` CLI and runtime hooks |
| `@pa-platform/claudecode-pa` | Claude Code adapter that provides the `cpa` CLI, settings.json hooks, and stream-json activity capture |

## CLI

The Nix package installs a `pa-core` CLI wrapper:

```bash
pa-core teams
pa-core board --project pa-platform
pa-core registry list
pa-core ticket list --project pa-platform
pa-core status
```

Deployment execution is adapter-hooked. Use `opa` for OpenCode runs and `cpa` for Claude Code runs:

```bash
opa deploy builder --mode implement
cpa deploy builder --mode implement
```

`cpa` defaults to model `claude-opus-4-7` and `--provider anthropic`; see `docs/cpa-claude-code-adapter.md` for the full adapter overview.

The Agent API server is core-owned:

```bash
pa-core serve
```

Without a deployment adapter hook, `pa-core deploy` returns an explicit error instead of invoking a runtime directly. `pa-core serve` starts the core Agent API server and routes API deployment requests through the configured default adapter when one is provided.

## Dev server access from phone/Tailscale

`pa-core serve` defaults to `--host 127.0.0.1` with CORS off — safe for production but unreachable from a Tailscale peer (e.g. iPhone). The Nix dev shell ships a `dev-pa-serve` wrapper that bakes in phone-friendly defaults and runs the server backgrounded under `dtach`:

```bash
nix develop
dev-pa-serve            # runs `serve --host 0.0.0.0 --port 9848 --cors` under dtach
dev-pa-serve status     # check the running server
dev-pa-serve stop       # stop the server, remove pid file
dev-pa-serve restart    # rebuild + cycle cleanly
dev-pa-serve --port 19848   # override flags via "$@" passthrough
dtach -a /tmp/pa-platform-serve.dtach   # attach to the live log stream
```

Without Nix (or to bind explicitly), invoke the server directly:

```bash
node packages/opencode-pa/dist/cli.js serve --host 0.0.0.0 --cors
```

Production defaults remain `127.0.0.1` and CORS off — only the wrapper opts in to LAN/Tailscale exposure. The dtach socket `/tmp/pa-platform-serve.dtach` is distinct from the legacy `personal-assistant` wrapper's `/tmp/pa-serve.dtach` so the two can coexist. The legacy path reference documents the current known convention and is not auto-synced with the external wrapper.

## Shared State

By default, `pa-core` uses the same on-disk workflow state as old `pa`:

| State | Default path |
|---|---|
| AI usage home | `~/Documents/ai-usage` |
| Registry DB | `~/Documents/ai-usage/deployments/registry.db` |
| Tickets | `~/Documents/ai-usage/tickets` |
| Bulletins | `~/Documents/ai-usage/bulletins` |
| Deployments | `~/Documents/ai-usage/deployments` |

Platform-specific config is separate:

```text
~/.config/sinh-x/pa-platform/config.yaml
```

## Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
nix flake show --no-write-lock-file
```

Fish completions are installed by the Nix package and maintained in `completions/pa-core.fish`, `completions/opa.fish`, and `completions/cpa.fish`.

Regenerate adapter completions and run the staged secret scanner with:

```bash
corepack pnpm completions
corepack pnpm secrets:scan
```

Check representative `opa` fish completion latency locally with:

```bash
corepack pnpm completions:timing
```

The timing check sources generated `completions/opa.fish`, performs one warm-up run plus the median of three timed `complete -C` runs per scenario, and enforces default thresholds for `opa ` (1000ms), `opa deploy ` (5000ms), `opa status ` (2500ms), `opa ticket show ` (2000ms), and `opa board --assignee ` (3000ms). Configure stricter thresholds without editing the script by setting millisecond environment variables, for example:

```bash
OPA_FISH_COMPLETION_THRESHOLD_TOP_LEVEL_MS=500 corepack pnpm completions:timing
```

Supported threshold variables are `OPA_FISH_COMPLETION_THRESHOLD_TOP_LEVEL_MS`, `OPA_FISH_COMPLETION_THRESHOLD_DEPLOY_MS`, `OPA_FISH_COMPLETION_THRESHOLD_STATUS_MS`, `OPA_FISH_COMPLETION_THRESHOLD_TICKET_SHOW_MS`, and `OPA_FISH_COMPLETION_THRESHOLD_BOARD_ASSIGNEE_MS`.

Release notes and tagging workflow are documented in `docs/release-process.md`.

## Branch Strategy

- `develop` is the integration branch.
- `main` is the release branch.
- Feature branches follow `feature/<ticket>-<topic>`.

See `.claude/branch-strategy.yaml`.
