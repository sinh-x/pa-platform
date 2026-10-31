# PAP-271 installed workflow qualification

Status: **verifier source implemented; actual selected-installed qualification NOT RUN/PASSED**. No installation, policy enablement, independent review, CI, human approval or UAT is implied by this source delivery.

## Exact approved command

```sh
node scripts/dev/verify_json_workflow_runtime.mjs --selected-installed \
  --require-candidate "$PA_FEATURE_SHA" --require-paired-config
```

Only that ordered four-argument contract is accepted. The candidate must be a full lower-case 40-hex commit. There is no binary/module/config/source-root/result-file/skip override, `HEAD` substitution, source-mode fallback, passing prerequisite-only stub or caller-supplied result import.

## Prerequisites and identity

Run from the exact clean candidate checkout with its cached lockfile-compatible build/development dependencies already available. The selected PATH `ppa` must physically resolve into its immutable Nix package. `review-runtime-provenance.json` must name the EXACT candidate/config/package identity; `unversioned-dirty-source`, dirty source, wrong SHA or arbitrary executable substitutes block before disposable case execution. The caller's Node ABI needs the candidate's matching native registry addon. The verifier installs/downloads nothing.

The actual selected physical PAPC home/teams, HEAD, runtime-owned config/registry pins, committed manifest/definitions/producers/fresh-and-amendment fixtures and consumed instruction bytes must agree. The complete non-test implementation module inventory for pa-core/Pi/OpenCode/runtime-host is compared byte-for-byte against the candidate build, including package metadata and actual registry addon identities. Installed Pi's pa-core dependency must resolve to that same closure, not a workspace copy. These are observations, not approvals.

Source/config HEAD, cleanliness, pins, resources, selected binary/provenance and implementation bytes are reread after all cases. Final enabled-pair qualification must use that actual final selected revision; a disabled predecessor's pass cannot certify enablement.

## Execution model: pinned drivers, installed implementations

The private disposable harness copies only exact committed test/fixture CODE/DATA. TypeScript transpiles those drivers, not product implementations. Every implementation path (including child `.ts`/compiled-path imports) is a one-line bridge to the verified installed module. Actual `@pa-platform` dependencies resolve into that package. Cached tsx/TypeScript are harness dependencies, never installers.

A native Node import audit rejects product source fallback, changed bridges, changed implementation bytes and missing required installed imports, including subprocess/worker imports. The final report records the installed import/module digests and the private driver identity artifact. Existing core/Pi cases exercise actual registry CAS, publication/queue, retained custody/resource handoffs, confined source checks/local commits, failed checks, two phases, foreground restart, validation/review claims/ledgers/seals and adversarial recovery. Exact native test events and final Node summaries are required; failed, omitted, skipped, cancelled, summaryless or forged-summary cases block.

A separate child exercises the ACTUAL selected public `ppa workflow`/`decision`/`template` CLI and default native read/template tools, not injected public read callbacks. It creates a clearly synthetic private issued-state fixture for positive status/decision reads, validates both selected handoff producers and generates a selected pinned primer. Native mutation override negatives do not display real approval dialogs.

The private environment selects disposable HOME/config/AI/registry/Git resources. Existing native owners/command confinement remain authoritative; this is not an OS sandbox. No live configuration is enabled or rewritten, no live slot/checkout is allocated and no provider/worker is launched by the verifier. Native principal/dialog, original admission/provider and Treehouse seams in the reusable cases remain explicitly labelled fixtures. Actual real-provider/foreground-human UAT is separate.

## Mandatory case inventory

Every ID is required. The first/final identity/unchanged-state checks and installed public-entry drivers combine with exact pinned native-test anchors in `workflow_installed_support.mjs`:

