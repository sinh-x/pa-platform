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
installed. PAPC-040 owns later selected skills; Lavish 0.1.67 remains separately
owned by PAP-197/PAPC-020. This integration makes no savings or live-provider
correctness/availability claim.

For example, select only quota (the existing Pi plugin options are independent):

```nix
pa-platform.lib.mkPaPlatform "x86_64-linux" {
  enableGhAxi = false;
  enableChromeDevtoolsAxi = false;
  enableQuotaAxi = true;
}
```

Strings, integers and null are rejected, not coerced. All default package aliases
(`default`, `pa-platform`, `pa-core`, `opa`, `cpa`, `dpa`, `ppa`) and the default
overlay keep all three tools disabled. Explicit standalone tool outputs exist on
x86_64-linux and aarch64-linux; only x86_64-linux native execution is covered.

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

### Metadata, authentication and diagnostics

Exact single-argument `--help`/`-h`/`help` and
`--version`/`-v`/`-V`/`version` return managed metadata without authentication,
credential reads or subprocesses. Explicit GitHub operations check the active
operator gh authentication for the requested hostname, discard auth output,
then use the pinned upstream entrypoint. **Sinh/operator owns gh authentication**;
PPA never logs in, copies credentials or provisions a token. `setup` (including
hooks/skills) and bootstrap/update commands are rejected. Exposing gh grants
**no extra PA approval, merge, branch, secrets or workflow authority**; existing
action gates still apply. Installation, module import and deployment startup
make **no GitHub mutation**, authentication probe, browser or quota operation.
CLI availability is not action approval.

| Diagnostic (nonzero exit) | Operator action |
| --- | --- |
| `AXI_GH_AUTH_REQUIRED` | Configure operator-owned gh authentication outside the agent; retry only an already-approved action. |
| `AXI_CHROME_REQUIRED` | Supply an existing absolute executable `PA_AXI_CHROME_EXECUTABLE`; no discovery/install/download fallback exists. |
| `AXI_QUOTA_CONSENT_REQUIRED` | Supply explicit consent for this deployment; do not provision credentials through PA. |
| `AXI_POLICY_REJECTED` | Correct invalid consent, deployment identity, ownership/collision or forbidden arguments/environment; never attach to or kill a foreign browser to recover. |

Diagnostics omit input paths, identities, credentials and raw errors. A missing
prerequisite for one tool does not disable metadata or unrelated selected tools.
Standalone upstream outputs do not promise these managed diagnostics/policies.

### Owned local browser

Before launching a selected PPA deployment, the operator supplies, for example:

```bash
export PA_AXI_CHROME_EXECUTABLE=/home/sinh/.nix-profile/bin/google-chrome-stable
```

Chrome is operator-owned, not bundled or provisioned. Managed commands are
`start`, `stop`, `pages`, `open URL`, `newpage URL`, `snapshot`, `click UID`,
`fill UID VALUE`, `press KEY`, `back`, `selectpage ID`, `closepage ID`.
An operation starts the isolated headless browser on demand; deployment startup
does not. The fixed shim uses flake-locked Node and MCP 1.10.1, disables MCP usage
statistics/update checks and forwards the exact operator Chrome executable.
CDP uses fixed pipe transport, not a TCP debugging listener. The shim reconstructs
private HOME/XDG/temp and mandatory telemetry/update opt-outs after SDK environment
filtering; authentication, proxy and arbitrary caller environment is not inherited.
Attach/shared/remote endpoints, personal profiles, headed/GPU launch options,
extra flags and `CHROME_DEVTOOLS_AXI_*`/`CHROME_DEVTOOLS_MCP_ARGS` overrides are
not admitted. Do not set upstream AXI environment overrides on a managed launch.

