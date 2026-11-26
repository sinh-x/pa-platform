# PA interaction foundation (PAP-282)

## PAP-347 bounded ordinary Analyst reconciliation

This supersedes only the historical blanket public-Analyst rejection below.
`deploy.launch`/`deploy.resume` keep their existing forms, launch effect, owner
disposition, null bindings/schema references and unproven installed availability.
The shared PPA CLI, Pi preflight/deploy and actual adapter now distinguish resolved
ordinary foreground Pi `analyst/analyze` from protected execution. Optional tickets
remain correlation, not Builder custody. Force, background, API, OPA, ticket-worktree,
legacy/profile and raw environment-only routes retain rejection. No new command,
selector, tool grant, generic forwarding, privacy exception or native record writer
is introduced. The primer carries no-repository/source/Git-write and no-implementation
instructions with an explicit instruction-only, non-sandbox limit; PAP-338 remains
future technical protection.

The ordinary plan now retains its existing profile classification as
`repositoryAdmission.plainInteractive`; the adapter requires that classification,
foreground/non-locking/no-custody evidence and agreement of all identity sources.
Ordinary resumes reuse raw complete ordinary lineage plus original recorded session,
roots, ticket, Pi/PPA and role checks. Protected notes/bindings/custody and uncertain
history reject without migration or a fresh fallback. Tests exercise ordinary
shared CLI/hooks/actual adapter code through synthetic process/probe seams, as well
as omitted-plan, conflicting-env, excluded-route, wrong-root/ticket/token and native
ancestry negatives. Production PID supervision remains unchanged; the synthetic
child fixture explicitly models the gate without claiming real PID qualification.

After this forms/effects/owner reconciliation and negative coverage, six changed
tracked source digests are renewed: core CLI deploy, repository admission/isolation,
primer composition, Pi deploy and Pi adapter. No other tracked owner is renewed.
This is implementer reconciliation, not independent Review, installed qualification,
agent behavior or human acceptance. Source-inventory tests only detect byte drift.

This directory contains a **partial implementation**, not the completed
PAP-282 interface or an adopted-profile claim. Installed disposable observations
for the existing trial are recorded in
[the PAP-282 verification report](../../../../docs/PAP-282-installed-verification.md);
byte comparison, commit provenance, live exposure and human UAT remain distinct. The catalogue/discovery
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
parity, independent review, hosted CI or actual human UAT. The separate
`scripts/dev/verify_interactions_runtime.mjs` runs the implemented-slice drivers
against verified installed modules, without installation or profile activation;
its comparison mode explicitly retains the trial's unversioned-source limitation.
See the report linked above for the exact invocation and observed 51/51 result.
P2–P7 and remaining P1 obligations must still be delivered and verified before
umbrella acceptance.

## PAP-292 additive status integration

The source catalogue now records `ticket.status.inspect` (read) and
`ticket.status.set` (write) on native and Pi CLI channels. Bindings remain null:
source discovery never claims live registration or permission. The actual finite
owner is tickets/status-service.ts plus TicketStore.setStatusWithIntent; the
adapters are pa_ticket_status and ppa ticket-status --request JSON. Retained
pa_ticket/intake grammars are unchanged. Selected policy callers cannot bypass
this status owner's CAS/ownership through legacy ticket update --status or soft
delete; operator/non-policy CLI semantics remain unchanged. Broad same-UID shell
is not a hostile-process sandbox or a supported raw-state workaround.

The six renewed historical source digests cover capability registry/primer,
canonical native/CLI process authentication, selected tool admission, the additive
store primitive and CLI dispatch. ticket.ts additionally refuses the two legacy
status routes for policy callers. Four new status owner/adapter sources are now
tracked. Tests cover native and actual subprocess CLI-first writes, original
intent replay, all nine statuses/81 enum edges, stale/changed requests, real CAS
contention, reauthentication-time drift and live-PID terminal-owner rejection.
This is semantic reconciliation by the implementer, not independent review or
full PAP-290 operation parity. See docs/PAP-292-implementation.md for remaining
catalogue, installed qualification and UAT gaps.

