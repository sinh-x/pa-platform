# PAP-298 production reader implementation

Status: default-off source-checkpoint integration authorized; full PAP-298/CR-2 acceptance remains open. Branch: `feature/PAP-298-reader-continuation-requirements`.
Baseline: `21530bc1912ea342b8cdbb679514b397c71d8f67`.
Contract: [continuation requirements](../../../docs/PAP-298-production-reader-requirements.md), plus published r001.

## Authorized outcome

Implement the production selected-Pi documentation reader and accepted cancellation/publication contract, preserving strict artifacts, ordinary/retained behavior and all original validation requirements. Reuse merged PAP-298 code. Installation/default switching, ticket closure and historical worktree rewrites remain excluded. Sinh subsequently authorized a PR and merge into `develop` after completion, review and green CI; that authorization does not waive the validation matrix.

## Latest operator decision

The corrected-source review found C1 (no final publication fence for default external Pi), C2 (host drift can retract already committed output) and C3 (nested history can retain pre-publication success). Sinh selected **keep external runtimes unchanged; leave CR-2/source completion blocked; do not merge yet**. Do not narrow the contract, switch the default runtime or treat another coding approval as an infrastructure repair. C2/C3 corrections remain within the existing implementation authority.

After CR-2 was explained, Sinh explicitly requested: **proceed to a PR merged into develop with the gaps noted on PAP-298**. This supersedes the earlier no-merge stop only for the default-off source checkpoint. Keep the external runtime unchanged and all unmet requirements open; do not declare PAP-298 complete, install/select the variant, close the ticket or certify PAP-312. Finish introduced-code review and hosted CI before merging the checkpoint, and append the PR/commit/evidence/gaps note to PAP-298 without changing its status.

## Phases

- [x] Reconcile published requirements/current source; record Sinh's publication-boundary choice.
- [x] Resolve this session's SDK-document access: Sinh authorized a narrow temporary AgentKit ignore exception. Normal selected README read now works; deployed PPA policy is unchanged. Remove the temporary exception before completion.
- [x] Read selected Pi integration documentation/examples; map actual dispatch and publication hooks before choosing a production implementation.
- [x] Add failing registered-reader and actual Pi output-publication regressions; preserve their baseline failures. Launch/provenance coverage is being extended.
- [x] Implement the candidate authenticated build-selected host/reader connection and real publication fencing; review-driven structured-image and buffer-retention regressions are fixed. Final route/compatibility qualification remains a separate gate.
- [ ] Integrate every selected launch/probe/child/resume path, with exact process/ABI/lifetime coverage.
- [ ] Run focused, affected and full checks; preserve failures and obtain independent exact-source review when a supported reviewer is available.
- [ ] Update source/security evidence and remaining installed/human gates; restore the temporary session configuration.

## Current inspection evidence

At the baseline, the normal reader bound only the single-link acquirer; specialized acquisition was internal and used by a non-default qualifier. The candidate now adds an explicit, non-default production build selected by its immutable packager. Its native supervisor stops the actual runtime child before Node; registration and publication use the fixed private producer. Legacy/default external-Pi routes remain ordinary. No production environment flag, document-root argument or fallback enables the exception.

Current source evidence is partial, not completion or installation:

- Registered-reader delegated-microtask regressions reproduced the old publication failure; focused timing/publication checks now pass.
- Patched actual Pi registration, nested execution, awaited extension events, public output and subsequent persistence pass without an external provider request. Model-loop cases use an owned loopback fixture.
- The first selected PPA build and inert production bootstrap passed exact-child admission, copied/direct-launch denial and real parallel-dispatch README/redaction/scope/mutable/image checks. An initial test capture failed because a 64-KiB tail split JSON; bounded complete capture fixed the driver and the rerun passed 3/3.
- The selected built CLI's `ppa pi smoke-tools` passed all eight managed tools on pinned Node 24.21.0, including guards and todo restoration, without a hard-link grant.
- New resume evidence is an absent-only private observation, never source authority. The original CLI checks host compatibility before allocation; the adapter rechecks it. Typecheck and focused resume/publication/adapter tests passed 73/73, zero skips.
- The inert qualification uses the actual production packager, rather than a second fixture bootstrap. Public foreground/background and retained routes pass at the recorded revisions; remaining actual-lifetime/producer coverage and final-source qualification are separate gates.
- Catalogue semantics retain existing launch/resume effects and no new command, read-root field, tool or grant. Producer, publication, launch/resume, finite environment and patch sources are inventoried; affected hashes were renewed after semantic review and focused checks.

The `Agent` tool reported no available reviewer roles. A live-qualified read-only fresh Pi session completed the source review, with the same-model-family limitation disclosed. It found two medium defects: dropped structured image results and retained whole-source buffers. Both baseline regressions reproduced and their corrections now pass actual Pi tests (3/3) and focused publication/resume checks (14/14), zero skips. See [review provenance and corrections](../reports/code-review-261116-0244-pap298-production-reader.md). Subsequent reviews require further changes and retain source completion blocked.

