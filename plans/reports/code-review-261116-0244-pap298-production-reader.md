# PAP-298 independent source review

The first review's two medium defects were reproduced and corrected. The corrected-source review found three additional medium issues and mandatory coverage gaps. Full source acceptance remains blocked by CR-2 and coverage gaps. After keeping external runtimes unchanged, Sinh later authorized merging only the default-off source checkpoint with those gaps recorded on PAP-298.

## Review provenance

- Review mode: read-only fresh Pi session, `openai-codex/gpt-6.1-sol`, high reasoning; only `read`, `grep`, `find` and `ls` tools. Same model family as implementation, not different-family arbitration or human acceptance.
- Candidate: staged diff SHA-256 `b704b9c9e44b2c70f734d3bd1509175d781884b3758e3d2b2f3a25dce41bfa41`, based on `21530bc1912ea342b8cdbb679514b397c71d8f67`.
- The reviewer read the full diff, owning instructions, continuation requirements, changed implementation, supporting acquisition/security code and relevant pinned upstream dispatch/publication code. It ran no checks and did not independently reproduce parent-reported tests.
- The harness `Agent` tool had no available reviewer roles. The fallback CLI's version, active model and read-only authentication readiness were verified before dispatch. The read-only process completed with exit 0 within its 12-minute external budget.
- Private capture: `/tmp/pap298-independent-review.jsonl`; immutable review input: `/tmp/pap298-review-source.diff`. Raw thinking/authentication material is not reproduced here.

## Findings and verified corrections

### R1 — Medium: successful publication dropped structured read results

Original location: `packages/pi-pa/src/pi-extension/read-publication.ts:88–103` in the reviewed snapshot.

Publication retained only content/details/error fields and removed `structuredContent`. Real Pi codemode consumes the nested reader's structured image object, so a valid ordinary image became a textual note instead of its expected image value.

The new actual patched-Pi nested image regression failed with `undefined` instead of `image`, in `/tmp/pap298-review-r1-baseline.log`.

Correction: preserve and clone the checked native structured result at commit. Withholding still removes it. Do not add a structured field to session messages that originally lacked one. The actual nested/image and parallel/sequential model-continuation/persistence suite now passes 3/3, zero skips: `/tmp/pap298-review-r1-r2-actual-runtime.log`.

### R2 — Medium: committed history retained full acquired source buffers

Original locations: `read-publication.ts:48–49,93–94,120–127` in the reviewed snapshot.

Content-keyed correlation retained the pending record while session history retained the content array. The pending record retained all closed source objects and their complete buffers, even when only a small page was published.

An always-executed isolated `--expose-gc` regression confirmed the source remained reachable after closure: `/tmp/pap298-review-r2-baseline.log`.

Correction: remove the unused original-result reference and empty the acquisition collection when attempting closure. Reject late acquisition after release/revocation. Keep only checked committed presentation/correlation data. Focused publication/resume checks now pass 14/14, zero skips, including collection while late committed output remains valid: `/tmp/pap298-review-r1-r2-focused.log`.

## Follow-up evidence

The full normal-umask rerun with pinned disposable config completed: typecheck and build passed; workspace tests reported 3,983 passes, zero failures and five explicit optional installed-fixture skips. All 14 previously skipped external-config cases executed. The actual PPA22/Pi24 native-addon case was separately enabled and passed 1/1, zero skips. Four pinned AXI/quota/browser installed cases remain unexecuted, not passing evidence. Completions generated no changes, and staged secrets scanning passed.

Public foreground/PTY, same-build resume, actual background runtime/native-parent/supervisor identity and termination, finite provider credential forwarding, examples, and changed-build/downgrade/legacy rejection now pass through the exact production packager. The latest source's actual-host app passed four real-Pi publication/startup cases plus five native/public-route cases; the mapped-UID builder boundary passed five cases. All those focused cases ran with zero skips. Logs: `/tmp/pap298-owned-startup-host-gate.log`, `/tmp/pap298-owned-startup-builder-gate.log`, `/tmp/pap298-workspace-normal.log`, `/tmp/pap298-dual-host-required.log` and `/tmp/pap298-corrected-source-guard.log` (24/24).

An earlier background attempt failed its binding before any model request. Its original metadata records completed/failed and both owned process fingerprints were subsequently absent. Original evidence is preserved at `/tmp/selected-pi-dispatch-LA0n9R`. A second read-only fresh-session diagnosis verified the factory failure boundary but found no justified unconditional custody correction. The precise failed predicate remains unproven. Both an unchanged-build stability control and a diagnostic-labelled build subsequently passed 5/5. No custody predicate was relaxed, and the failed attempt is not retroactively a pass.

