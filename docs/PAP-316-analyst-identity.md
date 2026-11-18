# PAP-316: trusted public Analyst identity

Requirements-only source support is implemented. **The current omitted-profile Analyst configuration remains blocked before deployment allocation or spawn. Nothing is installed or adopted.**

## Scope and completed tasks

- [x] Inventory the canonical PAPC `runtime-handoff`, `source-gap-map` and `workflow-contract` documents and the native identity consumers.
- [x] Preserve intended-cause regressions before implementation in `/tmp/pap316-p4-identity-red.log`.
- [x] Add strict native public/effective identity and committed resource closure without an environment or YAML team alias.
- [x] Close launch, process/session, origin, association, planning attribution, continuation and finite ticket permissions.
- [x] Verify focused source compatibility, builds/typechecks and unchanged owned-source fingerprints.
- [x] Repair independent findings R1–R3 with actual adapter/PTY child evidence, start-boundary freshness and source-only composer compatibility.

This is the identity portion of phase 4 in `plans/2026-11-17-PAP-316-approval-handoff/plan.md`, not completion of the entire ticket. PAPC still owns workflow and quality policy. Builder, advisory, protected requirements review/focus and any future review team are unchanged. Committed package/deployment-source intake implementation files were not edited.

## Contract

`pa-document-policy/v1`, `pa-mode-capabilities/v1` and the exact historical `pa-mode-capability-binding/v1` shape remain intact. V1 still binds `teams/requirements.yaml` and cannot describe a public Analyst start.

The new `pa-mode-capability-binding/v2` has exactly these fields:

- `schemaVersion`, `configRoot`, `configRevision`;
- `resourcePath: teams/analyst.yaml`, `resourceSha256`;
- `profile: pa-document-policy/v1`, `policy`, `repoKey`;
- fixed `identity`: public `analyst/analyze`, effective `requirements/analyze`, audit actor `requirements/analyze`;
- sorted unique `resources`, each with an exact relative `path` and raw-byte `sha256`, including the team YAML itself.

Configuration cannot choose the mapping, substitute another mode, import a grant or use the draft `contracts/analyst-workflow-v1.json` as selection authority. The native started event and current registry retain the public team. `PA_TEAM` stays `analyst`; it is never rewritten to impersonate requirements. Finite native ticket records deliberately keep the effective `requirements/analyze` actor and existing requirements artifact/assignment owners. V2 explicitly explains that attribution; old actor history is not renamed. Selection hashes bind the complete identity/resource version into existing intake and plan identities.

### One committed source

The native selector reads the actual Analyst YAML through one `CommittedConfigSource` and compares the parsed team against the launcher selection. It captures the selected objective, active agent instructions/skill, team/mode global documents, only the current repository's project guides, selected skills and transitive references. Inactive agents and unrelated project guides are not read.

Supported reference syntax is Markdown links/images, including reference-style destinations, plus explicit root-relative `docs/`, `skills/` or `primers/` file locators in code spans. Relative destinations resolve within the committed configuration root. External links are not fetched or treated as instructions. Dynamically discovered/natural-language resource names are not another loader contract. Missing, uncommitted, escaping, symlinked or unsupported resources fail closed; no directory enumeration, alternate root or latest-config overlay supplies replacements.

The source owner authenticates the physical canonical root/revision and exact committed bytes. V2 is bounded to 128 resource entries, 1,024-character relative paths with at most 16 segments, and a 64-KiB serialized binding/team YAML. Existing committed-source file/aggregate bounds also apply. Public policy YAML rejects repeated object/merge-alias graphs and exceeds neither 4,096 values nor depth 32. Sparse resource arrays and unknown binding fields are rejected.

The composer consumes the captured, hash-checked content. Reference-only resources remain explicitly labeled reference-only and appear once. Selected completion comes from that captured closure, not the historical shared completion fragment. There is no V2 filesystem/resolver completion fallback. V2 uses `--no-skills` without any `--skill` arguments: all selected skill bodies are already captured in the primer, and the native loader must not reopen mutable configuration or promote reference-only material. Freshness is rechecked synchronously at actual foreground child admission, after adapter preflight/native-child awaits and immediately before release into runtime code. Existing auto-launch and retained-resume gates remain controlling; a `runCommand` sink cannot honor this gate and stays fail-closed. Post-launch config edits do not widen the saved session.

Ordinary unselected/offline source composition, including Analyst analyze/investigate/research for Pi and OPA, does not grant native authority and needs no V2 capture. Explicit native Analyst composition still requires the authenticated snapshot. Production omitted-profile admission remains a separate launcher/execution-plan check that rejects before deployment allocation.

### Admission and consumers

