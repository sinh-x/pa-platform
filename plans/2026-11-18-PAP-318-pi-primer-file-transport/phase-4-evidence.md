# Phase 4 — integrated verification and review closure

Source implementation is complete and committed by phase. This is not installed adoption, production PAPC enablement, hosted CI or human acceptance.

## Candidate and commits

- Base: `407a87047fdf801b7fecc44a06687c232bbc37a2`.
- Phase 1: `1ae4945` — intended-cause real E2BIG characterization and pre-edit design.
- Phase 2: `5470d27` — bounded owned prompt transport.
- Phase 3: `e18ccb9` — versioned configuration-owned read-only profile and historical compatibility.
- Phase 4: this commit — lifecycle fault repairs, actual Pi input-boundary qualification, inventory reconciliation and final evidence.
- Final implementation diff after phase 3, restricted to changed runtime/source/test files, SHA-256: `31a8cc39898020356983402c2b9c7935b03c8a8363105865b67c2ac777eec954`. This is a reproducibility locator, not an approval or runtime grant.

## Actual checks and retained failures

| Check | Actual result |
| --- | --- |
| `corepack pnpm typecheck` | Passed; rerun after the final supervisor correction. |
| `corepack pnpm build` | Passed; rerun after the final supervisor correction. |
| First `NO_COLOR=1 corepack pnpm test` | Failed only at the conservative stale interaction-source inventory. Core: 2433 passed, 1 failed, 14 skipped. Later packages did not run in that attempt. |
| Full repository retry, same command | Exit 0. Script checks 43 passed; core 2435 passed/14 skipped; OPA 109 passed/1 skipped; Pi script checks 11 passed; Pi source tests 1712 passed/5 skipped; runtime-host 1 passed. Total: **4311 passed, 20 skipped, zero failed**. |
| Final supervisor/transport refresh | After the full pass, review found one remaining early-throw ordering case. The correction moves the existing cleanup latch before readiness validation and preserves the typed cause. Fresh typecheck/build and complete transport/background suites passed **51/51** after that delta. The full repository suite was not rerun a third time after this narrow correction. |
| Final catalogue/inventory refresh | **17/17 passed**, including all source fingerprints and the new private dependencies. |
| Exact source-built selected package | Nix build passed. Actual native selected host and Pi input-boundary test passed after the final correction, with no provider/agent start. Details below. |
| Independent review | Initial defects, repairs and narrow final closure are preserved in the reports listed below. The last N1 finding is closed in its exact scope; no whole-ticket/UAT acceptance is inferred. |
| Staged sensitive-workflow scan | `corepack pnpm secrets:scan` passed for phases 1–3; run again on this phase's complete staged content before commit. |
| Completions | Not regenerated: no CLI grammar, flag, operation ID or alias was added. |

Full-suite skips are retained, not passes. They include unavailable external PAPC fixtures and existing optional runtime/environment-dependent cases. No external PAPC selection was activated to eliminate them. Initial focused timeouts and fixture/setup failures are retained in earlier evidence and review reports; none is called a pass.

Ephemeral console logs: `/tmp/pap318-full-test.log`, `/tmp/pap318-full-test-final.log`, `/tmp/pap318-typecheck-final.log`, `/tmp/pap318-build-final.log`, `/tmp/pap318-supervisor-final.log`, `/tmp/pap318-inventory-final.log`. The committed summaries retain outcomes when temporary logs expire.

## Actual Pi initial-input and native-boundary evidence

Commands:

```sh
nix build --no-link --print-out-paths .#ppa-selected-pi
PA_TEST_SELECTED_PPA_ROOT=<exact returned output> NO_COLOR=1 node --test scripts/dev/pi-primer-input-runtime.test.mjs
```

Final source-built output: `/nix/store/il6rxlr6v1azikhqsmi82pkjhvsgkbza-pa-platform-0.1.174`.

Fixture SHA-256: `c309a7eef79bd97298531d8cd8aef005844329c0373a1f1f9588c9949af04380`.

The fixed host authenticates selected Pi 1.4.0 and Node 24.21.0 through its existing immutable build/native process contract. The test uses the actual stopped native child, proves no input observer runs before release, and matches actual Pi input PID/start incarnation to the admitted child. It exercises a 635831-byte primer, BOM/Unicode/CRLF/trailing-newline input, a small no-trailing-newline case, empty-input semantics, path spaces/quotes, bounded kernel argv/environment, snapshot removal and missing-input rejection before dispatch. Sub-limit inputs are compared against the original inline route at the same actual Pi initial-user-input event; byte count/digest, source, attachment absence and dispatch count match.

