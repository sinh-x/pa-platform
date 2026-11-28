# Local regression feedback — PAP-337

Local tests now separate ambient deployment identity from disposable test state.
An opt-in serial source runner adds focused feedback and bounded timing events.
These are source-development improvements, not full-suite, native, installed or
human acceptance. No concurrency threshold, test inventory or native guard was
removed. PAP-293 continues to own hosted CI provisioning and check delivery.

## Run checks

Use Node >=22.19 and the lockfile-selected pnpm/dependencies. Standard root
`test`, `test:code`, `test:coverage` and `test:paired-gate`, and workspace `test`
and `test:code` entrypoints use `scripts/dev/isolated-test-env.mjs`.
The `:run` scripts are implementation details; do not invoke them directly.
Installed verifiers and operator-local paired configuration checks retain their
own environments and acceptance contracts.

Prepare source dependencies before using the optional source-only runner:

```sh
corepack pnpm build
# Pi's complete source inventory expects both bundled editor fixtures.
PI_PA_PLUGIN_SELECTION='{"pi-vimmode":true,"proper-base":true}' \
  corepack pnpm --filter @pa-platform/pi-pa bundle:extensions

corepack pnpm test:local pi-pa --file src/__tests__/pi-todo.test.ts
corepack pnpm test:local pa-core --file src/__tests__/task-snapshot.test.ts
corepack pnpm test:local pi-pa --lane code --list
corepack pnpm test:local pi-pa --lane full --list

# Restore the ordinary bundle after local Pi checks, including after failure.
corepack pnpm --filter @pa-platform/pi-pa bundle:extensions
```

`test:local` accepts `pa-core` or `pi-pa`, `--lane code|full` (default code),
repeatable package-relative `--file`, `--timeout-ms`, `--budget-ms` and `--list`.
No globs, traversal or duplicate file selections are accepted. A manual-only
file cannot be selected in the code lane. Full source selection uses the original
`*.test.ts` entries, not their portable replacement helpers. `--list` runs no tests.

The existing code/manual inventory remains authoritative for partitioning, not
acceptance. Every available file is selected, not selected, or explicitly deferred
to manual integration. A missing inventory entry fails. Focused selection does
not claim omitted files passed. Full source selection is still not root `pnpm
test`: root driver, script tests, other workspaces and setup remain separate.

Run the complete required gate in its supported immutable toolchain:

```sh
corepack pnpm test
```

Code-only success never substitutes for that gate, installed verification or UAT.
Root `test` and `test:code` now build core once before driver/workspace tests.
Their internal `test:source` / `test:code:source` entries consume that same-run
build while retaining fresh workspace fixture environments. Pi source validation,
bundling, script tests and full/native source discovery are unchanged. Standalone
workspace `test` still builds its dependency. These internal source entries are
not independent fresh-build gates and must not be used to claim build/evidence
reuse across invocations.

Core files remain serial, including the unchanged 500 ms dashboard p95 assertion.
Do not run timing qualification alongside builds or other test lanes. No parallel
portable lane is enabled by this change.

## Opt-in develop-fast prototype (PAP-357)

From the repository root, with the normal Node/pnpm toolchain and dependencies:

```sh
corepack pnpm test:develop-fast --list
corepack pnpm test:develop-fast
```

`--list` validates the inventory and reports scope without building or testing.
The test command builds the workspaces first, then runs the shared root drivers,
seven selected Core source files, all OpenCode source and Pi script tests, four
selected Pi source entries (including the portable workflow entry), and the
runtime-host source suite. Core and Pi source tests stay serial. Each stage uses
a disposable test environment. A failed stage stops the run; later stages are
not verified. Existing skips are reported by their test suites.

The prototype prints selected, deferred and manual-integration counts separately.
Ordinary `test:code` still discovers and runs the full code inventory in hosted
CI. No branch events or checks changed. `test:develop-fast` does not run the
complete common CI checks or certify release, manual, installed or human
qualification. Use `test:code` for the deferred code tests and the applicable
manual gates separately. Do not call internal `:run` scripts directly.

## Isolation boundary

