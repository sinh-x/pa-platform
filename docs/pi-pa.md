# Pi Integration

`ppa` supports Node.js 22.19.0 or newer and Pi 0.84.4 or newer. It does not install Pi, configure authentication, or copy credentials.

## Setup

Register the trusted `pi-pa` extension and the live `pa-platform-config` checkout in Pi's package settings:

```bash
ppa pi setup                 # user-global: ~/.pi/agent/settings.json
ppa pi setup --local         # project-local: .pi/settings.json
ppa pi status
ppa pi remove                # remove only the two PA package entries
```

Setup is confirmation-gated and idempotent. `--local` changes only the current project's settings. It owns exactly two package entries: the installed `pi-pa` package and the resolved PA config package. Enabled editor plugins are bundled inside `pi-pa`; they are not separate package entries. Existing unrelated settings and packages are preserved, and `ppa pi remove` removes only the two PA-owned entries. The configured package sources are shown by `ppa pi status`; the extension source is the installed `pi-pa` package and the config source is `PA_PLATFORM_CONFIG_DIR`, `PA_PLATFORM_HOME`, or the current directory.

Both ordinary sessions configured this way and managed deployments load the same trusted `pi-pa` entrypoint, so both receive the PA modules and the editors selected in the installed build. Ordinary Pi sessions can still discover other packages and extensions according to Pi's normal rules.

After editing skills or package metadata in the config checkout, run `/reload` in an active Pi session. New ordinary sessions discover the current files without reinstalling the packages.

## Managed Deployments

`ppa deploy` is isolated from ordinary Pi discovery. Every managed Pi argv has one `--no-extensions`, exactly one `--extension` naming the trusted `pi-pa` entrypoint, and no discovered user or project extensions. A managed deployment receives only the selected PA skills through explicit resource arguments. A setup registration does not weaken this isolation. The same trusted entrypoint registers the existing `pa_ticket`, `pa_bulletin`, `pa_registry`, and `pa_status` tools plus question, todo, terminal status, safety interception, and the context UI below.

Pi provider/model precedence is explicit CLI flags, the selected flat mode pair (`deploy_modes[].provider` and `deploy_modes[].model`), then the PPA adapter default. A mode must provide both fields or neither. Pi remains an optional runtime; OpenCode remains the default when no runtime is selected.

Print, JSON, and RPC execution loads the same extension and commands but does not install an editor, open an overlay, or wait for terminal input. `question` returns a typed `ui_unavailable` result outside TUI mode. PA tools, output bounds, tool-call guards, and terminal result handling remain active.

The native `pa_ticket` tool accepts the typed actions `read`, `show`, `list`, and `comment`. `read` is an exact read-only alias for `show`; only `comment` mutates ticket data and it retains ticket-store serialization. Unknown actions report the accepted action set. Safety interception evaluates declared path fields and bounded shell operands rather than arbitrary question or todo prose. Direct shell deletion remains denied with a complete `ppa trash move <target> --reason '<non-empty>' --yes` alternative.

## Treehouse-backed builder ticket checkouts

PPA uses the pinned Treehouse v2.3.0 CLI as the checkout lifecycle manager while
PA remains authoritative for ticket branch intent, repository identity, launch
admission, concurrency, and deployment evidence. PPA intentionally has no
worktree create/list/return/prune/destroy commands and does not merge, rebase,
delete branches, clean checkouts, or claim filesystem sandboxing.

### Prepare the ticket branch intent

Requirements analysis is plan-first. It runs read-only at the canonical repository
root and records only the canonical repository key/root, exact ticket, approved
full base SHA, exact feature branch, `planned` state, and `create` action. It does
not require or accept a builder checkout, worktree, lease, holder, ticket slot,
or repository permit, and it performs no Treehouse lifecycle or branch action.
After approval, the trusted PPA builder/orchestrator launcher owns capacity
reservation, checkout acquire-or-reuse and authentication, exact branch
action, durable correlation, and implementation spawn. OPA/OpenCode and
CPA/Claude Code retain non-Treehouse behavior and make no Treehouse claim.

Record exactly one ticket branch before launch:

```bash
ppa ticket update PAP-189 --linked-branch 'pa-platform|feature/PAP-189-treehouse-workflow'
```

If the local branch is absent, this records `planned` intent without changing
Git. If it exists, PPA records authenticated `materialized` evidence. The same
ticket entry is promoted during checkout preparation; immutable `baseSha` and
refreshable authenticated `headSha` remain the sole branch correlation record.
Legacy linked branches and registry rows remain readable.

### Launch paths

For the canonical path, start the orchestrator from the registered repository
and identify it explicitly:

```bash
cd /registered/canonical/repository
ppa deploy builder --mode orchestrator --ticket PAP-189 --repo pa-platform
```

