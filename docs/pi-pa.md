# Pi Integration

`ppa` supports Pi 0.80.8 or newer. It does not install Pi, configure authentication, or copy credentials.

## Setup

Register the trusted `pi-pa` extension and the live `pa-platform-config` checkout in Pi's package settings:

```bash
ppa pi setup                 # user-global: ~/.pi/agent/settings.json
ppa pi setup --local         # project-local: .pi/settings.json
ppa pi status
ppa pi remove                # remove only the two PA package entries
```

Setup is confirmation-gated and idempotent. `--local` changes only the current project's settings. Removal preserves other Pi packages. The configured package sources are shown by `ppa pi status`; the extension source is the installed `pi-pa` package and the config source is `PA_PLATFORM_CONFIG_DIR`, `PA_PLATFORM_HOME`, or the current directory.

After editing skills or package metadata in the config checkout, run `/reload` in an active Pi session. New ordinary sessions discover the current files without reinstalling the packages.

## Managed Deployments

`ppa deploy` is isolated from ordinary Pi discovery. A managed deployment receives exactly the selected PA skills and the trusted PA extension through explicit resource arguments; it does not load unrelated user or project Pi skills/extensions. A setup registration does not weaken this isolation. The same trusted entrypoint registers the existing `pa_ticket`, `pa_bulletin`, `pa_registry`, and `pa_status` tools plus the interactive tools and context UI below.

Pi provider/model precedence is explicit CLI flags, the selected flat mode pair (`deploy_modes[].provider` and `deploy_modes[].model`), then the PPA adapter default. A mode must provide both fields or neither. Pi remains an optional runtime; OpenCode remains the default when no runtime is selected.

## OpenAI-to-Codex Mapping

PPA applies this normalization only after Pi runtime precedence has resolved the
effective provider/model pair. The mapping is provider-bound and does not change
OpenCode, Claude Code, Droid, or other non-Pi runtime values:

| Effective provider | Effective model | Pi command values |
| --- | --- | --- |
| `openai` | `openai/gpt-5.6-sol` | `openai-codex` / `gpt-5.6-sol` |
| `openai` | `openai/<model>` | `openai-codex` / `<model>` |
| `openai` | `<model>` | `openai-codex` / `<model>` |
| `openai-codex` | `openai/<model>` | `openai-codex` / `<model>` |
| `openai-codex` | `<model>` | `openai-codex` / `<model>` |
| any other provider | any model | provider and model unchanged |

Only one leading `openai/` model prefix is removed. PPA defaults to configured `openai` / `openai/gpt-5.6-sol` when the flat pair is
absent, so Pi-local configuration cannot silently select Luna. Empty values
remain omitted only for direct low-level session-command callers; managed
`ppa deploy` resolves a complete pair before spawn.

The same normalized values are used in both command paths:

- Managed `ppa deploy` command construction.
- Pi Agent API/session command construction, including resumed sessions.

PPA does not install, provision, or manage OpenAI/Codex authentication. The
operator must authenticate Pi separately with the `openai-codex` provider. The
normalization changes identifiers only; it does not select a fallback model or
alter credentials.

## Interactive Tools

### Structured questions

The sequential `question` tool accepts a question, an optional short header, Pi-style `{ label, description? }` options, and `multiple: true|false`.

- Single-select returns one predefined answer or one non-empty custom answer.
- Multi-select combines zero or more predefined answers with at most one custom value.
- Escape returns a typed cancelled outcome.
- TUI interaction is unavailable in RPC, JSON, and print modes; those modes return immediately with a typed `ui_unavailable` outcome and never wait for terminal input.
- Empty option lists return a validation outcome without opening a component.

Result details distinguish selected options, custom input, cancellation, unavailable mode, and successful answers. Text sent to the model is bounded to 50 KiB and 2,000 lines and includes a truncation marker when shortened.

### Session todos

The sequential `todo` tool supports `list`, `add`, `update`, `start`, `complete`, `cancel`, and `reorder`. Tasks have monotonic session-local numeric IDs, stable order, status, text, and dependency IDs. Only one task can be `in_progress`; starting another returns the prior active task to `pending`. Completed and cancelled tasks are terminal and cannot be reopened or edited.

Unknown IDs, self-dependencies, dependency cycles, incomplete dependencies, and invalid terminal mutations are rejected atomically. Every result stores the complete task snapshot and next ID in structured details. Pi reconstructs the latest snapshot on the active session branch after reload, resume, and tree navigation. A separate/new session starts empty. Todos are not written to an external file or synchronized between sessions. Full structured snapshots intentionally have no fixed task or text limit, so very large lists can increase Pi session-file size; textual tool output remains bounded to 50 KiB and 2,000 lines.

## Context Status and Sidebar

The extension uses Pi's additive `setStatus` API, so Pi's built-in footer remains installed. Compact status includes available PA deployment/team/mode/ticket identity, provider/model, repository, Git branch/dirty state, and todo progress/active task. Ordinary sessions explicitly show PA as unavailable while retaining model, repository/Git, and todo context.