## PAP-334 semantic supersession — current source-only ticket administration

This note supersedes the historical PAP-292 blanket restriction on generic
`ticket update --status` for selected policy callers, and the earlier read/comment-only
characterization of `pa_ticket`. It does not upgrade retained document, intake,
approval or execution contracts. The catalogue still has **null native/delegation
bindings and schema references**, with installed/session availability unproven and
admission not checked. These are finite source interfaces, not full R4 acceptance,
installed/native foreground qualification or human UAT.

- Generic CLI status updates and authenticated REST `PATCH /api/tickets/:id` now
  use the shared TicketStore owner independently of team/mode or document profile,
  including another target project. Trusted running deployment/operator authority
  is re-resolved under the mutex, including the final effect fence. Live competing
  custody, pending workflow/document effects, unsettled ticket intents and open
  subtickets still block dependent transitions. Completed history is not a blanket
  stage restriction. Deletion retains separate restrictions. These legacy writes
  do not acquire the selected status port's intent/CAS grammar or prove transport
  parity.
- Generic native `pa_ticket` adds `inspect`, `create`, `update`, `set-status` and
  authenticated `comment` through `tickets/admin-service.ts`, TicketStore and
  `ticket-session.ts`. Targets are exact registered projects/tickets, independent
  of the launch association or document capability selection. Process/session,
  immutable registry start, canonical roots, private incarnation anchor and live
  lineage must agree; environment labels alone fail. The process-anchor recorder
  now covers all managed teams/modes after start validation, not a role allowlist
  or a workflow/source grant. A deliberately omitted tool module is not registered
  by catalogue discovery or by policy exposure.
- Native creation preserves its original durable intent and defaults to an idea
  task with medium/M/sinh metadata. Native update accepts only the eleven bounded
  administrative fields: title, summary, description, priority, estimate, type,
  assignee, tags, blockedBy, from and to. It uses complete-snapshot CAS; supplied
  arrays replace their values. It cannot replace status, refs, primary or Git
  evidence. Native status uses the original durable status intent. Preserve
  original create/status request coordinates after reply loss; update/comment
  have no replay intent and require inspection before another mutation.
  Comment author/audit derives from the authenticated public team/mode, not the
  document profile's effective actor. The compatibility form
  `comment(id,author,content)` resolves the existing ticket's project and accepts
  only the caller or a configured same-team agent as attribution, never authority.
  Oversized inspect replies explicitly omit the body while retaining metadata;
  this is not a complete paged ticket/history interface.
- Selected `pa_ticket_status` and `ppa ticket-status --request` remain separate
  policy-selected, document-process-authenticated status-only owners. They now
  accept any exact registered target project, not only the caller's repository;
  target ticket/project matching, original intent/CAS and their stricter
  workflow/competing-owner checks remain. Finite document mutation contexts stay
  separate from generic administration principals so an owner can reconcile its
  own original pending publication/queue, not overwrite another owner.
- `pa_ticket_intake` keeps its selected finite capabilities/inspect/reuse/create/
  patch-planning grammar and conservative scalar-planning eligibility; generic
  administration does not silently widen it. In native execution sessions the
  five administrative forms, including inspect, pass the existing administrative
  source barrier and lower tool boundary: no concurrent source operation or pending
  restart, unchanged source snapshot and separate administrative evidence. This
  neither passes a phase check nor resets a failure. No source/Git, approval,
  publication, queue, resource or launch authority follows from administration.

The manifest renews only the twelve reviewed changed ticket/authentication/
registration/execution sources. It explicitly adds the new admin-service and
ticket-session owners plus previously untracked ticket exports, REST ticket route,
execution administration grammar and lower execution-tool barrier. The guard
**auto-discovers only added core CLI command files**; imported domain/native owners
need explicit inventory entries. Tracked hashes detect subsequent byte changes,
not semantic completeness, live registration or installed provenance. Launch
plan/control/deploy/adapter hashes are not renewed by this reconciliation; later
changes must trigger their own semantic review.

