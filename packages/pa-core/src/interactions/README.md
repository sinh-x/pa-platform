# PA interaction foundation (PAP-282)

This directory contains a **partial source implementation**, not the completed
PAP-282 interface or an installed/adopted runtime claim. The catalogue/discovery
reader is source-only and never grants permissions. A separate finite ticket
creation and exact existing-ticket selection service has an opt-in requirements native port described below.
Neither surface executes CLI commands or alters a retained tool schema. The Pi
adapter exposes `pa_capabilities` for native-proven advisory starts and the new
opt-in document-interactions profile; its target inventory is never live admission.

The approved product scope lives in PAP-282's six-member
`pap-282-full-cli-interactions/r001` requirements package. This code begins P1;
it does not replace that package or narrow its acceptance criteria.

## Contents

- `contract.ts`: versioned discovery `list`/`describe` request union, shared JSON
  Schema and strict raw JSON parser. Unknown/duplicate fields, invalid Unicode,
  excess bytes and execution/identity overrides reject before dispatch. It reuses
  the existing strict JSON reader without changing that reader's consumers.
- `discovery.ts`: bounded source-only listing/description over an immutable reader
  snapshot, with integrity-protected, reader/view/query-bound continuations. It
  does not inspect installed tools or runtime permissions. A fresh reader requires
  a fresh listing; a cursor never authorizes effects or access to runtime data.
- `catalogue.ts`: data-only target dispositions for core/PPA families and selected
  effect variants. `cliForms` are schematic inventory labels, **not runnable
  commands or an argv grammar**. `targetDisposition` is product intent, not
  current availability. No generic forwarding/dispatch exists.
- `tickets.ts`: strict raw creation/inspection/reuse schemas and requirements-only service;
  current native caller, exact registered project, primary scope, metadata and
  sensitive-input checks are repeated at the owner boundary. Creation rechecks
  inside the existing ticket-owner mutex; selection rereads without locking or
  mutation and rejects changed snapshots.
- `source-inventory.json`: hashes of selected dispatch/CLI/native owner sources. Tests conservatively
  require reconciliation when any tracked source changes or a command file is
  added. Hash equality is not semantic coverage, installed provenance or approval.

For example, `health.report` is a read while `health.save` is a write delegated to
its existing owner. `status.wait` and `serve.status` are not safe substitutes
for native reads: their existing CLI implementations can reconcile lifecycle
state or remove stale PID state. Signal dry-run
remains sensitive/operator-only even when it does not persist results.

Every native/delegation binding and operation request/result schema reference in
the source-only catalogue is currently null. Consumers must not convert a target disposition into an available
tool. `SOURCE_ONLY_AVAILABILITY` keeps configured, installed, session registration,
availability and admission separate and explicitly unproven/not checked.

## Remaining P1 work

This is not an exhaustive operation qualification. Finish semantic reconciliation
of supported help forms, positional aliases, option combinations, implicit effects
in imported domain services and concrete role/mode cells. Native-only
workflow/decision/document/workspace/preparation/execution/report actions are
listed separately by channel; they are never advertised as CLI subcommands. Add typed family request/result schemas and their owner bindings
as those services are implemented; do not populate references with proposed names.
The source-only reader is not a runtime capability service: role filters,
visibility/admission observations and installed provenance remain unimplemented.
The raw JSON TypeBox wrapper is in `packages/pi-pa/src/pi-extension/capability-tool.ts`;
core exports expose that reader separately from the new finite intake service.
Retained document/v1/v2/v3, pinned, unmarked and otherwise unselected starts do not
acquire the new registration or any additional write permissions.

For a changed CLI source, inspect the handler and its affected domain calls,
reconcile IDs/forms/effect boundaries and add negative tests **before** updating
its source digest. Never refresh hashes solely to silence a failing test. The
independent high-risk invariants are additional regression checks, not a complete
permission engine or exhaustive command parser.

## Ticket-owner creation primitive

`TicketStore.createWithIntent` extends the existing ticket owner, not the
interaction catalogue. It accepts trusted adapter-supplied caller scope, stable
request ID and a mandatory reauthentication callback under the same mutex used by
ordinary ticket writers. `tickets.ts` now supplies strict request validation,
registered-project scope and explicit companion intent; only the separately
selected new native profile can reach that service through a tool. Existing
unbound primitive digests remain unchanged. The new adapter also binds the
canonical raw request digest so a changed kind or text removed by CLI-compatible
sanitization cannot replay as an unchanged request. The digest is not authority.
The shared ticket mutex now rejects symbolic/hard-link and special-file aliases
before changing permissions and pins its verified inode for the flock helper.

The ticket store owns immutable `.ticket-create-<digest>.json` intent records
beside its existing counter/ticket/audit files. These are idempotency data, **not
permissions, approvals or a second adapter replay database**. An intent reserves
one exact ID and complete candidate before counter, ticket and audit effects.
All ordinary ID allocation skips these reservations. Candidate and counter writes
are atomic; the new primitive writes its audit through the same atomic file
boundary, and reports success only after ticket/audit readback. `reused` refers to
an existing intent and does not claim a recovery performed no remaining effects.

