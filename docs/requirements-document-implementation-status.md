# PAP-283 implementation status

Primary coordination: **PAP-283**. PAPC companion: **PAPC-077**, created at Sinh's explicit request in deployment d-15ffcf. Only runtime source was authorized for this checkout; PAPC source remains unchanged. These are source implementation/validation observations, not package approval or product acceptance.

| Phase | State | Evidence / remaining work |
| --- | --- | --- |
| P1 contract/session separation | Source implemented | `716459b`; extensible independent subject, strict parser, native fresh-session boundary. |
| P2 runtime toolkit | Source implemented | `2ffe4b1`; bounded helpers, immutable registry/native evidence, protected multi-member publication/queue, Pi tools/CLI discovery, versioned PAPC opt-in. 44 new source tests passed. |
| P3 PAPC composition | Handed off, not implemented here | `2a0898e`; PAPC-077 contains actual interfaces, config selector, P3a–P3d phases, instruction/template/validator targets, acceptance and joint qualification. Status requirement-review, not a fabricated native approval or workflow queue receipt. |
| P4 runtime validation | Partial; blockers preserved below | Full source checks were attempted. Runtime regressions fixed without weakening retained semantics. Complete green suites and joint installed/foreground/independent/CI/human qualification remain outstanding. |

Detailed runtime contract and supported grammar: [requirements-document-capabilities.md](requirements-document-capabilities.md).

Durable full PAPC handoff: `deployments/d-15ffcf/artifacts/PAP-283/PAPC-handoff.md` under AI-usage storage, attached non-primary to PAPC-077. The ticket description includes implementation details; PAP-283 comment `c-20261105234729853` links the actual split and source evidence. Ticket sanitation removed semicolons from its description; the attachment retains the original narrative. Neither is a native decision receipt.

## P4 source validation observations

Raw logs are retained under `deployments/d-15ffcf/artifacts/PAP-283/` in AI-usage storage. Earlier failures and incomplete attempts are retained, not relabelled as passes.

| Check | Actual result |
| --- | --- |
| `corepack pnpm typecheck` | Exit 0 on final runtime source. `pap283-typecheck-final.log`. |
| `corepack pnpm build` | Exit 0 on final runtime source. `pap283-build-final.log`. |
| `corepack pnpm completions` | Exit 0; generated Pi-only static document-discovery completion. OPA output unchanged. |
| `fish -n completions/ppa.fish` | Exit 0. |
| `corepack pnpm secrets:scan` / `git diff --check` | Exit 0. |
| `corepack pnpm test:paired-gate` | Exit 0, 36 passed, zero skips. Existing gate coverage, **not** new-route installed qualification. `pap283-paired-gate.log`. |
| Built-source `node packages/pi-pa/dist/cli.js document describe --format json` | Exit 0, exact action fields/limits returned, installedQualification explicitly not asserted. Not installed CLI evidence. |
| Focused document, migration, frozen characterization and native-host/extension tests | 110 passed, zero failed, 1 existing installed dual-host test skipped because PPA_STORE_OUTPUT is absent. `pap283-final-focused.log`. The 44 document cases themselves have zero skips. |
| Legacy workflow decision/config/startup focused regressions | 35 passed, zero failed/skipped. `pap283-legacy-final.log`. |
| OPA suite with actual PAPC source fixture | 107 passed, zero failed/skipped. `pap283-opa-test.log`. |
| Runtime-host suite | 1 passed, zero failed/skipped. `pap283-host-test.log`. |
| Initial `corepack pnpm test` | Exit 1 in core: 1,824 passed, 1 failed (stale schema-version-16 expectation), 14 missing-external-fixture skips. Corrected the migration expectation to 17 and asserted all new owner tables/triggers are empty and present. `pap283-full-test.log`. |
| Core suite with supported `PA_PHASE5_CONFIG_ROOT` pointing to unchanged PAPC checkout | 1,829 passed, 10 failed, zero skipped. All ten are legacy PAPC builder/report/team instruction contracts, not document tests. `pap283-core-retest.log`. |
| Unchanged runtime baseline `a40c5941...` with the SAME PAPC checkout and three affected legacy test files | Reproduced the SAME 10 failures (9 passed), confirming pre-existing source-pair mismatch. No old negative checks were deleted or weakened. `pap283-baseline-config.log`. |
| Full Pi suite | Timed out after 600 seconds. Observed legacy tool-inventory failure from unconditional new-tool registration. Fixed by native-authenticated lazy session registration, preserving the frozen legacy inventory; characterization retest passed. Existing installed dual-host skip remains. No complete pass claimed. `pap283-pi-test.log`. |
| Pi `test:code` follow-up | Timed out after 420 seconds. Observed stale schema-version expectation and explicit module-count expectation; corrected both with mode-scoped document-module assertions. All affected files passed in the final focused run. No complete pass claimed. `pap283-pi-code-retest.log`. |

P4 also corrected multiline ticket-intake descriptions, added exact native current-ticket association-edge verification, exercised status-based snapshot recovery, and preserved exact operation correlation in bounded replies. All such changes were typechecked/built and covered by the final focused tests. Lazy native registration fixes a real compatibility regression rather than changing the frozen expected tool loadout to accept unsupported tools.

## Remaining obligations and boundaries

- PAPC-077 must update and test the complete new instruction/template/composition closure, with explicit old/new version dispatch. The ten baseline source-pair contract mismatches require proper pinned legacy fixtures/owner coordination, not blanket regex relaxation.
- Complete green core/Pi full regressions remain outstanding after the observations above; focused success does not substitute for them.
- Joint P4 still needs a clean exact installed runtime/config pair, new mandatory PAP-283 installed-driver cases, genuine normal foreground TS-1–TS-18 trial with actual prompt counts/native receipts, independent review, hosted CI and Sinh UAT. No driver extension or genuine installed/human observation was produced in this runtime-only session.
- The new route is **not activated by legacy PAPC**. P3 must deliberately provide `deploy_modes[].document_profile: pa-document-package/v1` only on requirements/analyze after its entire composition is coherent. Manual drafting remains honestly agent-authored if no matching canonical producer exists.
- No install/activation, push, merge, source approval replay, builder launch, checkout/resource return or customer acceptance is implied. Preserve original r001 draft/provenance limitations and PAP-283's historical administrative queue transition. PAP-283 is not marked done by these source commits.
