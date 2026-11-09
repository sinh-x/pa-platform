# PAP-273 process amendment implementation

## P1 baseline and proof obligations

Selected branch began at `9a5ed4cc32c59d290b65fceadaf0e64cf9c32606`.
Its original delivery was squash-integrated as develop `7e0cae4`; the amendment
requires PAP-277/PAP-283. Reconcile with develop
`4c9394d385b33389b83c430403b55b9f07512550`, preserving the develop tree
rather than combining duplicate pre-squash implementations. No release/pin change.

Plan source: external PAP-273 process-amendment-d-6ce218/r001, P1–P6.
This implementation does not replace historical decisions or assert draft approval.

### Characterization

* `document-session.ts`: v1 authenticates immutable start, live registry,
  process incarnation, physical repository, session and association edges.
* `document-tool.ts`: v1 denies generic shell/edit/write. Retain this behavior.
* `package-service.ts`: descriptor-confined draft writes; immutable snapshots;
  native capture callback; existing append-only journal and ticket CAS.
* `document-native.ts`: v1 paged select capture remains v1, not conversational.
* Pi 1.4.0 `InputEvent` exposes text/source/streamingBehavior, **no immutable
  authenticated human event ID or original-event attestation**. Input transforms
  chain; SDK prompt source is caller-supplied. Source labels alone cannot prove
  the requested human provenance. New conversational capture must remain
  unavailable until a host-owned attested event interface exists. No invented
  tool actor/outcome/transcript port, no second approval database.
* Bubblewrap is present and a disposable namespace probe succeeded. Existing
  ProjectCommandContract confinement is reusable in design, but its catalogue,
  writer custody and execution semantics are not ordinary requirements gates.

### New capability design

Opt-in `document_profile: pa-document-workspace/v2` for fresh foreground
requirements/analyze only. Native start marker must distinguish v2 from retained
v1. Add a separate `pa_workspace` operation interface; never allow unrestricted
built-in shell/edit/write. Deployment-owned mutable workspace is outside product
source and immutable package snapshots. Only explicit, sensitive-checked repository
files are copied as inputs; no repository/host HOME/foreign deployments are mounted
inside helpers. Retained artifact reads stay read-only through existing owners.

Helpers require trusted root-owned Nix executables, bubblewrap namespaces, no
network, cleared environment, dedicated writable workspace and isolated temporary
files. Process/output/time/file limits are finite and advertised by the interface;
unsupported confinement blocks that operation only. Cancellation kills the owned
namespace/process group and must report unknown cleanup if settlement is unproven.
No arbitrary host installation, service access or application execution is implied.

### Executable source validation matrix

All commands execute in the selected feature checkout with cached dependencies.
Build core before adapter source tests to prevent stale dist imports.

| Phase / AC–TS | Source owner / command | Evidence class |
|---|---|---|
| P1 retained characterization, 01/13 | document-session/native tests | source fixtures |
| P2 02–05/14 | new document-workspace tests, including actual namespaces | source + disposable native process |
| P3 07–10 | capture capability dispatch tests, no injected event approval | source fixtures; host blocker retained |
| P4 06/13/14 | parser/primer/extension loadout tests | source composition only |
| P5 11/12 | document-service/integrity/process tests; branch bridge status | source disposable effects |
| P6 15/16 | typecheck, build, test:code, completions, secrets:scan | local source; not human acceptance |

Focused command: `node --import=tsx --test packages/pa-core/src/__tests__/document-*.test.ts packages/pi-pa/src/__tests__/document-*.test.ts`.
Verifier ownership: `node --test scripts/dev/verify_document_runtime.test.mjs`.
Retain every old installed ID and validation lane in
[requirements-validation-lanes.md](requirements-validation-lanes.md).

PAPC process edits belong to PAPC-077, external compatible selection to PAP-285.
Hosted CI, independent review, exact Git packaging/install/selection/reload and
Sinh foreground UAT are separate gates; none follows from these source checks.
Actual results and remaining limitations will be appended per phase.

## P2 source delivery

Added opt-in workspace profile/start marker, authenticated `pa_workspace`, CAS
writes, explicit sanitized repository-file import and read, and confined helpers.
Generic source/shell tools remain denied in both versions. Workspace inputs,
scripts and outputs persist under the native deployment draft directory;
helper results are retained in a sibling directory outside the helper mount.

Limits: request 64 KiB, file/import and RLIMIT_FSIZE 1 MiB, combined captured
stdout/stderr 32 KiB, wall/CPU 30 seconds, 128 descriptors, address space 8 GiB,
RLIMIT_NPROC 8192. NPROC is a **shared host-UID ceiling**, not an operation-local
PID quota; unavailable shared capacity fails closed. No aggregate workspace disk
quota or hostile-same-UID protection is claimed. The initial 1024 NPROC/2 GiB
attempt failed namespace startup (two tests failed), because this host already
had thousands of user threads. Preserve that failed attempt; corrected limits
passed the disposable checks. Node uses bounded old-space and disables the Wasm
trap reservation; arbitrary toolchains remain unsupported.

Executed: core build passed; adapter direct tsc passed after correcting initial
TypeScript narrowing/API errors. Focused complete document family: **50 passed,
0 failed/skipped** (source fixtures and actual disposable Python namespace
processes, not installed qualification or human input). New native workspace
suite has explicit manual-integration ownership in the portable CI partition;
full local entry still runs every case. Browser/Okular export, attested human
capture, PAPC rollout and foreground acceptance remain unproven.