## PAP-334 P2b — interim launch/resume rejection, not confinement

This separate **source-only interim ingress** reconciliation supersedes historical
working-launch claims for public Analyst (all modes), legacy
`requirements/analyze` and existing v3 `pa-readonly-document/v1` selections.
There is **no working confined executor or scope-grant override**. Read-only
admission, prompts, approvals and writer labels are not confinement.

- The reviewed core deploy CLI, Pi/OPA launchers, actual adapters and raw background
  runners fail closed for protected execution. The shared isolation owner checks
  all v1/v2/v3 bindings, public/effective identities, immutable plan identity,
  `plan.environment`, original environments and merged overlays. One source cannot
  erase another's protected selection. Source dry-runs remain static planning that
  may write private artifacts; actual adapter `dry-run` calls still reject
  protected execution.
- `queryReadonlyIsolationLineage` reads raw current/start/event rows and the whole
  resumed ancestry in one read transaction. Missing, conflicting, duplicate-start,
  cyclic or malformed evidence rejects rather than trusting display projections.
  Retained `requirements-document-*` or `readonly-document-policy/*` notes forbid
  downgrade even with a writer label or missing binding, including unrecognized
  protocol revisions. Existing-files-only reads do not initialize registry state
  or allocate missing WAL/SHM sidecars. Selecting rogue-one cannot remove retained
  protection.
- The private Pi and OPA `session-owner.ts` readers reuse the isolation owner's
  safe existing-file read and require the exact recorded native token/runtime for
  the prior deployment ID. Linked, special, multiply linked, oversized or changed
  evidence cannot qualify a direct adapter resume; a supplied token alone cannot.
- Raw runner checks run inside their lifecycle before runtime spawn or custody
  transfer. Isolation rejection retains the configuration and existing claims,
  publishes failed readiness, removes signal handlers and skips terminal registry
  reconciliation. Launcher cleanup recognizes matching rejection evidence rather
  than deleting the retained configuration. This is not a successful launch or
  permission to release another owner's claims.
- Agent API websocket start/resume admission runs before runtime preflight. The
  central `SessionManager` repeats admission before allocation, lifecycle logging,
  command building or spawn, including default-command fallback. Stdout session
  hints remain observational, never resume provenance. API continuation needs a
  matching launch-bound native session argument with retained origin or an exact
  recorded managed session. Unknown opaque API resumes remain unavailable;
  eligible nonAnalyst fresh sessions and known launch-bound/recorded continuations
  preserve their existing admission and rechecks. Observational deploy-session
  registration is not execution admission.

This final pass renews **eight changed tracked hashes**: Pi background runner,
Pi/OPA adapters and launchers, raw registry lineage, isolation owner and Agent API
websocket ingress. It adds **five explicit dependencies**:
`packages/pi-pa/src/session-owner.ts`,
`packages/opencode-pa/src/session-owner.ts`,
`packages/opencode-pa/src/background-runner.ts`,
`packages/pa-core/src/deploy/background-ownership.ts` and
`packages/pa-core/src/agent-api/ws/session-hub.ts`. Earlier reconciled core deploy
CLI/export and binding-parser hashes remain unchanged by this pass. Only added
core CLI command files are auto-discovered; these imported owners need explicit
entries. Hash equality detects byte drift, not semantic completeness or authority.
Catalogue forms, effects, null bindings/schema references and unproven installed
availability remain unchanged. Twelve historical Analyst functional cases remain
**deferred**, not qualifications. This is not working protected execution,
adoption, universal route qualification, installed verification or ticket completion.

