# PAP-316 final independent re-review

## Outcome

**No remaining blocking or high-priority source-review findings at `244c61543c5a240ee3aafbe732f6d8b93939fa5b`. Findings 1–5 are closed within the inspected source/disposable-fixture scope.** This is not installed qualification, PAPC activation, or human acceptance.

## Scope and method

- Read the initial `plans/reports/review-261118-pap316.md`, repair reports, current plan, repository/message rules, and PAPC runtime-handoff/final-gate/workflow/gap-map at `3ed0496880ee7c968ee90c40df94944b13e72f9f`.
- Compared `8d2fd8b..244c615`: 47 files, +2,759/-159 lines. Focus was the five reported production boundaries, G11, and catalogue/completion reconciliation, not a new full-branch audit.
- Scouted child/adapter admission, composer dependents, asynchronous request/view/capture ordering, original journal replay, and raw HTTP/WebSocket ingress before reviewing. Applied base/API blocking and informational checklists.
- No implementation, plan-state, installed/configuration, live-state, or Builder changes. Review outputs and disposable fixtures only. Both repositories were clean before this report; candidate HEAD remained unchanged.

## Finding disposition

| Finding | Verified production boundary and evidence | Disposition |
| --- | --- | --- |
| R1: missing process anchor | `packages/pi-pa/src/process-identity.ts:73–81` now includes Analyst/analyze. Actual foreground admission at `adapter.ts:1372–1384` writes the child anchor before release. `analyst-identity-adapter.test.ts:93–102` uses deployWithPi, real PiAdapter/PTY/bootstrap, and an inert child that authenticates, registers, and directly/indirectly invokes selected pa_document without planting evidence; PID agrees with production anchor and registry. Omitted policy denies before allocation/preflight. | Closed in source. |
| R2: adapter-time drift/native skills | `packages/pi-pa/src/deploy.ts:1559–1572` composes capability freshness with the existing auto/retained gate owners. The adapter invokes it synchronously immediately before bootstrap/selected-child release and rejects runCommand/nonforeground bypasses. `adapter.ts:298–310` supplies no V2 --skill paths; captured primer bodies are the sole selected skill input. Real-adapter second-preflight and PTY-admission mutations deny target release; command inspection covers active/reference-only semantics. | Closed in source. |
| R3: offline composer regression | `packages/pa-core/src/primer/index.ts:56–67` limits V2 capture enforcement to explicit native composition. Ordinary Pi/OPA analyze/investigate/research composition passes; production launch/execution-plan admission remains independently fail-closed. The actual canonical PAPC composer test also passes. | Closed in source. |
| R4: issuance during view loading | `packages/pa-core/src/documents/handoff-review.ts:140–178` constructs polling before request/revoke/view awaits, rechecks original coordinates after async boundaries and on errors, and aborts only its local capture. Delayed/rejected view tests cover all four outcomes; delayed stale/revocation tests settle without capture. Registered Pi/real CLI/dedicated-API tests cover held dialogs, canonical replay, conflicting input and abort/detachment. No compensating shared Cancel is submitted. | Closed in source. |
| R5: unrelated pipelined dispatch | `packages/pa-core/src/agent-api/routes/local-review.ts:124–157` claims review sockets before listener dispatch and gates subsequent request/Expect/upgrade/CONNECT events before all general listeners. Eighteen raw-socket cases cover rejected/accepted/slow reviews with actual harmless Hono effects and upgrade/tunnel counters; zero subsequent dispatch, preserved original issuance/replay. Ordinary keepalive/CORS/health/WebSocket positives pass. `agent-api-local-review.test.ts:31–49` isolates every test before TicketStore/app construction and closes/restores the disposable environment. | Closed in source. |

## G11 and reconciliation

`packages/pi-pa/src/__tests__/handoff-native.test.ts:74–91,297–355` now plants the shape-valid “all filtered rows” versus “current page” contradiction. An authored not-ready judgment includes bound requirement/UAT hashes, consequence, next action, explicit synthetic reviewer coverage, and an untested-product limitation. It is a required frozen **specification** member, not a reference or native semantic-pass field.

The test compares complete registered-Pi show output with the real CLI, dedicated HTTP API and general-server factory on the same subject. Linked member HTML and the Pi review component expose the judgment; changed finding bytes produce a different document subject. Structural checks pass while semantic completeness remains **not-assessed**. Content-only changes-requested grants no effects; ticket refs and feature refs remain absent. This closes the demonstrated source-transport gap, not independent semantic review, real browser accessibility or human acceptance.

