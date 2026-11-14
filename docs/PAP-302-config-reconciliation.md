# PAP-302 — updated config source reconciliation

## Outcome and scope

At Sinh's request after the full-check report, reconcile source compatibility with
merged PAPC develop `504a8dcc333fec6169b4b0242718bcbc3773ccff` (PAPC-087 PR59).
This is a disabled/source-only integration prerequisite, NOT r003 C0 agreement,
installed qualification, completed automation, adoption or activation.

The previous clean trial is retained in Git at
`b28026a35c80ee260477a9406c73a95aba1dcc53`, label `0.1.166-pap302.2`.
The installed `2fc76130...` package is not rebuilt/relabelled by these edits and
must not inherit this new source pin or test evidence.

## Actual repair

The ten external-config failures were stale split-builder assertions applied to
the existing direct-only config. No PAPC team/instruction bytes were changed:

- Keep every original split-profile assertion intact.
- Select direct-only assertions only for exact default `orchestrator`, an actual
  ticket-required orchestrator and no `implement` mode. Mixed/unknown profiles
  refuse; no catch-all fallback.
- Assert direct identity, protected branch action/persistence, one holder/four
  checkouts, legacy uncertainty hold, direct repair/all checks/independent review,
  current report schema/phase evidence and exact CI/UAT tuple boundaries.
- Offline negatives remove each required direct clause and reject implementation
  fallback, skipped review, unknown-check success and counter resets. These are
  instruction source assertions, not enforcement or actual human review.
- Check the configured execution provider/model for the selected split/direct
  profile; do not change models or restore the retired implement selector.

The existing direct pairing validator expected52modes; PAPC-086 had added one
reserved `requirements/auto-draft` mode. Accept53 ONLY when the selected committed
bytes contain its exact closed **disabled** `pa-auto-pair/v1` contract, exact
three resources and bounded native-only mode with no agents/skills/global docs
or extra defined profile fields. Enabled/unknown/duplicate/extra contract keys,
missing resource, unknown/extra mode, inherited skills or wrong objective fail.
The52-mode direct and59-mode retained fixtures remain strict and unchanged.
No model/native effect grant follows from a mode count.

After successful exact candidate preflight, update `.pa-platform-config.sha`
from `1c4994670088e5ac33e53e31065781d1fc2b0dc3` to merged config504a8dc.
A clean detached disposable source fixture is used at
`/tmp/pap302-papc-reconcile-53xaf6/config`; canonical develop and its unrelated
`sample.html` are untouched. No alternate checkout supplies live source custody.

## Messages and check evidence

Affected developer CLI: `scripts/dev/validate_paired_repository.mts`, source
compatibility information/failure (not an available PPA effect).
Before: `Expected 52 active modes, found 53` for the legitimate disabled source.
After: `MODES_VALID=53/53`, `REQUIREMENTS_READ_ONLY=7/7` and
`AUTO_DRAFT_SOURCE=disabled-v1-native-only-not-r003-pairing`.
Exact-SHA/clean/config-first ancestry, model/reference/admission, workflow and
existing enabled/missing/unsupported contract refusals remain mandatory. No
JSON schema, runtime exit/stream contract, caller grant or formatter probe added.
Plain-output agent review is separate from human UAT.

| Check | Actual result / `/tmp/` log |
| --- | --- |
| Config-facing core suites plus new direct contract negatives |189/189, zero skips/failures; `pap302-reconcile-contracts-first.log` |
| Paired gate suite including nine new native-source cases |45/45, zero skips/failures; `pap302-reconcile-pair-tests-final.log` |
| Actual `verify:paired-config -- --require-origin-develop` | Exit0 at exact504a8dc:10teams,53modes,4builder-exclusive,7requirements-read-only,42other; `pap302-reconcile-pair-cli.log` |
| Workspace typecheck/build | Both exit0; `pap302-reconcile-typecheck-first.log`, `pap302-reconcile-build.log` |

Retain initial failed preflight52/53 and initial44/45 run. The latter incorrectly
counted parser-created undefined DTO properties as configured fields; correction
ignores ONLY undefined values, still rejecting any extra defined field. No
producer/parser/permission assertion was weakened. Logs:
`pap302-reconcile-pair-preflight*.log`, `pap302-reconcile-pair-tests-first.log`.
Staged secrets/whitespace and later complete Pi/shard results are reported with
phase commits. Prior full-suite timeouts and installed smoke-driver mistakes
remain at `/tmp/pap302-full-*`; none is silently converted into a pass.

## Completed full regression accounting after reconciliation

