# PAPC-070: local source-development handoff

**Purpose:** let PAPC develop **inactive** JSON definitions, producers and fixtures against an exact local PAP-271 source candidate. This is not the full runtime-delivery milestone, PAPC source-edit/launch authorization, selected-installed qualification, human approval/UAT, or production readiness. PAP-271 remains incomplete. No terminal-ticket dependency is required to use the delivered source interfaces.

## 1. Pin the candidate; do not replace the installed PPA

**Continuation note:** the shared branch was operator-requestedly rebased onto runtime `develop` `3c8f6e8` (v0.1.153). The former handoff SHA remains historical evidence, not the current branch tip. Request the refreshed exact commit recorded on PAP-271/PAPC-070; do not move the shared checkout back to the old handoff. See `json-workflow-runtime.md` for linked-subject admission, explicit predecessor publication/primary reconciliation and the delivered source/matrix progression, selected-procedure isolation and remaining restart/installed-verifier/qualification gaps. d-daca29 source checkpoints are `be9de49` (native matrix bridge) and `72233a3` (selected-procedure pairing); use the later exact recorded handoff HEAD rather than those abbreviated locators for verification.

- Runtime checkout: `/home/sinh/.treehouse/pa-platform-cdb114/10/pa-platform`
- Branch: `feature/PAP-271-json-workflow-runtime`
- Existing interface baseline: `2088276c409a885100eab2f2c6fdbb2c1f1f52d7`.
- **Executable handoff pin:** use the full later commit recorded in the PAPC-070 source-handoff comment; it includes this document and the source verifier. Do not substitute `HEAD`, a branch name, `develop`, or the installed version for that recorded pin.

If the shared runtime checkout advances, request a refreshed recorded pin or use an independently authorized exact-source copy. **Do not reset/switch the shared ticket checkout**, borrow its custody, or return it on this handoff evidence.

The verifier uses the pinned runtime's **source**, not the currently installed `ppa`, live selected configuration, or a guessed compiled build. Cached lockfile-compatible Node/Corepack/pnpm/tsx/workspace dependencies must already exist. Missing prerequisites block; no install or network repair is part of this command. Both physical checkouts must be clean and committed. An unmerged local PAPC feature commit is accepted; cached/live `origin/develop` ancestry is not required for inactive source development.

From the runtime checkout, after setting the three exact values:

```sh
RUNTIME='/home/sinh/.treehouse/pa-platform-cdb114/10/pa-platform'
RUNTIME_SHA='FULL_40_HEX_HANDOFF_COMMIT_FROM_PAPC_070'
CONFIG_ROOT='/absolute/physical/PAPC-checkout'
CONFIG_SHA='FULL_40_HEX_COMMIT_OF_YOUR_DISABLED_DRAFT'
cd "$RUNTIME"
corepack pnpm exec tsx scripts/dev/verify_workflow_source_pair.mts \
  --runtime-sha "$RUNTIME_SHA" \
  --config-root "$CONFIG_ROOT" \
  --config-sha "$CONFIG_SHA"
```

Equivalent package entry: `corepack pnpm verify:workflow-source-pair --runtime-sha "$RUNTIME_SHA" --config-root "$CONFIG_ROOT" --config-sha "$CONFIG_SHA"` (no extra `--` separator).

This is **not** `verify_json_workflow_runtime.mjs --selected-installed`, nor an override for existing selected/installed qualification. It writes no pin files, selected home, workflows, tickets, registry, Git index, checkout or enablement state. Do not set `PA_PLATFORM_HOME`, change `.pa-platform-config.sha` / `.pa-template-registry.sha`, install this branch, merge, or enable a binding to make this development check pass.