Startup handling now adds finite privately branded assertion causes, revalidates after imports, unwinds created lifecycles, and returns owned fatal startup to the existing bounded PPA diagnostic. It no longer suggests bypassing the mandatory extension. The previous runtime reproduces this ownership defect: the new isolated startup case fails while the other three actual-Pi cases pass. The corrected runtime passes all four; its SDK error retains original diagnostics privately without displaying their canary. This negative mechanics case supplies no reader, source acquisition, producer binding or permission.

### Touched failure-message evidence

Affected categories are selected-host startup/runtime failures and retained-host compatibility blockers. Existing read result codes, stream routing and process exit contracts remain unchanged; no new command or grant is introduced.

Before the startup correction, the actual error was followed by `Hint: Start without extensions using "pi -ne".` That is not permitted recovery for the mandatory guarded reader. Afterward, the selected host owns a bounded failure headed `Pi runtime unavailable through the selected host.` Its Condition, Source, Reason, Correction and Resume action identify the current guard/setup uncertainty and direct inspection of the existing operation/build rather than another coding approval or alternate reader. Assertion causes come only from an internal weak-map brand; arbitrary error prose is not copied into the diagnostic.

For retained sessions, the previous integration could silently change hosts. The new blocker explains that the retained Pi session cannot resume through the selected host and requires inspection of the original session/build, without allocating a replacement. Matching same-build evidence is not rewritten. Source tests exercise binding, permissions, symlinks/hard links, absence, downgrade and pre-allocation rejection. Agent readability review, structural/focused checks, full software checks, CI, installed verification and human acceptance remain different evidence.

## Corrected-source review and operator decision

A second full read-only fresh-session review completed with exit 0 against diff SHA-256 `07650ddae02624ccf34a5b4e1f41d8accb735e79de0f2457caa67981c4c73827`. It used the same model family and executed no checks. Private capture: `/tmp/pap298-corrected-source-review.jsonl`.

Its verdict is **changes required**:

- **C1, medium:** default external-Pi reads have no actual final-publication fence. Registered-Promise checks do not cover later awaited runtime transforms. CR-2 is therefore incomplete on that route.
- **C2, medium:** the selected bootstrap validates the current host before consulting committed-result correlation, so later host drift can incorrectly replace valid previously published content.
- **C3, medium:** the nested recorder finalizes success before the awaited publication event; updating the returned outcome afterward leaves persisted nested-call status incorrectly successful.

Required actual-runtime coverage still does not establish every shutdown reason, genuine producer host drift or duplicate-loader denial. Hosted CI is also outstanding. Passing aggregate counts above do not close these findings or gaps.

Sinh selected: **keep external runtimes unchanged; leave CR-2/source completion blocked; do not merge yet**. This is a compatibility decision, not another approval of unchanged coding work. Correct C2/C3 within the existing implementation authority; do not silently patch/switch the external runtime, narrow the accepted contract or publish completion. Installation, human acceptance and downstream history remain unchanged.

## Targeted C2/C3 follow-up

C2 was reproduced by the selected publisher's pre-check running again after valid commitment (`2` checks instead of `1`). The producer now delegates to one private publisher. It checks the current host before first commitment and after closure, but consults authenticated committed correlation before requiring current host validity. Invalid host evidence still revokes pending owners; unowned content cannot inherit a cached result. The publication suite passed 11/11. C3's actual parent-history baseline produced `[ok, ok, ok]`; moving record finalization after emission corrects status. The C2/C3 source subsequently passed typecheck/build, 25 focused cases, four real-Pi and five native/public-route cases, and five builder-boundary cases, zero skips. Those runs predate the next corrections.

A targeted fresh read-only same-family review completed with exit 0 (`/tmp/pap298-c2-c3-delta-review.jsonl`). It confirmed those mechanisms but found two further issues:

- **Delta P1:** public content/details/structured references aliased the private committed snapshot. An in-place late mutation could therefore add unchecked content to later output while retaining correlation. The new regression reproduced the unchecked canary in the later message. Correction: keep the committed snapshot private, clone each outgoing projection and correlate the outgoing identity, never expose private snapshot references.
- **Delta P2:** moving usage accounting after projection lost legitimate nested-read usage, because read publication deliberately drops that field from its result projection. The actual runtime regression reproduced absent parent usage. Correction: retain upstream's pre-publication accounting of incurred usage and move only status/error finalization after publication. No new read result field or grant is introduced.

