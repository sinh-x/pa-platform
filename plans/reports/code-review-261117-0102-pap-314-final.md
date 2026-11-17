# PAP-314 final independent P4 / overall contract review

## Code Review Summary

**No blocking source findings at `766af44d76e67c9209cbbfe722f0fc586646ac8e`.** P4 accurately describes the implemented runtime capabilities, deliberately unauthenticated local confirmation, and native-only finite effects. It does not select defaults, implement PAPC-090, or claim installed/browser/human qualification.

Pre-Landing Review: No issues found in the reviewed scope.

### Scope

- Candidate: stable `HEAD=766af44`; P4 diff `b537789..766af44`, 13 files, **723 additions / 43 deletions**.
- Reviewed changed paths:
  - `docs/PAP-314-local-review-contract.md`, `docs/PAP-314-runtime-integration.md`.
  - `packages/pa-core/src/interactions/catalogue.ts`, `packages/pa-core/src/interactions/source-inventory.json`, `packages/pa-core/src/__tests__/interactions-catalogue.test.ts`.
  - `packages/pi-pa/src/__tests__/handoff-native.test.ts`, `packages/pi-pa/src/__tests__/local-review-contract.test.ts`, `packages/pi-pa/src/__tests__/fixtures/local-review-client.json`.
  - `scripts/dev/generate_completions.sh`, `completions/ppa.fish`.
  - `plans/261117-PAP-314-requirements-review-approval/plan.md`, `plans/261117-PAP-314-requirements-review-approval/phase-04-runtime-integration.md`, `plans/reports/implementation-261117-0544-pap-314-p4-runtime-integration.md`.
- Read `AGENTS.md`, the complete CLI message standard, P0 contract, runtime handoff, interaction-owner rules, phase/plan and prior independent review/repair dispositions. Applied both base/API checklist passes.
- Verified prose against strict local/native parsers, capability selection/registration, default transports, review journal, preflight/refresh/continuation and publication/ref/link/queue owners. Those admission/effect sources are unchanged by P4. Prior P1/P2 and repaired P3 source acceptance is retained, not presented as newly rerun full-suite evidence.

### Blocking Findings

None established. The accepted absence of local submitter authentication is not a defect against this scope. Current native process authentication and immutable origin verification remain separate requirements.

### Edge Cases Scouted and Verified

| Seam | Evidence and result |
| --- | --- |
| Original request and revocation coordinates | `handoff-contract.ts:143–160`, `handoff-review.ts:285–359` and `registry/handoff-reviews.ts:210–233` match the examples: revision 0 for the original capture; revision 2, a distinct key and the original decision target for revocation. Identical outcomes replay; changed outcomes and post-request revision 3 conflict. Provenance is generated atomically, never supplied by a client. |
| Default CLI/API shared state | The new `handoff-native.test.ts:287–390` test uses `runDocumentCommand` with only stdin/IO options and `startLocalReviewServer({port:0})`, with **no injected handler**. Its subject, plan, reader and request coordinates come from the registered native owners in disposable Git/TicketStore/registry fixtures. It does not insert approval receipts or override provenance/admission to make the example pass. Assertions cover shared pending state, stale replay, native successor refresh, deliberate successor approval, revocation and absent publication/ref effects. This is source dispatch, not an installed CLI journey. |
| Native versus local wire coverage | `handoff-native.ts:53–95,192–297` and the local parser match the matrix. CLI/API accept only show/request/decide/revoke. Preflight/refresh and publication/ref/link/queue remain native; native status aliases shared v2 show. The documented native envelope and 50 KiB summary limitation are real. Local show includes text/base64 content, inventory, history, eligibility and separate effect observations. |
| Version, origin and current caller | `document-session.ts`, `local-review.ts:21–54`, native registration and `handoff-preflight.ts:117–179` support the stated fresh-selection, saved-origin and narrowly admitted continuation boundaries. The handoff does not upgrade v1/omitted/retained/OPA/background/resume paths or describe an ended origin as the current caller. |
| Discovery risk and guard renewal | Stdin is conservatively write; listener startup is resource; standalone preflight/show are read; refresh/request/decide/revoke remain write. Bindings/schemas remain null, not live grants. Inventory inspection found **163 → 168 entries, zero removals, five added owners, 17 renewed hashes and zero hash mismatches**. Existing conservative guard assertions remain; independent effect-regression/missing-variant assertions were added, not disabled. |
| Completion collisions | Real fish completion produces only the supported document paths/options. Protected `ppa review preflight` and `ppa artifact review` remain separate. Generated outputs match checked-in files across two isolated generations; OPA is unchanged. No CLI refresh/publication/queue command is invented. |
| Finite effects and uncertainty | Current owners support full source/reader/manifest/decision attachment verification before requirements-primary promotion, then correlated ref/link and optional queue. The prose preserves independent custody/lifecycle/link admission, stale non-grant dispositions, original-operation recovery and revocation fences. Queue is not launch; browser-open request is not viewing or isolation. |