A disposable extension handles the initial input and records only bounded facts. A separate before-agent-start marker must remain absent. No agent/model/provider request or live ticket is used. The local model catalogue merely satisfies ordinary selection; it is not invoked. This qualifies the **initial-input boundary**, not downstream conversation persistence, provider/model behavior or genuine product UAT.

The build emitted existing Nix store link-count warnings but exited successfully; no store repair, generic hardlink exception or system-limit change was attempted. Building an uninstalled output is not exact installed package/config/Pi-pair verification. The user's installed profile was not changed.

## Review repairs and lifecycle truth

Reports:

- `plans/reports/code-review-261118-2242-pap318-final-readonly-e18ccb9.md`
- `plans/reports/code-review-261118-2304-pap318-f1-renewal.md`
- `plans/reports/code-review-261118-2327-pap318-n1-inventory-renewal.md`
- `plans/reports/code-review-261119-0031-pap318-n1-closure.md`

Partial snapshot preparation now captures exclusive physical ownership before any write, never deletes an uncreated/substituted public pathname, and uses private claim/removal on failure. Missing ownership, failed removal or uncertain close produces a typed cleanup failure. Tests inject exclusive-open, partial-write, fsync, close, replacement and cleanup failures with synthetic composed protected input; foreign evidence survives and no protected body enters diagnostics.

Supervisor ownership carries an optional **deny-only** `cleanupVerified: false` fact; absent legacy fields remain readable, and supplied true values reject. The outer launcher reobserves the same deployment/token after verified runner termination, combines process/input/config cleanup, and treats absent/nonterminal/unproven input outcomes conservatively. It never infers this fact from diagnostic prose. Returned no-child results latch uncertainty before any readiness throw. Full outer-background regressions cover both thrown preparation errors and returned startup/cleanup failures, retained inputs, false durable/outer flags and no admitted Pi children. Existing registry failure-event semantics remain unchanged.

The first full test failure required semantic inventory reconciliation, not a disabled check: existing deployment/status descriptions now explain explicit v3 name/resource binding and bounded transport; operation IDs, CLI/native forms, aliases, channels and effect classes remain unchanged. New private source dependencies are the strict profile validator, transport, preload and background supervisor. All changed guarded hashes were renewed only after those owners and variants were reviewed.

## Touched-message evidence

Categories: input failure, startup failure, incomplete cleanup, selected-host failure and ticket-status/capability help. Before: `Argument list too long` / `Pi exited with code 1`; partial preparation could previously collapse retained-byte uncertainty into PI_PROMPT_INPUT or a missing-PID wrapper. After: fixed outcome-first five-field PI_PROMPT_INPUT, PI_PROCESS_START or PI_PROMPT_CLEANUP guidance, preserving actual typed cleanup uncertainty through adapter/supervisor boundaries. It asks the existing owner to inspect the original operation and forbids an unsafe replacement launch.

Focused tests under NO_COLOR assert bounded fixed text, one of each required label, no synthetic private-context echo, actual propagation and the original registry/status contracts. Reviewers inspected wording and cause selection. Independent operator readability trial, installed rendering and human UAT remain separate unperformed evidence.

## Boundaries and remaining qualification

- **Source/process checks:** completed as recorded, including the preserved real E2BIG baseline and actual selected Pi initial-input boundary.
- **Exact installed package/config/Pi pairing:** not performed; no installation or activation was requested through its separate owner.
- **Production PAPC definitions/qualification/enablement:** not performed. All three Analyst modes and synthetic config evolution are disposable fixtures only.
- **Hosted CI:** not run; no push/remote workflow was requested.
- **Normal foreground provider trial and genuine human UAT:** not run; require separately authorized operator action.
- **Original d-20c9b0 and MVM-233:** unchanged; no live workflow retry or ticket-state update.
- **Local documentation access:** the operator-authorized Pi-package-only AgentKit exception was created outside the repository; the native source-security owner still denied installed package documents. No denied bytes were copied or reader exception added. Public upstream inspection and the independently built actual Pi boundary test are separate evidence, not a claim that installed-document access succeeded.

No unresolved source-design question remains. Installation, production selection, remote CI and human acceptance retain their separate owners; this report does not mark the ticket accepted or change its state.
