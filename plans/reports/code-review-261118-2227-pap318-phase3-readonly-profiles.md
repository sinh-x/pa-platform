# PAP-318 Phase 3 independent read-only review

## Code Review Summary

**Do not land yet. One blocking trust-boundary defect and one non-blocking schema defect were verified.** Passing selected-mode fixtures do not cover the missing-mode fallback.

### Scope

- Candidate: uncommitted changes against `5470d27a57a09577c1e752914fecb0c2af13ea09`, on `feature/PAP-318-pi-primer-file-transport`.
- Reviewed all 25 tracked changed files and five supplied untracked files. Code/tests: +599/-140 lines; supplied documentation/evidence: 233 new lines, excluding this review.
- Rulebook: repository `AGENTS.md`, exact published r002 requirements, `docs/readonly-document-profile.md`, the Phase 3 implementation report, and the implementation plan. Applied scout plus critical/informational base and API checklists.
- Environment: repository worktree specified by the request; Asia/Saigon; English, `en_US.UTF-8`. No source edits, commits, installation, provider calls, live ticket actions, Herdr, or denied installed-Pi reads were performed. Only this report is added to the repository.

Changed-file groups inspected:

| Area | Paths |
| --- | --- |
| Core schema/selection | `packages/pa-core/src/{readonly-document-config.ts,mode-capabilities.ts,mode-capability-selection.ts,analyst-resource-selection.ts,yaml-parser.ts,types.ts}` |
| Core plan/composition | `packages/pa-core/src/{deploy/plan.ts,primer/index.ts}` |
| Core finite consumers | `packages/pa-core/src/{documents/handoff-intake.ts,documents/handoff-preflight.ts,documents/local-review.ts,interactions/tickets.ts,tickets/status-service.ts,tickets/store.ts}` |
| Pi launch/authentication | `packages/pi-pa/src/{deploy.ts,document-session.ts,process-identity.ts}` |
| Pi finite consumers | `packages/pi-pa/src/{document-native.ts,document-confirmation-native.ts,handoff-native.ts,ticket-status.ts,pi-extension/document-tool.ts}` |
| Tests | Core `__tests__/{readonly-document-profile,analyst-identity-origin,execution-plan}.test.ts`; Pi `__tests__/{readonly-document-profile,analyst-identity-session,analyst-identity-ticket}.test.ts` |
| Documentation/evidence | `docs/readonly-document-profile.md`; `plans/reports/phase-implementation-261118-2134-pap318-phase3-readonly-profiles.md` |

### High Priority — blocking

#### R1. Omitting the mode drops the entire v3 contract and restores generic ticket-writer privilege

**Location:** `packages/pi-pa/src/deploy.ts:798-807`. The same missing guard exists at `packages/pa-core/src/deploy/plan.ts:157-159`; the accepted input is enabled by `packages/pa-core/src/readonly-document-config.ts:66`.

The strict schema permits a v3-only team without `default_mode`. With neither a requested mode nor a configured default, `resolveDeployMode` returns `undefined`. The new launcher determines `readonlyProfile` solely from that absent mode, so a public team other than `analyst` skips both the rejection and committed capability selection. Planning likewise treats it as an ordinary `default` route. There is no v3 registry binding, policy session marker, or source recheck/start callback. Document tool restrictions therefore are not selected.

This is also a writer-authority regression, not just missing prompt context: `resolveTrustedTicketMutationContext` sees no binding and returns `privileged: true` for the resulting running deployment. Renaming this configuration from `analyst` to a synthetic name changes rejection into an unbound privileged launch. An empty capability selection does not prevent it.

Minimal accepted configuration:

```json
{
  "name": "evidence-lab",
  "agents": [],
  "deploy_modes": [{
    "id": "report", "label": "Report", "objective": "docs/report.md",
    "document_profile": "pa-readonly-document/v1",
    "capability_policy": {"version": "pa-mode-capabilities/v1", "allow": []}
  }]
}
```

Request: `deployWithPi({ team: "evidence-lab", repo: "example" }, adapter)`.

**Verified:** An inline disposable fixture reached an injected inert adapter's `spawn`, without starting a target. Both `evidence-lab` and public `builder` spelling produced:

```json
{"mode":"default","binding":null,"beforeRuntimeStart":false,"ticketContext":{"privileged":true}}
```

The fixture deliberately lacked a qualified configuration Git source; reaching `spawn` also demonstrates that the committed-source owner was skipped. A separate dry-run returned `pending` with an allocated deployment and a primer lacking the v3 profile. No production state was used.

