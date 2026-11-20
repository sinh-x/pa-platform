# Lean immutable Analyst primer (PAP-327 P3)

This source slice implements FR-05 / NFR-03 / AC-04 / TS-04 of the PAP-327
r002 package. It changes fresh selected Analyst composition, not signing,
publication, Planned readers, Actual reports, installation or configuration adoption.
The P0 baseline is `d327e66`; no current reader defect is assumed.

## Composition and compatibility

`selectAnalystResources` captures `primers/budgets.yaml` through
`CommittedConfigSource`, alongside the exact team/mode and transitive resource
inventory. A fresh v3 Analyst snapshot explicitly sets `leanPrimer: true`.
The composer validates the captured budget hash and exact committed team/mode row;
it never guesses 9,000 from a mode name or substitutes a default when evidence is
missing, dirty, malformed, duplicate or corrupt.

Active objective, selected agent instructions, common methods, dispatch,
completion, workflow contract and final gate remain inline. Resources shared
between active slots are emitted once by exact selected path. Selected active
guides are not dropped by the retained placeholder-template heuristic.
Nonactive resources have bounded path/locator/digest metadata, not body dumps.
Selection still captures and verifies the full admitted closure at launch: this is
lean **prompt composition**, not deferred admission or an I/O/latency optimization.

Retained snapshots do not opt in from inventory alone, including those that
contain budget metadata. Historical v1/v2 bindings, unselected composition,
other public teams and OPA retain their existing budgets/loading. Previously
created primers are not rewritten. The Pi adapter suppresses independent native
skill loading for **both v2 and v3** resource bindings, including background
handoff serialization; otherwise Pi could reopen mutable optional `SKILL.md`
paths. Other plans keep their selected native skills and extension discovery.

## Native selected-reference read seam

Core `readSelectedModeResource(binding, path)` checks parsed binding membership
before I/O, reads only the exact commit's verified Git objects through
`CommittedConfigSource.readPinned`, verifies the selected SHA-256 and decodes
strict UTF-8 without altering BOM/CRLF bytes. It follows no new links and never
reads checkout content as a fallback. A newer HEAD cannot retarget the read.
Already verified object-cache bytes may satisfy it; unavailable/corrupt objects
or hash mismatches produce a typed dependent failure.

Pi `pi-extension/selected-resource-read.ts` wraps the **existing selected `read`
tool**, not a new capability. Its input uses the original read schema:

```json
{"path":"selected-resource:skills/global/example/references/detail.md","offset":1,"limit":2000}
```

The path must be an exact listed relative resource. Live native process, registry,
root, policy and session authentication run before reading, and caller identity is
rechecked before delivery. Selecting neither `ordinary.read` nor `context.read`
denies it. Full content/path security checks precede pagination; a redaction or
unavailable security policy withholds the reference instead of claiming exact
bytes. Pages preserve exact line bytes; `details.nextOffset` gives continuation.
Each result is at most 48 KiB of body text and 2,000 lines. A single oversized line
is refused rather than silently clipped. Source limits remain 1 MiB per resource
and the existing bounded closure. There is no automatic recursive read.

Success details label bytes `reference-only`, with selected revision, digest and
coverage. Reading never updates the binding, activates workflow obligations,
loads a native skill or changes tool exposure. A denied/missing/corrupt selected
locator never reaches the ordinary filesystem fallback. Normal non-locator reads
retain the existing implementation and schema, under their original permissions.
This is not hostile-same-UID isolation or a new filesystem sandbox.

## Host registration integration (P3 follow-up)

Core exports already work through the existing wildcard export of
`mode-capability-selection.ts`; no core index change is needed.

`registerPiSessionModules` now binds the final guarded/ordinary read definition,
including a supplied native-reader replacement, at authenticated `session_start`.
Only a resource-bearing immutable selection that already selects `read` gets
`createSelectedResourceReadTool(originalCaller, existingReadDefinition)`. It
replaces the same registered name in place, preserving the original schema,
renderers and common direct-call/lifecycle wrappers. There is no additional tool
or capability. Retained and omitted selections receive no locator description.

The native direct guard and document `tool_call` guard detect the exact
`selected-resource:` input before filesystem admission and call
`assertSelectedResourceRead(originalCaller, input, context)`. The original
registration/session identity is retained; current environment/config edits do
not widen it. Immutable tool admission and all non-locator path checks remain.
Unselected hosts also reserve this exact URI, so even a local file with that
spelling cannot become a fallback. Namespace aliases do not gain access.

The existing registry lifecycle owns each read. Cancellation/shutdown revokes
pending delivery and late calls; reload creates a new lifetime without reviving
the previous one. The registered API's final delivery fence also reauthenticates
selected locators after asynchronous settlement. Local result filtering remains
active, and the source-guard marker is informational, not authority.

