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

## Git Context Panel

In an ordinary TUI session with the trusted `pi-pa` package installed, or in a managed foreground `ppa deploy` TUI session, press Alt+G or run `/pa-git-context` to toggle the same dedicated Git overlay. At 120 columns or wider it is a bounded right-side panel; below 120 columns it is centered and nearly full width. Escape or Alt+G hides it. When a hidden panel is reopened after a terminal resize, it uses the current dimensions and switches layout in either direction across the 120-column breakpoint. Panel and selector rendering is ANSI/Unicode-aware and bounded to the width Pi supplies, including at 40, 80, 119, 120, and 160 columns.

While the panel has focus, press `r` to open the reference selector. It contains concrete local branches and remote-tracking branches already present in the clone. Symbolic remote `HEAD` aliases, tags, commit SHAs, and free-form refs are excluded. Up/Down moves, Enter selects, and Escape cancels; cancellation returns focus to the open panel. Selection immediately changes the visible reference and shows `loading (pending collection)`; the actual Git collection can remain deferred by the 10-second limiter. The choice is written atomically to `<canonical-repository-root>/<CONFIG_DIR_NAME>/pa-git-context.json` (normally `.pi/pa-git-context.json`) with owner-only file permissions. Temp creation, replacement, and cleanup stay relative to one validated open configuration-directory identity; replacing the lexical `.pi` path immediately before temp creation therefore cannot redirect data or cleanup into the replacement target. If the runtime platform cannot provide the guarded descriptor-relative primitive, persistence fails closed before creating a temp file. If persistence otherwise fails, the prior valid panel state remains visible. This approved project-local file is an observable side effect and can make the worktree appear untracked or modified. The extension never edits `.gitignore` or `.git/info/exclude`. Missing or malformed state is ignored safely. A concurrently replaced config path, non-canonical repository path, symlinked configuration directory, symlinked state file, or other canonical path escape is rejected or remains bound to the previously validated directory without reading, creating, replacing, or removing a file in an external target.

A valid saved selection is restored in an independent Pi session. If no valid saved ref exists, resolution is exactly: the locally detected default branch, local `develop`, locally present `origin/develop`, then `unavailable`. A missing saved ref follows that fallback without rewriting the state file; fallback is never persisted as if the user selected it.

The comparison is committed-only. The collector finds the selected reference's merge base with `HEAD`, then displays:

- active and reference branch names;
- the newest 10 commits from `merge-base..HEAD`, each with short hash, subject, author, and ISO date, plus exact total and truncated counts;
- aggregate committed insertions/deletions; and
- the first 20 deterministically sorted committed file rows, plus exact total and truncated counts.

Rename rows render as `old → new`, binary rows render as `binary`, and NUL-delimited Git output preserves spaces, tabs, Unicode, and newline-capable paths (control characters are made single-line for display). Deleted files remain in the committed file rows. Staged, unstaged, untracked, and other worktree-only changes are not included.

Collection starts on first open and is requested after reference changes and eligible tree/turn events. Requests are coalesced so no more than one refresh starts per 10,000 ms; reference selection updates the visible pending state immediately, while the cadence can defer the requested collection start. One complete collection attempt has a 2,000 ms total deadline, not a separate deadline per Git command. The panel names `non-git`, `detached-head`, `unborn-head`, `missing-ref`, `missing-merge-base`, `git-error`, `timeout`, and `unavailable` states. An initial failure shows no invented branch, commit, diff, or file data. If a successful snapshot already exists, a later timeout or Git error retains that snapshot and visibly marks it `stale` with the cause. This recovery snapshot also survives the immediate selected-reference pending state: if its cadence-deferred attempt times out or returns a Git error, the prior successful comparison reappears as stale. Shutdown, session replacement, and `/reload` cancel selectors, dispose cadence timers, hide overlays, and reject late results or overlay handles from the old session.

All runtime Git argv are fixed or selected from enumerated refs and use only read operations (`rev-parse`, `symbolic-ref`, `for-each-ref`, `merge-base`, `rev-list`, `log`, and `diff`). The panel never fetches, so remote-tracking choices reflect only local clone state; it never checks out, switches, stages, adds, commits, resets, or intentionally writes under `.git`.

RPC mode can emit the `PA Git context requires TUI mode.` warning but opens no custom component. JSON and print modes also open no component; because those modes have no UI, they do not display the warning.

## Compatibility, Reuse, and Collisions

The package targets Node.js 22.19.0 or later and Pi 0.80.8 or later. The question, todo, status, and overlay implementations adapt the MIT-licensed Pi 0.80.8 examples `examples/extensions/question.ts`, `todo.ts`, `status-line.ts`, and `overlay-qa-tests.ts`; comments in the source identify intentional PA changes.

An ordinary session can load unrelated extensions that also register `question`, `todo`, `/pa-context`, `/pa-git-context`, Alt+I, or Alt+G. Pi keeps duplicate extension commands and assigns numeric invocation suffixes in load order (for example, `/pa-git-context:1` and `/pa-git-context:2`). For duplicate extension shortcuts, Pi emits a collision diagnostic and the later-loaded shortcut wins; an allowed built-in shortcut conflict is also diagnosed, while a restricted built-in shortcut cannot be overridden. Remove, disable, or reorder the conflicting ordinary-session extension when deterministic routing is required. The selector's plain `r` binding applies only while the Git panel is focused.

Alt+I and `/pa-context` remain independent from Alt+G and `/pa-git-context`: toggling or cleaning up one PA panel does not invoke or dispose the other. Managed PPA deployments avoid unrelated extension collisions by loading `--no-extensions` plus exactly the trusted `pi-pa` extension path.

## Failure Diagnostics

Foreground deployments run Pi through a Node pseudo-terminal. Keyboard input,
terminal resize, and SIGINT are relayed to the child, while terminal output is
shown live. Log redaction carries bounded overlap across arbitrary PTY chunks,
so callback boundaries cannot expose a split configured value, bearer value, or
assignment-shaped credential. Redacted output is persisted in the deployment's
`pi.log`, `pi-output.jsonl`, and activity timeline; activity error bodies are
bounded to 2,000 characters.

The trusted PA extension writes each terminal `agent_end` result to an atomic,
permission-restricted `pi-terminal-status.json` side channel in the deployment
directory. Foreground supervision consumes this structured status instead of
trying to parse rendered TUI output. PPA reports failure for a non-zero Pi
process exit or `stopReason: "error"`, even if Pi exits with status 0. The
redacted terminal error is retained as activity evidence. A normal terminal
stop with exit status 0 remains successful.

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