Source candidate `db774342252e757a5470fb50d6554ab6238ab85b`:

- Complete core suite with the exact updated config: **2123/2123**, zero skips,
  failures or cancellations; `/tmp/pap302-reconcile-core-full.log` (487seconds).
- Full Pi script suite: **11/11**, no skips/failures;
  `/tmp/pap302-reconcile-pi-script-tests.log`.
- ALL **77 Pi source test files** appear exactly once in four disjoint file
  shards (1/26/25/25). No test-name filters or manual/native-file exclusions.
  Manifest `/tmp/pap302-reconcile-pi-shards.json`; summary
  `/tmp/pap302-reconcile-pi-summary.json`; logs `pap302-reconcile-pi-shard{0..3}.log`
  with separate exit files. All exit0, zero failures/cancellations. Totals:
  **1533tests,1528passed,5owning external-fixture skips**. Shards separately
  report191/191,457pass/2skip,485pass/3skip,395/395.
- The deployment file completes191asserted tests (89top-level) in724seconds.
  Slowest shard completes in834seconds. The original900-second workspace/full-Pi
  attempts remain incomplete history, not regressions erased by a new pass.
  A diagnostic filtered single contention case passed in54seconds; it is NOT
  counted as complete coverage and no body was omitted from final shards.
- One skipped installed dual-host case was subsequently exercised using the
  ACTUAL installed2fc76130... output: full characterization entry **10/10**,
  `/tmp/pap302-reconcile-installed-dual-host.log`. This overlaps the shard and
  is not ten new disjoint tests. It resolves that optional case only; four AXI/
  quota/MCP pinned-fixture cases remain deferred. No installed Git/config
  provenance or new-source package qualification is inferred.
- Updated-config OPA **108/108**, runtime-host **1/1**, no skips/failures;
  `pap302-reconcile-opa-full.log`, `pap302-reconcile-runtime-host.log`.
- Restore default editor bundle selection after Pi's prescribed both-enabled
  source test stage; `pap302-reconcile-pi-default-restore.log`.

These complete source/file-shard results supersede the previously unfinished
source regression dimension, not independent safety review, hosted results at
an integration SHA, exact installed resource identity or native-human/product
UAT. All original failure/timeout evidence remains. No performance threshold,
assertion, authority/cleanup boundary or runtime implementation changed to
obtain the completed matrix. There is no claim of comprehensive escaped-child
cleanup from a fixture's successful return.

## Operator-authorized source integration candidate

After reconciliation and completed regression accounting, Sinh explicitly asked
to proceed with PR/merge and update the config reference. A fresh
`feature/PAP-302-r003-source-integration` branch preserves the retained feature
and its divergent old remote history; no force-push/rebase is required. Restore
plain **0.1.166** across four shared manifests; runtime-host remains0.1.88, no
changelog/tag/release or dependency/lock/hash change. Pin remains merged504a8dc.

This candidate requests normal GitHub CI and squash integration of **partial,
default-off source**, not a PAP-302 completion/activation claim. Do not close
PAP-302 or import source tests as human policy/UAT/custody evidence. Review and
hosted checks must refer to the final candidate; no admin/quality-gate bypass.
The readable source version change does not alter installed `.2`, package
provenance, current controls or old receipts. No external PAPC selector/design
null field or historical released counterpart pin is rewritten.

## Installed provenance and remaining product gates

Read the owning source, not the previously denied installed metadata bytes.
`local-source-file.ts` keeps ordinary single-link descriptor-pinned ingress;
its private selected-Pi multi-link exception is confined to selected Pi text
documents. It is NOT an exception for arbitrary app provenance/artifact files.
`auto-policy.ts` independently uses the strict native artifact reader for actual
installed identity. No permission/owner/classification cause for the harness
read denial was proven from this source inspection. Do not infer file contents,
repair a global reader, copy/alias/import the denied provenance, broaden the Pi
exception, or substitute Nix derivation reconstruction for the withheld file.
Security/runtime owner must establish supported permitted access. Exact current
installed source/config provenance remains UNVERIFIED; no host/security change
or reinstall was performed.

Production `effect-owner-bridge`/`continueSelected`, bulletin/no-guidance policy,
safe package reuse, quarantine/final/new periodic effects and actual C0/profile/
path/check/resource agreement are unchanged and unfinished. The config pin now
identifies compatible disabled preparation, not a selected r003 pair. Independent
review, complete runtime regression, installed/native/provider/both-project/
desktop/human qualification and separate owner activation remain distinct gates.
No push/PR/merge, worker, human receipt, ticket-done or checkout return occurs in
this phase.
