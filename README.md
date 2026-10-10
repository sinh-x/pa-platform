# pa-platform

Runtime-neutral core library and adapter foundation for PA agent-team workflows.

`pa-platform` extracts shared PA state, API, CLI, registry, ticket, bulletin, document, health, codectx, signal, team, and primer logic into `packages/pa-core`. Runtime adapters provide execution hooks without duplicating core behavior. `opa` is the OpenCode deployment adapter, `cpa` is the Claude Code adapter, `dpa` is the Droid adapter, and `ppa` is the Pi adapter; `pa-core` still owns runtime-neutral server lifecycle behavior.

## Packages

| Package | Description |
|---|---|
| `@pa-platform/pa-core` | Runtime-neutral PA core library, shared CLI dispatcher, and Agent API app |
| `@pa-platform/opencode-pa` | OpenCode adapter that provides the `opa` CLI and runtime hooks |
| `@pa-platform/claudecode-pa` | Claude Code adapter that provides the `cpa` CLI, settings.json hooks, and stream-json activity capture |
| `@pa-platform/droidcode-pa` | Droid adapter that provides the `dpa` CLI driven by the Factory SDK with streaming activity capture |
| `@pa-platform/pi-pa` | Pi adapter that provides the `ppa` CLI and normalized Pi activity capture |

## CLI

The Nix package installs a `pa-core` CLI wrapper:

```bash
pa-core teams
pa-core board --project pa-platform
pa-core registry list
pa-core ticket list --project pa-platform
pa-core ticket list --all --status done
pa-core status
```

Ticket lists default to active, non-archived, non-backlog work. `--all` removes only those default exclusions, so explicit project, status, assignee, priority, type, tag, and search filters continue to compose.

Deployment execution is adapter-hooked. Use `opa` for OpenCode runs, `cpa` for Claude Code runs, `dpa` for Droid runs, and `ppa` for Pi runs:

```bash
opa deploy builder --mode implement
cpa deploy builder --mode implement
dpa deploy builder --mode implement
ppa deploy builder --mode implement
```

`cpa` defaults to model `claude-opus-4-7` and `--provider anthropic`; see `docs/cpa-claude-code-adapter.md` for the full adapter overview.

`dpa` defaults to model `deepseek-v4-pro` and requires `FACTORY_API_KEY` in the environment. Provider hints map to Droid model IDs. See `docs/dpa-droid-adapter.md` for the full adapter overview.

### Rogue-One bare deployment

Exact team selection `ppa|opa|cpa|dpa deploy rogue-one` activates a fixed `rogue-one` bare profile; there is no bypass flag. It omits PA workflow/review primer content and bypasses ticket, Git-status, repository-lease, workflow-approval, and final-review admission. It does **not** bypass registered repository identity, sensitive-input or runtime/provider validation, adapter hooks and permissions, runtime tool/host constraints, logging, or registry lifecycle. A supplied `--mode` is ignored with a warning.

Rogue-one intentionally does not serialize repository mutation, so concurrent or dirty-checkout work can overwrite other work. The Agent API supports rogue-one only for OpenCode/Pi and requires `Authorization: Bearer <PA_AGENT_API_OPERATOR_CREDENTIAL>`; credentials are not persisted in rogue audit evidence.

### Pi Adapter

See [`docs/pi-pa.md`](docs/pi-pa.md) for setup, status/removal, source paths, `/reload`, managed isolation, migration, and troubleshooting.

Pi 0.84.4 or later must be installed as `pi` on `PATH`; credentials and Pi-local configuration remain operator-owned. `ppa` does not install or authenticate Pi and does not change the platform default, which remains OpenCode through `opa` and the Agent API when `runtime` is omitted.

PPA provider/model precedence is explicit CLI flags, the selected flat mode pair (`deploy_modes[].provider` and `deploy_modes[].model`), then the PPA adapter default. A mode must provide both fields or neither. PPA defaults to OpenAI Sol (`openai-codex` / `gpt-6.1-sol`) and does not inherit Pi-local Luna. Foreground `ppa deploy` launches Pi's interactive TUI with terminal input/output attached; `--background` uses non-interactive JSON mode for supervised execution and activity capture:

```bash
ppa deploy builder --mode implement --provider openai --model openai/gpt-6.1-sol
ppa deploy builder --mode implement --background
ppa deploy builder --mode implement --dry-run
```

Every non-dry Pi deployment stores a session UUID in `session-id-pi.txt`. Resume it with `ppa deploy <team> --resume <deployment-id>`; cross-runtime resumes are rejected before spawn and identify the correct adapter.

The Agent API server is core-owned:

