# PAP-271 JSON workflow runtime — source checkpoint

Status: **partial implementation, not a supported production route**. The approved five-phase plan remains authoritative. This document records the source interface and continuation point; it does not replace requirements, their matrix, independent review, installation qualification or human UAT.

## Ordered commits

- Phase 1, `bcca196`: strict contracts, graph/type validation, selected-source loader and isolated fixtures.
- Phase 2, `3485d97`: observational preflight, bounded diagnostics and shared read projections.
- Phase 3, `d061fc7`: registry transaction/CAS owner extension, pinned snapshots/replay, package decisions, named revocation, intent reconciliation and native foreground capture port.
- Phase 4: **partial checkpoint only**. Structured consumer/baseline seam, materialization-time reread, actual PAP-270 producer admission/retention, and concrete opt-in ticket publication/queue adapters. Existing legacy defaults are unchanged; no structured launcher or default effect-owner host is registered.
- Phase 5: **not implemented**. Public CLI/native registration, generated primers/completions, paired validator integration and installed verifier remain outstanding.

Phase commits were separated at the operator's request during this session. Future work must commit after each verified phase, preserving these commits rather than squashing away the phase boundaries.

## Runtime/config contract seam

The loader uses the existing selected configuration resolver. The physical selected home and selected teams must agree. Only committed bytes at the observed selected config revision are accepted; symlink aliases, changed bytes, digest mismatches and revision drift reject. Git observation ignores `GIT_*` redirection and replacement objects. There is no arbitrary executable-definition path or runtime enable switch.

The fixed config-relative entry point is `workflows/manifest.json`:

```json
{
  "schemaVersion": "pa-workflow-manifest/v1",
  "definitions": [
    {
      "workflowId": "software",
      "version": "r001",
      "file": "workflows/definitions/software.json",
      "sha256": "<exact raw definition SHA-256>"
    }
  ],
  "bindings": [
    {
      "schemaVersion": "pa-workflow-binding/v1",
      "team": "requirements",
      "mode": "analyze",
      "enabled": false,
      "workflowId": "software",
      "workflowVersion": "r001"
    }
  ]
}
```

This is interface documentation, not production PAPC content or a valid digest fixture. PAPC-070 owns actual definitions/bindings and companion instructions; this change edits no config source or pin. A missing/disabled binding denies new runs. Existing runs replay their retained raw definition and subject independently of current rollout selection.

Definitions use `pa-workflow-definition/v1`; each step declares every field in `WorkflowStep` in `packages/pa-core/src/workflows/contracts.ts`. `operations.ts` owns the finite metadata vocabulary. An operation declaration is **not an executable registration**. Types, kinds, owners, effects, exact permission sets, verifier/input/output schemas, dependency outcomes, predicates and exhaustive transitions are validated. Output references must name typed ancestor outputs; transition targets must directly depend on that exact predecessor outcome. Presentation order is not authority. `completed`, `blocked` and `cancelled` terminate a path; only an explicit successor transition makes a dependent path eligible. Unknown outcomes cannot advance.

Raw definition/subject inputs are limited to 1,048,576 bytes, event/decision-request bytes to 65,536, nesting to 64, and definitions to 256 steps. The existing strict review reader supplies decoded duplicate-key, UTF-8/BOM and nesting enforcement. Errors do not echo rejected fields, artifact contents or underlying exceptions.

## Persistence and trust

`RegistryWorkflowJournal` extends the existing registry SQLite transaction owner (schema 16). Immutable content-addressed snapshots and append-only events live in that database, not a separate resource/approval file store. Immediate transactions compare the expected revision before accepting an event. Replay checks revision continuity, predecessor/body digests, discriminated data and authority/subject agreement. Exported JSON and session tasks are not importable authority.

`JsonWorkflowService` is an internal trusted-host interface, not a public RPC endpoint. Its constructor dependencies are runtime code, never model JSON. The host authenticates callers and supplies read-only prerequisites, native capture and registered existing-owner ports. It must not substitute a model-authored actor/outcome/passed flag. Fixture hosts in tests are synthetic and isolated from live state.