Output is one bounded unsigned `pa-workflow-source-pair/v1` JSON report; nonzero exit means blocked. Positive status is only `compatible-disabled-source-drafts`, with exact runtime/config SHAs, observed source-file digests, manifest/registry/fixture digests, required case counts and limitations. It is **not** a human/native execution/readiness receipt. Redirect output to an evidence location **outside both checkouts** if retaining it, otherwise the next clean-source check will correctly reject the added file.

## 2. Delivered interfaces and boundaries

Use the actual runtime parsers/metadata; do not copy schemas into another validator:

| Contract/surface | Actual owner | Current support |
|---|---|---|
| `pa-workflow-definition/v1`, `pa-workflow-binding/v1`, manifest | `workflows/contracts.ts`, `definition.ts`, `selected.ts` | Strict syntax, typed graph/operation/result validation and committed selected-source loading. |
| `pa-review-bundle/v1` | `workflows/contracts.ts::parseReviewBundle` | Exact raw artifact/matrix/tuple/scope/permission identities; separate fresh/amendment alternatives. |
| Shared `review-bundle` producer | `templates/service.ts`, `workflows/producer.ts` | Actual parser registered in CLI/native template hosts; unsigned deterministic draft, never approval. |
| `decision.package` | Native Pi foreground capture + registry | Requirements/analyze only; real host/caller/UI authentication remains mandatory. Source tests use labelled synthetic captures, not real decisions. |
| `publication.pair`, `ticket.queue` | Existing TicketStore/artifact owners | Absent-only recovery and authority rereads; linked revisions pair new refs before promoting only a proven completed-publication predecessor, preserving old files/metadata and an already-implementing proven queue. Unknown/foreign state still blocks. Source fixture success is not installed/live qualification. |
| `source.local` | Existing execution owner | Intent-bound native phase/result progression now exists: request the exact source step, use that step ID as the native phase ID, drive separately admitted native work, observe native phase evidence, then reconcile the SAME intent. Source verification covers real current journal/candidate/command/input/output proof and uses existing owner locks for registry settlement. Not installed/human qualification. |
| `check.matrix` | Existing validation/review owners | Default native result bridge delivered. Request one durable intent; separately admitted protected independent review uses its exact decision locator. Native supervisor start/result seals bind actual executor ledger/streams/current candidate and inputs. No auto-spawn/claim, agent result import, phase-pass substitution or blind retry. Missing seal/crashed/unknown work remains blocked; source fixtures are not installed/independent acceptance. |
| Coordinator resume | Registry + foreground host | Exact same-role/repository/ticket resume chain; **not execution-holder replacement/restart**. |
| Revised subjects after request-changes | Registry + foreground host + ticket owner | Linked immutable attempts and explicit predecessor primary/queue reconciliation now exist; new subject needs its own native decision. Do not invent a config loop, overwrite, lineage or counter reset. Installed/live qualification remains separate. |
| `ppa workflow`, `ppa decision`; `pa_workflow`, `pa_decision` | Shared read service + native request host | Bounded read/capture/request interfaces documented in `json-workflow-runtime.md`; no actor/outcome/passed/force override. |
| Selected-v1 procedural isolation | Runtime paired validator + PAPC source checker | Runtime validates typed handoffs/primer identity for enabled `requirements/analyze`, retaining all unselected legacy checks. PAPC direct checker must support the coexistence argument/result described below before enabled short guidance can qualify. |
| Full installed verifier | Runtime | **Unfinished**, together with execution-holder restart; source pairing does not waive either. |

d-502d03 adds only the C **journal-restart foundation** (`4ba2268`), not native restart delivery: immutable launch identity is retained, replay derives the successor holder, the existing replacement budget is consumed, and unresolved operations stay blocked. The default native host still has no authenticated restart port; launcher/resource transfer and resumed operation-actor proof remain missing. The candidate-installed verifier is not implemented. Its concrete prerequisites and mandatory inventory are in [workflow-installed-qualification.md](workflow-installed-qualification.md); no passing placeholder or installed readiness claim is supplied.