1. `installed-identity`: physical package/binary, exact source/config/registry, module/package/addon provenance.
2. `installed-entry-points`: default public CLI/native list/show/validate/preflight/status/next/decision/template agreement and override rejection.
3. `paired-handoffs`: actual shared producer/parser, exact artifact/raw-matrix bytes, fresh AND amendment for every declared binding.
4. `selected-procedure`: installed pinned-primer identity from actual selected instructions and typed fixtures. Full policy/legacy coexistence adoption remains independently paired-matrix/human acceptance, not a new verifier approval.
5. `static-zero-effects`: independent compatibility defects reject without effects/probes.
6. `structured-decision`: synthetic native capture, exact subject/permissions/rereads, stale/forged authority rejection.
7. `package-effects`: one package, publication/queue/scoped work through real owners, no legacy fallback or new approval prompts.
8. `publication-interruption`: same-intent absent-only effects, conflicts/symlinks/foreign primary retained.
9. `amendment`: explicit predecessor-only promotion/queue reuse; old scope/launch/review pins denied.
10. `native-two-phases`: actual confined checks/local commits with fresh input/provenance per phase.
11. `native-restart`: actual predecessor exit, retained failure/repair, foreground default-launcher admission, same bounds/lineage/resources/operation history and two phases; unknown work stays blocked.
12. `restart-interruption`: retained resource publication faults, real multi-process contention and exact retry; no duplicate permit/holder.
13. `native-matrix`: real native executor/review claim/attempt/ledger/streams/result seal and known-failure/missing-seal negatives.
14. `revocation`: no dependent new effect, completed proven same-intent settlement preserved.
15. `actual-cas`: actual 32-connection registry contention and retained linked subjects.
16. `tamper-no-fallback`: unissued/foreign/unfinished/reused result and missing adopted authority reject.
17. `isolation-accounting`: exact source/config/selection/imports unchanged, private native event accounting and complete mandatory inventory.

Initial supported restart scope is FOREGROUND structured direct custody. Force/background structured continuation explicitly rejects before effects; optional prepared/other-adapter continuation is not silently widened. A missing capability cannot be skipped to obtain success.

## Output, failures and retained evidence

One bounded unsigned `pa-workflow-installed-qualification/v1` JSON document is emitted. `status: passed` requires every mandatory ID and actual case runner to succeed; otherwise exit is nonzero with `status: blocked`, bounded five-field diagnostics and explicit not-run cases. No path/check/outcome/`passed` input is accepted as authority.

The report names physical installed roots/binary/source/config/module/addon digests, exact selected bindings, driver/bridge/import/test-event digests, case inventory/counts and limitations. Private evidence remains under a native-created external temporary directory: driver identity, public CLI/native results, import audit, original test-event/failure/stderr artifacts. Failure/timeout artifacts are retained, never rewritten as a success narrative; uncertain process/resource cleanup is not certified by a failed report. Full logs are private mode0600. Rerun only after the named owning prerequisite is reconciled.

## Observed development checks, not installed acceptance

The public verifier's parser/accounting/identity/audit negatives have source regression tests wired into the existing root test commands. An internal local-BUILT bridge run (NOT the public selected-installed route) executed241 core/Pi cases with zero failures/skips/cancellations, including real OS/CAS/owner/restart/matrix cases. An import-audited repeat also passed241 cases; the public-entry driver against the local built CLI/default native hosts passed13 parity/negative observations, both actual selected disabled handoff fixtures and pinned-primer checks. These establish driver implementation behavior, NOT a candidate-installed pass. There is no public source override for these internal regressions.

The installed package observed in d-502d03 was `/nix/store/h3ldz8n8bbz4ack47iyl71d9icy84pbd-pa-platform-0.1.153`; its provenance said `unversioned-dirty-source`. It cannot satisfy the current exact feature candidate. A later separately supported exact Git-candidate build/selection is required before the actual installed command can pass. This document does not authorize installing it.

After both runtime/config source contracts are reconciled, perform actual exact candidate packaging/selection and this installed verification, then independent approved full matrix/review, exact CI, genuine human UAT, explicit final-pair adoption, enabled-revision qualification and authorized canary/rollback. PAPC-072 owns its approvals/content/rollout; no circular terminal-ticket dependency or automatic ticket completion is introduced.