The Pi capture port reuses existing foreground requirements/analyze registry/process/canonical-root/session authentication. The exact subject, revision, digest and permission set are displayed without truncation. Principal comes from the local OS user; outcome comes only from the native foreground dialog. Caller identity is reread afterward, and service CAS rejects stale dialog revisions before persistence. The port is **not yet registered as a public tool**. No actual human capture is claimed by its synthetic UI tests.

The admitted workflow's capture role is distinct from the bundle's downstream builder route. Exact retained caller identity is currently required for coordinator mutation. Authenticated continuation after a process/deployment identity change is **not implemented**; denial is intentional until the existing owner supplies a legitimate continuation binding.

## Effect-owner requirements

The coordinator persists an intent before dispatch. It never implements allocation, custody, execution, review claims or publication itself. Owner admission must be observational; effects belong only in the owner's execution transaction. Registered owners must:

1. Authenticate live identity/custody/profile and freshly verify the exact decision at their actual effect boundary.
2. Use the same durable intent ID for idempotency, including overlapping original/reconciliation callers.
3. Prove exact existing results, absence, or unknown/conflict without guessing.
4. Execute only proven absent work. Preserve unknown/conflicting resources and original failures.
5. Verify native results and their exact subject/command/input/candidate/environment/output provenance before returning proof.

Revocation blocks new work, while proof/settlement of an already-started result remains possible. A missing owner cannot create an intent or inherit a legacy effect capability. Recovery test owners are synthetic, not proof of real publication/capacity/execution integration.

`authorizeStructuredConsumer` reads issued decisions and exact canonical artifact bytes without phrase parsing. `structuredTaskBaseline` currently supports only fresh handoffs; amendment execution rejects explicitly. Materialization accepts a trusted structured reread callback and compares it again inside the existing capacity transaction, preserving all existing branch/root/custody checks. No default launcher supplies this callback yet. This seam must not be treated as completed ordinary-launch adoption.

## Resume Phase 4, then Phase 5

Outstanding runtime source work (not merely companion rollout work):

- Register the new producer admission and concrete ticket owners in a legitimate default workflow host. PAP-270/PAPC-071 are now merged/installed dependencies; this checkout contains the merged PAP-270 service. The default native template host still needs the actual review-bundle parser registration (CLI registration is implemented). PAPC-070 must add the optional review-bundle entry/fixtures to the SAME registry, not a second registry.
- Qualify publication/queue adapters in that host, including selected canonical home and authenticated ticket-store mutation context. Current concrete owner checks use disposable files and the actual TicketStore mutex/audit; they are not live publication or installed qualification.
- Wire structured baseline decisions through Pi launch/materialization and execution, including exact fresh/amendment identity, scope/command references, revocation at new-effect boundaries and authenticated restart continuation.
- Integrate native validation evidence and protected review launch without weakening one-use claims, active-review exclusion, limits or candidate binding.
- Exercise actual owner integration: sole writer, one lineage/four checkouts, no duplicate reservations/authorizations, interrupted effects, changed candidate/input/environment, and retained failures. Existing regression tests are not substitutes for these new-route cases.
- Only then add CLI `workflow`/`decision`, native `pa_workflow`/`pa_decision`, concise pinned primers, completions, typed paired tests, and the installed disposable verifier required by the approved matrix.
- After runtime source/interfaces, PAPC-070 supplies real definitions/fixtures; joint selected-pair/installed qualification follows both. No circular terminal-ticket dependency is introduced.

Historical signed documents/comments and other adapters are unchanged. No optional preparation, change-impact/base policy, production binding, installation, remote effect, checkout return or deployment launch is authorized/performed by this checkpoint.

## Phase 4 continuation: producer and ticket owners

