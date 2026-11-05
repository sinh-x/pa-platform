# Document-only revision and coordinator continuation (PAP-277 follow-up)

This extends the existing workflow journal, producer, foreground decision capture
and ticket paired-publication owners. It does not redo the advisory-first runtime,
migrate a selected workflow/config, create a second run, or repair live PAP-277 /
PAPC-074 state. The original approvals, published bytes, failures, launch evidence
and unresolved intents are historical facts, not permissions for new bytes.

## Revision state table

All revisions keep the exact repository/root, ticket, downstream route, base,
branch and workflow definition pins; subject IDs are unique and revisions consecutive.
Retained templates/config resources remain pinned. Preview evidence is read from
`agent-teams/requirements/artifacts/reviews/<ticket>/rNNN/requirements.md` and
`uat-preview.md`, unless the exact canonical artifact already exists.

| Current state | Supported revision | Additional boundary |
| --- | --- | --- |
| Changes requested, fresh subject | fresh/create or amendment/reuse | Fresh-to-fresh needs unmaterialized proof |
| Approved fresh subject, including published pair, no execution outcome | fresh/create (`document-revision`) | Unrevoked approval; absent Git branch; no materialized/ambiguous ticket link; no live/unknown writer |
| Approved subject, including materialized work | amendment/reuse (`material-amendment`) | No live/unknown conflicting writer; amendment never becomes fresh |
| Changes requested, amendment | amendment/reuse only | Preserve lineage and all old evidence |
| Pending/unknown effect, any subject | No revision | Existing owner reconciles the **same intent** first |
| Cancelled/rejected/not yet reviewed | No revision | Explicit supported cancellation recovery or owner correction, not a fabricated revision |
| Missing retained resource closure / exhausted attempt bound | No revision | Preserve state; config/workflow owner correction |

The core calls a trusted `WorkflowHost.assertDocumentContinuation` port before
revision and inside final journal CAS. Fresh-to-fresh requires that port; a missing
port returns `WORKFLOW_CAPABILITY/document-custody-proof`. The Pi implementation
uses the existing protected ticket-slot observation and bounded, read-only Git
ref inspection, with ambient Git overrides removed. Stale, insecure or malformed
capacity evidence is unknown, never absence. It neither acquires a slot nor
releases/reclaims a holder. An inert materialized branch alone does not deny an
amendment document operation. Materialization and source/check execution still
validate their own exact baseline, worktree, process and custody evidence.

`subject-revised` retains an explicit predecessor edge and snapshots. Current
outcomes reset for the new subject, but predecessor outcomes and decisions remain
inspectable. No old decision approves the new requirements/UAT/matrix. Revocation
still blocks protected effects; existing historical material/changes-requested
revision semantics remain replayable without reviving their permissions.

## Authenticate first; adopt only when needed

An exact effective coordinator or a validated same-role registry resume chain can
continue without another adoption. Status/next reports caller `relation=exact`
or `registry-resume`. An unrelated same-role deployment is not a continuation.

Where status offers it, the fresh authenticated requirements/analyze foreground
caller can send this through **pa_decision**, using current values:

```json
{"action":"adopt","revision":4,"subjectSha256":"<current exact digest>"}
```

Native consent binds the predecessor/current caller, run revision, subject and
retained resources. The predecessor and its resume descendants must have terminal
registry evidence plus authenticated process-incarnation absence. Live owners,
PID reuse, unknown liveness, missing anchors, changed evidence/caller and stale CAS
fail closed. Proof is repeated after consent and at CAS. Cancellation/interruption
before commit creates no grant; competing successors have one CAS winner. A lost
reply is recovered by reading the existing succession, not repeating takeover.

Three purposes remain separate:

- **cancelled-review**: existing recovery semantics; adoption is not package approval.
- **queue-reconcile**: only the existing approved queue intent can be reconciled.
  No revision, new step or publication is authorized by this adoption.
- **document-continuation**: approved/changes-requested document state, including
  published/no-pending packages, with no current execution outcomes. The successor
  can revise/review/publish documents, not transfer source/check or builder custody.
  It cannot queue the adopted package. Only a **new revised subject's** separate
  exact approval and completed publication can authorize its queue operation.
  Further adoption/cancelled recovery cannot broaden document scope. If that new
  queue is interrupted, ordinary queue-only adoption remains available for its
  same intent.