An interrupted original intent can finish missing proven steps. Conflicting
payload/actor, malformed intent/candidate/audit, a deleted or moved ticket, and
unsafe file aliases are not silently normalized, overwritten or treated as
absence. Unknown reservation data blocks dependent creation (including ordinary
ID allocation); it never authorizes deleting evidence or retrying with a fresh
identity. Existing document-v1/v2/v3 tag-based intake is not migrated or widened.

Disposable tests cover response loss, interruption after intent/ticket/audit,
ordinary-writer reservation coexistence, real concurrent owner processes,
conflicting payloads, stale caller callbacks, corruption and symlinks. They are
not a genuine native foreground creation journey, exhaustive crash/power-loss
qualification, source-owner authentication or full CLI/native parity.

## Scalar planning — limited new-v4 native slice, not activation

`TicketStore.patchPlanningWithIntent` is the finite **data-owner** primitive for
`title`, `summary`, `description`, `priority` and `estimate` only. The explicitly
selected new-v4 `pa_ticket_intake` now exposes `action=patch-planning` through
`patchTicketPlanningInteraction`. This is not the complete FR-05 journey.
Status/assignee, arrays/tags/blockers, comments, refs, Git evidence and subtickets
are not patch fields. The adapter reauthenticates the supported native profile,
current caller, exact project and conservative retained-owner observation under
the same ticket mutex. Supplied versions are preconditions, never authority.

The primitive accepts the complete normalized ticket version, stable scoped
request identity, exact finite patch, derived actor and synchronous trusted
reauthentication callback. Only unclaimed requirements/`sinh` idea or
requirement-review data without primary/Git evidence is eligible. CAS is a data
precondition, not lifecycle admission. Unknown fields, invalid/oversized/sensitive
text, no-op patches, stale versions and protected scope reject. Ordinary CLI
methods and retained consumers are not redirected through this new method.

Immutable `.ticket-plan-<digest>.json` records precede ticket and audit writes.
The shared mutex serializes competing CAS updates; each result requires actual
ticket/audit readback. Original same-intent recovery completes missing proven
steps, while changed payload/actor/version/raw-input binding conflicts. A missing
final audit blocks a fresh planning identity for that target. Intervening ordinary
work is preserved, not rolled back or overwritten to finish an old intent. After
proven completion, replay returns the current ticket plus the original
`appliedVersion`, without reverting later changes or appending another audit.
These records are idempotency data, never approvals or a second permission store.

Source tests cover fault boundaries, real concurrent owner processes, stale CAS,
same-intent replay, changed caller/policy, pending-intent bypass, corrupt intent,
symlinks and torn audit. They do not prove crash/power-loss completeness, full
CLI/native differential parity, current retained-owner eligibility, installed
native planning or human UAT. The new native slice is separately covered by
synthetic composed-host source tests, not actual installed behavior. Incremental
owner flows and broader retained-owner reconciliation remain unfinished; no
generic raw-update tool is introduced.

## Opt-in native creation slice — source support, not activation

The NEW `requirements/analyze` configuration profile
`document_profile: pa-document-interactions/v4` selects the native start marker
`requirements-document-interactions/v4` for an eligible fresh foreground launch.
It retains v3 package/workspace/confirmation behavior and adds `pa_ticket_intake`
plus source-only `pa_capabilities`. The caller must match the native registry,
process incarnation, canonical root, session and registration identity on every
call and inside the ticket lock. Background, resumed, pinned, inherited, rogue,
auto/spike and non-requirements starts do not gain this port. Current config is
not modified or activated by this source change; PAPC composition, exact installed
pair qualification and operator adoption remain separate.

Retained `pa_ticket` remains read/show/list/comment. Retained document ticketless
intake, signed package bytes and native decisions are not migrated. Only requested
idea creation, read-only exact-ticket selection and limited scalar planning are
added, not status/primary/Git/resource/shell operations.
Cross-project metadata does not access that project's files or alter the primary
association/root/provider/model. Destination must be an exact registered project
key with an unambiguous prefix, not a path or fuzzy alias.

In the new-profile session, first describe the actual finite port with:

```json
{"request":"{\"schemaVersion\":\"pa-ticket-intake/v1\",\"action\":\"capabilities\"}"}
```

This strict read returns supported schemas, defaults, limits and only implemented
actions (`capabilities`, `inspect`, `reuse`, `create`, `patch-planning`), without constructing TicketStore or creating an
intent/lock/ticket/audit. It is interface metadata, not installed provenance,
creation admission or a grant. Each creation still rechecks all effect owners.
`pa_capabilities` remains a separate broader **source-only target inventory**.

### Select aligned existing work before creating

After searching through the existing read interface, inspect one exact candidate:

```json
{"request":"{\"schemaVersion\":\"pa-ticket-intake/v1\",\"action\":\"inspect\",\"kind\":\"companion\",\"project\":\"other\",\"ticket\":\"OTH-001\"}"}
```

