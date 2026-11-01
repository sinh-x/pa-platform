# PAP-273 phase 3B — bounded setup candidate writer

Source increment on `feature/PAP-273-workflow-startup-compatibility` after
`2ae4731`, continuing phase-3A catalogue foundation commit `192102b`. **Not ticket
completion, operator approval, installed availability, execution readiness or
requirements/UAT acceptance.** Phase 3A's static schema and legacy/local conflict
rules remain in `project-command-catalogue.md`.

## Companion interface (source only)

The implemented route is **Pi/PPA CLI**, exact team `repo-setup`, mode `setup`,
registered physical **primary** repository root, no application ticket. The
configuration companion PAPC-073 still owns the selected team/canonical objective
and instructions. It must not claim an installed route from these source files.
Once separately packaged/selected/qualified with that config, the intended launch
is `ppa deploy repo-setup --mode setup --repo <registered-key>` without an objective
override. Native runtime rejects OpenCode, API invocation, background/resume/force,
tickets, linked execution roots, ticket-worktree/review/Treehouse selection and
builder custody for this role. OpenCode setup remains unimplemented, explicitly
closed rather than relying on team prose or an unguarded generic agent.

Pi exposes `pa_repo_setup` only in the setup role, with exactly one `request`
string containing strict raw JSON:

```json
{"action":"inspect"}
```

```json
{"action":"stage","expected":null,"candidate":"<raw catalogue JSON>"}
```

A revision uses the **exact reference returned by inspect/stage** in `expected`
instead of null. Its closed structure is:

```json
{"schemaVersion":"repo-setup-candidate/v1","repository":{"key":"example","root":"/physical/registered/root"},"path":".pa/project-commands.json","sha256":"<64 lowercase hex>"}
```

This is a content reference/CAS precondition, **not an approval, opaque capability
or dispatch grant**. Candidate JSON is the phase-3A `project-command-catalogue/v1`
schema, at most 65536 bytes; the raw request is at most 262144 bytes. Duplicate
keys, caller paths/roots/actors/grants, unknown fields and invalid/sensitive
catalogues reject. Successful results explicitly say `candidate-unapproved` and
`executionReady:false`; missing inspection reports `missing`. Candidate bodies,
commands, credentials and parser exception text are not echoed in errors.

## Native ownership and effect boundary

Every operation reauthenticates the exact current Pi process, private immutable
launch-incarnation file, one original CLI launch and current running registry
binding, configured primary root and runtime/team/mode. A dedicated existing-only
registry reader checks **raw** launch/current correlation columns: malformed
historical correlation cannot disappear through a permissive public projection
and become apparent ticketless authority. Active/dead/unknown matching foreground
sessions block; none is forced terminal or silently reclaimed.

The writer reuses the existing lock order and owners:

1. Canonical repository capacity mutex; any retained slot/reservation blocks.
2. Existing primary mutation-slot mutex, then sorted linked-worktree slot mutexes.
3. Reinspect complete physical worktree metadata and every primary/linked owner,
   implement lease, borrower, review reservation and pending settlement.

Stale, malformed, insecure, missing-backlink or conflicting evidence blocks
without deletion, adoption, force, expiry or fabricated ticket/permit. A passive
allocated worktree is not itself an active writer grant. Inventory is rechecked
under locks, including after the operation. Native administrative mutex files may
be created; `inspect` is not a zero-filesystem-effects claim.

Only `.pa/project-commands.json` is publishable. The native writer may create
`.pa` mode0700 and private mode0600 temporary data there; it never repairs an
existing insecure parent/file. Existing local catalogues require exact CAS;
legacy registration, tracked `.pa` entries, linked administrative candidates,
aliases, hard links, unsafe modes and retained setup temporaries reject. Git
inspection is bounded metadata-only with ambient Git redirection scrubbed; no
status/filter/script/command probe or remote operation runs. Unrelated dirty,
staged, untracked, source, Git index/HEAD and exclude bytes are preserved.

Publication uses exclusive no-follow private temporary creation, file fsync,
authority/content/physical-parent/index rechecks, exclusive link for initial
creation or atomic replacement for an exact existing reference, directory fsync
and protected readback. Lost authority or uncertain publication returns failure;
uncertain temporary evidence is intentionally retained and blocks another write
until separately reconciled. No automatic cleanup/rollback/adoption is offered.
Concurrent cooperating creates serialize: one succeeds, the stale null reference
loses without overwriting it. These are managed-agent protections, **not isolation
against arbitrary hostile code running as the operator's OS user**.

The managed Pi role rejects shell, generic editors, unknown/wrapper tools, child
spawning, workflow/decision mutations and ticket comments. Discovery uses the
read/search tools and unsigned canonical templates; todo/question remain usable.
Only the native fixed-path writer supplies an administrative write exception.
All ordinary legacy command/executable/confinement/custody guards remain, and the
local candidate still fails execution with approval required/source conflict.

## Verification in d-cea6a5

- Workspace typecheck/build: passed.
- Core focused catalogue/files/setup/plan/repository/capacity entries: 160 passed,
  zero failures/skips, including actual two-process creation contention.
- Separate Pi setup/process/catalogue-source/legacy-command/startup/config entries:
  48 passed, zero failures/skips.
- Script/inventory/verifier entries: 25 passed, zero failures/skips.
- Completions generation passed, no completion diff; `git diff --check` passed.
- Combined Pi entry including full native workflow exceeded its 240-second tool
  limit after 33 passing events. It has **no complete summary and is not a pass**.
  The separate 48-case boundary run is not a replacement full-workflow result.
- Installed harness retains all previous cases and adds both setup test files and
  two mandatory accounting groups (25 qualification rows total). This is verifier
  source coverage, not an installed test result or omitted-native-case waiver.

Raw logs: `/tmp/pap273-d-cea6a5/`. No full workspace/hosted green, exact installed
package qualification, independent review, human UAT or affected-ticket resumption
is claimed. The foundation and writer are committed as separate phase-3A/3B source
increments; inherited source changes are preserved.

## Remaining phases — do not infer completion

Phase 4 still needs the operator-only password credential/approval CLI, hidden
fresh terminal input and managed-agent native denials, protected hash-bound
approval ownership, catalogue adoption/revocation, rotation/reset invalidation,
reviewed file-set/drift checks and exact local Git-exclude reconciliation. There
is **no approval command grammar available yet**. The candidate is not currently
ignored automatically: the future operator-approved ignore effect owns that
separate metadata mutation. Setup cannot untrack a file or change `.gitignore`.

Execution consumption must then bind the actually approved catalogue and genuine
task-required matrix to the existing native authority, supported executor,
prerequisite provenance and confinement. Legacy all-check semantics are unchanged;
no unsupported Nix/Android/general toolchain support has been invented.

Joint PAPC-073 source/config review, exact Git-candidate packaging/install/selection
and real fresh CLI/native host reload/qualification remain. Canonical pair/matrix
production, hosted/local mandatory matrix results, independent review, genuine
human UAT/adoption and history-preserving NX-067/TTL-017 continuation are distinct
unperformed gates. PAP-271/PAPC-072 remain done; no prior approvals/links/history
are replayed or upgraded by this increment.