PPA atomically reserves the ticket and one of four repository permits before it
calls Treehouse. It derives holder `pa:pa-platform:PAP-189`, reuses exactly one
matching lease or runs bounded `treehouse get --lease --lease-holder ... --json`,
authenticates the returned physical linked worktree, and materializes or selects
the ticket branch there. For this authenticated Treehouse builder flow only,
Pi's CWD, `PA_REPO`, and `PA_WORKTREE_ROOT` are that exact checkout. Canonical
identity remains separately available as immutable plan `repoRoot`, deployment
and registry `repo_root`, and repository lease evidence. Canonical branch, HEAD,
and raw porcelain-v2 bytes must remain unchanged.

An operator may instead prepare the lease with Treehouse v2.3.0, `cd` to its
exact physical root, and omit `--repo`:

```bash
treehouse get --lease --lease-holder pa:pa-platform:PAP-189 --json
cd /exact/path/reported/by/treehouse
ppa deploy builder --mode orchestrator --ticket PAP-189
```

PPA never accepts an explicit worktree path. It requires one matching lease and
checks path, lease ID, holder, Git top-level, Git dir/common dir, registered
worktree membership, ticket branch, and HEAD before runtime preflight or spawn.
The launcher and adapter also require Treehouse path, runtime CWD, `PA_REPO`,
`PA_WORKTREE_ROOT`, protected background configuration, and parent registry
execution path to agree exactly before Pi/native-host preflight or child spawn.
Missing, canonical-root, relative, stale, or conflicting runtime path evidence
fails closed while preserving the Treehouse checkout and branch.
Treehouse v2.3.0 free status rows are valid when their non-`leased` status is
paired with `lease_id: ""`, `lease_holder: ""`, and `leased_at: null`; PPA then
makes exactly one bounded lease-acquisition call. Leased rows still require a
complete non-empty lease ID and holder. Contradictory, malformed, duplicate,
unexpected, truncated, or over-1-MiB JSON fails closed; human output is not
evidence. A branch/HEAD/status drift or partial failure
starts no Pi worker, automatically finalizes only matching PA evidence, and
preserves the Treehouse lease and branch for inspection. Diagnostics name the
condition, source, reason, correction, and resume action and are bounded to
2,000 characters.

Only one live builder launch is allowed for a repository/ticket, with at most
four distinct live ticket builders per canonical repository. Persistent inactive
Treehouse leases do not consume those four PA permits. A direct parented
`builder/implement` must be launched in background by its live orchestrator and
may use either `--repo <registered-key>` or `--repo <exact-canonical-root>` to
identify the parent's canonical repository. Those values are identifiers only:
protected live-parent evidence selects the existing authenticated worktree, and
the child runtime CWD, `PA_REPO`, `PA_WORKTREE_ROOT`, registry `repo`, execution
root, and memory root all remain that worktree. Registry/plan `repo_root` remains
canonical. There is no canonical-root child execution mode.

The parented child must exactly match the parent's ticket, checkout, lease,
branch, Git identity and full HEAD, slot, permit, lineage, CWD, and protected
environment. It reuses those values and performs no second checkout acquisition,
branch selection/materialization, ticket-slot reservation, repository-permit
reservation, or lineage creation. All protected sources are reread immediately
before spawn. Wrong, ambiguous, linked-worktree, nested, symlinked, unrelated,
or drifted selectors/evidence fail before child spawn with a redacted five-field
diagnostic bounded to 2,000 characters.

A standalone ticketed `builder/implement` remains allowed only when launched
from the matching free leased checkout, with `--repo` omitted and no live owner;
explicit keys, paths, and canonical-root execution still reject. OPA/OpenCode
and CPA/Claude Code behavior is unchanged and makes no Treehouse claim.
Canonical-root, wrong-checkout, duplicate-ticket, fifth-ticket, or
mismatched-parent attempts fail before Pi spawn. Requirements and non-builder
modes retain their existing canonical/linked CWD behavior and do not enter this
ticket-checkout acquisition flow.

Verified success, failure, or crash handling refreshes authenticated `headSha`
and finalizes PA ticket/worktree slots, permits, mutation leases, and borrowers.
It never returns the Treehouse checkout.

### Conditional return requires Sinh's fresh approval

Return is a separate operator-approved action, never deploy cleanup. First prove
there is no live PA owner, Git is clean and committed, and freshly display the
exact repository key/root, ticket, physical path, branch, full HEAD, lease ID,
and holder. Ask Sinh interactively for fresh approval of those exact values and
persist that approval and all identities in a durable ticket comment. If the
approval, comment, or any identity check is missing or changed, stop and retain
the lease.

Only after those gates may the agent make one non-force conditional attempt:

```bash
treehouse return --if-lease-id <exact-lease-id> --if-lease-holder <exact-holder> <exact-physical-path>
```

Never add `--force`, and never invoke return automatically. A nonzero result
preserves the lease and is reported as a blocker; PPA provides no lifecycle
command to retry, prune, or destroy it.

### PAP-189 implementation evidence

