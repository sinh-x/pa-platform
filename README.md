# pa-platform

Runtime-neutral core library and adapter foundation for PA agent-team workflows.

`pa-platform` extracts shared PA state, API, CLI, registry, ticket, bulletin, document, health, codectx, signal, team, and primer logic into `packages/pa-core`. Runtime adapters such as `cpa` and `opa` can then provide execution hooks without duplicating core behavior. `opa` is the default OpenCode deployment adapter; `pa-core` still owns runtime-neutral server lifecycle behavior.

## Packages

| Package | Description |
|---|---|
| `@pa-platform/pa-core` | Runtime-neutral PA core library, shared CLI dispatcher, and Agent API app |
| `@pa-platform/opencode-pa` | OpenCode adapter that provides the `opa` CLI and runtime hooks |

## CLI

The Nix package installs a `pa-core` CLI wrapper:

```bash
pa-core teams
pa-core board --project pa-platform
pa-core registry list
pa-core ticket list --project pa-platform
pa-core status
```

Deployment execution is adapter-hooked, with `opa` as the default OpenCode adapter:

```bash
opa deploy builder --mode implement
```

The Agent API server is core-owned:

```bash
pa-core serve
```

Without a deployment adapter hook, `pa-core deploy` returns an explicit error instead of invoking a runtime directly. `pa-core serve` starts the core Agent API server and routes API deployment requests through the configured default adapter when one is provided.

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

Fish completions are installed by the Nix package and maintained in `completions/pa-core.fish` and `completions/opa.fish`.

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
