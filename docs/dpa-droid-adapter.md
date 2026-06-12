# dpa — Droid Runtime Adapter

`dpa` is the Droid runtime adapter for `pa-platform`, parallel to `opa` and `cpa`. It lives in `packages/droidcode-pa/` and exposes the `dpa` binary that drives PA deployments through Factory's `@factory/droid-sdk`.

## When to use

| Adapter | Runtime | Provider | Default model |
|---|---|---|---|
| `opa` | OpenCode | openai/minimax (per team YAML) | `ollama-cloud/deepseek-v4-pro` |
| `cpa` | Claude Code | `anthropic` only | `claude-opus-4-7` |
| `dpa` | Droid | provider hint mapped to Droid model | `deepseek-v4-pro` |

Use `dpa` when you want the deployment to run inside a Droid session: the primer is delivered to Droid via the SDK, tool activity is streamed into `activity.jsonl`, and session resume is keyed off `session-id-droid.txt`. All dpa runs (foreground and background) capture a session id and are resumable.

## Common commands

```bash
dpa --version                                  # prints `dpa <pkg-version>`
dpa deploy <team> --dry-run                    # write primer.md, no droid spawn
dpa deploy <team>                              # foreground (streaming via SDK)
dpa deploy <team> --background                 # detached; writes session id + activity
dpa deploy <team> --resume <deploy-id>         # resumes a droid session
dpa deploy <team> --list-modes                 # list mode IDs from team YAML
dpa deploy <team> --validate                   # parse + check team config without spawning
dpa deploy <team> --model claude-opus-4-8      # override the default model
```

`dpa` reuses `pa-core`'s shared CLI surface for everything else (`dpa ticket ...`, `dpa registry ...`, `dpa bulletin ...`, `dpa status ...`, etc.).

## Prerequisites

`dpa` requires `FACTORY_API_KEY` set in the environment. Without it, deploys fail fast with a clear error.

```bash
export FACTORY_API_KEY=fk-...
```

## Provider and model resolution

```
--model > --team-model > deploy_modes[].model (team YAML) > platform defaults.droidcode.model > provider map > $PA_DPA_DEFAULT_MODEL > deepseek-v4-pro
```

Droid uses a flat model namespace — no provider prefix. When `--provider` is set, dpa maps it to a default Droid model:

| Provider | Default Droid model |
|---|---|
| `anthropic` | `claude-opus-4-8` |
| `openai` | `gpt-5.5` |
| `deepseek` | `deepseek-v4-pro` |
| `gemini` | `gemini-3.1-pro-preview` |
| `minimax` | `minimax-m2.7` |
| `ollama-cloud` | `glm-5.1` |

O pencode-style `provider/model` IDs (e.g. `deepseek/deepseek-v4-pro`) are automatically stripped to the flat model ID.

## Configuration

Platform config (`~/.config/sinh-x/pa-platform/config.yaml`) supports a `droidcode` defaults section:

```yaml
defaults:
  droidcode:
    model: gpt-5.5     # default model for dpa deploys
```

Environment variable overrides:

| Variable | Effect |
|---|---|
| `PA_DPA_DEFAULT_MODEL` | Override the default droid model |
| `PA_DPA_AUTONOMY` | Set autonomy level: `low`, `medium`, `high` (default: `high`) |
| `FACTORY_API_KEY` | Required. Factory API key for SDK authentication |

## Session resume + cross-runtime guard

A `dpa` deploy writes `session-id-droid.txt` after the first stream event. `dpa deploy --resume <id>` reads that file and resumes the Droid session. If only `session-id-opencode.txt` or `session-id-claude.txt` is present, the resume errors with `cannot resume: deploy <id> was launched by <runtime>; use '<binary> deploy --resume <id>'`.

## Autonomy

dpa runs Droid with autonomy level `high` by default, auto-approving all tool permissions. This is equivalent to `--auto high` on the `droid exec` CLI. Override via `PA_DPA_AUTONOMY`:

```bash
PA_DPA_AUTONOMY=medium dpa deploy builder
```

## Packaging

The Nix flake produces `result/bin/dpa` alongside `result/bin/opa`, `result/bin/cpa`, and `result/bin/pa-core`, and installs `share/fish/vendor_completions.d/dpa.fish`. All adapters share the `pa-core` symlink for minimal closure overhead.

## Verification

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm completions
nix build .#default && ls result/bin/dpa
```

The first four return 0 in CI; `nix build` is gated to environments with network/Nix access.

## Related

- Source: `packages/droidcode-pa/` (cli, deploy, adapter, background-runner, tests)
- Config: `docs/runtime-neutral-config.md`