This synthetic locator is not a real ticket or authorization. `inspect` returns
bounded safe identifying metadata and a digest of the complete normalized ticket
snapshot bound to the current native caller. To select this unchanged work, send
`action=reuse` with the same kind/project/ticket and exact `expectedVersion`,
`expectedTitle`, `expectedType` from inspection. The version is a freshness
precondition, **not permission or approval of hidden content**. Every call checks
the current caller/project/primary again. Changes to any ticket content, including
comments, or the caller invalidate reuse. Missing/moved/foreign tickets and
unaligned title/type reject; no fuzzy matching or automatic replacement occurs.

Both operations are read-only as-of observations. They return the existing real
ID and unchanged primary ID, not a durable reservation, claim, planning grant,
execution right or promise of later availability. They do not write ticket,
intent, counter, audit or lock state, and the adapter will not initialize a missing
ticket directory for a selection. Unsafe or oversized legacy metadata is rejected,
not truncated into a misleading alignment preview. Full paged ticket/history
readers remain separate P3 work.

### Patch scalar planning from an inspected snapshot

For this NEW v4 port only, `inspect` also returns `snapshotVersion`, the complete
normalized data-owner CAS digest. Send `action=patch-planning` with a stable
`requestId`, the same exact kind/project/ticket, `expectedVersion` set to inspected
`version`, `expectedSnapshotVersion` set to inspected `snapshotVersion`, and a
nonempty `patch` containing only the five scalar fields listed above. For example,
a synthetic patch body is `{"summary":"Clarified requested scope","estimate":"S"}`;
use the real inspected versions, not fixture hashes. Strict raw JSON rejects
unknown/duplicate/authority fields and unsafe, oversized or invalid text before
effects. Planning preserves text verbatim within these bounds; unlike creation,
it does not apply lossy CLI creation sanitization.

The service verifies the caller-bound version against the ORIGINAL intent
snapshot inside the ticket mutex, including same-intent recovery. The adapter's
read-only registry observation rejects ANY other current or historical deployment
association, even if completed or later reassociated. Missing registry evidence
also rejects. This deliberately conservative slice cannot settle a retained
package/custody owner or promise general requirements planning; that reconciliation
remains with the existing owners. Current registry observations are not a global
reservation against future owner changes, and are repeated before effects.

A successful result identifies the persisted ticket/project, unchanged primary,
original applied version and whether the original intent was reused. It returns
no hidden ticket body and makes no approval/lifecycle/execution claim. After reply
loss, retain ORIGINAL ID, both versions and patch. Completed replay preserves later
ordinary work without another audit; pending uncertainty is not bypassed with a
fresh ID. If caller/project/ownership is no longer admitted, the dependent call
stops and original records stay preserved. A proven stale request that published
no intent requires reinspection and a new planning decision, not blind retry.

Synthetic creation request for an already-bound new-profile session (not a real
ticket or authorization; replace project/title with explicitly requested work):

```json
{"request":"{\"schemaVersion\":\"pa-ticket-intake/v1\",\"action\":\"create\",\"requestId\":\"requested-companion-1\",\"kind\":\"companion\",\"project\":\"other\",\"title\":\"Requested companion\"}"}
```

A companion requires a valid bound primary; defaults are feature/medium/M/sinh.
Ordinary `kind=intake` stays in the current project and requires explicit type,
priority, estimate and assignee, preserving CLI required metadata. Search existing
work first. The new result returns only actual ID/project, original request ID,
primary ID, intent-reuse flag and sanitized field names. Text sanitization reuses
the CLI helper; raw and sanitized content both pass the sensitive-input owner.
Warnings are versioned data, not prose appended to legacy CLI machine streams.
After response loss, reconcile the ORIGINAL ID/content. `reusedIntent` does not
claim recovery performed zero remaining effects. Changed raw payload conflicts;
unknown owner state is not absence. Public errors are bounded static guidance,
not raw metadata or exceptions.

Source fixtures exercise real ticket persistence/audit and native registry/process
identity with a synthetic Pi host, including the source launcher-to-default-port
path with a simulated provider. They are **not** actual installed/foreground
human observations. Full planning flows,
all concrete role cells, actual launcher-to-provider/default installed qualification,
remaining P1 and P3–P7 remain incomplete. No umbrella completion or acceptance follows.
The external-file-read amendment is outside approved r001 and is not implemented
or authorized by this creation port.

## Focused checks

From the repository root:

```sh
corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-contract.test.ts packages/pa-core/src/__tests__/interactions-catalogue.test.ts packages/pa-core/src/__tests__/interactions-discovery.test.ts
corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-ticket.test.ts packages/pa-core/src/__tests__/ticket-create-intent.test.ts
corepack pnpm --filter @pa-platform/pa-core build
corepack pnpm exec tsx --test packages/pi-pa/src/__tests__/interactions-ticket-native.test.ts
corepack pnpm typecheck
```

These source checks do not establish installed exposure, CLI/native end-to-end
parity, independent review, hosted CI or actual human UAT. P2–P7 and remaining P1
obligations must still be delivered and verified before umbrella acceptance.