| Acceptance criterion | Disposable evidence |
| --- | --- |
| AC1 | `linked-branch-lifecycle.test.ts` and `treehouse-ticket-concurrency.test.ts`: planned promotion, immutable base/head, exact local develop, canonical byte snapshot. |
| AC2 | `pi-treehouse.test.ts`: zero-lease acquire, sole-lease reuse, physical checkout plan/CWD/environment, branch materialization. |
| AC3 | `pi-treehouse.test.ts`: operator-prepared authentication plus malformed, duplicate, path, parent, and pre-spawn drift rejection. |
| AC4 | `treehouse-ticket-concurrency.test.ts` and `pi-treehouse.test.ts`: duplicate/fifth and concurrent cap, terminal/crash PA finalization with Treehouse lease retained. |
| AC5 | `pi-treehouse.test.ts`: parented exact-match/mismatch and standalone linked-checkout/canonical-root admission. |
| AC6 | `primer.test.ts`, `cli-core-command.test.ts`, and `pi-treehouse.test.ts`: fresh approval, durable comment, conditional non-force guidance, and no automatic return call. |
| AC7 | `registry.test.ts`, `deploy-status.test.ts`, `agent-api.test.ts`, and existing PPA deploy suites: optional projections, pre-change migrations, requirements/non-builder, canonical, and linked-worktree regressions. |

All named fixtures create temporary Git repositories, Treehouse responses, PA
homes, ticket stores, and registry databases. They do not use or return a live
Treehouse checkout.

### PAP-215 plan-first integration evidence

PAP-215 pins merged `pa-platform-config/develop` commit
`d82429b9f88efadba5ddafa1829e250f5731ad02`. Paired validation generates the
`requirements/analyze`, `requirements/analyze-auto`, and `requirements/spike`
primers and requires canonical ticket/base/branch planning, zero
requirements-time checkout prerequisites, builder-owned materialization,
one-lineage/four-ticket capacity, operator-only return, and non-Pi/runtime
boundaries. A negative fixture restores a stale operator-prepared-checkout
prerequisite and must be rejected. This paired evidence does not itself prove
PAP-189 runtime enforcement or grant post-cap review authority.

## Bundled Editor Selection and Composition

> **Breaking default:** both bundled editor plugins are disabled unless the Nix package is constructed with explicit options. Updating the flake input without opting in removes the former always-enabled editor behavior. Selection happens only while building the package; `ppa`, Pi, environment variables, and runtime configuration cannot enable a plugin in an already-built output.

Use `lib.mkPaPlatform system { ... }` and install the resulting package. The existing `packages.<system>.pa-platform`, `ppa`, `default`, and overlay aliases deliberately select neither plugin. These are the four supported constructor combinations; copy exactly one definition into the `let` bindings of the consumer flake's `outputs` function (where the input is named `pa-platform` and `system` is the target Nix system):

```nix
# Neither plugin (the default).
ppaPackage = pa-platform.lib.mkPaPlatform system { };
```

```nix
# pi-vimmode only.
ppaPackage = pa-platform.lib.mkPaPlatform system {
  enablePiVimMode = true;
};
```

```nix
# proper-base only.
ppaPackage = pa-platform.lib.mkPaPlatform system {
  enableProperBase = true;
};
```

```nix
# Both plugins.
ppaPackage = pa-platform.lib.mkPaPlatform system {
  enablePiVimMode = true;
  enableProperBase = true;
};
```

For example, a flake can expose the selected package for inspection and also add it to a NixOS configuration:

```nix
{
  inputs.pa-platform.url = "github:sinh-x/pa-platform";

  outputs = inputs@{ self, nixpkgs, pa-platform, ... }:
    let
      system = "x86_64-linux"; # or "aarch64-linux"
      ppaPackage = pa-platform.lib.mkPaPlatform system {
        enablePiVimMode = true;
        enableProperBase = true;
      };
    in {
      packages.${system}.ppa = ppaPackage;
      nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit inputs; };
        modules = [
          ({ ... }: { environment.systemPackages = [ ppaPackage ]; })
        ];
      };
    };
}
```

Replace `my-host` and the system with the consumer's own values. After changing the input or options, update the lock and rebuild the selected consumer output:

```bash
nix flake lock --update-input pa-platform
nix eval --raw '.#ppa.drvPath'
out=$(nix build --no-link --print-out-paths '.#ppa')
# NixOS consumers can then apply the same evaluated package:
sudo nixos-rebuild switch --flake '.#my-host'
```

A build with both plugins registers `pi-vimmode` 0.9.0 first and `proper-base` 0.5.0 second. proper-base therefore remains the outer editor wrapper around the Vim editor. A one-plugin build registers only that factory; a default build retains Pi's base editor. Startup, resource discovery, `/reload`, new/resumed/forked sessions, and shutdown retain one active selected editor chain; cleanup removes stale handlers, timers, overlays, and cursor state before replacement. The selected upstream sources and defaults are bundled unchanged.

When selected, pi-vimmode starts in **insert** mode. Press Esc for normal mode and `i` to return to insert mode. Its supported motions, edits, visual modes, registers, marks, macros, prompt search, and Ex-style commands retain upstream 0.9.0 behavior. `/vimmode`, `/vimmode on`, `/vimmode off`, `/vimmode status`, and `/vimmode reload` control the current runtime. This is practical modal prompt editing, not a claim of complete Vim compatibility. JSON settings remain under the `piVimMode` key; start mode, cursor style, keymap, protected overrides, status items, and other defaults are unchanged.