Concurrency, error propagation, API shapes, compatibility, boundary validation, process/effect authorization, bounded queries and disclosure were checked in these seams. P4 adds no DB query/ledger, generic dispatcher, effect authority, dependency or active configuration selection. Transport timeout/disconnection and response failure remain explicitly uncertain, not proof of rollback.

### Independent Checks

Commands ran in the requested checkout with `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1` for tests/build/typechecks. Every completed check below exited **0**. Test summaries reported zero failures, cancellations or skips; the fish behavioral test actually ran.

```bash
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/interactions-catalogue.test.ts src/__tests__/interactions-contract.test.ts src/__tests__/interactions-discovery.test.ts
corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/mode-capabilities.test.ts src/__tests__/document-handoff-contract.test.ts src/__tests__/document-local-review.test.ts
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-contract.test.ts src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts
corepack pnpm --filter @pa-platform/pa-core build
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='PAP-314 P4 inert client|omitted native handoff|v2 invocation cannot upgrade|P3 R4 retained v1|handoff diagnostics' src/__tests__/handoff-native.test.ts
corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-contract.test.ts
corepack pnpm --filter @pa-platform/pa-core typecheck
corepack pnpm --filter @pa-platform/pi-pa exec tsc -p tsconfig.json --noEmit
```

| Check | Result / evidence |
| --- | --- |
| Discovery/catalogue/contracts | **23/23**; `/tmp/pap314-final-core-discovery.log`. |
| Capability/schema/local owner boundaries | **38/38**; `/tmp/pap314-final-core-boundaries.log`. Includes concurrent conflicting decisions, issuance rollback, original-coordinate replay and v1 isolation. |
| Client/CLI/server | **33/33**; `/tmp/pap314-final-client-transport.log`. Includes strict examples, hostile errors, limits/deadlines, slot retention, source CLI propagation and completion generation/behavior. |
| Rebuilt core and selected registered-native checks | Build passed, then **5/5 selected tests**; `/tmp/pap314-final-core-build.log`, `/tmp/pap314-final-native-focused.log`. Not a whole native-suite run. |
| Client contract after core rebuild | **4/4** repeated tests; `/tmp/pap314-final-contract-rebuilt.log`. These overlap the 33, not four additional distinct tests. |
| Core and Pi TypeScript checks | Passed; `/tmp/pap314-final-core-typecheck.log`, `/tmp/pap314-final-pi-typecheck.log`. Pi used direct `tsc --noEmit`, not the package wrapper's extension bundling and build sequence. |
| Shell/fish and diff checks | `bash -n scripts/dev/generate_completions.sh`; fish syntax on `completions/ppa.fish` and `completions/opa.fish`; actual `complete -C` document/protected/artifact paths; `git diff --check b537789..766af44`; OPA diff and staged-diff checks passed. Generation ran in temporary directories through the contract tests, not over checkout sources. |
| Inventory and documentation | Independently compared old/new inventory keys and actual SHA-256s. Both contract documents' local links resolve; runtime handoff is 185 lines, below 800. |

### Message Standard Accounting

Affected categories are catalogue information/next-step guidance and completion help, not newly changed runtime blocker envelopes or machine/exit/stream contracts. Before, document discovery advertised describe only and generic review completion could suggest protected preflight. After, it offers “Inspect or decide eligible v2 reviews; no authentication”; stdin says “may persist a decision”; serve says “Explicitly expose local review on numeric loopback.” Catalogue guidance explicitly denies authenticated human consent and CLI/API effect parity. Plain-text reviewer inspection and structural/software checks are separate from genuine human comprehension acceptance.

### Plan Follow-ups and Qualification Limits

- P4's checked tasks are supported as complete for **bounded runtime handoff/discovery**. This report supplies final independent source review; it does not mutate plan/task status.
- P5 may record this bounded review and the checks above. Do not mark broader workspace/CI/installed/browser/human verification passed from this report. The implementation report's earlier broad Pi timeout remains a timeout; this review did not repeat that aggregate or claim a full-workspace pass.
- PAPC-090 still owns external process/default integration and actual selected-pair qualification. No active defaults, installation or external repository changes were made or inferred.
- Installed normal-entry/foreground CLI/API/Pi, hosted CI, genuine browser/keyboard/zoom/accessibility/readability, trusted-opener isolation and Sinh UAT remain known separate gaps, **not newly discovered source blockers**. The agreed system-default-browser fallback does not satisfy those gates.
- Type/test coverage percentages were not measured. No standalone lint script or lint pass is claimed.

The first report-write attempt was rejected by a hook that interpreted a path-like phrase in prose as a denied path. No file was written by that attempt; rewording the phrase allowed the requested report without changing hook configuration.

Only this report was written. No source, fixture, plan state, staging, commit or live ticket/database state was changed; test mutations were disposable and core build outputs were generated locally. Candidate HEAD remained unchanged.

### Unresolved Questions

None for this source-only review scope.

Status: DONE
Summary: Final independent P4/overall contract review found no blocking source defect at 766af44; focused checks, strict examples, default shared-state propagation, discovery risk and completion guards passed.
Concerns/Blockers: No source blocker. Existing broader/installed/browser/human qualification and PAPC-090 integration remain separate and unclaimed.