MCP's explicit page-ID routing stays enabled. First `open` without a selection,
and `newpage`, record only a unique created-page row matching the requested URL.
Redirected/ambiguous output requires explicit `selectpage ID`; `pages` and its
`[selected]` display marker never establish routing. Page-scoped commands use the
private deployment's nonce-bound selected ID. A private AXI selection mirror only
signals invalidation; it never establishes routing. Closing it, reconnecting or a
missing-page error invalidates selection without guessing or reopening another tab
in the failed invocation. Concurrent routing operations
reject rather than retarget an in-flight command.

PPA binds lifecycle identity to its own foreground/background supervisor (also
on resume); operators do not invent `PA_AXI_LIFECYCLE_PID/START`. State lives at
`$PA_DEPLOYMENT_DIR/axi-browser/`, with private profile/HOME/temp descendants
(mode 0700), mode-0600 non-symlink ownership records, distinct Linux sessions and
loopback-only bridges. Port/state collisions and foreign or reused process
identities reject before reuse/termination. Owned cleanup runs on normal exit,
cancellation and failure, independently of the 300000-ms idle shutdown.
Readiness is bounded at 30000 ms; deployment-end cleanup at 10000 ms. Never
remove a foreign profile or signal a PID merely because it appears in a file.

### Explicit profile-only quota consent

The managed public quota surface is only `quota-axi`, `quota-axi quota`,
`quota-axi --json`, or `quota-axi quota --json`, plus metadata above. Before a
read, the operator creates an absolute, operator-owned regular JSON file, exactly
mode 0600 and not a symlink (maximum 65536 bytes), then supplies its path through
`PA_AXI_QUOTA_CONSENT`. For **this exact deployment**, its complete schema is:

```json
{
  "version": 1,
  "deploymentId": "d-example",
  "providers": [
    { "id": "codex", "profilePath": "/absolute/operator-approved/codex-profile" },
    { "id": "claude", "profilePath": "/absolute/operator-approved/claude-profile" }
  ]
}
```

Use the real deployment ID; copied consent from another deployment rejects.
Select zero, one or both unique providers explicitly. Unknown fields/providers,
duplicates, relative paths, wrong version/deployment/mode/ownership, symlinks and
oversize/malformed JSON reject **before profile reads or provider requests**.
A file path alone is not consent. PPA does not create consent or credentials.

Each consented provider runs separately as
`quota --provider codex|claude --profile-only --no-credential-refresh --json`,
with only its exact `CODEX_HOME` or `CLAUDE_CONFIG_DIR`. A positive child-environment
allowlist removes other providers, operator HOME/PATH, API keys, proxy/discovery
roots and Node injection options. Only codex/claude profiles are supported; no
keychain, discovery, TUI, refresh, inference, automatic routing or public fixture
endpoint override is allowed. `QUOTA_AXI_*` and provider endpoint/base-URL
variables reject rather than becoming an escape hatch.

JSON output is parsed and allowlisted: provider ID, status/reason enums,
generated/refreshed timestamps, and window kind, percentages, spending/limits,
window duration and start/reset timestamps. Tokens, account IDs/emails, paths,
credential sources, raw errors, labels and remedy commands are omitted. Statuses
`fresh`, `stale`, `expired`, `not-configured`, `unknown`, `rate-limited`, `error`
remain distinct; missing/invalid readings never become zero usage or healthy
availability. On quota-axi 0.1.56's profile-only path, a generic authentication
denial does **not** itself establish expiry. For a single empty, non-stale
`auth_required` row only, PA checks advisory expiration in the exact consented
profile: Codex `auth.json` → `tokens.access_token` (or `accessToken`) JWT `exp`
in seconds; Claude `.credentials.json` → `claudeAiOauth` (or the root object)
`expiresAt` in milliseconds (numeric or UTC ISO timestamp), with an access token.
ID-token expiry is not access-token expiry. This means **denied authentication
plus explicit stored expiry**, not proof of the vendor's reason for denying it.
Successful quota always wins, even with advisory-expired credentials. Missing,
ambiguous or malformed expiry evidence leaves an authentication-denied row
unknown. Unsafe files fail closed before upstream access; a missing credential
file retains upstream `not-configured`, and malformed profile JSON can retain
upstream `error` (never invented expiry). PA neither verifies JWT signatures nor
downloads keys, refreshes credentials, or probes models.