Run `/pa-context` or press Alt+I to toggle the same initially hidden, right-anchored details sidebar. It is visible only at terminal widths of 120 columns or greater; compact status remains available on narrower terminals. Escape or Alt+I hides it. Rendered lines use Pi's ANSI/Unicode-aware width utilities.

Relevant session, model, todo, tree, and turn events are coalesced to at most one refresh per two seconds. Git and deployment lookups each have a 500 ms deadline. A timed-out lookup retains the prior value with a `stale` label. Timers and overlays are disposed on session shutdown or reload; the extension starts no daemon or external server.

## Compatibility, Reuse, and Collisions

The package targets Node.js 22.19.0 or later and Pi 0.80.8 or later. The question, todo, status, and overlay implementations adapt the MIT-licensed Pi 0.80.8 examples `examples/extensions/question.ts`, `todo.ts`, `status-line.ts`, and `overlay-qa-tests.ts`; comments in the source identify intentional PA changes.

An ordinary session can load unrelated extensions that also register `question`, `todo`, `/pa-context`, or Alt+I. Pi applies its normal collision behavior (including suffixed duplicate command names where supported). Remove or disable the conflicting ordinary-session extension if deterministic names are required. Managed PPA deployments avoid this ambiguity by loading `--no-extensions` plus exactly the trusted `pi-pa` extension path.

## Failure Diagnostics

Foreground deployments run Pi through a Node pseudo-terminal. Keyboard input,
terminal resize, and SIGINT are relayed to the child, while terminal output is
shown live. On settlement, PPA removes its input, resize, and signal listeners,
restores the prior terminal raw mode, and pauses stdin only when attaching PPA's
input listener started the stream flowing. An already-flowing or already-paused
caller-owned stdin state is preserved. This ownership-aware restoration lets the
wrapper exit naturally after child-exit evidence and cleanup even when its parent
keeps the stdin writer open; PPA does not force termination with `process.exit()`.

Log redaction carries bounded overlap across arbitrary PTY chunks, so callback
boundaries cannot expose a split configured value, bearer value, or
assignment-shaped credential. Redacted output is persisted in the deployment's
`pi.log`, `pi-output.jsonl`, and activity timeline; activity error bodies are
bounded to 2,000 characters.

The trusted PA extension writes each terminal `agent_end` result to an atomic,
permission-restricted `pi-terminal-status.json` side channel in the deployment
directory. Foreground supervision consumes this structured status instead of
trying to parse rendered TUI output. Wrapper settlement is controlled by PTY
exit or process-disappearance evidence plus resource cleanup, independently of
whether rendered Pi output is valid JSON, non-JSON terminal text, a differently
shaped JSON value, or a recognized activity event. Activity normalization and
persistence remain observability paths; recognized activity is not a prerequisite
for wrapper termination.

PPA reports failure for a non-zero Pi process exit or `stopReason: "error"`, even
if Pi exits with status 0. The redacted terminal error is retained as activity
evidence. A normal terminal stop with exit status 0 remains successful.

Foreground failure paths use one exact-once cleanup state machine. Persistence
and terminal relay errors, timeouts, and interrupts request termination, wait
for the PTY exit event, escalate from SIGTERM to SIGKILL after a grace period,
and restore input listeners and raw mode before settling. The terminal registry
marker is emitted exactly once.

## Migration

Replace every team- or mode-level `runtimes` block with flat mode fields. Use
both fields for an explicit pair, for example `provider: openai` and `model:
openai/gpt-5.6-sol`, or omit both to use the selected adapter default. Run
`ppa deploy <team> --validate` after migration; partial pairs and removed maps
are rejected with their YAML paths.

Existing `ppa deploy` users can run `ppa pi setup` once at the desired scope. Existing Pi settings and packages are retained. To move from global to project-local registration, run `ppa pi setup --local`, verify with `ppa pi status --local`, then run `ppa pi remove` globally if the global registration is no longer wanted.

## Troubleshooting

- `Pi version must be 0.80.8 or later`: upgrade Pi and ensure `pi --version` is available on `PATH`. The version probe allows up to 15 seconds for a loaded system to start Pi.
- `Pi PA extension package path is missing`: reinstall/build pa-platform or use the current packaged `ppa`; inspect the path printed by `ppa pi status`.
- `PA config package path is missing`: set `PA_PLATFORM_CONFIG_DIR` to the existing `pa-platform-config` checkout.
- Skills changed but Pi still shows old content: run `/reload`; managed deployments pick up changes on their next invocation.
- Setup says `Already configured`: the two paths are already present. Use `ppa pi status` to inspect them.

The Nix output includes the `pi-pa` extension and runtime-host resources under `$out/share/pa-platform/packages/`, plus `ppa.fish` under `$out/share/fish/vendor_completions.d/`. It does not include the operator's config checkout or credentials.
