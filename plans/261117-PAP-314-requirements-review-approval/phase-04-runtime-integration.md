# P4 — bounded runtime handoff and discovery

Status: completed bounded runtime handoff/discovery and focused verification. Base: b537789 (P0–P3 committed). No parallel implementation or ownership conflict occurred. Broader aggregate Pi testing timed out; exact evidence and remaining qualification are in [the P4 report](../reports/implementation-261117-0544-pap-314-p4-runtime-integration.md). Runtime source support is not installed/default selection or human acceptance.

## File Ownership

This phase exclusively owns the following paths; all core admission and external PAPC files are read-only:

- docs/PAP-314-runtime-integration.md (new), docs/PAP-314-local-review-contract.md (status/navigation only).
- packages/pa-core/src/interactions/catalogue.ts and source-inventory.json.
- packages/pa-core/src/__tests__/interactions-catalogue.test.ts.
- packages/pi-pa/src/__tests__/handoff-native.test.ts.
- packages/pi-pa/src/__tests__/local-review-contract.test.ts (new).
- packages/pi-pa/src/__tests__/fixtures/local-review-client.json (new, inert).
- scripts/dev/generate_completions.sh and completions/ppa.fish. Generation must leave completions/opa.fish byte-identical.
- This phase file, plan.md, and plans/reports/implementation-261117-0544-pap-314-p4-runtime-integration.md.

## Tasks

- [x] Publish an accurate source-bound capability/native/API/CLI matrix, v2 continuation/recovery and inert Avodah client contract; preserve local-unverified/no-auth disclosure.
- [x] Document requirements-primary/full-bundle attachments, no launch and PAPC-090 pair qualification prerequisites without selecting defaults.
- [x] Reconcile actual new local native actions and CLI stdin/server discovery, risk classes and reviewed source inventory without effect parity claims.
- [x] Generate path-scoped PPA completions for document review stdin/server/port/help; preserve OPA.
- [x] Validate inert examples with actual strict schemas and exercise default CLI/API shared state using the existing disposable registered-native fixture, including stale and original revocation coordinates.
- [x] Run focused tests, completion syntax/behavior/determinism, affected typecheck/build and inline final review; report exact results and remaining qualification.

## Verification boundary

The accepted P0/P3 contracts and current source owners govern behavior. Existing registered/native/local-review tests protect omission, retained v1 and current-caller admission; new checks address stale discovery, example drift, completion collisions and real shared CLI/API state. No dependency, app/UI, core admission change, external selection, install/activation, live database/ticket mutation, staging or commit is authorized. Disposable fixture stores are created for tests and removed afterward.