When selected, proper-base keeps its 0.5.0 defaults for automatic session titles, model-preserving `/clear`, project prompt history and reverse search, prompt editing/cancellation, autocomplete, collapsed settled tool rows, transcript navigation, footer composition, image handling through packaged `sharp`, skill/image context transforms, and its commit-command guard. Internal commands beginning with `__proper-` remain reserved. PA's destructive-command and sensitive-path interception still runs independently, so the bundled editor cannot bypass PA tool-call policy.

### Verify the built artifacts and runtime

The following inspection is read-only and uses the Node 22 executable from the built package. Change the two expected names to match the chosen combination and do not inspect implementation source:

```bash
export OUT="$out"
export EXPECTED='["pi-vimmode","proper-base"]' # [], either one, or both in this order
"$OUT/bin/pa-platform-node" --input-type=module --eval '
  const { existsSync, readFileSync } = await import("node:fs");
  const root = `${process.env.OUT}/share/pa-platform/packages/pi-pa`;
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const provenance = JSON.parse(readFileSync(`${root}/dist/pi-extension/vendor/provenance.json`, "utf8"));
  const expected = JSON.parse(process.env.EXPECTED);
  const imports = { "pi-vimmode": "#pi-pa-vimmode", "proper-base": "#pi-pa-proper-base" };
  if (JSON.stringify(provenance.selectedSources) !== JSON.stringify(expected)) process.exit(1);
  for (const name of Object.keys(imports)) {
    const enabled = expected.includes(name);
    const bundle = `${root}/dist/pi-extension/vendor/${name}.js`;
    const license = `${root}/dist/pi-extension/vendor/licenses/${name}-LICENSE.txt`;
    if (existsSync(bundle) !== enabled || existsSync(license) !== enabled || Object.hasOwn(pkg.imports, imports[name]) !== enabled) process.exit(1);
  }
  console.log({ output: process.env.OUT, selected: expected, imports: pkg.imports });
'
PAP167_REAL_PI="$(command -v pi)" "$OUT/bin/ppa" pi preflight
PAP167_REAL_PI="$(command -v pi)" "$OUT/bin/ppa" pi smoke-tools
```

The preflight must report the packaged Pi-host addon and a Node 24 host. `smoke-tools` must report all eight managed PA tools as passed. Its factory and command evidence is exact and ordered for each choice:

| Choice | `extension.factories` | `extension.commands` |
| --- | --- | --- |
| Neither | `[]` | `["pa-context","pa-git-context"]` |
| pi-vimmode only | `["pi-vimmode@0.9.0"]` | `["vimmode","pa-context","pa-git-context"]` |
| proper-base only | `["proper-base@0.5.0"]` | `["fast-global","__proper-restore-model","clear","__proper-cancel-prompt","pa-context","pa-git-context"]` |
| Both | `["pi-vimmode@0.9.0","proper-base@0.5.0"]` | `["vimmode","fast-global","__proper-restore-model","clear","__proper-cancel-prompt","pa-context","pa-git-context"]` |

After `ppa pi setup`, start a new Pi session or run `/reload`. `/vimmode status` exists only when pi-vimmode was selected; proper-base-only behavior can be checked with its model-preserving `/clear` and prompt history. Neither command should be attributed to a disabled plugin.

## State and Removal Ownership

