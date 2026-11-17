# PAP-316 installed acceptance verification

## Verdict

**The installed version is `0.1.173-pap316.1`, but it cannot be signed off as meeting all PAP-316 acceptance criteria.** Twelve bounded installed CLI/HTTP assertions passed. The normal selected PAPC native handoff route is still unselected, exact installed source provenance could not be read under the current host policy, and complete foreground/client/effect/browser/CI/human qualification remains open.

This is an agent-authored verification report, not a native approval, workflow adoption or human UAT result. Latest ticket policy controls: deliberately local-unverified confirmation and one HTML entry linking every complete member/raw source/manifest. Superseded authenticated-human/all-members-inline requirements are not being reintroduced. Builder changes remain deferred by Sinh; requirements publication/ref/link/queue are still requirements-side qualification obligations and were not performed against live state here.

## Exact observations

- Checked on 2026-11-18, Asia/Saigon, from `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`.
- Worktree source/label candidate before these verification artifacts: `e3552853dbbc89c94053eab51ee2835fed546238`, branch `feature/PAP-316-approval-handoff`.
- PATH entry: `/home/sinh/.nix-profile/bin/ppa`.
- Observed physical executable: `/nix/store/56ci9913pix322chply13i8ypwyw38ll-pa-platform-0.1.173-pap316.1/bin/ppa`.
- Actual `ppa --version`: `ppa 0.1.173-pap316.1`, unchanged before/after the installed checks.
- Installed `ppa template list --format json` selected root: `/home/sinh/git-repos/sinh-x/tools/pa-platform-config`; revision `3ed0496880ee7c968ee90c40df94944b13e72f9f`; registry SHA-256 `86c78a59faf6b2130ef8a73c44112c94b584706d36ca54007a540d0c2d14b7d5`. This is native selection metadata, not readiness or effect authority.
- That configuration checkout remained clean. Its `teams/analyst.yaml` declares three modes but intentionally omits `document_profile` and `capability_policy`. Its requirements/analyze policy selects `document.package` but omits **both `document.handoff` and `document.local-review`**. Team discovery/phone visibility does not supply these capabilities.
- Installed `ppa deploy analyst --validate` returned 0 and validated three modes. This is structural configuration validation, **not native launch admission**.
- An isolated installed `ppa deploy analyst --mode analyze --dry-run` returned 1 with **`CAPABILITY_PROFILE`**, before deployment artifact allocation. This is correct fail-closed behavior and a concrete positive-journey blocker, not a successful handoff.

### Provenance boundary

The ordinary read of the installed `share/pa-platform/review-runtime-provenance.json` was denied with `LOCAL_SOURCE_UNSUPPORTED_FILE`. File metadata shows a regular, read-only file with three links. The current local-read policy does not admit that multi-link metadata through this ordinary surface.

No alternative reader, copy, hardlink removal, permission change or policy exception was used to recover its content. Therefore the installed `sourceSha`, build/config pins and module-byte identity were **not established**. The readable version and store path do not prove that the artifact was built from the clean `e355285...` commit. Resolving this observation requires a supported provenance surface or authorized security/runtime-owner correction, not another approval or a fabricated hash.

## Installed checks actually executed

Reproducible bounded harness:

```sh
TZ=Asia/Saigon LANG=en_US.UTF-8 python3 \
  plans/261118-0613-pap316-installed-verification/verify-installed-surface.py
```

The final run exited **0**: **12 assertions passed**, plus one separate selected-configuration observation. Its status explicitly says surface-only, `fullAcceptanceEstablished=false` and `humanUat=not-performed`.

| Installed observation | Actual result |
| --- | --- |
| CLI readable version | Exact expected trial label; executable unchanged across checks |
| Caller-supplied actor on review request | Exit 1, `DOCUMENT_INPUT` |
| Duplicate action key | Exit 1, `DOCUMENT_INPUT` |
| Unsupported publication action through local-review grammar | Exit 1, `DOCUMENT_INPUT` |
| Omitted Analyst native selection | Exit 1, `CAPABILITY_PROFILE`; no deployment artifacts |
| General-server opt-in with nonloopback bind and force | Exit 1 before PID/data effects |
| Dedicated HTTP listener health | `pa-local-review/v1`, `local-unverified` |
| Dedicated listener with `Origin: null` | HTTP 403, `LOCAL_REVIEW_ORIGIN`, no CORS header |
| Dedicated listener invalid request | HTTP 400, `DOCUMENT_INPUT` |
| Real general CLI server with `--local-review --cors`, then `Origin: null` | HTTP 403, `LOCAL_REVIEW_ORIGIN`, no CORS header |
| Real general-server invalid request | HTTP 400, `DOCUMENT_INPUT` |
| General-server credential header | HTTP 400, `LOCAL_REVIEW_HEADERS` |

Both listeners were started through the installed `ppa` executable, not injected transport handlers or source modules. All stateful checks used fresh `/tmp` ai-usage/data/registry paths; no live ticket, native review subject, final decision, publication, branch/link, queue, provider or implementation process was requested. Servers were stopped and reaped after observation.

The actual general CLI enables registry watchers. Its fixture used a registry inside the ai-usage sandbox, backed up the empty database **before** native schema setup, then verified rejected review requests preserved the initialized schema and zero registry events without creating handoff-review tables. These are disposable database effects, not evidence that a real handoff occurred. Other rejected-input paths created no database.