A subsequent independent review found two additional source defects. Pi `spawn`
now consumes only an adapter-issued, single-use fresh session reservation; supplied
existing tokens cannot masquerade as fresh requests. This reservation is not
qualification of races in installed native session storage. The actual Pi runner
entrypoint now consumes its configuration only after isolation admission inside
the existing lifecycle, preserving rejected configuration evidence. The adapter
and runner hashes are renewed again for these reviewed changes. No configuration
field, environment grant, approval selector or confined executor is introduced.

The full source regression run also exposed a finite native auto-publication
compatibility regression: its approved operator-owned queue was being checked as
unrelated generic administration. `auto-runtime.ts` now uses the same internal
finite-owner distinction as document publication, retaining terminal/native
reauthentication, the exact approved intent, mutex/CAS and per-effect authorization.
No public actor/privilege field or new operation is accepted. The existing combined
owner test again publishes/queues once while holding synthetic implementation
success uncertain. Its hash is renewed for this semantic repair. Generic
administration still cannot take over the native owner's unsettled operation.

## PAP-334 scope split and integration handoff

On 2026-11-25 Sinh explicitly revised PAP-334 to the delivered independent typed
administration and interim fail-closed source slice, with PR integration into
`develop`. The original unfinished requirements remain in linked follow-ups:
PAP-338 mechanism feasibility, PAP-339 trusted topology, PAP-340 confined execution,
PAP-341 transactional shared files, PAP-342 forced AC2/AC3 qualification, PAP-343
foreground AC1 observation, and PAP-344 remaining universal AC5 availability.
Closing the revised delivery after a verified PR merge does not convert source
checks, deferred cases, or launch rejection into original confinement acceptance.
See [the maintained contract](../../../../docs/analyst-repository-isolation.md).
Sinh will perform installation from the retained worktree. This integration
instruction is not agent installation, selector activation, native-effect
approval, worktree return, or human UAT.

## PAP-349 — configured Rogue-One retention

This reconciliation supersedes the earlier fixed-bare/nonselection description
of `deploy.rogue-one`. Its CLI form, launch effect, operator-only disposition and
null native/delegation/schema bindings are unchanged. Foreground PPA CLI now
selects compatible PAPC modes/pairs/instructions and preserves original verified
configuration/resources/overrides through native snapshot continuation. It keeps
the exact native admission exception, not ordinary interactive vacancy admission.
Protected ancestry, current credentials/privacy/hooks and native custody remain
current; configured content is not permission. Unverifiable legacy, crossed roots,
conflicting overrides, tamper or unsupported dependency closure reject without a
live-PAPC fallback. OPA, background, API deployment and WebSocket Rogue-One
execution explicitly reject until their full-retention consumers qualify. API
operator authentication still precedes rejection. Source support is not installed
availability, independent Review or human UAT; PAPC-110 owns configuration adoption.

Implementer reconciliation inspected the changed core selection/plan/primer/CLI
and exports, Pi/OPA launch consumers and Agent API session boundary. Focused tests
exercise configured selection and pair causality, exact native identity, actual
retained skill paths and selected-agent events, deletion-proof continuation,
resource/native faults and unsupported API/OPA/WebSocket rejection. No new public
command, flag, native grant, delegation binding or snapshot RPC was introduced.
The manifest renews those eight changed tracked sources and explicitly adds the
Rogue-One selection/snapshot/script owners, shared parser/agent-skill locator,
API deployment rejection, and the lockfile's compiler dependency selection. The
mutable core package version is intentionally not byte-pinned: automatic patch
bumps change it without changing dependencies. Regression coverage keeps the
production compiler declaration and lockfile guard explicit. Native Rogue-One
originals reject cross-team continuation before adapter configuration selection;
current filename/original-path/content privacy checks also apply to retention.
Static selectors reject shadowing, array mutation/escape, filesystem re-exports
and unverified CWD-relative paths instead of accepting incomplete retained bytes.
Hash renewal follows these semantic assertions; it does not weaken the
conservative source guard or claim complete interaction parity.
