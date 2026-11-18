## Phase Implementation Report

Requirements-only public Analyst identity support is implemented and source-verified. The current omitted-profile configuration remains blocked before allocation or spawn; nothing is installed or adopted.

### Executed Phase
- Phase: P4 requirements identity/resource closure.
- Plan: `plans/2026-11-17-PAP-316-approval-handoff/`.
- Status: completed for this scope, not the entire PAP-316 ticket.

### Files Modified
Tracked entries show added/deleted lines; new entries show total lines.

| File | Lines |
| --- | --- |
| `packages/pa-core/src/mode-capabilities.ts` | +60/-2 |
| `packages/pa-core/src/mode-capability-selection.ts` | +5/-2 |
| `packages/pa-core/src/analyst-resource-selection.ts` | new 72 |
| `packages/pa-core/src/yaml-parser.ts` | +20/-2 |
| `packages/pa-core/src/primer/index.ts` | +44/-16 |
| `packages/pa-core/src/deploy/plan.ts` | +12/-5 |
| `packages/pa-core/src/deploy/repository-admission.ts` | +1/-1 |
| `packages/pa-core/src/tickets/store.ts` | +3/-1 |
| `packages/pa-core/src/documents/handoff-intake.ts` | +5/-4 |
| `packages/pa-core/src/documents/handoff-preflight.ts` | +12/-7 |
| `packages/pa-core/src/documents/local-review.ts` | +6/-5 |
| `packages/pi-pa/src/document-session.ts` | +29/-16 |
| `packages/pi-pa/src/deploy.ts` | +9/-3 |
| `packages/pi-pa/src/document-native.ts` | +3/-3 |
| `packages/pi-pa/src/handoff-native.ts` | +3/-3 |
| `packages/pi-pa/src/pi-extension/document-tool.ts` | +1/-1 |
| `packages/pi-pa/src/ticket-status.ts` | +4/-4 |
| `packages/pa-core/src/__tests__/analyst-identity.test.ts` | new 104 |
| `packages/pa-core/src/__tests__/analyst-identity-origin.test.ts` | new 54 |
| `packages/pi-pa/src/__tests__/analyst-identity-launch.test.ts` | new 63 |
| `packages/pi-pa/src/__tests__/analyst-identity-session.test.ts` | new 111 |
| `packages/pi-pa/src/__tests__/analyst-identity-ticket.test.ts` | new 44 |
| `docs/PAP-316-analyst-identity.md` | new 93 |

This implementation report is also new. Existing tests, package-source intake files, main's handoff-native test and parallel bridge files were not edited.

### Tasks Completed
- [x] Initialize tasks before source mutation and inspect the canonical PAPC requirements.
- [x] Preserve intended-cause red before behavior changes.
- [x] Bind fixed public/effective identity and exact committed resource closure in strict V2; preserve V1.
- [x] Use captured composer content, read-only admission and immediate pre-spawn rechecks without aliases/fallback.
- [x] Authenticate public process/environment, intake, effective plan attribution, saved origin, same-version continuation and selected Pi tools.
- [x] Deny generic Analyst lifecycle privilege while retaining explicitly authenticated finite publication/ref/link/queue/status owners.
- [x] Verify focused compatibility and document messages/qualification boundaries.

### Tests Status
- Core focused suite: **155/155 passed**. Pi focused suite: **8/8 passed**. These include all ten new identity tests; repeated runs are not added to the totals.
- Final parser change: **12/12 core and 5/5 Pi passed**, followed by workspace typecheck and new-test typecheck.
- Build/typecheck: `corepack pnpm --filter @pa-platform/pa-core build`, `corepack pnpm typecheck` and the temporary identity-test tsconfig all passed.
- Scoped `git diff --check` passed. No standalone lint script exists. Full-suite, completions, installed/browser/human qualification were not run.
- Red: `/tmp/pap316-p4-identity-red.log`. Green and exact commands: `/tmp/pap316-p4-identity-green.log`; reproducible command groups and failure classification are in the documentation.
- Owned code/test fingerprints matched before/after final checks. SHA-256 of `/tmp/pap316-p4-identity-source-final-after.sha256`: `7ee4021f46ba0e3e71875e87b8388c6f42e5a2f02d1cdfb52f37960ff19a1783`.

### Issues Encountered
One directly necessary ownership extension was communicated: the existing finite adapter is `packages/pi-pa/src/ticket-status.ts`; `ticket-native.ts` does not exist. It must derive explicit native privilege after authentication, not inherit the generic public grant. No overlapping ownership edits occurred. Fixture/setup mistakes and additional intended-cause parser/directory/inherited-launch regressions were retained and resolved; no final failures remain. Delegation was unavailable, so review was inline rather than independent.

### Messages and Next Steps
Before, omitted Analyst could allocate and fail generically; now the existing bounded `CAPABILITY_PROFILE` blocker explains non-admission and owner inspection before retry. Ticket-status help changed from “requirements/analyze only” to “requirements/analyze or natively bound analyst/analyze.” Public primer information explicitly distinguishes public identity, effective actor and lack of human authentication. Full examples and structural/plain-text checks are in `docs/PAP-316-analyst-identity.md`.

Builder/advisory/protected review/focus and future review-team adoption remain out of scope. No configuration edits, installs, activation, live state effects, repository staging or commits occurred; committed-source Git fixtures were disposable only. The main plan is left to its owner. Exact installed-pair, independent review and human qualification remain separate before any future adoption; there is no unresolved source blocker in this scoped implementation.

```text
Status: DONE_WITH_CONCERNS
Summary: Trusted requirements-only Analyst/analyze support closes identity, committed resources and finite native consumers without environment impersonation or generic ticket privilege.
Concerns/Blockers: Source-only evidence; no independent or installed/human qualification, and no activation. The current omitted-profile route remains blocked.
```