```bash
pa-core serve
```

Without a deployment adapter hook, `pa-core deploy` returns an explicit error instead of invoking a runtime directly. `pa-core serve` starts the core Agent API server and routes API deployment requests through the configured default adapter when one is provided.

## Selected AXI tools for managed PPA (PAP-240)

`lib.mkPaPlatform` accepts independent strict booleans `enableGhAxi`,
`enableChromeDevtoolsAxi`, and `enableQuotaAxi`, all **false** by default. Selected
outputs add only managed executable shims and their pinned dependencies to PPA
PATH; OPA/CPA/DPA and pa-core added prefixes are unchanged. Inherited host PATH
is not a sandbox prohibition. Pi's existing plugin selection and managed
skill/extension discovery remain unchanged; no AXI skill or global hook is
installed. PAPC-040 owns later selected skills; Lavish remains PAP-197/PAPC-020.

| Managed executable | Pin | Selected dependencies / operator prerequisites |
| --- | --- | --- |
| `gh-axi` | 0.1.35 | flake-locked Node >=22.19 and gh; operator-managed gh authentication |
| `chrome-devtools-axi` | 0.1.38 | same Node, chrome-devtools-mcp 1.10.1; absolute executable `PA_AXI_CHROME_EXECUTABLE` |
| `quota-axi` | 0.1.56 | same Node; explicit deployment-bound `PA_AXI_QUOTA_CONSENT` |

The selected binaries live in `share/pa-platform/axi-bin/`. Nix supplies
`PA_AXI_PATH` containing that directory and **only selected** dependency bins;
the adapter preserves that prefix across foreground/background/resume launches.
Raw upstream closures remain referenced in `share/pa-platform/axi-tools/` and
explicit standalone Nix outputs. Standalone upstream CLIs are **not** the managed
policy boundary. Pins, resolved transitive integrity/locks and licenses are
recorded in [`nix/axi/README.md`](nix/axi/README.md). No runtime package download,
self-update, fallback npx bootstrap, credential provisioning or browser install
is performed by managed admission.

**Phase 2 behavior:** exact single-argument `--help`/`-h`/`help` and
`--version`/`-v`/`-V`/`version` return managed metadata without authentication,
credential reads or subprocesses. Explicit GitHub operations check the active
operator gh authentication for the requested hostname, discard auth output,
then use the pinned upstream entrypoint. `setup` (including hooks/skills) and
unknown bootstrap/update commands are rejected. Exposing gh grants **no extra
PA approval, merge, branch, secrets or workflow authority**; all existing action
gates still apply. Installation, module import and deployment startup execute
no GitHub action, authentication probe, browser or quota operation.

Missing operational prerequisites return non-secret codes with no input paths,
identities, credentials or raw auth errors: `AXI_GH_AUTH_REQUIRED`,
`AXI_CHROME_REQUIRED`, `AXI_QUOTA_CONSENT_REQUIRED`. Unsupported operations or
unsafe/malformed configuration return `AXI_POLICY_REJECTED` and exit nonzero.
**Browser and quota operations stay fail-closed even with prerequisites present
in Phase 2.** A consent path is not consent; this phase does not read it or any
provider profile and makes no provider request. No placeholder successful quota
result or browser session is returned.

**Phase 3 contract (not implemented/validated by Phase 2):** operator-owned,
mode-0600 non-symlink consent JSON at `PA_AXI_QUOTA_CONSENT` must have exactly
`version: 1`, `deploymentId` matching the current deployment, and `providers`,
an array of unique `{ "id": "codex" | "claude", "profilePath": "/absolute/path" }`
objects. Unknown fields/providers, duplicates, wrong ownership/mode or deployment
must reject before credential/provider access. Each admitted provider must use
profile-only, no-refresh JSON reads and allowlisted sanitized output; discovery,
keychain/TUI, refresh, inference, telemetry and automatic routing stay forbidden.
Browser policy must pin Node/MCP, disable MCP telemetry/update checks, use only
isolated headless operator Chrome with deployment-owned profile/state and a
loopback bridge, reject foreign/remote/shared attachments and override arguments,
and supervise owned cleanup. Required bounds are readiness <=30s, idle=300s,
deployment-end cleanup <=10s, without modifying foreign processes/profiles.
Full consent/redaction/lifecycle enforcement belongs to Phase 3; installed-output
selection/platform/lifecycle evidence belongs to Phase 4 and independent review.

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

Fish completions are installed by the Nix package and maintained in `completions/pa-core.fish`, `completions/opa.fish`, `completions/cpa.fish`, `completions/dpa.fish`, and `completions/ppa.fish`.

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
