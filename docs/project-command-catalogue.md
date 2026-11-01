# PAP-273 phase 3A — catalogue foundation

SOURCE foundation increment after phase-2 commit `2ae4731`. Not a
completed phase 3, installed interface, native operator approval, execution grant,
requirements/UAT acceptance or supported repo-setup launch. No product/config
repository or real `.pa` file is created by this increment.

## Delivered static contract

The runtime-neutral core implements `parseProjectCommandCatalogue(bytes,
{ key, root })` and `selectCatalogueTaskChecks(catalogue, exactTaskCommands)`.

The candidate location is `.pa/project-commands.json` under the already-registered
physical repository root, not each linked worktree. Its distinct schema is
`project-command-catalogue/v1`. This filename/schema are now SOURCE interfaces,
not an instruction to install files or an already available setup CLI.

The closed top-level fields are `schemaVersion`, `repository`, `effects` and
`commands`. Repository contains exactly `key` and `root`; both must match the
observing context. Effects are exactly the ordered pair `project-read`,
`isolated-temp-write`. There must be 1–64 commands, each with exactly:

- `id`: unique lower-case command ID; `executable`: bounded canonical absolute
  path in the current executor's permitted binary prefixes.
- `argv`: bounded literal argument array; `environment`: bounded literal map with
  authority, loader, credential and ambient path/home injection excluded.
- `readPaths`: distinct safe project-relative file paths; `prerequisites`:
  nonempty distinct `{ path, sha256 }` rows. Git/admin metadata, traversal and
  sensitive paths are excluded.
- `timeoutSeconds`: 1–1800; `maximumOutputBytes`: 1–16777216.

Raw candidate JSON is bounded to 65536 bytes. Invalid UTF-8, duplicate keys
(including escaped equivalents), unknown/missing fields, unsupported versions,
ambiguous command spellings and changed repository identities reject. Errors
contain fixed bounded codes, not user-controlled command/path/parser text.
Returned data are deeply frozen and retain SHA-256 of the original raw bytes;
formatting changes therefore change identity. No caller-supplied hash or approved
flag is consumed.

The exact displayed command spelling reuses the legacy basename/literal-quoted
argument convention, but is **never executed as shell** by these helpers.
`selectCatalogueTaskChecks` accepts only a parser-produced catalogue and requires
every exact task command, in task order, rejecting outsiders and duplicates.
Unused catalogue entries are not mandatory. The task authority/matrix owner must
supply the real required set later; this helper cannot authenticate a matrix,
issue approval or establish that a partial task set is authorized.

Parsing performs no filesystem or executable/prerequisite probe. A valid schema
is not a supported toolchain, matching script provenance, confinement readiness,
approved contract or execution permission. In particular, existing executable
prefixes do not imply that every such binary works inside the restricted sandbox.

## Read-only file observation and legacy guard

`inspectLocalProjectCommandCatalogue(repoKey, repoRoot)` resolves the actual
repository registration and reads existing candidate data only. It does not
initialize directories, inspect Git state, execute commands, write an approval,
change ignore rules or adopt a source. The configured root and administrative
parent must be physical, without aliases. The `.pa` directory must be owned by the
current user and mode0700; the candidate must be owned, mode0600, bounded, regular
and single-linked. Existing protected reads plus pre/post identity checks reject
aliases, hard links, drift and malformed data. Missing data remain missing; no
native authority follows from successful observation. Git-primary/common-dir and
live writer authentication remain necessary work for the future mutation owner.

Before Pi legacy command observation/resolution and before generation of a new
legacy dispatch program:

- Valid local candidate without a legacy registration rejects with
  `EXECUTION_PROJECT_APPROVAL_REQUIRED`.
- Coexisting legacy/local sources or a linked checkout's administrative candidate
  reject with `EXECUTION_PROJECT_SOURCE_CONFLICT`.
- Malformed/insecure local data reject as an invalid contract, never fall back to
  a legacy command source.
- With no local candidate, legacy `project-command-contract/v1` remains unchanged:
  PA-config registration, exact manifest/input hashes, every contract check,
  trusted executable, real namespace confinement and task/custody owners remain.

Phase-3 candidates cannot dispatch at all. Current workflow profile projection
reports unavailable/unsupported rather than claiming a supported local execution
profile. Exact approval/source reasons are exposed by the native command-contract
boundary. Requirements discovery/drafting stays separate from execution readiness.
No native local adoption exists yet: persistent adoption/revocation/reset semantics
must not be inferred from a candidate's presence or deletion.

## Verification ownership

Portable catalogue/parser/file/source-negative cases run in the normal code lane,
including a copied untrusted-Node regression proving source rejection needs no
trusted executable or namespace probe. Two new positive/ongoing legacy cases
remain unconditionally in the existing full native command-contract entry. The
installed workflow harness requires all four relevant test files, all legacy
command-contract cases and two new mandatory catalogue accounting groups (23 rows
total); all prior rows/native cases remain. Editing the verifier is source
coverage, not a candidate-installed result.

Final focused source entry: 228 passed; full native workflow entry: 35 passed;
script/verifier regression entry: 25 passed. All three had zero failures/skips.
Final workspace typecheck/build passed; generated completions remain unchanged;
whitespace checks passed. The combined ordinary/native entry exceeded its
240-second limit and is incomplete, not passing. The full workflow was then run
separately and passed. A combined typecheck/build attempt also exceeded its
150-second tool limit; the later complete retry passed. These limits do not
certify the full ordinary/workspace suite, hosted CI or installed qualification.
Temporary raw logs: `/tmp/pap273-phase3a-VVzS2Z`; final-prefixed logs identify the
last successful runs at that checkpoint. This foundation is now committed as its
own phase-3A increment; installation and activation were not performed.

## Remaining phase 3 and phase 4

**Continuation:** `repo-setup-candidates.md` records the subsequent phase-3B
source writer/Pi route and current verification. The following paragraph is the
historical phase-3A handoff, not a claim that the subsequent writer is absent.
Operator approval/execution/installed acceptance remain outstanding.

Next at this checkpoint: implement the bounded ticketless repo-setup native admission/writer and its
actual public route, deployment identity, immutable candidate reference, exact
allowlisted writes, concurrency/exclusion and failure contracts. Reuse existing
repository-capacity/worktree owners. Ordinary `repo-setup` team classification is
currently non-locking; team prose/naming must not be treated as writer authority.
Inspect all conflicting live/uncertain owners and preserve unrelated changes. No
synthetic ticket, builder permit, source/script/Git/credential write or duplicate
approval ledger may be introduced merely to bootstrap a candidate.

Phase 4 still owns operator-only hidden-password approval, source adoption,
protected native hash evidence, rotation/reset/revocation, exact Git-local-exclude
reconciliation and execution consumption of the approved catalogue plus the real
task-required matrix. The executor still uses legacy all-check semantics today;
this increment does not silently switch it to subset execution. No approval or
credential CLI grammar has been delivered. PAPC-073 may review these static source
interfaces but must not activate guessed deployment modes/flags or claim its
runtime implementation dependency complete. Existing installed/provenance,
independent review, full matrix/CI and human UAT gaps remain separate.
