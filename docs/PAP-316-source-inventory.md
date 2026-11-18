# PAP-316 source inventory reconciliation

Scope: source-only catalogue, conservative source dependencies, catalogue tests and
completion output for the actual `serve --local-review` flag. No runtime owners,
other tests, configuration, installation, staging or commits are changed here.

## Tasks

- [x] Read `packages/pa-core/src/interactions/README.md` and reproduce the existing failures before editing.
- [x] Inspect changed dispatch and domain owners; reconcile CLI/native/API effects and aliases.
- [x] Add negative discovery and source-boundary checks, then update only reconciled source digests.
- [x] Generate completions for the actual serve flag and run focused checks, typecheck and build.
- [x] Verify final source freshness and report commands, results and limitations.

No live task-management tool is exposed in this session; this checklist records
the assigned work without inventing a task command or capability.

## Initial evidence

`corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-catalogue.test.ts`
exited 1 before edits: 11 passed, 2 failed. Log:
`/tmp/pap316-inventory-red.log`. The failures are the obsolete combined
`--no-skills`/`--no-extensions` source assertion and changed tracked source hashes.
Hashes were renewed only after the semantic inspection below, not from this failure alone.

After adding the new expectations but before catalogue/manifest edits, the same
command again exited 1: 12 passed, 4 failed. This second red run is appended to
`/tmp/pap316-inventory-red.log`. The independent managed-skill and protected-review
extension assertions passed; the new serve, identity/source guidance and dependency
expectations failed as intended, alongside the conservative snapshot guard.

## Semantic reconciliation

### General-server listener and aliases

`cli/commands/serve.ts` dispatches bare `serve`, nested `serve restart`, and the
`restart` alias through the same lifecycle. Start/restart accept `--local-review`,
including background propagation. Stop/status and their aliases reject it before
PID operations or stopping/restarting an existing server. The schematic catalogue
also records accepted host/port and restart/background forms; these labels are not
an argv grammar or runnable authorization.

`serve-lifecycle.ts` passes the explicit opt-in to `agent-api/index.ts`, which
supplies the actual Node server factory from `agent-api/routes/local-review.ts`.
The factory owns ingress before general Hono/CORS/WebSocket dispatch. The route is
absent by default; an enabled Hono-only request without the native peer factory
fails closed. Opt-in requires numeric loopback bind and direct loopback peer,
exact Host/path, no Origin, forwarding or credentials, bounded strict JSON, and
single-flight ownership that survives lost replies until the owner finishes.
General-server `--cors` does not admit browser review requests.

Starting/restarting remains an **operator resource allocation**, not a decision,
native binding, authenticated-human interaction or runner grant. The transport
calls only the shared `show`/`request`/`revoke`/`decide` local-v2 journal owner.
Request/revoke/decide can persist journal state; show is observational. Publication,
branch ref/link, queue and refresh remain separate native effects. No API channel
was invented in the discovery contract, which supports only CLI/native labels.
The existing dedicated `document review serve --port` listener stays distinct.

### Analyst selection and generic ticket denial

Inspected `mode-capabilities.ts`, `mode-capability-selection.ts`,
`analyst-resource-selection.ts`, `selected-config-source.ts`, `yaml-parser.ts`,
`deploy/plan.ts`, `deploy/repository-admission.ts`, primer composition, Pi launch,
process identity, document session/native dispatch and ticket-status admission.
Public `analyst/analyze` requires explicit native `pa-mode-capability-binding/v2`:
committed resource closure, exact public/effective identity, repository, process,
registry and foreground session evidence. The fixed effective actor remains
`requirements/analyze`; public environment/registry identity remains Analyst.
The launch rechecks selection before releasing the runtime child. Captured primer
resources are not reopened through independent Pi skill loading.

`TicketStore.resolveTrustedTicketMutationContext` denies generic privilege for
Analyst, including generic CLI/API writers. Only authenticated finite
`pa_document`, `pa_handoff` and `pa_ticket_status` owners can derive their selected
effective mutation context and then apply their own reauthentication/CAS gates.
No generic grant, new tool, default selection, retained-session migration or
Builder change is represented by this inventory reconciliation.

### Own-deployment authoring and review convergence

Inspected the committed source-authoring change `8d2fd8b` and its current
`package-contract.ts`, `package-tools.ts` and `package-service.ts` owners.
`deployments/d-<six hex>/artifacts/` is a finite source-root grammar, not authority.
Draft/check/freeze intake requires exact authenticated deployment ownership and
qualified selected policy; the complete source set is checked before reading.
Draft writes unsigned text with CAS, check remains structural observation, and
freeze persists an unapproved snapshot. Retained snapshots continue through their
existing owners; there is no project/repository-write, approval or publication grant.

Inspected convergence commit `993ec04`, current `handoff-review.ts`,
`handoff-native.ts` and `pi-extension/handoff-review-ui.ts`. The v2 waiting
foreground observes the original request key across request/view/capture loading
and returns the canonical shared decision even after delivery failure or a
conflicting local outcome. Detachment does not submit a compensating shared
Cancel. The v1 genuine foreground evidence path and separate dependent effect
admission remain unchanged. The current view-loading repair is included in the
reviewed digest; no implementation owner was edited here.