The first full run failed three unchanged permission fixtures because its runner used `umask 077`, and skipped 14 external-config fixtures. Normal `umask 022` reproduced all three as passing without source changes. The full rerun then passed typecheck, build and workspace tests with the detached pinned config: 3,983 passes, zero failures and five explicit optional installed-fixture skips. All 14 external-config cases executed. One skipped dual-host addon case was separately executed against the actual selected build and passed 1/1, zero skips; four unrelated pinned AXI/quota/browser fixture cases remain unexecuted. Active configuration and external refs are unchanged. Logs: `/tmp/pap298-workspace-normal.log` and `/tmp/pap298-dual-host-required.log`.

The first Nix production lane correctly rejected the daemon's mapped UID-65534 namespace. Production root checks remain unchanged: the Nix boundary check exercises publication and namespace denial, while `corepack pnpm verify:selected-pi-reader` uses an explicit actual-host app. The split boundary lane passed 4/4 on the pre-startup-diagnostic source. Actual-host controls now pass 5/5 on both the unchanged previous build and the labelled diagnostic build, zero skips. They cover public foreground/PTY, same-build resume, background runtime/native-parent/supervisor fingerprints and settlement, provider credential forwarding without disclosure, examples, and changed-build/downgrade/legacy rejection before allocation.

An earlier background startup failed its binding before any model request. Its original failed actor is finalized and both owned process fingerprints are absent; evidence remains at `/tmp/selected-pi-dispatch-LA0n9R`. The failed predicate was not captured, so its precise cause remains unproven. A fresh read-only diagnosis confirmed the failure boundary but did not justify relaxing any custody condition. Added finite, privately branded cause labels and an additional pre-main stability check; no admission predicate was removed. Owned fatal startup now returns to the existing bounded PPA diagnostic instead of upstream advice to disable the mandatory extension, and all created lifecycles are explicitly shut down on an unwound main. The old actual Pi reproduces the fatal-startup handoff regression (3/4 pass, one expected failure). That owned-startup candidate, before C2/C3 corrections, passed the actual-host app (four real-Pi transport/startup tests and five native/public-route tests) and the builder boundary lane (five tests), all with zero skips. Logs: `/tmp/pap298-owned-startup-host-gate.log` and `/tmp/pap298-owned-startup-builder-gate.log`. The precise earlier failed predicate remains unproven; these results do not retroactively relabel that failed run.

Completions generation produced no changes. C2's committed-host-drift mechanics regression reproduced revalidation after valid publication. C3's actual parent-history regression reproduced `[ok, ok, ok]` instead of `[ok, ok, error]`. Their corrections passed 25 focused, four real-Pi, five native/public-route and five namespace-boundary cases. The initial C3 driver omitted `message_start`; that reported setup failure was corrected before reaching the intended baseline.

A further targeted review confirmed the C2/C3 mechanisms but found mutable public aliases into the private committed cache and lost legitimate nested usage. Both were reproduced. The current publisher keeps its committed snapshot private and clones/correlates outgoing projections; nested status finalization remains after publication while incurred usage retains upstream's pre-publication accounting. Current typecheck/build and focused checks pass 26/26, the publication suite passes 12/12, and real-Pi transport/history/usage/same-identity-mutation cases pass 4/4, zero skips. The rebuilt code also passed four real-Pi plus five native/public-route cases and five namespace-boundary cases, all with zero skips. The staged secrets scan passed. These are recorded dirty-source build/test artifacts, not a clean release or installed qualification; final report-only updates were not rebuilt. No final corrected-source approval is claimed. Logs use `/tmp/pap298-private-cache-usage-*`.

Genuine producer drift/duplicate-loader and every-shutdown actual-transport coverage remain open. CR-2's external boundary and full source acceptance remain open, not waived by aggregate counts. The later operator instruction separately authorizes checkpoint PR/merge after review and green CI, with these gaps explicitly recorded on PAP-298. Four optional AXI/quota/browser installed-fixture cases, installed/default selection, real-provider qualification and human acceptance remain separate and unclaimed.

Explicit config-first paired verification and `test:paired` subsequently passed against pinned `504a8dcc333fec6169b4b0242718bcbc3773ccff`, fetched only in the disposable clone: 10/10 teams, 53/53 modes, no invalid pairs; 45 gate tests, 2,275 core tests and 110 OpenCode tests passed with zero skips. This predates C2/C3 corrections and is not their final-source evidence.

The temporary AgentKit exception has been removed and default exclusions restored. Raw reviewer sessions are retained privately outside Git. Both disposable pinned clones were removed only after exact SHA, clean status and absence of ignored/untracked data were verified. No active companion checkout or ref was changed.

This session's first normal selected SDK read was blocked by AgentKit's node_modules exclusion, separately from the managed PPA bug. The suggested global ignore file did not exist. With Sinh's permission a temporary file preserved all built-in exclusions and narrowly allowed only the exact selected Pi README/docs/examples; it has now been removed. A Bash command testing forbidden negative path strings was itself blocked before execution; it is not a failed product test. Normal README read succeeded afterward. No hook source was changed. A later cleanup/status command was blocked before execution because a printed heading resembled an excluded build path; correcting that heading required no policy exception or denied-file access.

## Verification policy

Use exact current-revision evidence. Unit fixtures do not establish production authority or installed success. Keep source, independent review, CI, installed and human acceptance separate. Do not turn timeouts/skips into passes. Back up before any live database schema/data mutation; use disposable test stores for regressions. No live data mutation is planned.