`selected-resource-host.test.ts` exercises the production module composition,
the native-reader override and actual Pi SDK loader/runner registration. Its
nested-shaped calls dispatch real tool-call/result handlers; direct calls invoke
the registered definition. This is source-host integration, not an installed
runtime, model-driven end-to-end run, or human qualification.

## Focused evidence and message review

Disposable core/native fixtures cover all three modes, exact selected budgets,
actual footer counts/over flags, active obligations once, thin metadata, nested
reference loading, newer committed HEAD/mutable edits, omitted/foreign paths,
unavailable resources, corrupt hashes/objects, denied security policy,
continuation, cancellation and changed caller/session. Retained/full-capture,
ordinary-read schema, Pi v2/v3 loader and OPA controls are separate checks.

The actual selected PAPC revision was read through the immutable owner:
`ca4867a36e89fb18014cfd632fc2bd466596dc76`. Three deterministic repetitions per
mode gave the following same-pair counts (no deployment extra context):

| Mode | Selected budget | Active bodies, once | Lean lines / UTF-8 bytes | Full-capture control lines / bytes |
| --- | ---: | ---: | ---: | ---: |
| analyze | 9,000 | 7 | 439 / 85,363 | 8,583 / 682,497 |
| investigate | 9,000 | 7 | 437 / 83,794 | 8,581 / 680,928 |
| research | 9,000 | 7 | 431 / 80,977 | 8,575 / 678,111 |

Each selection has 53 resources: seven active bodies, team metadata, budget and
44 optional references. Footer lines/chars/over flags match actual output. The
control uses the same captured bytes without fresh lean opt-in or the newly added
budget resource; it is not the historical P3b run. Exact output counts satisfy
the size comparison, not a startup-speed claim. End-to-end performance verdict:
**inconclusive**; startup/model/host latency was not measured.

Information/help paths changed: reference catalogue, read-tool description and
selected budget footer. Before: “Reference-only methods are captured below…”
with full bodies and budget 1,200. After: selected locators/digests with explicit
reference-only status, on-demand read guidance and the committed budget 9,000.
Failures reuse existing bounded capability and local-content diagnostics, not raw
exceptions. Example: an unselected locator returns `CAPABILITY_OMITTED`; content
withheld by local security returns `LOCAL_CONTENT_POLICY`, not corrupt-binding
or success. NO_COLOR structural assertions and native source execution passed;
independent human readability review and installed verification remain unrun.

Administrative logs, red/green results, reproducible count script and the P3
implementation report are under
`/home/sinh/Documents/ai-usage/deployments/d-5ee695/artifacts/checks/pap-327-p3/`.
Workspace build/typecheck passed. Focused checks passed: core 109/109, Pi 36/36,
adapter selection 1/1, OPA 96 passed/one pre-existing skip. Earlier build/Pi runs
caught parallel-owned incomplete content-review integration; the final runs
passed without editing those files. No standalone lint script exists. Full
aggregate regression, hosted CI, installed registration qualification,
independent review and human UAT are not claimed. No live database/schema,
external configuration, installation or push was changed.

The P3 follow-up preserves the existing help/failure text: before, the registered
read description had only local-file guidance and the selected locator was
unwired; after, the existing selected-reference guidance is reachable on the
selected read tool. This is an information/help integration, not a diagnostic
rewrite. Typed capability/local-content failures and machine result contracts
remain with their existing owners. Independent human readability review and
installed verification remain unrun. Follow-up check logs are isolated under
`/home/sinh/Documents/ai-usage/deployments/d-5ee695/artifacts/pap-327-p3-host-Lt0Hab/`.

Follow-up verification passed: workspace `corepack pnpm build`, workspace
`corepack pnpm typecheck`, and 38/38 focused source tests (five new host cases,
including the real Pi loader/runner). The focused command was:

```bash
NO_COLOR=1 TZ=Asia/Saigon LANG=en_US.UTF-8 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 \
  src/__tests__/selected-resource-host.test.ts src/__tests__/selected-resource-read.test.ts \
  src/__tests__/mode-capability-session.test.ts src/__tests__/local-source-security.test.ts \
  src/__tests__/readonly-document-profile.test.ts src/__tests__/pi-extension-composition.test.ts
```

The initial red run exposed the absent registration/URI guard; two cases also
needed their disposable committed policy rows corrected. Early retries/builds
encountered incomplete parallel-owned phase-report imports/types; final checks
passed without edits to those owners. A broader attempt including the expensive
ordinary-development launch suite timed out at 120 seconds and is not a passing
aggregate regression. No standalone lint script exists. No installed adoption,
push, live ticket/database mutation, independent review or human UAT is claimed.