Pi state and proper-base state belong to the selected Pi user agent directory (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`), not to the PA package registration. The pinned, unmodified pi-vimmode v0.9.0 configuration paths are an upstream exception and remain fixed under `~/.pi/agent`.

- proper-base writes one private JSONL file per encoded working-directory key under `proper-history/`. It loads at most 200 entries, skips prompts longer than 4,096 characters, reads at most the newest 512 KiB at startup, and compacts stores over 2 MiB to the newest 2,000 valid entries. Delete one file to forget one project key, or the directory to forget all proper-base history.
- pi-vimmode reads `piVimMode` JSON settings from `~/.pi/agent/settings.json` and may load the operator-owned `~/.pi/agent/pi-vimmode.config.js` trusted JavaScript file. These fixed paths do not follow `PI_CODING_AGENT_DIR`. The JavaScript file is unsandboxed user code. Use `/vimmode reload` after changing it.
- Git context selection remains project-owned under the guarded Pi project configuration directory documented below. Todos remain authoritative session-branch state inside Pi's session file. Managed deployments additionally publish the latest complete active-branch state to the private status sidecar documented below; ordinary sessions do not.

`ppa pi setup`, `status`, and `remove` own only the two package entries described above. Removal preserves extension state, Git context selection, todos, sessions, and unrelated packages.

## Existing Linked-Worktree Deployments

Run `ppa deploy` without `--repo` from an existing Git linked-worktree root or
any physical descendant to keep Pi in that exact worktree. PAP-195 supersedes
PAP-162's linked-worktree prohibition only for this authenticated PPA
CWD-inference path; explicit inputs and non-Pi adapters retain the prior
restriction. PPA authenticates the
worktree by its physical Git directory, common directory, reciprocal `.git`
metadata, and exact membership in the registered primary checkout's physical
`git worktree list`, then requires the common directory to identify exactly one
registered primary repository. PA does not create, switch, move, prune, lock, unlock, or
remove a worktree or branch.

For every authenticated linked-worktree launch, the two roots retain deliberately
different identity domains:

- `repo_root` identifies the registered primary repository and remains the
  canonical trust anchor.
- `worktree_root`, `PA_REPO`, `PA_WORKTREE_ROOT`, `repositoryCwd`, registry
  `repo`, project and memory access, Git snapshots, and Pi process CWD identify
  the selected execution worktree.
- Canonical registry/configuration evidence is compared only with the registered
  key/root pair. Runtime evidence is compared only with authenticated
  `worktree_root`; the two roots are not required to be the same path.
- Explicit `--repo <registered-key-or-primary-path>` ordinarily executes at the
  primary root, even when invoked from a linked worktree. The sole exception is
  the authenticated direct background PPA `builder/implement` path described
  above: key or exact canonical root identifies the protected parent repository,
  while execution remains exclusively in the parent's worktree. Explicit
  worktree paths remain invalid, and this exception creates no canonical
  execution mode.

Authenticated linked worktrees may be dirty for foreground or background PPA
launches. Admission records branch, full HEAD, and staged/unstaged/untracked
state without changing files. Ownership evidence is stored under the physical
per-worktree Git directory, never beneath the worktree's `.git` file. One live
`builder/orchestrator` and one live implement-slot deployment may coexist in an
exact linked worktree; every other builder mode shares the implement slot.
Sibling worktrees have independent slots. Token-verified transfer, borrowing,
and cleanup affect only the exact slot and worktree.

Primers, environment, background configuration, registry start events, default
status detail, and runtime spawn evidence carry both roots. `PA_REPO` is
execution-scoped to `worktree_root`, while canonical identity remains
`repo_root`. `ppa status <id>` shows `Repo Root`, a distinct `Worktree`, and
`Repo Slot` when recorded. OPA,
CPA, and DPA retain their prior repository behavior.

## Orchestrator Branch Reconciliation

A foreground Pi `builder/orchestrator` has two supported direct-child entry
paths. It may launch already on a clean exact ticket branch in the registered
primary root or an authenticated linked worktree; ordinary borrower admission
then leaves the parent lease bytes unchanged. It may instead launch only at the
registered primary root on clean configured `develop` synchronized with the
local `origin/develop` remote-tracking ref, create the exact branch with the
existing `ppa branch create` command or select an existing exact branch with
`git switch`, and request one direct background `builder/implement` child
without restarting the orchestrator.

The child-admission gate, not the launcher, authenticates that one-way change.
Under the repository mutex it rechecks parent process lineage and registry
state, primary-root and physical Git identity, the same parent/child ticket,
both configured feature-branch patterns (execution repository and ticket
project), complete clean Git evidence, borrower/slot exclusion, and the immutable
launch-time local develop/remote-tracking HEAD pair plus a no-drift reread. It performs no fetch or other network access and
never creates, switches, cleans, stashes, resets, commits, or discards work. A
new branch may retain develop's HEAD; an existing branch may have another exact
40-lowercase-hex HEAD.

Successful reconciliation replaces only the parent's authoritative Git snapshot
and publishes borrower evidence carrying that same complete snapshot. Both
mode-`0600` files remain within the 65,536-byte evidence limits. Replacement and
publication are one logical transaction: publication failure removes no
unrelated evidence, restores the prior parent bytes exactly, and spawns no
runtime. Dirty or stale states, missing local remote refs, ticket/pattern
mismatch, repeated transitions, linked-worktree transitions, physical identity
drift, and live ownership conflicts fail with bounded structured recovery
diagnostics before spawn. This transition path is Pi-only and does not broaden
OPA, CPA, or DPA policy.

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

Unknown IDs, self-dependencies, dependency cycles, incomplete dependencies, and invalid terminal mutations are rejected atomically. Every result stores the complete task snapshot and next ID in structured details. Pi reconstructs the latest snapshot on the active session branch after reload, resume, and tree navigation. A separate/new session starts empty. Ordinary sessions do not write an external task file or synchronize todos between sessions. Full structured snapshots intentionally have no fixed task or text limit, so very large lists can increase Pi session-file size; textual tool output remains bounded to 50 KiB and 2,000 lines.

For managed Pi deployments, the trusted todo extension is also the snapshot producer. After `session_start` restoration, each `session_tree` active-branch change, and every todo result, it synchronously publishes a version-1 complete snapshot to `$PA_DEPLOYMENT_DIR/deployment-tasks.json`. The validated snapshot contains the deployment ID, ISO freshness timestamp, complete ordered task array, monotonic `nextId`, each lifecycle status, and dependency IDs. The writer creates a private temporary file, sets mode `0600`, and atomically renames it over the prior snapshot. A successful callback therefore makes complete evidence available to the next status invocation without polling. A failed write is non-fatal, retains the prior complete sidecar, and appends a bounded activity diagnostic. Terminal completion, partial completion, failure, and crash reconciliation do not delete the last successfully written snapshot.

Default `ppa status <deploy-id>` detail appends this section only when registry evidence identifies a Pi deployment:

```text
Session tasks: 1/3 completed
  Freshness: 2026-08-29T12:34:56.000Z
  ✓ #1 Discover
  ▶ #2 Implement ← #1
  ○ #3 Verify ← #1,#2
```

Rows retain stable task `order`/`id` ordering and share Alt+I's lifecycle markers: `○` pending, `▶` in progress, `✓` completed, and `−` cancelled. Dependency IDs follow `←`; at most one row is active. The completed count includes only completed tasks, while total includes cancelled tasks. A valid empty snapshot renders `No session tasks`.

Before parsing, status rejects a sidecar larger than 5 MiB. Missing, malformed, unsupported-version, deployment-mismatched, oversized, or unreadable evidence renders a bounded `Session tasks: unavailable` / `Tasks unavailable: <reason>` section without hiding the deployment detail or changing a valid lookup's exit code from 0. Rendered task evidence is capped at 50 KiB and 2,000 lines; truncation retains the header and emits an explicit task-omission notice. Task text is stripped of ANSI and terminal controls and normalized to one terminal-safe row.

This snapshot and status section are Pi-only. OpenCode, Claude Code, and Droid deployments are not inspected for tasks, and status lists, `--activity`, `--wait`, `--report`, and `--artifacts` keep their existing structures without a task section. `ppa status` is read-only: it neither mutates tasks nor aggregates child task lists. Managed todo guidance requires two-or-more-step work to initialize tasks after discovery and before the first target-repository mutation, complete or cancel the prior active task before starting the next phase, and complete or cancel an active task before shutdown. These checkpoints are observable guidance, not an automatic completion gate.

The shared default single-deployment header used by all adapters now renders exactly one Team line as `  Team:     <team>/<mode>` when a recorded mode is non-empty. If mode is absent, the byte-equivalent team-only fallback remains exactly `  Team:     <team>` with no slash or synthetic value. This human-readable formatting performs no additional I/O; list and alternate status paths remain unchanged. Structured registry and API fields are unchanged.

The snapshot/status implementation adds no external runtime dependency and remains compatible with Node.js `>=22.19.0` and the Pi APIs available since `>=0.80.8`; the synchronized `pi-pa` package continues to require Pi `>=0.84.4`.

## Context Status and Sidebar

The extension uses Pi's additive `setStatus` API, so Pi's built-in footer remains installed. Compact status includes available PA deployment/team/mode/ticket identity, provider/model, repository, Git branch/dirty state, and todo progress/active task. Ordinary sessions explicitly show PA as unavailable while retaining model, repository/Git, and todo context.

Run `/pa-context` or press Alt+I to toggle the same initially hidden PA Context overlay. At terminal widths of 120 columns or greater it is anchored at the top-right, uses 68% of the terminal width with a one-column right margin, and retains a 42-column minimum. On narrower terminals the overlay stays hidden and the compact status remains the fallback. Escape or Alt+I hides it. Rendered lines use Pi's ANSI/Unicode-aware width utilities.

In a managed linked-worktree deployment, Alt+I keeps the two path domains explicit: `Repository` is the canonical registered `repo_root`, while `Path` is Pi's execution-worktree `ctx.cwd` and `Git` is looked up from that same execution worktree. It does not resolve the repository again or use the canonical checkout for Path/Git state.

Relevant session, model, todo, tree, and turn events are coalesced to at most one refresh per two seconds. Git and deployment lookups each have a 500 ms deadline. A timed-out lookup retains the prior value with a `stale` label. Timers and overlays are disposed on session shutdown or reload; the extension starts no daemon or external server.

## Git Context Panel

In an ordinary TUI session with the trusted `pi-pa` package installed, or in a managed foreground `ppa deploy` TUI session, press Alt+G or run `/pa-git-context` to toggle the same dedicated Git overlay. At 120 columns or wider it is a bounded right-side panel; below 120 columns it is centered and nearly full width. Escape or Alt+G hides it. When a hidden panel is reopened after a terminal resize, it uses the current dimensions and switches layout in either direction across the 120-column breakpoint. Panel and selector rendering is ANSI/Unicode-aware and bounded to the width Pi supplies, including at 40, 80, 119, 120, and 160 columns.

While the panel has focus, press `r` to open the reference selector. It contains concrete local branches and remote-tracking branches already present in the clone. Symbolic remote `HEAD` aliases, tags, commit SHAs, and free-form refs are excluded. Up/Down moves, Enter selects, and Escape cancels; cancellation returns focus to the open panel. Selection immediately changes the visible reference and shows `loading (pending collection)`; the actual Git collection can remain deferred by the 10-second limiter. The choice is written atomically under the current execution worktree's guarded Pi project configuration directory at `<execution-worktree-root>/<CONFIG_DIR_NAME>/pa-git-context.json` (normally `<execution-worktree-root>/.pi/pa-git-context.json`) with owner-only file permissions. The canonical repository root is not used as the persistence root for a linked-worktree session. Temp creation, replacement, and cleanup stay relative to one validated open configuration-directory identity; replacing the lexical `.pi` path immediately before temp creation therefore cannot redirect data or cleanup into the replacement target. If the runtime platform cannot provide the guarded descriptor-relative primitive, persistence fails closed before creating a temp file. If persistence otherwise fails, the prior valid panel state remains visible. This approved project-local file is an observable side effect and can make the worktree appear untracked or modified. The extension never edits `.gitignore` or `.git/info/exclude`. Missing or malformed state is ignored safely. A concurrently replaced config path, non-canonical repository path, symlinked configuration directory, symlinked state file, or other canonical path escape is rejected or remains bound to the previously validated directory without reading, creating, replacing, or removing a file in an external target.

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

The package targets Node.js 22.19.0 or later and Pi 0.84.4 or later. The question, todo, status, and overlay implementations adapt the MIT-licensed Pi 0.80.8 examples `examples/extensions/question.ts`, `todo.ts`, `status-line.ts`, and `overlay-qa-tests.ts`; that number identifies the adapted example source, not the supported Pi runtime floor. Comments in the source identify intentional PA changes.

An ordinary session can load unrelated extensions that also register `question`, `todo`, `/pa-context`, `/pa-git-context`, Alt+I, or Alt+G. Pi keeps duplicate extension commands and assigns numeric invocation suffixes in load order (for example, `/pa-git-context:1` and `/pa-git-context:2`). For duplicate extension shortcuts, Pi emits a collision diagnostic and the later-loaded shortcut wins; an allowed built-in shortcut conflict is also diagnosed, while a restricted built-in shortcut cannot be overridden. Remove, disable, or reorder the conflicting ordinary-session extension when deterministic routing is required. The selector's plain `r` binding applies only while the Git panel is focused.

Alt+I and `/pa-context` remain independent from Alt+G and `/pa-git-context`: toggling or cleaning up one PA panel does not invoke or dispose the other. Managed PPA deployments avoid unrelated extension collisions by loading `--no-extensions` plus exactly the trusted `pi-pa` extension path.

## Immutable Sources, Licenses, and Updates

`packages/pi-pa/extension-sources.lock.json` is the canonical source record. It contains exactly two records with upstream version, repository, 40-character commit, source and entrypoint paths, source-tree SHA-256, MIT license path/digest, and bundle name:

| Bundled source | Immutable commit | Reviewed version |
| --- | --- | --- |
| `proper-base` from `proper-pi-extensions` | `859feb321ec81d773beea379d28e21d0b7d0c8c0` | 0.5.0 |
| `pi-vimmode` | `52bd6ac5e905157ac46ec15c120b7d0cc61a62df` | 0.9.0 |

`packages/pi-pa/THIRD_PARTY_NOTICES.md` records the eligible source attribution. Each output copies only the selected MIT text(s), emits only selected plugin sections in its installed `THIRD_PARTY_NOTICES.md`, and generates `dist/pi-extension/vendor/provenance.json` without a timestamp. Selected provenance retains the exact reviewed commit, source digest, license, and license digest from the lock; a neither-selected output has empty selected-source and source arrays. The build performs no source fetch or package installation. It still validates both eligible source checkouts and fails before TypeScript compilation or Pi startup when a gitlink, checkout, URL, source digest, package version/license, or license digest is absent or drifted. Initialize a checkout with `git submodule update --init --recursive` before building.

To update either upstream, use a separate approved ticket: review the upstream diff and license; move only the relevant gitlink to an exact commit; update its version and digests in the lock record; keep the source tree clean; run `node packages/pi-pa/scripts/validate-extension-sources.mjs`; refresh the pnpm/Nix dependency hash only when dependency inputs require it; then run the focused composition/lifecycle tests and the full repository, Nix store, setup/isolation, secrets, and diff suites. Never point the lock at a branch, fetch at runtime, or edit vendored source locally.

## Failure Diagnostics

Foreground deployments run Pi through a Node pseudo-terminal. Keyboard input,
terminal resize, and SIGINT are relayed to the child, while terminal output is
shown live. On settlement, PPA removes its input, resize, and signal listeners,
restores the prior terminal raw mode, and pauses stdin only when attaching PPA's
input listener started the stream flowing. An already-flowing or already-paused
caller-owned stdin state is preserved. This ownership-aware restoration lets the
wrapper exit naturally after child-exit evidence and cleanup even when its parent
keeps the stdin writer open; PPA does not force termination with `process.exit()`.

Pi-owned content filtering is disabled. Foreground output and Pi-originated
`pi.log`, `pi-output.jsonl`, activity records, terminal-status sidecars, registry
diagnostics, and failure paths preserve protected values, credential-shaped
text, credential-named fields, and reasoning metadata such as signatures or
encrypted content. Operators must therefore treat every Pi deployment artifact
and rendered Pi stream as potentially sensitive. This behavior has no feature
flag or automatic restoration; changing it requires a separate approved change.
Existing numeric sink bounds remain unchanged: normalized activity bodies are at
most 500 characters, and terminal and failure diagnostics are at most 2,000
characters. Artifact retention and access controls remain in force, and
filtering owned by shared `pa-core` or other runtime adapters is unchanged.

Pi runs the detector rules removed from the output path in shadow mode. Every
configured-value, credential-shaped text, credential-named key, bearer, `sk-`
value, reasoning-signature, and encrypted-content match is appended once per
observed Pi surface occurrence to
`$PA_DEPLOYMENT_DIR/pi-redaction-audit.jsonl`. Each schema-version-1 record
contains `schemaVersion`, ISO `timestamp`, `deploymentId`, `surfaceId`, stable
`ruleId`, `originalLength`, `matchedText`, and `truncated`. `matchedText` is
limited to 2,000 JavaScript string characters and each UTF-8 JSONL record is at
most 16,384 bytes. The file is created lazily on the first match and remains mode
`0600` after creation and every append; a zero-match deployment creates no file.
Because records intentionally retain the matched text, operators must protect
this audit with the same care as all other Pi artifacts. The original sink
receives its content before audit persistence. Audit creation or append failure
emits at most one non-sensitive warning of at most 2,000 characters per failing
deployment-local sink, and never changes output, blocks the session, or feeds the
warning back through detection. The audit covers
Pi terminal output, logs, structured output, activity, terminal sidecars,
deploy/background/native-host diagnostics, extension diagnostics, and todo
persistence diagnostics. It does not alter non-Pi runtimes or shared `pa-core`
policy.

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
if Pi exits with status 0. The original terminal error is retained within the
existing activity and diagnostic bounds. A normal terminal stop with exit status
0 remains successful.

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

For the editor-default migration, choose one constructor combination above, rebuild the consumer, and rerun `ppa pi setup` only if the installed package path changed. Selecting neither does not delete editor state; it only removes editor bundles, import mappings, and registrations from that package output. Re-enabling a plugin in a later build reuses its existing user-owned state.

## Troubleshooting

- `Pi version must be 0.84.4 or later`: upgrade Pi and ensure `pi --version` is available on `PATH`. The version probe allows up to 15 seconds for a loaded system to start Pi.
- `Missing ... entrypoint` or source/license drift: initialize recursively with `git submodule update --init --recursive`, confirm both submodules are clean at the commits above, and rerun the validator. Do not repair the mismatch by editing vendor contents.
- `Pi PA extension package path is missing`: reinstall/build pa-platform or use the current packaged `ppa`; inspect the path printed by `ppa pi status`.
- `PA config package path is missing`: set `PA_PLATFORM_CONFIG_DIR` to the existing `pa-platform-config` checkout.
- A selected editor is missing: first inspect the built output with the artifact command above. If its provenance and imports omit the plugin, correct the constructor options and rebuild; runtime settings cannot enable a disabled build. Then confirm `ppa pi status` points at the new store output and run `/reload` or start a new Pi session.
- Vim behavior is unavailable or misconfigured after its artifact is present: run `/vimmode status`, `/vimmode reload`, or `/vimmode off`. In ordinary sessions inspect duplicate editor extensions; managed sessions intentionally load only pi-pa.
- History is not recalled: verify the Pi agent directory, project working directory, file permissions, and the size/bounds above. Prompts over 4,096 characters are intentionally omitted.
- An editor or panel appears duplicated after a change: run `/reload`; if it persists in an ordinary session, inspect extension collisions. Managed reload/lifecycle tests require exactly one composed chain.
- Skills changed but Pi still shows old content: run `/reload`; managed deployments pick up changes on their next invocation.
- Setup says `Already configured`: the two owned paths are already present. Use `ppa pi status` (and the matching `--local` scope) to inspect them.

Every Nix output includes the trusted `pi-pa` entrypoint, selected-only provenance and notices, Node 22 and Pi-host Node 24 native addons, runtime-host resources under `$out/share/pa-platform/packages/`, and `ppa.fish` under `$out/share/fish/vendor_completions.d/`. Plugin bundles, import mappings, and MIT license copies exist only for selected plugins; shared dependencies such as `sharp` may remain present when proper-base is disabled.

`bash scripts/nix-store-output-smoke.sh` evaluates all four selections on both `x86_64-linux` and `aarch64-linux`, rejects invalid constructor values, verifies default aliases and the overlay, dry-runs every non-native selection, and builds all four native outputs. It checks exact selected/absent artifacts and reviewed hashes, Node 22 registry load/query/close, Pi Node 24.19.0 addon/helper preflight, eight managed tools for each selection, both-enabled teardown regression, and caller-boundary behavior. It does not include the operator's config checkout or credentials.
