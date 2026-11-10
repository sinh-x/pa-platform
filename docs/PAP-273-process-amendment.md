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

## P3 presentation and confirmation boundary

`pa_document present(sha256)` is available only on the new native workspace
profile. It reuses the existing pure escaped/CSP Markdown renderer, emits complete
snapshot-derived Markdown and static HTML links, and a package/member/renderer/hash
manifest. Existing companions must match exactly; changed output is a conflict,
not silently overwritten. Images remain explicitly opaque. Mermaid diagrams are
inert source, not claimed rendered diagrams. No browser is opened or observed;
Okular-compatible export is unavailable with an explicit Markdown/browser fallback.

New-profile capture/revoke now fail locally with DOCUMENT_UNAVAILABLE **before**
calling any legacy native UI. Capabilities report the attestation requirement.
Old-profile select capture is unchanged. Added tests prove caller actor/outcome,
transcript and source/event labels cannot issue a decision, journal state remains
unchanged, and publication without a decision fails. No conversational capability
is advertised or fabricated. Completing AC/TS-08–10 requires a Pi-host-owned,
unforgeable original input event identity/attestation, session/principal binding,
deduplication and exact pending-target protocol; an SDK event/source label alone
is insufficient. This is a dependent implementation blocker, not new scope intake.

Executed: core build and adapter direct tsc passed; presentation + retained native
suite **14 passed, 0 failed/skipped**. These are source/disposable fixture results,
not human-event evidence or human readability/visual acceptance.

## P4 runtime integration handoff (partial phase)

Added [the actual PAPC integration contract](requirements-workspace-interface.md),
version-aware runtime primer and tool descriptions, and source dispatch tests.
The native start marker, not current config/env text, selects rights. Explicit
v2 registration/loadout keeps generic shell/source and alias denials. V1/OPA/
retained primer paths retain their original semantics. Safe workspace tools are
not claimed as conversational approval capability.

Executed core build, adapter tsc and native/dispatch tests: **12 passed, zero
failed/skipped**. PAPC-077's complete external instruction/template/validator
closure is **not edited or qualified here**. That owner's integration remains
pending, especially the blocked trusted-event experience; no active selection,
legacy-resource rewrite or source-pair passing claim is made.

## P5 publication/recovery and handoff (partial phase)

Reused existing complete-before-primary publication, same-intent journal/ticket
CAS and queue owners without a new approval/effect path. Added v2-only status
readback distinguishing session association, recorded queue, recorded-but-unverified
branch evidence and unproven custody/launch. Branch-plan bridge remains explicitly
unsupported and assigned to the ticket/launcher owner, as allowed by the handoff;
no guessed action, write grant or automatic builder launch was introduced.

New handoff tests: **2 passed** after repairing one failed fixture that attempted
forbidden direct linkedBranches replacement. The repaired fixture uses the actual
TicketStore authenticated add-link owner and disposable Git repository. The first
combined recovery run had **31 passed/1 failed** (that fixture), with all 30 existing
integrity/process/service cases passing. Existing process-death/lost-reply,
revocation, changed-byte and lifecycle negatives remain intact. V2 source fixture
readback of already-issued exact effects performs no duplicate ticket/journal
writes and requests no new consent. Actual new conversational decision integration
and live branch bridge are not complete.

## P6 local qualification checkpoint — NOT acceptance

Final source includes P1–P5 commits `981f688`, `e73679a`, `6e9d5c1`,
`6c9a1e1`, `9332a8f` and the P6 commit containing this report. No runtime version,
config pin, installed store, external config, remote or ticket lifecycle is changed.

Qualification review added durable, exclusive pre-dispatch helper intents,
private 0600 result files/0700 result directory, and a native pending marker.
Crashes/unknown cleanup retain the marker and block overlapping workspace writers;
safe reads/capability inspection remain possible. Only proven settlement clears
it. There is no caller settlement grant or blind-reset action. Added portable
unsettled-state/duplicate-key/request-boundary cases and real Node/Bash, exact
32 KiB stdout and over-1 MiB file-limit probes. Native probes now attempt denied
host/foreign/symlink writes, not just inspect absent mounts. Repository/workspace
ancestor overlap is rejected. No aggregate disk quota or per-operation PID quota
is claimed; resource-saturation and full crash/recovery qualification are pending.