**Remedy:** Require a resolved v3 mode whenever the selected team declares this v3-only contract. Without `default_mode`, require an explicit mode; do not infer a generic base route. Enforce this in native immutable planning as well as the launcher, while preserving historical unprofiled-team behavior. Add missing-mode negatives for `analyst`, a renamed synthetic team, and public privileged spellings, asserting rejection before allocation/probes/spawn and no generic ticket privilege. Retain positive coverage for an explicit mode when the default is absent.

**Requirements affected:** FR-7/FR-8, AC-07, NFR-2; configuration-only renaming, exact capability selection, source admission and public-name/effective-role separation.

### Low Priority — informational

#### R2. Strict enum validation accepts arrays by coercing them to strings

**Location:** `packages/pa-core/src/readonly-document-config.ts:51,57`.

`String(mode.mode_type)` accepts `mode_type: [work]`; the parser then returns the actual array as the typed `DeployMode.mode_type`. The same coercion accepts `inject-as: [reference]` at schema validation, although resource selection subsequently rejects that skill. This contradicts the documented malformed-type rejection and leaves parser consumers with an invalid runtime shape. No native privilege widening was demonstrated from this issue alone.

**Verified:** `parseTeamYamlContent` accepted an otherwise valid v3 configuration with `mode_type: ["work"]` and returned `acceptedModeType: ["work"], type: "object"`.

**Remedy:** Check `typeof value === "string"` before exact enum membership for both fields, and add raw YAML/JSON array/object/number/null negatives. Do not repair malformed values by coercion.

### Scout findings and risk calibration

- Traced name-based default-mode resolution, repository classification, process anchors, registry/session markers, generic ticket privilege, direct tool guards, handoff origin/continuation and intake/status consumers. The missing-mode branch was outside the selected-mode fixtures and caused R1.
- For explicitly selected v3 modes, source snapshots and synchronous pre-release rechecks remain in the existing owners. The reviewed session path checks canonical roots, registry agreement, PID incarnation/lineage, exact public identity and marker/version agreement.
- The real-launch fixture reuses one adapter/runtime while committing configuration additions, edits and renames. It checks all three Analyst modes with supplied and absent tickets, exact large-primer count/digest, resources, tools, process anchors and unchanged primary-ticket metadata. All fixture definitions supply a default, explaining why R1 passes that coverage.
- No additional confirmed blocking defect was found in those selected-mode finite consumers. This is not a claim about installed Pi behavior or arbitrary same-UID isolation.

### Independent checks executed

All test commands used `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`. These commands did not build or modify source.

```sh
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-origin.test.ts src/__tests__/execution-plan.test.ts
# 27 passed, 0 failed/skipped.

corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/analyst-identity.test.ts src/__tests__/analyst-identity-composer.test.ts src/__tests__/mode-capabilities.test.ts
# 18 passed, 0 failed/skipped.

corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/readonly-document-profile.test.ts src/__tests__/analyst-identity-ticket.test.ts src/__tests__/analyst-identity-session.test.ts
# 8 passed, 0 failed/skipped; approximately 91 seconds.

git diff --check 5470d27
# Passed.
```

Additional bounded inline checks compared current and baseline `parseModeCapabilityBinding` serialization for ten v1/v2 cases across five capability sets: all byte-equal. Baseline TypeScript came from `git show 5470d27` and was transpiled in memory; no baseline file was written. This supplements, rather than replaces, historical semantic tests. Other inline probes reproduced R1 and R2 as described above.

Total independently rerun software cases: **53 passed, zero failed or skipped**. These are source/disposable-process checks. Pi suites use the existing workspace core build; this reviewer did not rebuild or qualify an installed package. Type/test coverage percentages were not measured; no independent lint run was performed.

### Plan follow-ups and evidence limits

Phase 3's explicit-version seam, selected-mode consumer updates, fixture matrix and contract documentation are present. Its fail-closed and strict-schema tasks should not be considered complete until R1 is repaired and R2 is addressed or explicitly tracked. No plan state was changed.

The main agent's post-commit repository typecheck/build/full tests, sensitive-workflow scan and hosted CI remain separate pending evidence. The implementation report's timed-out full handoff invocation is not converted into a complete-suite pass by this review. Exact installed pairing, production PAPC qualification/activation, normal-operator trials and human UAT remain unperformed and are not additional source-defect findings.

Touched help and fixed capability diagnostics were inspected under `docs/cli-message-standard.md`; focused plain-output assertions passed. That evidence does not establish exhaustive malformed-YAML CLI propagation or independent human usability acceptance.

### Unresolved Questions

None requiring a product/workflow redesign. The verified defects are local candidate-source fixes.

Status: DONE_WITH_CONCERNS
Summary: Independent review verified one blocking missing-mode admission/privilege bypass and one non-blocking strict-enum defect; 53 focused tests passed.
Concerns/Blockers: Repair R1 before landing and add its negative matrix. Full integrated, CI, installed and UAT evidence remains separately owned.