Later d-502d03 continuation adds durable `restart-intent` gating (`685f58b`) and retained native owner operations (`8a06796`), with actual registry/process/Git/owner-lock tests and 32 subprocess contention. This advances C SOURCE foundations but still does NOT deliver default CLI/native restart: launcher/bootstrap, current Treehouse lease reread and exact resumed operation-actor proof remain unfinished. No config schema, selected procedure contract or enablement change is required by these internal owner APIs.

Latest continuation delivers exact per-operation actor replay (`12ccba1`) and native successor session reconstruction after SETTLED handoff (`ae82b3a`). The latter authenticates current live Pi/owner/capacity/Treehouse and reuses the immutable original descriptor/journal/bounds. It does NOT implement the pre-spawn default launcher handoff. Remaining C source: retained resume admission, durable bootstrap/launch barrier, effect-bound Treehouse proof and child-start handshake before tools; default end-to-end CLI restart stays blocked. Installed verifier remains missing. No workflow/config schema, producer, enablement or public request grammar changed.

The later foreground continuation (`e9e1b69`, `6c41e5a`) now delivers DEFAULT launcher admission and its inert child-start gate: retained selection without fresh slot/checkout/materialization, durable pre-runtime reservation, actual child fingerprint and current lease/decision rereads before existing-owner handoff and exec release. Source integration retains a real check failure across predecessor exit, then repairs and completes two native phases with one package. Treehouse/provider/dialogs are fixtures; separate OS gate tests prove no target code before release. Initial support is FOREGROUND direct structured resume; background/force continuation explicitly deny. The installed verifier is still missing. This is refreshed source-interface evidence for PAPC-072, not installed readiness, final drafting/adoption approval, independent review/CI or human UAT.

The default foreground host now advertises operator capture, publication, queue, the delivered interactive native scoped-source bridge and `validation.matrix`. This is source executable support, NOT installed qualification or enablement. Unsupported operations still fail early instead of supplying legacy authority. Do not omit required full-workflow stages or mislabel source checks as independent validation just to obtain a compatible draft report.

Raw requirements and UAT hashes cover their whole original files; the matrix hash covers the **raw Full Validation Matrix section**, using `parseReviewMatrixPlan`, not the whole requirements file. Command references must name that exact matrix source/hash/command ID. Native execution profiles independently bound allowed effects; opaque shell commands are not silently rewritten into argv grants.

The bundle's JSON amendment uses `branchAction: reuse` with exact retained base/feature SHA. Do not mix it with the separately retained legacy task-handoff producer's amendment/select contract. One native package decision may grant only the finite package permission set; remote push/PR/merge/deploy/risky external effects/checkout return remain separate. JSON structure, a principal name, a template receipt or an approval paragraph cannot issue that decision.

## 3. PAPC files and fixture protocol

1. Add `workflows/manifest.json` and versioned files under `workflows/definitions/` as specified in `json-workflow-runtime.md`. **Every declared binding stays `enabled: false`.** Installing support is not enablement; disabling a binding is not revoking an admitted decision.
2. Add optional `review-bundle` to the **same** `contracts/templates-v1.json` registry delivered by PAPC-071, with canonical content under `skills/templates/`, actual `validation.kind: review-bundle`, and required typed JSON `bundle` binding. A minimal resource body is `{{bundle}}` (its exact raw digest remains registry-owned). Use its exact registry revision; there is no `latest` or second workflow template registry.
3. Extend the existing canonical-template fixture/adoption/instruction inventories for the selected seventeenth producer. Existing PAPC-071 producer/consumer checks still apply; this new source checker does not certify the other sixteen producers' policy/adoption behavior.
4. Add committed `workflows/fixtures-v1.json`:

   - Exactly `schemaVersion: pa-workflow-fixtures/v1` and `fixtures`.
   - Each fixture has exactly `id`, `team`, `mode`, `producer`, `requirementsFile`, `uatFile`, `candidateSha256`.
   - `producer` is one **raw JSON string** containing the actual shared render request: action `render`, id `review-bundle`, exact template `version`, bindings `{bundle: ...}`. Duplicate keys/UTF-8/byte limits are validated, not normalized into permission.
   - Artifact fixture files are explicitly named relative paths below `workflows/fixtures/`. Bundle refs still name their intended canonical requirements/UAT targets; the fixture reader supplies raw test bytes for those refs. No artifact is published by validation.
   - Every declared team/mode binding needs both **fresh and amendment** fixtures, including disabled bindings. Required fixtures are not skipped because enablement is off.
   - `candidateSha256` binds the exact shared producer output, including any template newline. Render with the actual service, not an independently copied JSON formatter.
   - Do not add `passed`, approval, issuer, captured-outcome or callback fields. These are data fixtures, not native decisions or result import surfaces.