Each launcher allocates a fresh temporary fixture root. It removes inherited
`PA_`, `PI_`, `PPA_`, `OPA_`, `TREEHOUSE_` and `GIT_` variables, redirects HOME,
XDG config/data/cache/state, PA config/data/home/usage/registry and Pi agent state,
and removes `NODE_TEST_CONTEXT` so nested Node test commands actually run.
It does not inject `PA_PLATFORM_HOME`: the default home remains isolated through
HOME/config, while an explicit suite-owned `config_dir` keeps its documented
precedence. Injecting that override initially broke the repository-map fixture;
the broader follow-up found and corrected this launcher regression.
Descendants inherit fixture paths; suites can explicitly supply their own fixtures.
The todo registration unit fixture explicitly uses `createTodoModule({ env: {} })`.
Production default persistence is unchanged.

PATH, locale, timezone, runtime safety settings and the selected Corepack cache
remain available. The Corepack cache is toolchain state, not isolated native
state. No credentials are printed by the new event projection. Environment
separation is **not filesystem, network or credential confinement**: explicit
absolute paths, external services, inherited non-PA credentials and malicious
fixture code are not contained. Native sandbox admission remains mandatory.
This does not authorize running untrusted code or granting access to live records.

Allocation/spawn failures never fall back to ambient paths. On POSIX, the launcher
owns a separate process group; signals/timeouts terminate that group, escalate
after two seconds and clean its fixture root after child close. Normal close also
terminates leftover group members. It never targets another deployment. Escaped
process groups and uncatchable host termination are not guaranteed cleanup; on
Windows only the direct child is signalled. No live records are repaired or restored.

The audit found other default registration/lifecycle paths and many environment
fixtures in Pi composition, native host, deploy and adapter suites. Existing
suite-local isolation was inconsistent. The shared entrypoints protect defaults
without changing production registration; direct raw `node`/`tsx` invocations
must use the launcher explicitly. This is a focused audit, not proof that every
absolute path or external integration is confined.

## Events and honest outcomes

The opt-in runner emits JSON lines to stdout; it writes no log or report file.
Standard test reporters/exit contracts are unchanged. New records include:

- Run identity: HEAD, Node version, declared pnpm, lockfile and selected-file hashes.
- Complete file inventory and actual file start/end for the fixed serial Node/tsx
  invocation, with duration and exit/signal.
- A running-file heartbeat every 30 seconds, without percentages or a completion claim.
- Node case counts, at most twenty failure ordinal/location references, and five
  slowest cases per file. Names, stdout/stderr bodies, assertion messages and stacks
  are excluded. Native Node locations can refer to transformed TS coordinates;
  use the file and ordinal, not an assumed original source line.

Each line is bounded to 4096 bytes. Child startup stderr is not projected in this
optional lane. For detailed diagnosis, rerun the selected file with the standard
reporter through the isolation launcher and the existing admitted output boundary;
this command creates no alternate raw-log writer. No automatic retry occurs.

Default budgets are five minutes per file and fifteen minutes per run; each can
be explicitly set to 1–3,600,000 ms. These are conservative operational limits,
not measured whole-suite SLOs. A run budget caps the next file's budget; interrupted,
timed-out, unavailable, stale and unrun outcomes are not passes. A file timeout
can be followed by other files while run budget remains. `completed` means selected
processes exited zero, not zero skips or acceptance: inspect case counts. Absent
final events mean completion is unknown. Event delivery through an agent tool can
be delayed by security scanning; heartbeats do not bypass that boundary.

Selected source/lockfile drift at close is non-successful. Hashes do **not** cover
all transitive source, vendor state, generated dist/bundles, executable bytes,
external configuration or the complete environment. There is no build/evidence
cache, HEAD-only reuse, durable shard receipt or cross-run resume. Rebuild and
revalidate changed dependencies. Exact-input reuse is deferred until an owner can
bind all those inputs and completed mandatory shards without weakening admission.

The producer is this repository's local runner and Node test process. Its output
uses the invoking terminal/tool's existing security and retention boundary. Any
persisted check summary requires that deployment's admitted artifact writer and
routing, with no-clobber and sensitivity checks; no `tee`, temporary raw-log
fallback or new native-record writer is introduced. Runtime/security owners retain
historical evidence projection and retention policy.

## Measured qualification (2026-11-25)

Candidate `deae4918ac787d1e8448dae7ae882e659b1bfc41`; Node v22.23.5,
pnpm 10.28.0; Asia/Saigon, en_US.UTF-8; prebuilt dependencies. The same selected
Pi todo/workflow portable files and lockfile were unchanged between runs.