`JsonWorkflowService.admitProduced` invokes PAP-270's shared `templateService` with the actual `parseReviewBundle`, never a caller-supplied receipt/callback. Producer and workflow must name the same selected physical config root/revision. Exact rendered bytes, unsigned producer provenance (source/registry/config/bindings/candidate digests), artifact bytes and raw matrix section are retained by `RegistryWorkflowJournal` in the existing SQLite snapshot owner. No decision is inferred from this provenance. The trusted internal `admit` seam is not a public import API.

`readWorkflowEvidence` now authenticates the matrix using the existing `parseReviewMatrixPlan`: its hash is the raw Full Validation Matrix SECTION, not the whole requirements document. It binds repository/root/base/branch, operator-gate ticket and named scope commands. Requirements/UAT are bounded UTF-8, exact raw hashes; both are reread before and after native capture. This corrects the earlier synthetic fixture assumption that document and matrix hashes were interchangeable. Old immutable events/signed artifacts are not rewritten.

`createTicketWorkflowOwners` provides concrete **opt-in** `publication.pair`/`ticket.queue` adapters. They use `TicketPairPublication` under the SAME TicketStore transaction mutex used by ordinary writers, retaining lifecycle checks and audit. Each absent member is created exclusively with no overwrite through a pinned no-symlink parent; exact existing members are reused. Partial writes, conflicting bytes, missing directories, symlinks or a foreign primary block and preserve original state. Parent directories must already exist; the adapter does not allocate or repair them. Queue advancement requires both exact files, both correctly typed refs and the unique requirements primary. It targets only the supported builder/orchestrator -> builder/team-manager handoff.

Authority/caller/pending intent are freshly checked inside that ticket transaction before EACH new file, doc-ref or queue effect. Interrupted partial work reuses the same intent; fully observed publication/queue can settle after revocation, but absent work cannot. No second publication/resource/approval ledger exists. These adapters do not yet provide the remaining authenticated launch, amendment, execution, review or cross-deployment continuation paths. No production binding is enabled.

The new producer/ticket cases are imported by `workflow-owner-integration.test.ts`, so the approved explicit matrix entry includes them rather than silently omitting newly split files. Source-case hosts and operator captures are synthetic; file, ticket mutex/audit and registry owners are real disposable instances.

## Observed checks

Continuation checks (implementation-phase evidence only): workspace typecheck/build, completion generation (no output diff), secrets scan and whitespace passed. The combined workflow/template/ordinary-baseline/ticket/registry regression run passed 424 tests, zero failures/skips/cancellations before the final two additional recovery/concurrency cases. Final focused recheck: 46 workflow cases and 9 Pi capture/template CLI/tool regressions passed, all zero failures/skips/cancellations; workspace typecheck/build passed again. Initial test-authoring failures (readonly fixture assignments and a mistaken audit accessor) were corrected; no passing run is substituted for independent matrix, installed qualification or human UAT.

All focused checks here are implementation-phase evidence, not the independent full matrix:

- Contract suite: 27 passes, zero failures/skips (including exact/one-over input bounds, all operation kinds and graph negatives).
- Preflight/read-projection suites: 4 passes, zero failures/skips. The filename `workflow-cli.test.ts` currently tests shared query semantics, **not a public CLI**.
- State suite: 5 passes, zero failures/skips. Its actual 32-connection SQLite race accepted one append and returned 31 conflicts.
- Synthetic native capture suite: 3 passes, zero failures/skips; no human UAT claim.
- Consumer seam suite: 1 pass, zero failures/skips.
- A combined focused/regression run before the final additional contract case: 236 passes, zero failures/skips, including registry and ordinary baseline regressions.
- Workspace typecheck passed; core/Pi builds run by that check passed. Secrets scan and whitespace checks passed before phase commits.

SQLite tests ran using the selected installation's Node-22 native binding, not the foreground Pi Node-24 binding. No independent full validation deployment, selected paired qualification, installed workflow verifier, CI, or actual human UAT was run. The ticket is not implementation-complete.