After adoption, reread the new journal revision. Through **pa_workflow**:

```json
{"action":"revise","revision":5,"producer":"<raw retained review-bundle render request>"}
```

Then reread and explicitly request the new **pa_decision** capture:

```json
{"action":"capture","revision":6,"stepId":"<eligible decision step>"}
```

These are request shapes, not executable values or approval receipts. The run,
caller, resources, permissions and outcome cannot be imported from public JSON.
There is no CLI approval/adoption workaround. A generic chat question is not native
consent. No public override permits abandoning a pending effect to revise documents.

## Publication and diagnostics

The existing ticket owner follows the replay-validated completed-publication
predecessor chain. New files use absent-only creation under the same TicketStore
mutex; exact interrupted members are reused, never overwritten. Both typed refs
must exist before the exact successor requirements primary is promoted. Old file
bytes and ref metadata remain intact apart from primary demotion. Conflicting
bytes, an unrelated primary, uncertain predecessor publication or unsupported
lifecycle state stop through the existing owners. Administrative status alone
cannot stand in for native publication/queue results or the new package decision.

`ppa workflow status|next --ticket TICKET --json` and native reads expose separately:

- `documentRevision`: structural revision eligibility, fresh-to-fresh eligibility,
  pending intent owner, correction and next action;
- `coordinatorContinuation`: effective coordinator/scope, adoption purpose, exact
  request and actual authenticated caller relation (or uninspected from CLI);
- `documentCustody`: registered writer/unknown evidence and independent fresh
  branch/tuple observations, with named correction owners;
- `packageReview`, project-command execution prerequisites and pending effects.

`executionAdmitted=false` / `effectsAdmitted=false` are read projections, **not**
proof that a mutation was attempted or denied. Structural eligibility is not
liveness, caller authority, native approval, materialization or builder readiness.
Missing project-command support does not become a document-revision prerequisite;
it remains a separate source/check execution limitation. Unrelated safe reads and
repairs are not disabled by a negative document operation.

## Retained compatibility and verification

This is an explicit owner-supported operation extension for pinned runs with
retained resources, not automatic reinterpretation or config adoption. Old
`coordinator-adopted` events without a purpose retain exactly their cancelled-review
or queue-only grammar. New document adoptions record `purpose=document-continuation`;
new approved fresh revisions record `reason=document-revision`. Older runtimes
reject these new records. Install compatible runtime support before using these
operations and do not downgrade an affected run. Missing old process anchors are
not manufactured. No live run/intent is migrated or settled by this source change.

Focused source regressions cover core revision/adoption/publication owners and
Pi's real default mutation host with synthetic native UI/provider fixtures:

```sh
corepack pnpm exec tsx --test --test-concurrency=1 \
  packages/pa-core/src/__tests__/workflow-document-continuation.test.ts \
  packages/pa-core/src/__tests__/workflow-state.test.ts \
  packages/pa-core/src/__tests__/workflow-adoption.test.ts \
  packages/pa-core/src/__tests__/workflow-owner-integration.test.ts \
  packages/pi-pa/src/__tests__/workflow-config.test.ts \
  packages/pi-pa/src/__tests__/pi-workflow-decision.test.ts
```

These checks are source/disposable integration only. Exact installed runtime/config
qualification, genuine foreground agent behavior, independent review, CI and human
UAT are separate evidence; this document does not claim them passed.

Source checkpoint, d-a9768a: the six-entry focused command above passed 223 tests;
the separate full `pi-workflow-runtime.test.ts` entry passed 36 tests, including
native materialization, matrix and retained restart cases. Workspace typecheck,
build, completions, secret scan and whitespace checks passed. `corepack pnpm test`
was bounded to 600 seconds: core and OpenCode completed without failures; the run
then timed out in Pi integration, before all packages completed. Full-suite success
is **not** claimed. No installed activation, native live workflow/queue settlement,
lease/checkout return, requirements approval or ticket acceptance was performed.