| Source workload | Wall time | Result |
| --- | ---: | --- |
| Existing serial Node command, both files, isolated environment | 30.987 s | 32 passed |
| Observable runner, same files | 33.972 s | 32 passed; todo 5.467 s, workflow 28.317 s |
| Observable todo-only retry 1 | 10.847 s | 12 passed; 97 code files not selected, 7 manual files deferred |
| Observable todo-only retry 2 | 10.937 s | Same explicit scope and result |
| Core status/tasks plus snapshot | 9.869 s runner time | 16 passed |

The same-workload runner was about 10% slower in this small sample. Its useful
improvement is diagnosability and avoiding unrelated work during focused retries,
not a demonstrated whole-suite speedup. The two-file selection SHA was
`42d628dfc34f4bdbc964fc2952d4df3c7b5c1af6194a77715167e8e7c7aa225f`;
lockfile SHA was `090528536bb7e469e6e6b4849f6ab3e552e570fcdc7e0a36207ded0fe16b918a`.
Slowest measured portable workflow case was 4.940 s; fixture setup/subprocess
costs are not separately instrumented, so these samples do not justify caching
fixtures or raising concurrency.

Qualification: 17 isolation/inventory/projection tests passed; Pi todo 12 passed;
workspace typecheck and build passed. A broader `pnpm test:code` reached its
600-second caller budget (exit 124) after the root driver's 53 tests passed.
No completed workspace code-suite or full/native/installed/UAT pass is claimed.
No completions changed; completion generation was not rerun.

Priorities: retain the isolation sentinel in regression; collect whole-lane file
rankings in a supported uninterrupted run; then profile fixture setup and subprocess
counts before proposing reuse or an isolated portable shard. Coordinate any hosted
CI overlap/provisioning with PAP-293. Numerical full-suite speed targets and exact
input reuse remain open until comparable whole-lane baselines exist.

## Equal-coverage optimization follow-up

The initial delivery improved isolation and visibility but did not establish a
runtime optimization. The operator correctly challenged that distinction.
Commit `67ecc97` adds actual repeated-work reductions:

- Nine utility suites import their owning production modules instead of loading
  the whole core barrel independently. All non-import statements were verified
  identical using the TypeScript AST. One public-export identity test checks that
  the public API still exposes the same implementations. Safety-policy tests
  subsequently use the same narrow-import approach, without changing any case,
  warm-up, sample count or performance threshold.
- Root full/code invocations build core once rather than three times in downstream
  workspaces. Every original test inventory and native setup step remains;
  no source check, full entry, external guard or build prerequisite is cached away.

On the same Node/pnpm/lockfile and serial command, the original nine-suite workload
ran in 13.821 and 13.247 seconds (37 cases: 35 passed, two existing optional
configuration skips). With narrow imports **including the added export test**, it
ran in 8.223 and 7.916 seconds (38 cases: 36 passed, the same two skips). Median
wall time dropped about 40%. This comparison does not rely on focused omission,
parallelism, a RAM filesystem, shortened timeouts or a compilation cache.
Three redundant core builds measured 15.364, 15.215 and 15.290 seconds; retaining
one removes approximately 30 seconds of repeated setup in that environment.
These are scoped measurements, not a proven whole-suite speedup.

The larger root `test:code` attempt on `67ecc97` still reached its 1800-second
caller budget after 54 driver tests passed. Core reported a repository-config
fixture failure (corrected in the launcher) and a safety-policy p95 failure.
Focused recheck after the config correction: 28 of 29 passed; the unchanged
5 ms safety-policy limit measured 7.465 ms over 1200 calls and remains a failure.
The isolation/inventory/projection harness passed all 18 tests after correction.
Workspace typecheck passed; the subsequent combined typecheck/build command hit
its 420-second caller budget during build, so no final complete build pass is
claimed for that attempt. No workspace-code, full/native, installed or human
acceptance is established by these partial checks.

Host load varied substantially during profiling. A later single native-fixture
probe measured 42 ms document setup, 7 ms DB backup, 242 ms Git/plan, 12 ms freeze,
187 ms reader publication and 5 ms origin persistence, much lower than the initial
loaded-host file totals. That does not justify weakening durability or native
revalidation. Temporary timing instrumentation was removed. An alternating Node
compile-cache experiment (7.516/7.183 seconds without; 7.034/7.089 with) showed only
a small noisy difference and was not adopted. A discovery command failed closed
in `scout-block.cjs` (exit 70); no bypass was used.