| Boundary | Behavior |
| --- | --- |
| Public launch | Only an explicit fresh foreground `analyst/analyze` policy selection can enter V2. Omitted policy, reports, pinned/resume/background/inherited/force/ticket-worktree routes do not fall through to generic launch. |
| Execution plan | Public identity, policy, exact repository, primary root and public environment must agree with the binding. Repository admission is read-only, not generic non-locking or builder custody. |
| Pi authentication/tools | Canonical started bytes, running registry, public environment/deployment directory, physical roots, process fingerprint/lineage and session agree. Tool exposure and direct invocation retain exact capability checks. |
| Intake/association | The binding authenticates the public route; the existing finite owner records the explicit effective actor and retains original intake/recovery coordinates. |
| Planning/origin | Existing plan attribution remains effective `requirements/analyze`. Saved-origin verification checks the public binding/version, selection digest, association and original complete native plan. |
| Continuation | Origin and current caller remain separate. Existing death/custody checks apply; a V1 continuation cannot silently migrate a V2 origin, or vice versa. |
| Generic ticket CLI/API | A running public Analyst deployment has `privileged: false` in `resolveTrustedTicketMutationContext`. It does not inherit generic lifecycle privilege. |
| Finite ticket owners | Only after native caller and selected-tool authentication do package/handoff/status adapters construct an explicit effective context. Their original CAS, admission, review, publication, ref/link and queue owners remain controlling. |

The directly necessary additional authentication consumer is `packages/pi-pa/src/ticket-status.ts`; the proposed ownership filename `ticket-native.ts` does not exist. No general ticket service or review-team adoption was added.

## Test evidence

CWD: `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`. Qualification uses `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`, existing pnpm/tsx/Node tooling and disposable stores/repositories only. Temporary Git commits inside fixtures establish committed-source identities; this working tree was neither staged nor committed.

- Red: `/tmp/pap316-p4-identity-red.log`. Original intended failures show unsupported V2 parsing, requirements-only YAML/session authentication, generic allocation of an omitted Analyst route and non-locking classification. Additional intended reds cover alias graphs, duplicate reference rendering, deployment-directory disagreement, inherited launch and sparse arrays.
- Green: `/tmp/pap316-p4-identity-green.log`. The focused compatibility run passed **155 core tests and 8 Pi tests**, including all 10 new identity tests. Reruns are not additional distinct coverage.
- After the final raw-object parser hardening, 12 core identity/policy tests and all 5 new Pi identity tests passed again, followed by workspace typecheck and the identity-test TypeScript check. The only later parser change rejects sparse raw arrays; dense persisted V1/V2 contracts are unchanged.
- Final owned source/test identities: `/tmp/pap316-p4-identity-source-final-before.sha256` and `...-final-after.sha256`; `cmp` returned 0. Current tracked baseline was `8d2fd8b8eed237e42930315dc143b464f07a6b82`; these fingerprints, not that commit alone, identify the dirty candidate.

Exact focused commands (run from repository root):

```bash
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/analyst-identity.test.ts src/__tests__/analyst-identity-origin.test.ts src/__tests__/mode-capabilities.test.ts src/__tests__/document-handoff-intake.test.ts src/__tests__/document-handoff-planning.test.ts src/__tests__/document-local-review.test.ts src/__tests__/primer.test.ts src/__tests__/primer-handoff.test.ts
corepack pnpm --filter @pa-platform/pa-core build
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/analyst-identity-launch.test.ts src/__tests__/analyst-identity-session.test.ts src/__tests__/analyst-identity-ticket.test.ts src/__tests__/document-session.test.ts src/__tests__/mode-capability-session.test.ts src/__tests__/ticket-status-native.test.ts
corepack pnpm exec tsc -p /tmp/pap316-p4-identity-tests-tsconfig.json
corepack pnpm typecheck
```

The disposable Pi integration authenticates a public process, registers its selected tools, creates/associates a ticket, plans and stages it, freezes exact documents, requests/decides the same local-unverified review, then completes publication, physical ref/full link and queue through unchanged finite owners. It verifies effective attribution, actual queue readback and the original saved public origin. Separate tests cover native ticket-status privilege versus generic-writer denial, and same-version continuation versus crossed-version rejection. No Builder is launched.

Intermediate expectation/fixture failures were repaired, not counted as behavioral red: an initially wrong temporary team directory, a missing fixture ticket, incomplete fixture timestamps, an incorrect registry-emitter import, and a non-durable observation connection. Raw intermediate logs remain under `/tmp/pap316-p4-identity-*.log`. No observed final failure was ignored. Existing test files, including `handoff-native.test.ts`, were not edited.

## Independent-review repairs (R1–R3 only)

The original source tests used manually planted anchors and a replacement adapter; they did not prove production start integration. The additional `analyst-identity-adapter.test.ts` uses `deployWithPi`, the real `PiAdapter`, real `node-pty`, the production runtime-start bootstrap and a disposable inert executable. The actual child authenticates itself, registers selected `pa_document`, invokes both the registered wrapper and direct native `capabilities` operation, and confirms its PID matches the production-written anchor. No test calls an anchor writer. Version/native-host probes are controlled seams; this is source integration, not installed-host/provider qualification.

