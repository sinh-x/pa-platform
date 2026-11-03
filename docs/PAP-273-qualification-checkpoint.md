# PAP-273 qualification checkpoint

This records separate results, not ticket completion, independent review, human
approval/UAT, installation/activation or permission to resume affected applications.
Source phases are committed separately; Draft PR: https://github.com/sinh-x/pa-platform/pull/164.

## Exact tested runtime candidate

- Git candidate: `78ae3b0c3c6edfb50a5b2906ea5fe386d8a22b2e`.
- Immutable package: `/nix/store/w32xfg9va28khim34cy9if1dnk1pqnbl-pa-platform-0.1.154`.
- Derivation: `/nix/store/056r4yx3p951wb3bzgsmj8fklriayzvl-pa-platform-0.1.154.drv`.
- Actual package provenance names that exact source SHA, not dirty/unversioned source.
- Package build config pin: `d4855185cecc3cb26af5d3ceec2133bc0297455f`.
- Actual selected committed config: `c614cfd385a03a2b0f6b5697046e374a2ca1811e`.
- Actual selected registry: `86c78a59faf6b2130ef8a73c44112c94b584706d36ca54007a540d0c2d14b7d5`.
- Selected manifest: `9defa865b1357d0343b2b29a3fb76738fd7b0729efa2fd2da793d7d9b2c96da2`.

The exact package's real template list and workflow preflight succeeded. The latter
reports static-compatible, projectProfile=missing, a separate execution prerequisite
and executionAdmitted=false. Actual selected requirements/analyze is enabled;
successful observation confers no admission, publication or execution grant.

## Strict immutable-package qualification: passed, bounded meaning

The unmodified public verifier ran against the exact immutable package in a child
PATH selection and clean disposable exact-candidate clone with the matching
no-editor-plugin build variant and cached dependencies. It passed **28 mandatory
qualification rows, 418 actual tests, zero failures/skips/cancellations**, including
all mandatory native legacy/catalogue/setup/operator/CAS/restart/matrix cases,
installed import audit, unchanged source/config proof and real CLI/native entry
observations. Raw report: `/tmp/pap273-exact-qualification-clean.json`; private native
evidence: `/tmp/pa-workflow-installed-S9vQJe` in deployment d-cea6a5.

This is actual exact immutable-closure functional qualification, NOT changing the
operator's persistent PATH/install, reloading the current foreground Pi host,
operator adoption, an independent approved project matrix or genuine human UAT.
The report explicitly retains installationPerformed=false, enablementPerformed=false,
humanApproval=false and humanUat=false. Native capture/provider/Treehouse seams in
tests remain labelled fixtures. No real credential or application `.pa` was created.

Earlier attempts remain historical failures: first Nix command exceeded its 160s
tool bound (later exact retry built successfully); active old PPA rejected candidate
identity; default packaged plugin selection differed from local both-editor build,
correctly rejecting module inventory/bytes. A disposable matching-variant clone
initially lacked submodule identity and had unignored dependency-cache symlinks;
those fixture causes were corrected without changing verifier guards or source.

## Full workspace result and correction

Full workspace attempt exited nonzero: core1673pass/14optional skips; OpenCode104pass/
1optional skip; Pi1305pass/28fail/5optional skips. This remains a FAILURE, not a full
workspace or hosted-green result. During inventory diagnosis, two local generated
editor modules were briefly moved under an incorrect stale-artifact hypothesis.
They were restored; 27 Pi adapter failures were caused by those missing build
artifacts. The remaining genuine regression was a fixed baseline extension-module
count (8 instead of 9 after adding the bounded, role-inactive setup module).

This checkpoint's source correction updates the exact module inventory to nine
AND asserts presence of the real setup registration function while preserving the
ordinary-role tool/command/shortcut assertions. With restored generated artifacts,
the complete affected adapter/extension/setup entry passed **70/70**, zero skips.
Earlier complete functional entries: operator+actual synthetic PTY14/14; native
command/catalogue/source/startup37/37; full native workflow35/35; scripts25/25.
Workspace typecheck/build, completions generation and per-phase staged secret scans
passed. None substitutes for a clean full workspace rerun or actual hosted CI.

The correction and this documentation are after candidate78ae3b0. Their new Git
identity MUST NOT inherit the exact-package report's source SHA merely because the
runtime modules are unchanged. Packaging/qualification must name the actual target.

## Remaining separately owned gates

- Actual hosted results on the final feature/PR SHA; prior failed/cancelled runs
  remain their own outcomes.
- Clean full workspace rerun after the artifact/inventory correction.
- Independent approved full matrix/review and canonical full requirements/UAT
  evidence; current administrative queue override is not such approval.
- PAPC-073 config/team/instruction integration and its actual selected pair.
- Separately chosen persistent installation/activation and fresh host reload,
  real operator approval/credential UAT/adoption outside managed agents.
- NX-067 and TTL-017 resume at first unproven action only after their actual host
  prerequisites pass, without replaying valid approvals/links/history.

PAP-271/PAPC-072 remain done. No merge, tag, release, real credential setup, device
operation, acceptance, ticket completion or selected checkout return is asserted.
