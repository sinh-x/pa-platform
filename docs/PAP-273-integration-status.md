# PAP-273 develop integration checkpoint

Sinh explicitly requested PR integration into `develop` after the `.4` installed
check in deployment `d-cdfdc6`. This is source integration authorization, not
retroactive passing qualification, ticket acceptance or production adoption.
Existing PR #164 is reused; historical failures and signed evidence are retained.

## Candidate identity and version

The labelled `.4` source is commit
`2f2deccfea37364dadc36be1e497db3f94efbbcb` on
`feature/PAP-273-workflow-startup-compatibility`. For integration, the same four
root/core/Pi/OpenCode manifests restore plain `0.1.154`, matching `develop` at
`b09366977463d607264bc3b2ed9ccc55283554cf`. The existing CI-success-triggered
patch-bump owner remains responsible for the next plain patch version. No manual
release/tag or lockfile/Nix dependency-hash change is made. Installed trial `.4`
and its original source commit remain distinct from this integration candidate.

## Results retained, not grandfathered

- `.4` local typecheck/build/completions/secret scan passed; mandatory native
  source entry: 519 passed, zero failures/skips/cancellations. All 109 exact
  source-owner anchors and 41 installed inventory groups remain required.
- Full workspace did **not** complete: the first attempt exposed an OpenCode
  test-sentinel collision with a timestamp, corrected without weakening the
  sensitive-input check. The rerun timed out at 1800 seconds during Pi after
  passing root scripts/core/OpenCode/Pi-script lanes. An additional Pi tail
  attempt timed out at 300 seconds without a completed case. Neither is a pass;
  see `PAP-273-r006-setup-repair-handoff.md` for lane details and original logs.
- PATH selected `.4` at
  `/nix/store/90vqi2bq93jy86nwqxq5zflsx2c9rvnb-pa-platform-0.1.154-pap273.4`.
  Installed template list and workflow list/preflight/status exited 0 against
  selected config `b2b25a15a55d21c0a017179745df2a23d14e6be3`. Retained PAP-273
  resources still use their own pinned config; no approval/publication replay.
- Installed provenance still reports `sourceSha=unversioned-dirty-source`.
  The exact supported installed verifier exited 1 with
  `WORKFLOW_INSTALLED_CANDIDATE_MISMATCH`: **0 passed, all 41 groups not run**.
  The version string is not exact source provenance; no identity guard is waived.
- Missing project command registration remains a real execution prerequisite,
  not a safe requirements-discovery/drafting/approved-queue startup blocker.

## Remaining owner gates

Hosted results must name the actual PR candidate; prior green PR runs cannot
certify newly pushed commits. Portable CI does not certify the mandatory local
native/installed lane. Source integration does not make the full approved
matrix, exact-Git installed 41-group qualification, fresh foreground setup on
`pa-platform-config` and `money-seasons`, genuine human UAT, independent review,
paired adoption or affected-ticket continuation complete.

Do not close these gaps by editing store/provenance bytes, widening registry
bounds, fabricating historical launch evidence, dropping native cases or
replaying valid approvals. PAP-271/PAPC-072 stay done; PAPC-073 and affected
application-ticket owners retain their evidence and first-unproven actions.
No automatic ticket completion, credential/setup action, device operation,
checkout return or live workflow launch follows from PR integration.