After whole-consent validation, profile metadata is safety-checked before
upstream execution. Profile files must be owner-held, regular, single-link,
mode 0600 and at most 65536 bytes; directories must be owner/root-held and not
writable by others (root-owned sticky temporary ancestors are allowed). Symlinks
in any path component reject. Expiry reads are descriptor-anchored, capped,
UTF-8/JSON/JWT bounded, reject duplicate keys/nesting over 32, and require the
file metadata to remain unchanged across the upstream read and enrichment.
Keep consented profiles stable during a read: these checks do not turn the
upstream process into a filesystem sandbox against a concurrently hostile owner.
No profile contents, tokens, paths, identities or raw errors are output. An
expired profile needs operator handling outside PA; no refresh is delegated.
Hermetic smoke proves policy/schema boundaries, **not live-provider correctness,
availability or measured savings**.

### Installed-output evidence (independent review only)

The separate fail-closed smoke has exactly this CLI; it does not replace or modify
`scripts/nix-store-output-smoke.sh`:

```bash
bash scripts/axi-nix-output-smoke.sh --system x86_64-linux --eval-system aarch64-linux --all-selections --chrome /home/sinh/.nix-profile/bin/google-chrome-stable --log-file "$PA_DEPLOYMENT_DIR/evidence/pap-240-axi-smoke.log"
```

Run only under independently admitted review authority, after the approved
software checks and unchanged baseline smoke. Prerequisites: x86_64-linux host,
working Nix flakes/daemon/sandbox, Git submodules at their pins, Python 3, an
operator Chrome supporting headless mode, and unprivileged bubblewrap network/PID
namespaces with ptrace available for strace. The coordinator builds its strace
and bubblewrap from the same locked nixpkgs. No namespace/ptrace fallback or
success fixture is accepted. No real gh/provider credentials, personal browser,
provider endpoints, npm cache or global skill/hooks are needed. Build fetches are
integrity-pinned; runtime tests have no external network. The full idle case
actually waits about five minutes; it is not an optional skip.

The log path must be a **new** `.log` directly in the trusted deployment's
`evidence/` directory; a same-basename `.json` is written alongside it. Existing
files/symlinks reject to preserve prior evidence. Both are mode 0600. The real
log is bounded to 2 MiB/10000 records and contains command start/end/exit/duration
and output lengths/digests rather than raw auth/provider/browser stderr. JSON
records candidate/lock SHA, exact derivation/store paths, resolved Chrome/version,
all 8 native build/runs, 16 evaluations, 8 explicitly non-native dry-runs, all
string/integer/null selector failures, aliases/overlay defaults, pins and
installed lock/integrity/license digests/closures, selected-versus-inherited PATH,
other-adapter prefixes, plugin defaults, measured real browser isolation/lifecycle
and quota denial/status/redaction cases. The additional required
`quota-pinned-expiry` case exercises the **actual pinned CLI, providers and
serialization** with disposable synthetic Codex/Claude profiles and in-process
HTTP responses only (expired denial, unexpired/no-expiry denial, advisory-expired
success and unsafe-file denials). Generic status/redaction workers remain clearly
constructed fixtures, not actual pinned-provider acceptance. Runtime effects are observed
through strace and instrumented filesystem/subprocess/loopback HTTP boundaries;
missing or failed cases exit nonzero, with incomplete/failure JSON retained.
Raw traces, synthetic credentials and sentinel fixtures stay in a disposable
private temporary root, not durable evidence. Provider simulation/ownership and
port-race injection exist only in repository smoke helpers, never public runtime
flags; installed shims/modules and real Chrome/MCP are exercised.

Passing this smoke alone is **not final acceptance**. Independent review owns the
complete approved matrix, four native Pi-plugin/binding baseline selections and
software regressions; Sinh retains UAT/merge/return approval. PAPC-040 consumes
this binary/operator contract later and installs no skills here.

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