### Evidence and preserved unsuccessful attempts

- Final summary: `/tmp/pap316-installed-surface-final.json`; final stderr: `/tmp/pap316-installed-surface-final.stderr`.
- Detailed final evidence: `/tmp/pap316-installed-surface-0v30qdj6/observations.json`, per-command stdout/stderr, listener logs and `general/before-server.db`.
- First attempt: `/tmp/pap316-installed-surface-run.json` and `.stderr`. A harness function name shadowed the Python HTTP module; this was a verification-code error, **not a product failure**. Fixed before rerun; the original evidence remains.
- Second attempt: `/tmp/pap316-installed-surface-rerun.json` and `.stderr`. The general server refused the fixture's registry outside its ai-usage sandbox. That was an incompatible fixture layout, not evidence that the normal server route failed. The final fixture moved its registry inside its own sandbox without relaxing any runtime guard and accounted for legitimate startup schema initialization.
- Failed attempts are not counted as passed checks. No old PAP-283/v1 qualifier, synthetic approval or source test was substituted for PAP-316 installed acceptance.

## Per-AC assessment

“Partial” and “blocked” are not passes. Prior source evidence remains historical source evidence, even when broad regressions were green.

| AC | Installed verdict | Evidence and remaining requirement |
| --- | --- | --- |
| AC-01: truthful early preflight, typed causes and continuation | **Partial** | Actual omitted Analyst selection rejects before deployment artifacts; strict CLI/transport blockers are present. Full supported-route source/delivery/owner diagnostics and original resume coordinates are not exercised. |
| AC-02: own-deployment exact bytes and negative source controls | **Not installed-qualified** | Prior source suite covered own-deployment intake and safety. No genuine selected installed read-only session authored/froze/reviewed/published exact bytes here. |
| AC-03: supplied-ticket association, main fields and full CAS/link journey | **Blocked/unperformed** | The intended native route is unselected. No installed supplied-ticket journey or historical-association reconciliation and attributed physical-link readback was performed. |
| AC-04: one decision across media, races/disconnect/reply loss | **Partial** | Actual CLI and both actual HTTP transports reject unsafe input and preserve local-unverified disclosure. No original pending foreground review was issued/decided here; prompt counts, cross-medium canonical convergence and reply-loss outcomes remain unqualified on the installed pair. |
| AC-05: complete publication, physical ref/link, queue and recovery | **Not installed-qualified** | Prior finite-owner source tests are not installed proof. No installed publication/primary promotion, actual pinned feature ref/full attributed link, queue or fault/revocation/reply-loss recovery was exercised. |
| AC-06: separate approval/effect/readiness/launch/UAT states | **Partial** | Actual help discloses no authentication and no runner/effect authority; invalid effect imports reject. Complete installed status/effect/eligibility and mutable worktree-owner readback remain unobserved. No implementation was launched. |
| AC-07: selected trust/reader/mapping contract under latest policy | **Blocked/incomplete** | Local-unverified disclosure is observed. The current Analyst profile/resource/capability selection is absent; no actual complete reader/browser or native public/effective mapping journey is qualified. Historical evidence was not changed. |
| AC-08: intended-cause red before fixes, focused green and affected regressions | **Source-process evidence exists** | The committed implementation history and prior report preserve behavioral reds, repairs, 4,265 source passes/20 skips and independent source review. This does not establish the unavailable exact installed source binding or convert skipped/installed/human checks into passes. No runtime behavior was changed in this verification task. |
| AC-09: exact installed pair/default entry, real clients, CI/accessibility/Sinh UAT | **Not met for sign-off** | Readable installed version and selected PAPC revision are observed, but exact build provenance is unavailable, native selection is blocked, real supplied-ticket/ticketless foreground and forwarding journeys are unperformed, and hosted CI/browser/accessibility/Sinh UAT/adoption remain open. |

## Required next owners/actions

1. **PAPC and runtime selection owners:** prepare a separately authorized compatible native Analyst profile/capability/resource closure, including the previously disclosed transitive missing-resource issue. Preserve existing sessions and protected review/Builder history. Do not patch environment aliases, copy artifacts to legacy roots, or widen running sessions.
2. **Security/runtime provenance owner:** provide a supported exact installed provenance observation so the actual build/module/config identity can be checked without bypassing the denied multi-link file policy.
3. **Qualification operator:** after those prerequisites, run supervised supplied-ticket and ticketless normal Pi journeys, original CLI/API issuance while Pi waits, real forwarding/general-server parity, exact publication/physical ref/full link/queue and negative/partial/recovery cases. Use isolated authorized test resources; queue is not an implementation launch.
4. **CI/browser/accessibility owners and Sinh:** separately evidence hosted CI, actual complete-reader usability/accessibility and genuine UAT, then obtain the distinct future-start adoption decision if requested.

This verification did not install, activate or change configuration, approve an exact package, update live tickets, migrate protected owners, alter source safety policy or change Builder admission. It does **not** close PAP-316 or assert all ACs pass.

## Unresolved questions

- Which separately authorized PAPC native candidate/resource closure should be paired for full installed qualification?
- Which supported security/runtime surface will establish exact provenance for this installed Nix artifact?