The updated unit suite passes 12/12. Real-Pi coverage now also injects a same-identity mutation in an awaited message-end callback and checks public/persisted output, plus exact synthetic parent usage. The rebuilt correction code passes typecheck/build, 26 focused cases, four real-Pi transport cases, five native/public-route cases and five namespace-boundary cases, zero skips. The staged secrets scan passes. Logs: `/tmp/pap298-private-cache-usage-{focused,actual-runtime,host,boundary}.log` and `/tmp/pap298-final-blocked-source-secrets.log`. These are recorded dirty-source artifacts, not a clean release/install; final report-only edits were not rebuilt. No final independent review of the last alias/usage corrections or new full-workspace rerun is claimed. Neither the earlier targeted review nor mechanics fixtures establish genuine producer drift/duplicate-loader qualification or whole-source approval.

C1 remains intentionally unresolved under Sinh's compatibility decision. The later checkpoint authorization below permits integration after review and green CI, but not full source/requirements completion.

## Authorized checkpoint integration

After receiving the CR-2 explanation, Sinh explicitly requested a PR merged into `develop` with the gaps noted on PAP-298, followed by switching the canonical local repository to `develop`. This supersedes the earlier no-merge stop for checkpoint integration only. It does not close C1/CR-2, remove coverage requirements, authorize installation/default runtime switching or establish human/downstream acceptance. Keep PAP-298's status and requirements open; append the eventual PR, commit and evidence/gaps note rather than claiming completion. Review the final alias/usage corrections and require green hosted CI for this checkpoint before merging.

## Committed checkpoint review and accounting corrections

Fresh read-only review of `d3929db946418b821ee51f83617999f47d144cb0` completed with exit 0. It identified two P2 regressions: an event-only `tool_result` error override could become success, and top-level usage was removed before sequential/parallel message accounting. It otherwise found the private-cache cloning, host-check ordering, structured results and buffer release consistent with their stated contracts. This is same-family source inspection, not independent test execution or full acceptance.

Both defects were reproduced. The publication unit baseline failed its new `error-override` case; the actual-runtime baseline failed usage accounting in both execution modes (2/4 passed). Correction: first commitment preserves the end event's typed error flag as well as the result flag. The pinned agent loop privately retains the existing incurred read-usage field before public projection, then consumes it for message accounting without forwarding other result fields. Nested accounting remains unchanged.

Corrected publication tests pass 13/13 and actual-runtime tests pass 4/4, zero skips, including error-only hooks, usage for successful/withheld sources in both execution modes, cached alias mutation and nested history/usage. Logs: `/tmp/pap298-event-error-{baseline,corrected}.log`, `/tmp/pap298-top-usage-error-baseline.log`, `/tmp/pap298-top-accounting-corrected-runtime.log`. Further committed-code review and current hosted CI are required before checkpoint merge; known accepted requirement/qualification gaps remain open.

## Remaining review gate

The reviewer retained G1 as a blocking evidence gap, not a demonstrated code defect: exact-candidate foreground/PTY, background, retained/resume, lifetime and all repository/CI gates must finish before source completion. Earlier builds predate corrections and are not final-candidate qualification. Review the corrected source and test/packaging deltas before landing.

The first full workspace attempt failed three existing permission fixtures under the runner's accidental `umask 077` and skipped 14 external-config cases. The unchanged failures pass under `umask 022` in `/tmp/pap298-core-normal-umask-control.log`; the full rerun described above used detached disposable config at pinned `504a8dcc333fec6169b4b0242718bcbc3773ccff`. No active external configuration or ref changed.

The first Nix production check passed actual publication tests but rejected positive host custody inside the daemon's user namespace. Observation established root/store/input ownership mapped to UID 65534. The same built native cases passed 5/5 outside the builder, including real public foreground and same-build resume after test setup/rendering corrections. Production UID checks are unchanged. Nix separates publication/namespace-boundary checks from the explicit actual-host verification app; both exact-source lanes now pass as recorded above. Corrected-source independent review and hosted CI are still pending.

Installation/default switching, real provider/human acceptance, PAP-312 qualification and ticket closure remain separate and unclaimed. Remove the temporary development documentation exception before wrap-up.