- Red evidence: `/tmp/pap316-p4-identity-review-red.log`, captured before implementation. It includes the missing production anchor, mutable `--skill` command, missing native gate on `runCommand`, six ordinary composer failures, and the canonical actual-composer failure. The first preflight mutation landed at the launcher's earlier check; that fixture-boundary error is retained, followed by the corrected deterministic second-preflight regression. Both actual adapter windows released target code without the needed binding denial before repair; post-repair tests require one inert PTY child, no release file and no target result.
- Green evidence: `/tmp/pap316-p4-identity-review-green.log` (7 new core and 6 new Pi tests). Affected suites: core **88/88**, Pi **16/16**, selected adapter compatibility **12/12**, auto compatibility **6/6**, retained-resume gate **1/1**; corresponding logs are `/tmp/pap316-p4-identity-review-{core-affected,pi-focused,adapter-compat,auto-compat,retained-gate}.log`.
- Canonical PAPC `3ed0496880ee7c968ee90c40df94944b13e72f9f`: actual source composer **1/1**; independent read-only sweep **118/118** compositions (12 teams, 59 modes, Pi and OpenCode); `scripts/validate-with-platform.mjs` passed **59/59 modes**, **269/269 references** and its compatibility fixtures. Logs: `/tmp/pap316-p4-identity-review-{canonical-composer,all-mode-source,canonical-validator}.log`. Canonical Git status remained clean. The validator's optional recovery diff-scope check was skipped because no recovery revisions were selected.
- Workspace `corepack pnpm typecheck`, `corepack pnpm build`, the identity-test TypeScript check and scoped `git diff --check` passed. A broader Pi invocation including all `pi-adapter.test.ts` timed out at 180 seconds after 68 passing subtests; it is **not** a completed suite result (`/tmp/pap316-p4-identity-review-pi-affected.log`). The narrower complete suites above supersede no unrun full-suite claim. The orchestrator owns the already-observed full-core failures and all non-identity review repairs.

These repairs do not adopt the canonical omitted-profile Analyst configuration. The independent review's hypothetical explicit-selection missing `docs/json-workflow-runtime.md` closure is not requalified by ordinary composition or compatibility validation; its resource contract remains a separate configuration-owner blocker. No external config, installed state, Builder source, bridge/review implementation or existing handoff tests were changed.

## Human-facing messages

Affected categories are unsupported-selection blockers, native primer information and finite ticket-status CLI help. Machine JSON, exit/stream contracts and historical actor labels are preserved.

- Before: omitted Analyst could allocate a deployment and fail later through a generic path. After: no deployment ID or spawn; the existing fixed diagnostic says `Operation not started: capability selection does not admit it`, with `CAPABILITY_PROFILE`, and one each of Condition/Source/Reason/Correction/Resume Action. The recommended action is owner inspection (impact none; agent/operator; no approval to ask; preserve identities); retry requires corrected supported selection and fresh admission. No activation command is suggested.
- Before: ticket-status help said `Selected fresh Pi requirements/analyze only.` After: `Selected fresh Pi policy sessions only: requirements/analyze or natively bound analyst/analyze.` Help remains ordinary information, not a blocker envelope.
- New primer information: `Public identity: analyst/analyze. Effective native identity and audit actor: requirements/analyze ... Environment and registry remain analyst/analyze ... not ... human authentication.` No retained session or human approval is implied.

Focused policy diagnostics passed existing fixed-text/plain-output/2,000-character/unique-label assertions. New CLI help and public primer text have focused assertions. Inline readability review found outcome, limit and next action identifiable without color; this is agent review, not independent human comprehension evidence.

## Qualification limits and ownership

No config-repository edits, installation, activation, live ticket/database effects, working-tree staging or commits occurred. No worktree/lease/capacity allocation or implementation launch was added. Fixture resources are cleaned in `finally`; evidence logs and local compiler outputs intentionally remain.

Source support is not installed/default-entry, forwarded-client, browser/accessibility, hosted-CI or Sinh UAT qualification. No new semantic quality engine or human authentication is claimed. Investigate/research reports are not native handoff profiles. The current omitted Analyst YAML stays unsupported; a separately authorized future explicit configuration must satisfy the complete committed closure and undergo exact-pair qualification before adoption.

No independent reviewer, simplifier or Kongming delegation was available through the exposed runtime tools. Review was inline, not reported as independent. No separate lint script is defined; scoped `git diff --check` passed. Full workspace tests/completions and installed verification were not run. Parallel bridge files were not edited; shared-tree typecheck is not a standalone installed-runtime qualification. The main plan is left to its owner; this document and the scoped implementation report record phase progress.