The end-to-end runtime goal remained unfinished at that point. The continuation
below records newer evidence; it does not turn partial checks into acceptance.

## Updated develop and CLI startup continuation

The operator requested an update from develop. Merge `1a1813b` incorporates
`origin/develop` at `937c303` (v0.1.184), preserving the PAP-337 phases and adding
upstream PAP-293 CI/fish driver tests to both root lanes. The single package.json
conflict was resolved without dropping either side's tests; 34 focused checks
passed before the merge commit.

On that baseline the complete core code inventory ran serially: 155 files,
2,596 passing events, 19 skipped, no failed/timed-out/unrun files, in 880.277
seconds. The unchanged safety-policy benchmark passed separately at 1.953 ms
against its 5 ms limit. This is an observed recheck, not proof that the merge
fixed the earlier timing failure. OpenCode passed 125 with one skip; runtime-host
passed its one test. The standard Pi code lane still reached its 1800-second
budget and is not green.

File-level profiling identified substantial repeated CLI startup in the native
read-only helper matrix. `cli.ts` had imported every command handler, deployment
and foreground machinery before dispatch. The continuation changes startup only:

- Handlers load on their existing routes. Template resource `--version` precedence,
  original handler arguments/callbacks, messages, streams and exit ownership remain.
- `board`, `branch validate` and `repository inspect` use the same read-only helper
  capability without loading unrelated deployment machinery. Mutating commands
  stay on the full deployment-hook path.
- The capability and its three supporting functions move to `readonly-helper.ts`.
  TypeScript AST comparison verified all four function bodies byte-for-byte equal
  to the merge baseline. `deploy.ts` re-exports the same implementations, not a
  second guard or a permissive substitute. There is no authorization cache or
  skipped physical/process/lease/ticket/registry/snapshot/immediate-reread check.

New startup tests use disposable routing-only stubs to prove unloaded handlers,
version precedence and mutation-route separation. They do not establish native
authority. The unchanged real built-CLI helper suite still owns its 167-case role,
negative, lineage and no-lifecycle-effects matrix.

| Workload | Before | After | Actual result |
| --- | ---: | ---: | --- |
| Five-role positive matrix, same six tests and isolated TAP command | 56.182 s | 37.831 s | Six passed both times; about 33% lower wall time |
| Full unchanged helper suite | 594.758 s file profile | 225.786 s isolated TAP | 167 passed in each completed run; different reporters and variable host load limit comparison |
| Built CLI version, including launcher | 1.721–1.817 s | 0.131–0.134 s | Identical stdout and exit zero |

A later **matched-profiler** full-helper repeat reached its 600-second file budget;
therefore the single completed full-helper comparison is not a demonstrated
repeatable 62% SLO or whole-suite improvement. An import-only lazy-dispatch
experiment did not improve the positive helper matrix (56.830 s), which motivated
the separate lightweight guard owner. A fresh private Node compile-cache experiment
also remained inconclusive (68.138/52.995 s) and was not adopted.

After the CLI changes, workspace typecheck and build passed; root driver tests
passed 70/70; focused CLI/startup/auto/session/recovery/local-review/template tests
passed 83/83. A final Pi typecheck/build passed after import cleanup. Completion
generation passed with no generated diff. Four guard-body hashes and normalized
original handler-call ASTs were checked; all original invocations were retained.
The 167-case real helper pass is separate from the routing-only stub tests.

Remaining qualification is explicit: handoff-native exceeded its 600-second
profile budget, the later helper profile repeat was incomplete, and there is no
complete final-candidate Pi code/full/native/installed/UAT pass. Prior completed
file checks and partial retries do not substitute for those gates. Do not count
larger diagnostic budgets as a speedup or silently remove the expensive cases.
The measured positive-matrix gain is the scoped optimization established here.

## PR source-inventory reconciliation

The first PR #194 CI attempt rejected stale interaction-source hashes for the
changed CLI and deployment modules. Reconciliation confirmed that existing command
forms, aliases, effect classes and native/delegation bindings are unchanged:
version, board, branch validation and repository inspection remain reads; branch
creation/quarantine remain operator-owned resources and deployment remains launch.
The inventory now pins both changed modules and the new read-only helper owner.
A regression asserts those coverage/boundary invariants. The conservative byte
comparison and added-command checks remain intact; renewing reviewed source hashes
is not installed provenance, a native binding, approval or a qualification waiver.