New-profile unavailable capture now reports the exact Pi human-input host owner
with bounded, operation-local five-field guidance. This is formatting over fixed
native causes, not another probe, approval question or permission path.

### Actually executed

Evidence: deployment-owned
`deployments/d-977df3/artifacts/PAP-273-validation/` under the ai-usage store.

| Command / lane | Actual disposition |
|---|---|
| `corepack pnpm typecheck` (final) | exit 0 |
| `corepack pnpm build` (final) | exit 0 |
| focused core/Pi `document-*.test.ts` (final) | **58 passed, 0 failed/skipped**, exit 0 |
| verifier + portable partition ownership tests | **12 passed, 0 failed/skipped**, exit 0 |
| `corepack pnpm completions` | exit 0; no generated diff |
| `corepack pnpm test:code` | exit 1: driver 35 passed; core 1769 passed, **1 failed**, 14 skipped; downstream lanes not reached |
| separate OpenCode test | 106 passed, 0 failed, **1 skipped**; exit 0 is not a required-skips waiver |
| separate Pi `test:code` | **600-second command timeout**, no final suite summary; incomplete, not passed |
| runtime-host test | 1 passed, exit 0 |
| full `corepack pnpm test` entry | **180-second command timeout** including preceding final typecheck/build; no complete suite result |
| staged sensitive-workflow scan | run before every phase commit; final result recorded by commit command |

The broad core failure is `generatePrimer live requirements config satisfies the
versioned compatibility contract when available`: the currently selected live
config's dispatch objective does not satisfy the retained fresh-handoff tuple
regex. No baseline reproduction or exact paired-lane qualification was performed
here; do not relabel it as an unrelated passing baseline or weaken the assertion.
The Pi/full timeouts leave their incomplete cases outstanding. No owned test
process remained after the harness timeouts. Early development TypeScript errors,
two namespace-limit failures and the forbidden direct-link fixture attempt remain
reported above. A later guidance edit also initially failed typecheck/build due
to mutable action narrowing; retained `*-narrowing-failed.log` records precede the
corrected final passing builds.

### AC / TS disposition (not acceptance)

| AC / TS | Source evidence delivered | Remaining gate |
|---|---|---|
| 01 | native association authentication + v2 handoff readback | complete missing-context diagnostic/foreground coverage |
| 02 | workspace CAS/read/import and boundary tests | exact installed modes and full artifact coverage |
| 03 | actual Python/Node/Bash confined helpers | installed/fresh-host/objective trial |
| 04 | actual host/foreign/symlink/network denial, child/cancel/output/file limits | saturation, operation-local quota design if required, full cleanup matrix |
| 05 | persistent results/intents and unsettled writer denial | actual interruption/resume/retention experience |
| 06 | existing extensible package mechanics retained | PAPC complete process/composition and feedback trial |
| 07 | exact snapshot Markdown/HTML manifests; no viewer claims | actual browser readability, diagrams, chosen Okular export/fallback |
| 08–10 | explicit fail-closed unavailable capability; v1 unchanged | host-attested events, pending-target/dedup/CAS implementation and real human confirmation |
| 11 | existing publication/queue process-death/lost-reply cases retained | new trusted decision integration + installed proof |
| 12 | truthful record-only handoff readback | supported ticket/launcher branch bridge |
| 13 | explicit new launch marker/parser/primer/tool dispatch tests | exact old/new selected-config and installed lanes |
| 14 | bounded workspace/unattested-capture causes and injection negatives | independent human readability and complete adapter/CLI review |
| 15 | local source checks and old installed inventory preserved | current hosted CI, independent review, exact packaging/selection/installed provenance |
| 16 | **not performed** | genuine normal foreground Sinh UAT/adoption; actual prompt counts/effects |

The old 62-ID document installed verifier remains **v1 only** and unchanged; it
cannot qualify v2 by numerical count or source substitution. A v2 installed/default
entry qualifier and complete new-case ownership must accompany the missing host/
PAPC integration before rollout. Existing validation lanes and mandatory tests
are not removed. No installed verifier, packaging, installation/activation/reload,
source-pair config lane, remote CI/push/PR/merge, independent reviewer, browser/
Obsidian/Okular observation, actual human approval/UAT, NX-067/TTL-017 retry or
checkout return was performed. The ticket and amended process remain **partial**,
not complete/accepted. Resume independent safe source work at the specific owner
blockers; do not repeat historical human decisions or product effects.
