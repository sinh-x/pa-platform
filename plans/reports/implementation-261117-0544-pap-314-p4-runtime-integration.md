## Phase Implementation Report

**Bounded P4 runtime handoff/discovery is complete. Focused tests, affected typechecks/builds and completion checks passed. No admission logic, PAPC source/default, installation, activation, staging or commit changed. A broader Pi aggregate timed out and is not counted as a complete pass.**

### Executed Phase

- Phase: `phase-04-runtime-integration`.
- Plan: `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform/plans/261117-PAP-314-requirements-review-approval/`.
- Status: completed bounded source implementation/verification, with broader qualification outstanding.
- Base: `b537789`; branch: `feature/PAP-314-requirements-review-approval`.
- Commands below ran from `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`. Test/build/typecheck commands used `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`.

### Files Modified

Paths below are exact checkout-relative names. Counts are additions/deletions against HEAD; new files show total lines.

| File | Lines |
| --- | --- |
| `docs/PAP-314-runtime-integration.md` | New, 185 |
| `docs/PAP-314-local-review-contract.md` | +2/-1; status/navigation only |
| `packages/pa-core/src/interactions/catalogue.ts` | +17/-3 |
| `packages/pa-core/src/interactions/source-inventory.json` | +22/-17 |
| `packages/pa-core/src/__tests__/interactions-catalogue.test.ts` | +31/-2 |
| `packages/pi-pa/src/__tests__/handoff-native.test.ts` | +109/-0 |
| `packages/pi-pa/src/__tests__/local-review-contract.test.ts` | New, 94 |
| `packages/pi-pa/src/__tests__/fixtures/local-review-client.json` | New, 76 |
| `scripts/dev/generate_completions.sh` | +25/-11 |
| `completions/ppa.fish` | +20/-8 |
| `plans/261117-PAP-314-requirements-review-approval/phase-04-runtime-integration.md` | New, 29 |
| `plans/261117-PAP-314-requirements-review-approval/plan.md` | +1/-1 |
| `plans/reports/implementation-261117-0544-pap-314-p4-runtime-integration.md` | New, 112 |

`completions/opa.fish` is byte-identical to HEAD. No ownership conflict occurred. No dependencies, external configuration or live ticket/database were changed.

### Tasks Completed

- [x] Published the source-bound capability/native/API/CLI matrix, exact preflight/refresh/stale/revoke/replay/current-caller continuation, no-auth disclosure and PAPC-090 selected-pair prerequisites. The 185-line handoff does not claim installed/default selection or human UAT.
- [x] Documented requirements-primary promotion after all source/reader/manifest/decision attachments, finite ordered effects, original-operation recovery and no launch. Preserved P0 design text and added only status/navigation there.
- [x] Inventoried actual native v2 show/preflight/request/decide/refresh and corrected status/revoke descriptions. CLI stdin is conservatively write; the dedicated server is resource, never read. No fabricated CLI effect parity or live binding is advertised.
- [x] Reconciled 17 stale P0–P3 source hashes after inspecting owners/diffs and latest independent repair review; added the five missing local-review/preflight/intent/transport owners. The conservative guard remains active.
- [x] Generated exact-path PPA document review stdin/serve/port/help completions, excluded the generic protected-review collision and preserved OPA.
- [x] Added inert client data and strict parser/negative tests. Existing disposable registered-native fixture now exercises default, non-injected CLI routing and HTTP dispatcher against the same real Git/TicketStore/registry: pending state, stale approval/replay, native refresh, deliberate successor approval, changed-outcome conflict, request-only revocation, rejection of post-request revision 3, finalization/replay with original revision 2, and no publication/launch. No app/UI or admission workaround was added.

### Tests Status

All completed commands in this section exited **0**; suites had **zero failures and skips**. Counts overlap where stated; they must not be summed as distinct tests.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/interactions-catalogue.test.ts src/__tests__/mode-capabilities.test.ts src/__tests__/document-local-review.test.ts src/__tests__/document-handoff-contract.test.ts src/__tests__/document-handoff-review.test.ts src/__tests__/document-handoff-planning.test.ts
```

**124/124 passed**; `/tmp/pap314-p4-core-final.log`. After final catalogue guidance was made explicitly CLI-local instead of referring to a current native session, reran its affected discovery/contracts:

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/interactions-catalogue.test.ts src/__tests__/interactions-contract.test.ts src/__tests__/interactions-discovery.test.ts
```

