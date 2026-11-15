# PAP-282: historical session-only external-read proposal

Status: **historical, unimplemented proposal; not an active implementation handoff
or approved runtime authority**. Original deployment: `d-4da053`.

## Current disposition — reviewed 2026-11-15

Documentation review baseline: `fb5b4172c52d054f620e6098a35ecd75940b5a59`
(`develop`, v0.1.168), not proof of the selected installed runtime.
PAP-282 is now Done and archived; that administrative disposition does not approve
or implement the external-read amendment below. Retain this record as design
history, not a new backlog item, selected capability or instruction to resume work.

- [PAP-292's ordinary-tool contract](PAP-292-implementation.md) already supports
  explicitly selected `ordinary.read`, including the whole normal effective
  ai-usage workspace under shared path/content safeguards. Do not introduce the
  proposed approval ceremony for reads that the current selected owner already
  admits. Actual availability still depends on the immutable session selection.
- [Current capability selection](mode-capabilities.md) keeps `context.read` and
  retained profiles separate. This proposal cannot widen their bindings, turn a
  denied read into an approved one, or authorize an alternate-reader fallback.
- [PAP-298's disabled integration](PAP-298-disabled-integration.md) owns a distinct
  selected-host/immutable-document problem. An ad hoc session grant cannot satisfy
  its provenance, hard-link, host or qualification prerequisites.
- No `pa_external_read` tool, request schema, grant store, profile selection or
  runtime change is delivered here. Any future revival needs a separately scoped
  decision that reconciles current PAP-290/PAP-292 access and PAP-298 boundaries;
  do not treat the old amendment as approval for new effects.

The original request was deployment-artifact access and native one-time ad hoc
approval for files outside the repository, asking again next session. The original
ticket amendment and the sections below describe that proposed design without
turning a path allowance into general host access. They do not replace the
published `pap-282-full-cli-interactions/r001` package or its exact decisions.

## 1. Historical source observations

Inspected base: `1eaf2e3f4f871cf0eaa2dbc07c969589f864978b` (`develop`, v0.1.159).
Also inspected PAP-282's existing foundation at
`760117c0c778f05bea188f87063ac8b76750bb2b` through Git objects, not by reading
another deployment's checkout. The observations below are source findings, not
claims about the selected installed runtime.

| Existing owner | Observed behavior and reuse boundary |
| --- | --- |
| [`document-tool.ts`](../packages/pi-pa/src/pi-extension/document-tool.ts), `documentSessionToolAllowed` | Requirements-route `read` resolves a path, restricts it to the repository, requirements artifacts or optional config root, checks sensitivity, and validates up to 8 MiB with `readArtifactFile`. Arbitrary deployment directories are not included. Other tools are explicitly allowlisted. Do not add the deployments root to this list. |
| [`document-session.ts`](../packages/pi-pa/src/document-session.ts), `authenticatePiDocumentCaller` | Authenticates native launch profile, running registry, canonical repository, process incarnation/ancestry and Pi session ID. V3 additionally returns `sessionId`. It deliberately excludes rogue-one and builder routes. Reuse the proof pattern, not this requirements-only role as a universal caller authenticator. |
| [`safety.ts`](../packages/pi-pa/src/pi-extension/safety.ts), `interceptToolCall` | Applies shared protected-path/shell policy to declared path fields and shell operands. It is not a repository-containment policy. It does not recursively validate paths inside a custom tool's raw JSON `request`. The new service must enforce policy itself. |
| [`advisory.ts`](../packages/pi-pa/src/pi-extension/advisory.ts) | Native advisory starts register checkout-local effect tools, while read/grep/find/ls and `pa_` names pass its tool-call gate. This is not an external-read approval owner or a complete filesystem sandbox. |
| [`operations/host.ts`](../packages/pa-core/src/operations/host.ts), [`operations/runtime.ts`](../packages/pa-core/src/operations/runtime.ts) | Builder advisory host verifies immutable native start, physical repository identity and live owner; it does not itself supply the Pi session identity needed for a read grant. Environment values are locators, not authority. |
| [`native-execution-tools.ts`](../packages/pi-pa/src/native-execution-tools.ts) | Wraps bash/write/edit at lower SDK execution boundaries for eligible native execution. It does not wrap the read tool here. External-read approval must not loosen these execution or write owners. |
| [`document-confirmation-native.ts`](../packages/pi-pa/src/document-confirmation-native.ts), [`document-confirmation-ui.ts`](../packages/pi-pa/src/pi-extension/document-confirmation-ui.ts) | Genuine foreground custom UI, cancel default, abort handling and caller checks before/after selection already exist. Reuse these interaction patterns, but not package-decision schemas, ledgers or publication grants. |
| [`dirty-borrow-approval.ts`](../packages/pi-pa/src/pi-extension/dirty-borrow-approval.ts) | Another native approval example, specifically for one dirty direct-child continuation. Its durable receipt/child authority is not suitable for session-only file reads. |
| [`artifacts/manifest.ts`](../packages/pa-core/src/artifacts/manifest.ts), `openArtifactDirectory`, `readArtifactFileAt` | Linux descriptor-relative no-symlink traversal, regular-file/single-link checks, size bounds and before/after file identity validation. Useful primitives, but they do not authenticate a session or bind an approved scope. The root must also remain pinned/revalidated. |
| [`sensitive-patterns.ts`](../packages/pa-core/src/sensitive-patterns.ts), [`safety-policy.ts`](../packages/pa-core/src/safety-policy.ts) | Existing path, filename, content and protected-path owners must still reject prohibited targets. Human approval cannot override them. |
| [`pi-extension/index.ts`](../packages/pi-pa/src/pi-extension/index.ts) | Composes modules and tracks registry accesses/shutdown steps before closing the database. New approval/read lifecycle work must join this owner rather than create an independent teardown path. |
| [`activity/index.ts`](../packages/pa-core/src/activity/index.ts), [`tool-result.ts`](../packages/pi-pa/src/pi-extension/tool-result.ts) | Existing activity-event sink and 50 KiB/2,000-line reply bounds. Event append alone is not approval or guaranteed durable issuance. Add explicitly bounded, non-sensitive events, not raw external file bodies. |

The PAP-282 feature branch adds source-only `pa_capabilities` discovery through
`packages/pi-pa/src/pi-extension/capability-tool.ts`, only in native-proven
advisory registration. Its inventory has unqualified/null effect bindings. Add
external-read inventory entries there as proposed/unsupported until implemented
and qualified. Do not advertise them as installed tools merely because listed.

### Pi API compatibility

The original deployment reported reading the local Pi extension/lifecycle
documentation and `permission-gate.ts` example. At that checkpoint the harness
documentation was Pi 1.4.0, while the inspected source declared Pi **0.84.4**.
According to that inspection, the declarations in
`packages/pi-pa/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
included `mode`, `hasUI`, `sessionManager`, `session_start`, `session_before_switch`,
`session_before_fork`, `session_shutdown` and tool-call hooks. It also found that
later `tool_call` handlers could mutate arguments **without revalidation**, so the
proposal requires validation again inside execution. Newer documentation was not
proof that every newer API existed in the then-selected 0.84.4 runtime. Any future
implementation must verify its own actual SDK and lifecycle, not reuse this
historical compatibility observation as current proof.

Pi extensions run with the account's OS permissions. A working directory,
project-trust setting, hook or approval dialog is not hostile same-UID isolation.
Do not use saved project trust (`/trust`, `trust.json`) for this permission.

## 2. Recommended shape: one dedicated read service

Use a dedicated, additive Pi tool, provisionally named **`pa_external_read`**.
The name and requests below are design examples, not an available command/tool.
Do not broaden retained `read`, `pa_document context`, workspace imports or shell.

The tool owns authorization **and the actual read**, returning only the bytes it
validated. A `tool_call` hook that approves a path and then lets the built-in read
reopen it leaves a second-open race. A boolean allowlist addition also loses
scope, expiry, revocation and audit information.

Proposed strict request union (all unknown/duplicate fields reject):

```json
{"action":"capabilities"}
{"action":"request","scope":{"kind":"file","path":"file:///home/sinh/Documents/ai-usage/deployments/d-example/activity.jsonl"},"purpose":"Inspect the selected deployment failure"}
{"action":"request","scope":{"kind":"directory","path":"/home/sinh/Documents/ai-usage/deployments/d-example","recursive":true},"purpose":"Inspect explicitly selected deployment artifacts"}
{"action":"read","path":"/home/sinh/Documents/ai-usage/deployments/d-example/activity.jsonl","offset":0,"limit":16000,"purpose":"Inspect the selected failure"}
{"action":"status"}
{"action":"revoke","grantId":"opaque-native-reference"}
```

- `read` with no matching grant may request native approval for that **exact file**
  and then read it. `request` permits an explicit directory grant without reading
  contents. A directory scope requires explicit `recursive: true|false`, never an
  implicit whole-tree grant. Nonrecursive covers direct regular-file children only.
- Repeated reads within a current grant do not prompt. Out-of-scope reads may ask
  for their own exact-file grant, never silently expand an existing directory.
- `request` approval reads metadata only. Content sensitivity is checked during
  the approved read. An approved path can still be unreadable or policy-denied.
- `grantId` is a non-transferable lookup/correlation reference, not a bearer token.
  No input accepts `approved`, actor, principal, outcome, session ID, deployment
  ID, repository root, expiry override, command, environment or receipt import.
- `status` lists only current caller grants, bounded, without file contents.
  `revoke` only removes a current caller grant; it does not create authority or
  require an approval prompt. An operator status/revoke slash-command may share
  the same service, but is optional and needs its own exact supported grammar.
- Proposed results distinguish `approved`, `denied`, `cancelled`, `unavailable`,
  `expired`, `scope-mismatch`, `policy-denied`, `stale`, and `read-completed`.
  Approval is not read completion. Keep machine codes and human text separate.

## 3. Native approval and session lifetime

Bind each in-memory grant to a native-derived tuple:

```text
(runtime incarnation nonce, process fingerprint, deployment ID,
 Pi session ID, repository identity, eligible role/profile, canonical scope,
 scope kind + recursive extent, pinned scope filesystem identity, policy version)
```

Generate a new nonce on every runtime/session start. A persisted Pi session ID
alone is insufficient: restarting or resuming the same transcript must ask again.
Never reconstruct grants from tool-result details, `appendEntry`, session history,
activity files, ticket decisions or environment selectors. Do not persist usable
grants to disk. Audit receipts remain historical observations only.

Approval sequence:

1. Validate request and authenticate the eligible native caller. Normalize and
   check the requested scope using metadata only. Capture current session epoch.
2. Serialize pending UI per session. Identical concurrent scope requests share
   one prompt; do not batch different scopes into an implicit larger grant.
3. In foreground `tui` only, show the entire safely rendered canonical path,
   file/directory kind, recursive extent, purpose, current session, read-only
   effect and expiry. Explain that allowed content enters model context and may
   appear in the session transcript. Offer Approve this scope / Deny / Cancel,
   with Cancel selected by default. No page acknowledgements or second approval.
4. Reauthenticate after UI, check abort/closing/epoch and scope identity again.
   A stale caller/target or missing native UI yields no grant. Do not treat generic
   question answers, chat assent or a caller-provided principal as native evidence.
5. Record bounded issuance audit successfully before activating the grant. On
   audit failure leave it inactive. Derive native interaction ID/local UID in the
   adapter; local UID is not independent proof of a real-world human identity.
6. On each read, revalidate the tuple, current policy, scope and target. Audit an
   authorized attempt before content I/O. Recheck revocation/epoch after I/O and
   before returning any content. Serialize grant changes/read release or use an
   epoch counter so a pending revoked read cannot release bytes afterward.

Clear/invalidate before session shutdown, new/resume/fork/reload and at every
`session_start`, even if an ID happens to match. Use `session_before_switch` and
`session_before_fork` to invalidate pending UI early, plus idempotent shutdown
cleanup. If a switch is cancelled, conservatively require fresh approval. Ordinary
turn end, model retries and compaction within the unchanged live session should
not clear grants. Close all held scope descriptors and abort pending UI/I/O during
revocation/expiry/shutdown, including error paths. Validate actual lifecycle
ordering against the selected SDK.

A crash cannot make a grant reusable because only memory held it. A crash may
omit a terminal expiry event: do not fabricate one or replay old grant records.
Revoke invalidates first, then records the outcome; audit failure must not restore
a revoked grant. On any required audit/read-release failure withhold content.

## 4. Scope normalization and safe file I/O

The deployments directory is an eligible scope to ask about, **not an allowlist**.
No deployment artifact or other requested external input was read during this
design work. Local Pi API documentation was read to check the integration.

- Accept absolute local filesystem paths and local `file:///` URIs. Use a real URI
  parser/`fileURLToPath`, not string prefix removal. Reject nonlocal authorities,
  query/fragment, malformed or encoded separators, controls, invalid Unicode,
  shell expansion and unsupported schemes. Decode once, then normalize.
- Normalize `.`/`..` before approval and display the actual resulting scope.
  `file:///home/sinh/Documents/ai-usage/deployments/..` means
  `/home/sinh/Documents/ai-usage`, not the deployments directory. Never display
  one root and approve another, or silently widen to `/home/sinh` or `/`.
- Check protected-path/sensitive-path/filename policy on both input and normalized
  target. Metadata traversal must not follow symlinks. Reject symlink ancestors,
  final symlinks and hard-linked files. Use path components or `relative`-based
  containment, not a naked string prefix (`deployments-other` is not inside).
- Pin approved directory/file device+inode identity. File approval is permission
  to read that file, not approval of an immutable content digest: stable appended
  logs may be read again. Replacement with another inode invalidates the scope.
  A directory grant may cover newly created safe regular files within its extent,
  but root replacement/rename outside the approved path must fail revalidation.
- Reuse/extract the artifact descriptor-relative traversal pattern without changing
  its existing consumers. Open descendants relative to the pinned root, disallow
  symlinks, verify approved-root path/identity before and after I/O, and reject
  escapes/mount aliases. No `/proc`, `/sys`, `/dev`, devices, sockets or FIFO reads.
  The existing helper is Linux-specific; fail unavailable on unsupported hosts
  until separately qualified. Do not claim inode checks prevent hostile same-UID
  attacks or bind-mount changes without a stronger OS boundary.
- Read once into a bounded stable buffer. Validate regular file, single link,
  configured maximum size and before/after device/inode/size/timestamps. Reject
  concurrent modification rather than return an unverified prefix. Do not reopen
  after validation through built-in `read` or spawn `cat`/Python/shell.
- Validate strict UTF-8 text, controls/terminal safety and **whole-buffer** sensitive
  content before slicing. Reject the read on a sensitive match. Scanning only the
  requested page can leak split credentials. Images/binary input are unsupported
  in this first implementation, not passed to a different reader automatically.
- Proposed initial bounds: 8 MiB source (matching the current requirements guard),
  16,000 characters/page, final serialized response at most 50 KiB/2,000 lines,
  at most 32 active grants/session and one pending approval UI. Final values belong
  to the reviewed contract. Oversized deployment logs need an explicit supported
  diagnostic; do not truncate before sensitivity checks. Safe large-file streaming
  is separate design work if required, not an unbounded fallback.
- Pagination must pin a content hash/identity after the initial stable read and
  return a continuation bound to session/grant/file/version/offset. Later changes
  return stale; a new initial read can see a new stable log version without a
  redundant scope prompt. Never treat a cursor or file hash as authorization.

The selected reader must not enumerate a directory merely because its files may
be read. No external writes, arbitrary search, helper mounts/imports, shell,
network, publication, workflow decision or other-project execution follows.

## 5. Profile integration and bypass limits

The original PAP-282 amendment proposed all Pi roles with role limits; it does
not select them now. If separately authorized in future, implement a common read
grant service with **role-specific authenticated caller adapters**, not a universal
environment flag. Each eligible profile must supply native start, running/process
identity, session ID and current repository proof. It must not need builder write
capacity merely to read an independently allowed diagnostic.

For requirements, select a reviewed successor profile through existing native
launch owners, with the tool explicitly allowed only there. Preserve v1/v2/v3
and retained/pinned starts. `pa_workspace` remains confined and cannot import or
mount external files using the grant. For builders, coordinate advisory/native
execution owners without borrowing their write/lease authority for file reads.
Other roles remain unsupported until their authenticators/composition are covered.
Rogue-one is not a grant, nor proof that this new capability was selected.

A dedicated tool alone does **not** make every other read approval-gated. Current
advisory hooks admit ordinary read/grep/find/ls, and general safety is not a sandbox.
For each new profile, explicitly close alternate external-read routes (built-in
read, grep/find/ls, nested/custom tools and shell where applicable) using the
existing owning confinement/tool boundaries. Keep already-authorized safe reads
working. Shell reads must not consult the new grant or acquire new host mounts.
If arbitrary host shell or other trusted extensions remain accessible, document
that limitation and do not claim host-wide approval enforcement. Strong isolation
requires the host/OS owners, not a shell regex or the `pa_` name prefix.

## 6. Suggested implementation slices

All new paths/names in this table are proposals, not existing files.

| Slice | Existing integration / proposed addition | Exit evidence |
| --- | --- | --- |
| Contract | Add `packages/pa-core/src/external-reads/{contract,service}.ts`; reuse strict JSON parsing, sensitive policy and bounded results. Define typed host authentication/UI/audit ports, no generic permission engine. | Invalid/unknown/duplicate/forged fields reject before UI/I/O. |
| Checked I/O | Add `external-reads/files.ts`, extracting or internally reusing artifact fd-relative primitives without changing artifact behavior. | Traversal/race/sensitive-content and unchanged artifact tests. |
| Native caller/UI | Add `packages/pi-pa/src/external-read-native.ts` and `pi-extension/external-read-tool.ts`; adapt existing native UI/caller/abort patterns. | Genuine foreground selection only, per-role proof, cancel default and changed caller/target rejection. |
| Session integration | Compose in `pi-extension/index.ts`, profile launch/config owners and requirements/advisory guards. In-memory epoch/grants and lifecycle invalidation. | Lifecycle/concurrency/revocation and alternate-reader negative tests; no retained-profile upgrade. |
| Discovery/audit/docs | Reconcile feature-branch `interactions` catalogue/source inventory and capability tool; reuse activity owner with sanitized minimal metadata. Update relevant primer/help/profile docs together. | Actual advertised-versus-registered capability test; bounded events and safe diagnostics. |
| Qualification | Build selected runtime, verify exact installed pair/profile, exercise native approval/read/revoke in foreground. | Source tests and installed observations separately recorded; real human UAT, no generated-output-as-observation claim. |

Audit minimal event data: native interaction/grant reference, session-epoch
correlation, scope kind/digest, safe policy code, approved/denied/cancelled/revoked/
expired/read-attempt/read-completed outcome and bounded counts. Do not copy raw
purpose, file bodies, exception strings, environment secrets or credential-bearing
paths into events. The operator screen can show the validated exact scope without
creating a persistent raw-path log. Ordinary safe returned content may still be
recorded by Pi's transcript/tool-output pipeline; inspect that pipeline during
qualification. New audit records are not reusable authority.

## 7. Message changes to review

Follow the [CLI message standard](cli-message-standard.md), especially procedure
§4 and checklist §8. Affected categories: capability/help, approval information,
read success, expired approval and policy/UI/read blockers. Preserve structured
results, streams and existing policy owners. The following are synthetic designs,
not installed output or a proposed modification of every existing message.

Before (historical generic requirements-route denial at the inspected base):

```text
This requirements route supports artifact drafting/context and ticket tools, not shell/source/Git/builder/resource operations. Use pa_document for local supporting operations.
```

After (new eligible reader, native UI unavailable):

```text
External file not read: native approval is unavailable in this session.
Condition: The requested external read did not start.
Source: Native session read-approval check.
Reason: This operation requires the eligible foreground approval UI. No grant was created.
Correction: Ask the operator to inspect the current runtime/profile capability. Impact: none. Actor: agent. New approval: not required to ask. Prerequisite: preserve the existing request; do not use shell or another reader to bypass the check.
Resume Action: Retry the read only when the owning service confirms a supported foreground approval boundary. Admission is checked again.
```

Success (grant, not content): “Read access approved for the displayed scope in
this session. No file content has been read.” Read success must instead report the
actual page/version and whether more remains. Expiry should identify the old grant
as unusable and offer the exact native request again, without implying ticket or
package approval is missing. Policy denial must not suggest another approval can
unlock a protected file. No repeated prompt inside an unchanged approved scope.

## 8. Test matrix for the implementation deployment

| Case | Required result |
| --- | --- |
| Exact safe deployment file | One native prompt; complete bounded read; repeated pages/reads use the same live scope. |
| Directory extent | Explicit recursive/nonrecursive prompt; only approved descendants/direct children; outside file gets a separate exact request. No automatic enumeration. |
| Deny/cancel/abort/headless | No active grant or target content I/O; pending UI resolves safely; denial cannot fall through to another reader. |
| Forged caller/arguments | Reject model outcome/principal/session/env/receipt overrides and post-hook mutated arguments. |
| Lifecycle | New/resume/restart/reload/fork/new deployment cannot reuse grants, even with same transcript ID. Turn end/retry/compaction alone do not reprompt. |
| Concurrency/revoke | Same-scope concurrent requests share one prompt; different scopes serialize; revoke/switch during UI or I/O prevents activation/content release. |
| Paths | Local URI/path equivalence, encoded traversal/separators, malformed authorities, `deployments/..`, sibling prefixes and prohibited roots. |
| Filesystem | Ancestor/final symlinks, hardlinks, FIFO/socket/device, directory/file substitution, rename/root replacement, changed inode and unstable growing log. No descriptor leaks. |
| Sensitive/large input | Whole-buffer filename/path/content rejection, split-page secrets, invalid UTF-8/controls, oversized file, final JSON byte/line limits; no raw rejected bytes in audit/error/details. |
| Pagination | Cursor bound to caller/epoch/grant/file/version/offset; changed file is stale; no cursor replay after expiry/revocation. |
| Composition | Requirements/advisory/native/other eligible roles authenticated separately; retained and unsupported profiles unchanged; existing safe reads preserved; alternate-route limitations measured. |
| Non-grants | No write/edit/shell/helper import/mount/project/workflow/publication/launch rights; unrelated policy denials stay denied. |
| Audit/diagnostics | Issuance/audit failure cannot activate/release; revoke stays revoked on logging failure; crash does not reconstruct permission. Five blocker labels once, <=2,000 JS characters, NO_COLOR and hostile-context checks. |
| Installed/human | Exact built/installed version and selected profile/tool registration recorded; real foreground approve/deny/revoke/read and next-session prompt observed by the operator. |

Add focused tests such as `external-read-{contract,files,service}.test.ts` in
pa-core and `external-read-{native,lifecycle,composition}.test.ts` in pi-pa. Also
run existing artifact, document-session/native, dirty-borrow approval, advisory,
execution and extension-composition regressions where touched. Use the admitted
implementation checkout and task-specific matrix for pnpm typecheck/build/test,
completions when affected, and secrets scan before a sensitive-workflow commit.
These are future checks, **not passes recorded by this design deployment**.

## 9. Historical handoff and evidence limits

If Sinh separately chooses to revive this proposal, first identify which requested
reads remain unsupported by their current admitted owners. Do not reopen unchanged
intake or add prompts to normal ai-usage reads. Any still-needed design must then
be reconciled into a newly scoped capability matrix, requirements/specification,
implementation plan and UAT through the existing owners. Preserve r001 and earlier
approvals. Revised immutable packages need their own exact native decisions before
dependent effects; this record does not inherit or manufacture them. Final tool,
schema and profile selection remains subject to that review, especially alternate-
reader confinement and safe oversized-log access. No implementation is selected
by this documentation cleanup.

Original deployment's reported evidence: source/API inspection and documentation-
only structural checks. It reported no external deployment-file reads, runtime
changes, new permission settings, implementation tests, installed exposure
qualification, independent review or human product UAT. Those historical claims
are not evidence about the later review deployment; original ticket history owns
its check results and source revision/branch. Repository documentation is non-active
config.