Inspected baseline `5d5c28c`: managed foreground/background launches independently
disable automatic skills, while protected review/validation independently disables
extension discovery. The obsolete combined-flag regex was replaced with separate
checks for both boundaries, plus the v2 no-mutable-skill-reload guard. The protected
review invariant was not removed or weakened.

## Source snapshot changes

The snapshot now tracks **177 sources**: 148 unaffected digests are byte-for-byte
preserved, 20 semantically reconciled tracked digests are renewed, and 9 inspected
dependencies are added. No tracked source was removed.

Renewed owner groups:

- Launch/selection: Pi adapter/deploy, core primer, YAML parser, mode capabilities
  and mode selection.
- Review/intake: local review, handoff intake/preflight/review, Pi handoff native
  adapter and handoff review UI.
- Authoring: document package service.
- Finite ticket identity: TicketStore, Pi ticket status, document native/session
  and document extension admission.
- Server opt-in: serve command and lifecycle.

Added dependencies: `analyst-resource-selection.ts`, `selected-config-source.ts`,
`deploy/plan.ts`, `deploy/repository-admission.ts`, Pi `process-identity.ts`,
`agent-api/index.ts`, `agent-api/routes/local-review.ts`,
`documents/package-contract.ts` and `documents/package-tools.ts`.

Inspection-time hashes are retained in `/tmp/pap316-reviewed-source-snapshot.json`;
the original manifest is in `/tmp/pap316-inventory-before.json`. The final guard
compares source bytes to **both** the reviewed snapshot and updated manifest,
checks preserved digests and rejects unreviewed changes rather than rehashing them.
Current `documents/handoff-review.ts` SHA-256:
`668b790f1d02cdea4bc3f39c1aba1c0d6e68cd2d9b2254e7da8a46a4d1348048`.

## Informational wording and completion review

Affected categories are source-discovery information/guidance and completion hints,
not runtime success/failure messages. The CLI message standard was applied to these
touched descriptions; no JSON shape, exit, stream, registration or permission
contract changes are made.

- Before: serve start/restart carried generic `authenticated caller` context.
  After: `explicit server-owner invocation; no caller authentication at the review endpoint`.
- Before: serve used generic operator guidance without the opt-in effect boundary.
  After: `Starting or restarting allocates a server resource`, followed by numeric
  loopback requirements, local-unverified decision limits and no CLI/API effect parity.
  The next step is supported-adapter `serve --help`, not an imagined native tool.
- Before: no `--local-review` completion. After: `Opt in to loopback local-unverified review; no authentication or runner grant`.

Self-review checked plain-text meaning and separation of saved decisions from
execution. No independent human readability/UAT or installed verification was
performed. Negative tests preserve unauthenticated-local-review wording, reject
read/native promotion and removal of listener variants, prohibit fictitious native
tools and keep native-only effects out of local-review CLI forms.

## Executed checks

All commands ran from the repository root; no live installation, service start,
configuration edit, staging or commit occurred.

| Command | Result | Log |
| --- | --- | --- |
| `corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-catalogue.test.ts` (pre-edit) | Exit 1; 11/13 passed, intended baseline failure | `/tmp/pap316-inventory-red.log` |
| Same command after new expectations, before catalogue/manifest changes | Exit 1; 12/16 passed, intended red | Same red log, appended |
| `corepack pnpm exec tsx --test --test-concurrency=1 packages/pa-core/src/__tests__/interactions-contract.test.ts packages/pa-core/src/__tests__/interactions-catalogue.test.ts packages/pa-core/src/__tests__/interactions-discovery.test.ts` | Exit 0; 26/26 passed | `/tmp/pap316-inventory-green.log` |
| `corepack pnpm completions` | Exit 0; PPA/OPA generated from pa-core source | `/tmp/pap316-completions.log` |
| `fish --no-config -n completions/pa-core.fish completions/opa.fish completions/ppa.fish` | Exit 0 | Same completions log |
| `fish --no-config /tmp/pap316-completion-check.fish` | Exit 0; 39 positive/negative command-path checks across all three binaries | Same completions log |
| `corepack pnpm typecheck` | Exit 0; workspace | `/tmp/pap316-inventory-typecheck.log` |
| `corepack pnpm build` | Exit 0; workspace | `/tmp/pap316-inventory-build.log` |
| `node /tmp/pap316-inventory-freshness.mjs` | Exit 0; 177 current hashes; 148 preserved, 20 renewed, 9 added; no inspection-time drift | `/tmp/pap316-inventory-freshness.log` |
| `git diff --check -- packages/pa-core/src/interactions/catalogue.ts packages/pa-core/src/interactions/source-inventory.json packages/pa-core/src/__tests__/interactions-catalogue.test.ts completions/pa-core.fish completions/opa.fish completions/ppa.fish` | Exit 0 | `/tmp/pap316-inventory-freshness.log` |

No lint script is declared in the root or pa-core manifest. Build/typecheck emit
only the existing dirty-tree warning. Full workspace `corepack pnpm test` was not
rerun by this inventory task; main owns that gate. These focused source checks do
not establish installed availability, end-to-end CLI/native/API parity, product
acceptance or completeness of the broader PAP-282 inventory.