The source checker verifies exact Git HEAD/cleanliness and consumed committed blobs before/after observation; physical paths, raw digests and the existing shared registry/parser are authoritative for structural comparison. It exercises both handoffs, exact artifact/matrix identities, actual source CLI list/show/render/validate parity, candidate/forged-request negatives, source CLI definition validation, and the **actual new-run selector's rejection of disabled bindings**. It never makes an in-memory enabled copy or writes a new run. Config remains data; no config-provided command/module/script is executed. Hostile Git fsmonitor/hooks, replacements, lazy fetch and network protocols are disabled for these Git observations.

## Observed source checks

The handoff's paired-gate suite executes 31 cases, including four subprocess source-driver scenarios: both disabled handoffs with 24 actual CLI comparisons, unchanged source/config/Git metadata snapshots, wrong/dirty pins and override rejection, enabled/missing/changed fixture negatives, ignored substitutions, and hostile Git fsmonitor non-execution. All passed with zero skips. The 48 focused core workflow cases also passed, including structural disabled-fixture coverage while actual new-run selection stays denied. Workspace typecheck passed. Initial disposable dependency-cache fixture failures were corrected without installing dependencies; they are not installed/runtime acceptance evidence. The exact clean handoff-commit smoke and its report digest are recorded separately on PAPC-070 after commit.

## 4. What PAPC may prepare versus what still waits

The handoff is sufficient to discuss/refine requirements and develop **separately authorized inactive drafts** using delivered contracts. Keep a visible list of runtime gaps above. Do not remove PAPC-070's `waiting-runtime-implementation` tag, advance its status or claim its full runtime milestone solely from this document/report; that decision belongs to the companion owner after verifying the required delivery scope.

PAPC owns shortened selected-workflow instructions and fixtures, not executable operation semantics, decision issuance, another ledger, new native profiles or runtime gap workarounds. Preserve historical signed sources and other adapters/unselected modes. The runtime still needs authenticated execution-holder restart with retained bounds/failures/unknown operations, the candidate-bound installed verifier and installed qualification of all delivered owners. The paired validator now isolates exactly the supported enabled Pi `requirements/analyze` procedure and validates both handoffs even while disabled. For future enabled adoption, PAPC's existing `checkDirectOnlyWorkflow` must preserve its optional second reader argument and accept a third `{ workflowRoutes: ["requirements/analyze"] }` argument, apply route-aware checks and return the exact ordered `workflowRoutes` acknowledgement. Runtime derives this list from validated selected bindings; it is not a public override. Old companion code blocks enabled coexistence rather than silently accepting shortened prose. All disabled/unselected route checks remain effective. A pass from the narrow disabled-source checker is still not installed readiness, full paired acceptance or permission to delete safety gates.

After both source deliveries, obtain the supported candidate build/selection and perform joint selected-pair/installed qualification, independent matrix/review, CI and genuine human UAT before authorized PAPC enablement. No circular requirement that PAP-271 be terminal is introduced, but these acceptance gates are not inferred from source development success.
