# Configuration Reference

Schemas and defaults for the configuration files and environment variables consumed by `pa-core`, `opa`, and the Agent API server. All defaults and resolution order documented here are derived from `packages/pa-core/src/config.ts`, `packages/pa-core/src/paths.ts`, `packages/pa-core/src/repos.ts`, `packages/pa-core/src/health/score.ts`, and `packages/opencode-pa/src/adapter.ts`.

> **Source of truth:** `packages/pa-core/src/config.ts`, `packages/pa-core/src/paths.ts`, `packages/pa-core/src/repos.ts`, `packages/pa-core/src/types.ts`, `packages/pa-core/src/health/score.ts`, `packages/opencode-pa/src/adapter.ts`.
> **Last updated:** 2026-08-13

## Table of Contents

- [Config Directory & Resolution Order](#config-directory--resolution-order)
- [config.yaml](#configyaml)
  - [Schema](#configyaml-schema)
  - [Defaults](#configyaml-defaults)
  - [Example](#configyaml-example)
- [repos.yaml](#reposyaml)
  - [Schema](#reposyaml-schema)
  - [Defaults](#reposyaml-defaults)
  - [Example](#reposyaml-example)
- [health.yaml](#healthyaml)
  - [Schema](#healthyaml-schema)
  - [Defaults](#healthyaml-defaults)
  - [Example](#healthyaml-example)
- [Team Config Files (teams/*.yaml)](#team-config-files-teamsyaml)
- [Environment Variables](#environment-variables)
  - [Paths & Dirs](#paths--dirs)
  - [Server Lifecycle](#server-lifecycle)
  - [Runtime / Adapter](#runtime--adapter)
  - [Deployment Context (injected by adapters)](#deployment-context-injected-by-adapters)
  - [Provider Model Overrides (`opa`)](#provider-model-overrides-opa)
  - [Command Resolution](#command-resolution)
  - [Status Wait](#status-wait)
- [Resolution Priority Summary](#resolution-priority-summary)

---

## Config Directory & Resolution Order

The platform looks for user configuration under a single config directory. `repos.yaml` and `health.yaml` are read relative to this directory; `config.yaml` (the main user config) lives directly inside it.

**Config directory resolution** (`getConfigDir()` in `paths.ts`):

1. `PA_PLATFORM_CONFIG` env var — if set, used verbatim (after `~` expansion).
2. Default: `~/.config/sinh-x/pa-platform`.

The main user config path is `<configDir>/config.yaml` (`getUserConfigPath()`). `repos.yaml` is searched in (`candidateReposFiles()` in `repos.ts`):

1. `<dirname(config.yaml)>/repos.yaml` (i.e. the same config directory).
2. `~/.config/sinh-x/personal-assistant/repos.yaml` (legacy coexistence).
3. `<platformHomeDir>/repos.yaml` (the bundled platform repo root).

The first existing file wins. `health.yaml` is read from `<configDir>/health.yaml` (`getHealthConfigPath()`).

### Platform home directory

**Platform home** (`getPlatformHomeDir()`) is the root for bundled `teams/` and `skills/`:

1. `PA_PLATFORM_HOME` env var.
2. `config_dir` field in `config.yaml`.
3. Default: the pa-platform package root (three levels up from `paths.ts`), i.e. the bundled checkout.

---

## config.yaml

The main user configuration file. All keys are optional; the file may be absent (defaults are applied).

### config.yaml Schema

```yaml
# Root directory for bundled teams/ and skills/ (overrides platform package root)
config_dir: string  # optional, ~-expandable path

# Data directory for runtime state (PID files, logs, primers)
data_dir: string    # optional, ~-expandable path

# Teams directory (overrides <config_dir>/teams)
teams_dir: string   # optional, ~-expandable path

# Skills directory (overrides <config_dir>/skills/global)
skills_dir: string  # optional, ~-expandable path

# Platform-wide defaults
defaults:           # optional
  runtime: "claude" | "opencode" | "droid"   # optional, default runtime
  opencode:                                   # optional
    provider: string                          # optional, default provider for opencode
    model: string                             # optional, default model for opencode
  claudecode:                                 # optional
    model: string                             # optional
    minimax_via_claude: boolean               # optional
  droidcode:                                  # optional
    model: string                             # optional
    autonomy: "low" | "medium" | "high"      # optional

# Provider credentials and model tiers (merged with any <config_dir>/config.yaml)
provider_defaults: # optional
  default_provider: string                    # optional
  default_model: string                       # optional
  providers:                                   # optional
    anthropic:     { base_url?: string, models?: { sonnet?, opus?, haiku? } }
    minimax:       { base_url?: string, models?: { sonnet?, opus?, haiku? } }
    openai:        { base_url?: string, models?: { sonnet?, opus?, haiku? } }
    deepseek:      { base_url?: string, models?: { sonnet?, opus?, haiku? } }
    "ollama-cloud": { base_url?: string, models?: { sonnet?, opus?, haiku? } }
    factory:       { api_key?: string, base_url?: string }
```

### config.yaml Defaults

| Field | Default | Notes |
|-------|---------|-------|
| `config_dir` | (platform package root) | Used to locate bundled `teams/` and `skills/` |
| `data_dir` | `~/.local/share/pa-platform` | Overridable by `PA_PLATFORM_DATA` |
| `teams_dir` | `<platformHome>/teams` (or `<config_dir>/teams` when `config_dir` set) | Overridable by `PA_PLATFORM_TEAMS` |
| `skills_dir` | `<platformHome>/skills/global` (or `<config_dir>/skills/global`) | Overridable by `PA_PLATFORM_SKILLS` |
| `defaults.runtime` | (unset — adapter default applies; opencode is default) | One of `claude`, `opencode`, `droid` |
| `defaults.opencode.provider` | (unset; `--provider` flag or `provider_defaults.default_provider`) | |
| `provider_defaults.default_provider` | `ollama-cloud` (via `opa deploy --provider` fallback) | |

### config.yaml Example

```yaml
config_dir: ~/git-repos/sinh-x/tools/pa-platform-config
data_dir: ~/.local/share/pa-platform

defaults:
  runtime: opencode
  opencode:
    provider: ollama-cloud
    model: ollama-cloud/deepseek-v4-pro

provider_defaults:
  default_provider: ollama-cloud
  default_model: ollama-cloud/deepseek-v4-pro
  providers:
    "ollama-cloud":
      models:
        sonnet: ollama-cloud/deepseek-v4-pro
        opus: ollama-cloud/deepseek-v4-pro
        haiku: ollama-cloud/qwen3-coder-next
    factory:
      api_key: ${PA_FACTORY_API_KEY}
      base_url: https://factory.example.com
```

> **External config merge:** When `config_dir` is set, the platform also reads `<config_dir>/config.yaml` and merges its `provider_defaults` (the main user config takes precedence). This lets provider credentials live in a separate repo while the user config overrides individual fields.

---

## repos.yaml

Registers the git repositories the platform manages (for ticket project prefixes, CWD-aware board scoping, and branch creation).

### repos.yaml Schema

```yaml
repos:                           # required top-level map
  <key>:                         # repository key (e.g. "pa", "avodah")
    path: string                 # required, ~-expandable absolute repo path
    description: string          # optional
    prefix: string               # optional, ticket-prefix (e.g. "PA", "AVO")
    mainBranch: string           # optional, default "main"
    developBranch: string        # optional, default "develop"
    featureBranchPattern: string # optional, default "feature/<ticket>-<topic>"
```

### repos.yaml Defaults

| Field | Default | Notes |
|-------|---------|-------|
| `featureBranchPattern` | `feature/<ticket>-<topic>` | Constant `DEFAULT_BRANCH_PATTERN` in `repos.ts` |
| `mainBranch` | `main` | Used by `branch validate` to identify base branches |
| `developBranch` | `develop` | Base branch for `branch create` |
| `prefix` | (none) | Required for project resolution and CWD-aware board scoping |

### repos.yaml Example

```yaml
repos:
  pa:
    path: ~/git-repos/sinh-x/tools/personal-assistant
    description: Personal Assistant monorepo
    prefix: PA
    mainBranch: main
    developBranch: develop
    featureBranchPattern: feature/<ticket>-<topic>
  avodah:
    path: ~/git-repos/sinh-x/avodah
    prefix: AVO
  pa-platform:
    path: ~/git-repos/sinh-x/tools/pa-platform
    prefix: PAP
```

> **Project resolution** (`resolveProject`): accepts the exact key (`pa`), the prefix case-insensitively (`PA`), or the repo path basename (`personal-assistant`). CWD-aware resolution (`resolveProjectFromCwd`) runs `git rev-parse --show-toplevel` and matches against registered repo paths.

---

## health.yaml

Optional configuration for the health scoring system. Absent file → all defaults apply. Parse failures also fall back to defaults.

### health.yaml Schema

```yaml
weights:                         # optional, per-category weights (0 disables a category)
  deployments: number           # default 20
  agents: number                 # default 20
  tickets: number                # default 20
  compliance: number            # default 20
  schedules: number              # default 10
  infrastructure: number         # default 10

thresholds:                      # optional, score-label thresholds
  healthy: number                # default 80 (score >= this → "healthy")
  warning: number                # default 60 (score >= this → "warning"; below → "unhealthy")
```

### health.yaml Defaults

| Field | Default | Notes |
|-------|---------|-------|
| `weights.deployments` | 20 | Constant `DEFAULT_WEIGHTS` in `health/score.ts` |
| `weights.agents` | 20 | |
| `weights.tickets` | 20 | |
| `weights.compliance` | 20 | |
| `weights.schedules` | 10 | |
| `weights.infrastructure` | 10 | |
| `thresholds.healthy` | 80 | |
| `thresholds.warning` | 60 | |

**Score computation:** Weighted average of per-category scores (categories with weight ≤ 0 are excluded). Per-category score = `100 - 15*<fails> - 5*<warns>`, clamped to `[0, 100]`. Overall label uses the configured thresholds.

### health.yaml Example

```yaml
weights:
  deployments: 30
  agents: 20
  tickets: 20
  compliance: 15
  schedules: 10
  infrastructure: 5

thresholds:
  healthy: 85
  warning: 65
```

---

## Team Config Files (teams/*.yaml)

Team configs live in the teams directory (resolved via `getTeamsDir()`; see [Paths & Dirs](#paths--dirs)) as `<team>.yaml`. The `example.yaml` file is skipped. The full schema is defined by the `TeamConfig`, `Agent`, `DeployMode`, `Hierarchy`, `SkillEntry`, and `RuntimeConfigMap` types in `packages/pa-core/src/types.ts` (see [Data Models](./data-models.md)). Key fields:

```yaml
name: string                # required, team name
description: string         # required
objective: string           # required, default objective
model: string               # optional, default model for the team
default_mode: string        # optional, default deploy mode id
timeout: number             # optional, deploy timeout seconds
global_docs: [string]       # optional, memory docs injected into primers
terse_mode: boolean          # optional, enable terse prose
variables: {string: string} # optional, template variables
context:                    # optional
  organization: string
  notes: string
agents:                     # required, list of agents
  - name: string            # required
    role: string            # required
    instruction: string     # optional
    skill: string           # optional
    model: string           # optional
hierarchy:                  # optional
  "team-manager": { role?: string, participates_in?: "all" | [string] }
  agents: [{ name: string, role?: string, participates_in?: "all" | [string] }]
deploy_modes:               # optional, list of deploy modes
  - id: string              # required
    label: string           # required
    mode_type: "housekeeping" | "work" | "interactive"  # optional
    objective: string       # optional
    agents: [string]        # optional, subset of agents
    skills: [{ name: string, "inject-as": "global-skill" | "shared-skill" | "reference" }]  # optional
    solo: boolean           # optional
    model: string           # optional
    provider: string        # optional
    timeout: number         # optional
    global_docs: [string]   # optional
    runtimes:               # optional, per-runtime overrides
      opencode: { model?: string, provider?: string, autonomy?: "low"|"medium"|"high", timeout?: number }
      claude:   { ... }
      droid:    { ... }
    require_ticket: boolean  # optional, require a ticket for deploys in this mode
runtimes:                   # optional, team-level runtime overrides (same shape as mode.runtimes)
  opencode: { ... }
  claude:   { ... }
  droid:    { ... }
```

See [Data Models](./data-models.md) for the full `TeamConfig` / `DeployMode` / `Agent` field reference.

---

## Environment Variables

### Paths & Dirs

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `PA_PLATFORM_CONFIG` | `~/.config/sinh-x/pa-platform` | `paths.ts`, `config.ts` | Config directory root (where `config.yaml`, `repos.yaml`, `health.yaml` live) |
| `PA_PLATFORM_HOME` | (platform package root) | `paths.ts`, `config.ts` | Platform home (bundled `teams/` + `skills/` root); overridden by `config_dir` in `config.yaml` |
| `PA_PLATFORM_DATA` | `~/.local/share/pa-platform` | `paths.ts`, `config.ts` | Data directory (PID files, logs, primers) |
| `PA_PLATFORM_TEAMS` | `<platformHome>/teams` | `paths.ts`, `config.ts` | Teams config directory |
| `PA_PLATFORM_SKILLS` | `<platformHome>/skills/global` | `paths.ts`, `config.ts` | Skills directory |
| `PA_AI_USAGE_HOME` | `~/Documents/ai-usage` | `paths.ts` | Root for `deployments/`, `tickets/`, `bulletins/`, `trash/`, `signal/`, `sessions/`, `daily/`, `knowledge-base/`, `sinh-inputs/`, `agent-teams/` |
| `PA_PLATFORM_SKILL_ROOTS` | (unset) | `skills/index.ts` | Colon-separated extra skill scan roots appended after the built-in skills dir and `config.yaml#skills_dir`; empty segments are ignored, non-existent paths are filtered out |
| `PA_REGISTRY_DB` | `<deploymentsDir>/registry.db` | `paths.ts`, `registry/` | Deployment registry SQLite database path |
| `XDG_CONFIG_HOME` | `~/.config` | `schedule.ts`, `opencode-pa/src/adapter.ts` (`pickBackgroundEnv`) | Used to locate `systemd/user/` for timers; `pickBackgroundEnv` forwards it to spawned background processes so opencode resolves its config dir |

### Server Lifecycle

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `PA_DEV_MODE` | (unset) | `serve.ts`, `cli/run.ts` | Truthy values (`"1"`, `"true"`, `"yes"`) activate dev mode (per-process; binary resolution consults `PA_OPENCODE_BINARY`). `agent-api/index.ts` only references it in JSDoc, not at runtime |
| `PA_OPENCODE_BINARY` | (unset → `"opencode"` on PATH) | `session-hub.ts`, `cli/run.ts` | Explicit opencode binary path; only consulted when dev mode is active |
| `PA_MAX_SESSIONS` | `3` | `session-hub.ts` | Maximum concurrent WebSocket sessions; invalid/non-positive values fall back to default |
| `NO_COLOR` | (unset) | `board.ts` | When set, disables colored board output |

### Runtime / Adapter

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `PA_RUNTIME` | (set by adapters on spawned processes) | `cli/run.ts` | Set on spawned child processes to the adapter name (`opencode`, `claude`, `droid`) |
| `PA_MAX_RUNTIME` | (unset → `DEFAULT_DEPLOY_TIMEOUT_SECONDS` = 1800) | `deploy/control.ts` | Deploy timeout in seconds, consulted between the `--timeout` flag and the built-in default. Bounded to `[60, 7200]`; invalid values are rejected before the deployment hook runs |

### Deployment Context (injected by adapters)

These keys are rendered into the `<deployment-context>` primer block by all three runtime adapters. The full key list is defined by `PA_ENV_KEYS` in `packages/pa-core/src/primer/index.ts`:

| Variable | Description |
|----------|-------------|
| `PA_DEPLOYMENT_ID` | Current deployment id (e.g. `d-abc123`) |
| `PA_DEPLOYMENT_DIR` | Per-deployment workspace directory |
| `PA_ACTIVITY_LOG` | Path to `activity.jsonl` for the deployment |
| `PA_TEAM` | Team name for the deployment |
| `PA_MODE` | Deploy mode id |
| `PA_TICKET_ID` | Associated ticket id (if any) |
| `PA_REPO` | Repository path (if any) |
| `PA_PROVIDER` | Model provider (if any) |
| `PA_MODEL` | Agent model (if any) |
| `PA_TEAM_MODEL` | Team-level model (if any) |
| `PA_AGENT_MODEL` | Agent-level model (if any) |

`PA_DEPLOYMENT_ID` is also read by `evaluate --record` as the default evaluator deployment id.

### Provider Model Overrides (`opa`)

The OpenCode adapter (`packages/opencode-pa/src/adapter.ts`) resolves default model strings per provider from these env vars. When unset, the hard-coded defaults below apply.

| Variable | Default | Provider |
|----------|---------|----------|
| `OPA_MINIMAX_MODEL` | `minimax-coding-plan/MiniMax-M2.7` | `minimax` |
| `OPA_OPENAI_MODEL` | `openai/gpt-5.5` | `openai` |
| `OPA_DEEPSEEK_MODEL` | `deepseek/deepseek-v4-pro` | `deepseek` |
| `OPA_OLLAMA_CLOUD_MODEL` | `ollama-cloud/deepseek-v4-pro` | `ollama-cloud` (default provider) |
| `OPA_OPENCODE_GO_MODEL` | `opencode-go/deepseek-v4-pro` | `opencode-go` |

Supported `opa` providers: `minimax`, `openai`, `deepseek`, `ollama-cloud` (default), `opencode-go`. Provider model strings are prefixed with `<provider>/` when a bare model name is passed (e.g. `--model deepseek-v3.2` → `ollama-cloud/deepseek-v3.2` for the `ollama-cloud` provider).

### Command Resolution

Used by `schedule`/`remove-timer` to determine the pa command invoked by systemd units (`defaultPaCommand()` in `schedule.ts`):

| Variable | Description |
|----------|-------------|
| `PA_COMMAND` | Full command override (highest priority) |
| `PA_CORE_BIN` | Full command override (second priority) |
| `PA_BIN` | Directory containing the `pa` binary (resolved as `<PA_BIN>/pa`) |
| (fallback) | `pa-core` |

### Status Wait

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `PA_STATUS_WAIT_TIMEOUT` | (deployment `effective_timeout_seconds` or `1800`) | `status.ts` | Override the `status --wait` timeout; must be an integer between 60 and 7200 seconds |

---

## Resolution Priority Summary

**Config directory** → `PA_PLATFORM_CONFIG` → default `~/.config/sinh-x/pa-platform`.
**Platform home** → `PA_PLATFORM_HOME` → `config.yaml#config_dir` → platform package root.
**Data dir** → `PA_PLATFORM_DATA` → `config.yaml#data_dir` → `~/.local/share/pa-platform`.
**Teams dir** → `PA_PLATFORM_TEAMS` → `config.yaml#teams_dir` → `<config_dir>/teams` (when `config_dir` set) → `<platformHome>/teams`.
**Skills dir** → `PA_PLATFORM_SKILLS` → `config.yaml#skills_dir` → `<config_dir>/skills/global` (when `config_dir` set) → `<platformHome>/skills/global`.
**AI usage home** → `PA_AI_USAGE_HOME` → `~/Documents/ai-usage`.
**Registry DB** → `PA_REGISTRY_DB` → `<deploymentsDir>/registry.db`.
**Server dev mode** → `--dev` flag OR truthy `PA_DEV_MODE`.
**Server binary (dev)** → `PA_OPENCODE_BINARY` → `"opencode"` on PATH.
**Max sessions** → `PA_MAX_SESSIONS` → `3` (invalid → default).
**Provider default model** → `OPA_*_MODEL` → hard-coded defaults per provider (see [Provider Model Overrides](#provider-model-overrides-opa)).
**Deploy timeout** → `--timeout` → deployment `effective_timeout_seconds` → `PA_MAX_RUNTIME` (env, bounded `[60, 7200]`) → `DEFAULT_DEPLOY_TIMEOUT_SECONDS` (1800); final value is bounded by `[60, 7200]`.
**Health config** → `<configDir>/health.yaml` (parse failure → defaults).
**Repo registry** → `<configDir>/repos.yaml` → `~/.config/sinh-x/personal-assistant/repos.yaml` → `<platformHome>/repos.yaml` (first existing file).

All defaults and resolution orders above are derived from the pa-core source linked in each section; no values were invented.