**23/23 passed**, including the overlapping 13 catalogue tests; `/tmp/pap314-p4-discovery-final.log`.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern='PAP-314 P4 inert client|omitted native handoff|v2 invocation cannot upgrade|P3 R4 retained v1|handoff diagnostics' src/__tests__/handoff-native.test.ts
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts src/__tests__/local-review-contract.test.ts
```

**5/5 native checks** and **33/33 transport/client/completion checks passed**; `/tmp/pap314-p4-native-focused-final.log`, `/tmp/pap314-p4-transport-contract-final.log`. The fish behavior test executed, not skipped. These use built core exports from this checkout, not a different installed core. Default CLI command routing is tested in process; this is not an installed foreground CLI trial.
After the final documentation clarification of native 50 KiB summaries versus full CLI/API content, `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-contract.test.ts` passed **4/4** again (`/tmp/pap314-p4-contract-doc-final.log`). A one-off local-link/length check passed for both contract documents; the runtime handoff is below 800 lines.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core typecheck
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa typecheck
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa build
```

Passed; logs `/tmp/pap314-p4-core-typecheck-final.log`, `/tmp/pap314-p4-pi-typecheck-final.log`, `/tmp/pap314-p4-pi-build-final.log`. Pi typecheck also runs **`corepack pnpm --filter @pa-platform/pa-core build`**, including reader worker build. That core build also passed separately (`/tmp/pap314-p4-core-build.log`). No standalone lint script exists; no lint pass or full-workspace build/test pass is claimed.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 corepack pnpm completions
bash -n scripts/dev/generate_completions.sh
fish --no-config --no-execute completions/ppa.fish
fish --no-config --no-execute completions/opa.fish
git diff --exit-code -- completions/opa.fish
git diff --check
git diff --cached --exit-code
```

Passed. Generator log: `/tmp/pap314-p4-completions.log`. Contract tests also generated both outputs twice in an isolated temporary directory and compared them byte-for-byte, and used real `fish complete -C` on document/protected/artifact paths. Staged diff remains empty.

### Issues Encountered

- Initial catalogue run: **11 passed / 2 failed**, exposing missing new owners and the stale P0–P3 source snapshot. Reconciled metadata rather than disabling the guard. Original log: `/tmp/pap314-p4-catalogue-initial.log`.
- First six-file core command above hit the harness's **120-second** timeout after 78 passing subtests, before summary; `/tmp/pap314-p4-core-focused.log`. The unchanged command completed with a larger budget as the 124-test pass above.
- Broader Pi command below hit its **600-second** command limit after 40 passing native subtests, before summary/transport files; `/tmp/pap314-p4-pi-final.log`. No assertion failure was printed. This is **not a complete aggregate pass**. The two remaining native cases (retained-v1 recovery and diagnostics) and the targeted P4/omission cases completed in the five-test command above; transport/client checks completed separately.

```bash
TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/handoff-native.test.ts src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts src/__tests__/local-review-contract.test.ts
```

No policy/assertion was weakened for timeouts. No focused runners remained afterward. Completed fixtures cleaned themselves; the two interrupted synthetic temporary directories were identity-checked against their exact generated config, then removed. No live resource was touched. Initial trailing whitespace was corrected; final diff checks pass.

### Message and Review Accounting

Affected categories are catalogue information/next-step guidance and fish completion help, not runtime failure envelopes or machine/exit/stream contracts. Before: `ppa document` offered only describe; generic review completion could suggest protected `preflight` under document review. After: it offers local review, `--request-stdin` says it **may persist a decision**, serve says it **explicitly exposes local review on numeric loopback**, and preflight no longer collides. Catalogue before had no local transport actions; after it discloses unauthenticated decisions and classifies server allocation as resource. These are source metadata, never human identity/installed authority.

Inline outcome/readability and structural review was performed against the standard; real fish behavior, actual default CLI/API propagation, bounded safe diagnostics and plain-output regressions passed in the focused suites. No independent human comprehension review, browser/accessibility acceptance or installed verification is asserted. No live delegation/reviewer capability was exposed, so review/simplification was inline only, not an independent review claim.

### Next Steps

P4's source handoff is available to PAPC-090, but does not execute its process/default work. Independent P4 review, P5/broader aggregate/full-workspace verification, hosted CI, selected installed normal-entry/foreground/native/CLI/API qualification, real browser/accessibility/readability and Sinh UAT remain separate. No scope decision is pending in this bounded runtime implementation.

Status: DONE_WITH_CONCERNS
Summary: Runtime handoff, truthful discovery, scoped completions and inert default-dispatcher client contract are implemented and focused checks pass. No installed/default-selection or human acceptance is claimed.
Concerns/Blockers: The broader aggregate Pi command timed out; selected-pair/installed/browser/human qualification remains outstanding.