Catalogue changes remain data-only: null bindings and source-only availability do not become permissions. Listener allocation is operator/resource scope; local decisions remain unauthenticated and effect execution stays native-only. The two prior snapshot/regex guards were semantically reconciled: separate managed-skill/protected-extension boundaries remain asserted, V2 mutable-skill reload is prohibited, and the source inventory covers the added owners. All 26 discovery/contract/catalogue tests pass. Fish changes only expose the actual start/restart opt-in; syntax checks pass for all three completion files.

## Independent checks

Commands ran in the requested checkout with `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`. Test commands use `corepack pnpm`, `exec tsx --test --test-concurrency=1`, and the named package filter unless stated otherwise.

| Check | Result | Evidence |
| --- | --- | --- |
| pa-core: agent-api-local-review, document-local-review, analyst-identity-composer | 76/76 | `/tmp/pap316-final-core-focused.log` |
| pi-pa: analyst-identity-adapter, launch, session, ticket | 11/11 | `/tmp/pap316-final-identity.log` |
| pi-pa: handoff-native, --test-name-pattern=PAP-316 | 11/11, including G11 | `/tmp/pap316-final-handoff.log` |
| Root: interactions-contract, catalogue, discovery | 26/26 | `/tmp/pap316-final-inventory.log` |
| pi-pa: runtime-start-gate | 2/2 | `/tmp/pap316-final-start-gate.log` |
| Canonical actual composer: PA_PLATFORM_REPOSITORY set to this checkout; pa-core runner; --test-name-pattern='actual composer' against PAPC scripts/analyst-team-source.test.mjs | 1/1 | `/tmp/pap316-final-canonical-composer.log` |
| pa-core and pi-pa: exec tsc -p tsconfig.json --noEmit | Both exit 0 | `/tmp/pap316-final-{core,pi}-types.log` |
| git diff --check 8d2fd8b..244c615; fish --no-config -n on completions/pa-core.fish, ppa.fish, opa.fish | Exit 0 | Observed command results |
| Candidate changed-file probe using the unchanged staged scanner's patterns, without printing matches | 47 files, zero matching lines | Observed command result |

Completed suites total **127 tests**; coverage percentages were not measured. No separate lint lane was run. The first combined Pi command timed out at 100 seconds after 14 passing subtests without suite completion (`/tmp/pap316-final-pi-focused.log`); it is not a pass. The complete split reruns above establish the results instead.

The short synthetic Bearer fixture no longer matches the scanner pattern, and the scanner implementation is unchanged: no exception or suppression was added. The main session's final official scan is separate evidence; this review did not claim a clean-index staged scan proved committed content.

## Message and plan follow-up

Reviewed help/information and blocker paths against the CLI message standard. Before, serve lacked --local-review; after, help discloses numeric loopback, unauthenticated-local decisions and no runner authority. Before, ticket-status help named requirements/analyze only; after, it names natively bound Analyst without generic privilege. The primer discloses public/effective attribution. Fixed transport diagnostics retain one five-label envelope, bounded length and withheld raw exceptions; focused assertions pass. These are agent readability/structural/software checks, not human acceptance or installed propagation.

R1–R5 and the requested G11 source regression are resolved. P2/P4 source repairs can proceed to the lead's final gate. P5 remains subject to the main session's final full-workspace rerun and qualification accounting; this review ran no broad build/test/install lanes and did not mutate the plan. All Builder work remains explicitly deferred, not an omitted deliverable here.

## Residual qualification limits and unresolved question

- Exact committed/installed PAPC resource selection remains a **separate opt-in prerequisite**. The previously disclosed missing `docs/json-workflow-runtime.md` closure is not waived by ordinary composer success or synthetic V2 fixtures. Which separately authorized PAPC resource contract resolves that closure remains with its configuration owner.
- Real selected-host/provider/default-entry, supplied-ticket/ticketless installed journeys, actual forwarding, browser/accessibility and Sinh acceptance remain unqualified here. Production PTY tests use controlled version/host probes and an inert executable.
- Source-only independent review does not authorize installation, activation, live effects, a Builder launch or ticket acceptance.

Status: DONE_WITH_CONCERNS
Summary: No remaining blocking/high source defect was found; R1–R5 and G11 passed independent focused verification at candidate 244c615.
Concerns/Blockers: Exact PAPC resource closure remains a separate opt-in prerequisite; final full-workspace, installed and human qualification remain outside this review.
