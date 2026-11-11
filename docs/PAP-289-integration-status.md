# PAP-289 integration and operator acceptance

## Integration decision

After the `d-fbce8c` requirements/analyze foreground trial, Sinh explicitly directed:
“with the PA:d-fbce8c/requirements/analyze/PAP-289 qualification run we can consider
this is done and proceed to PR merge to develop”. This records operator acceptance
of the delivered supplied-URL capability and permission to prepare/push the PR
and merge to `develop` subject to actual integration checks. It is not a fabricated
native exact-package approval, independent review or passing unexecuted test.
The trial's own report correctly described its bounded scope; this later operator
disposition does not rewrite that history or the published r006 package.

Implementation/trial source: `b89d73526ea1d175f09bcb29129aa83cc2721747`, with
worktree label `0.1.160-pap289.5`. Integration restores plain `0.1.160` across the
four shared manifests to preserve normal develop auto-patch behavior.
`runtime-host` retains its independent `0.1.88`. No label-only edit changes an
installed runtime or transfers provenance. No default config pin, active PAPC
policy, installation, release/tag or checkout-return operation is part of this
integration request.

## Actual foreground evidence

PAP-289 `c-20261111134406655` and `c-20261111134500945` report the original
`d-fbce8c` native observation. The live registry was still running when first
inspected during PR preparation; no process-settlement inference follows.

- Native `requirements-document-policy/v1`, Pi/ppa requirements/analyze,
  `rogue_one=false`, provider openai-codex / gpt-6.1-sol preserved.
- Immutable config revision `c0385c1756c203e7754c3ffc5f895a8712e59149`, resource
  `teams/requirements.yaml` SHA-256
  `11578cebe125e224d66ef39f4b1cc98931cbcba0341c071109201bb99c522eed`, exact twelve
  baseline capabilities plus `web.public-read`; actual native tool exposed.
- One `pa_web_read` of `https://github.com/jaredpalmer/kev`, retrieved
  `2026-11-11T13:43:17.564Z`, `ok=true`, cleanup settled, no redirect or alternate
  retrieval. Evidence locator:
  `pi-tool-result:d-fbce8c/call_d01f5acee90b4511a3edb8e0c3aa23a3|fc_0163b0dc354222bd016af470f3edb887d0b7c402e13674b5cb`.
- Complete decoded body: 471615 bytes, SHA-256
  `68350581330e191f2a6d282beb9e2bedca5d8bd834e53079a0626d1973a10bb3`.
  Exact returned text SHA-256:
  `4c697a39ff02b5cbca91c9f59ebe2d1b99cc7f84f35a76c13951b9655b674718`.
- Meaningful Models/Run It Locally documentation returned: 42202 extracted code
  points, 16000 returned, **clipped=true**, static-text-not-rendered. Source-backed
  hardware explanation distinguished measured/stated configurations, inference
  and unmeasured expectations. No complete-README/rendered-coverage claim.

This supersedes the earlier wrapper-only observation for useful page extraction,
not its historical validity. Sensitive URL/local-file/native capability owners
remain intact. Public response content remains untrusted evidence, not commands.

## Evidence that acceptance does not manufacture

The single positive read is not same-installed-binary config-only A/B/A,
independent security/code review, full local regression, hosted CI, independently
verified clean installed provenance, human readability review or a separate formal
UAT run. The original trial-only installed-source exception remains distinct.
Previous timeout/failed checks remain as reported. Operator acceptance above is
recorded separately from these evidence gaps; integration checks/PR results must
be reported as actually observed, not assumed.

Implementation, bounded-process design, source tests, failure/repair history and
packaging limitations: [public-web-curl-python.md](public-web-curl-python.md).
Capability/retained-route contract: [mode-capabilities.md](mode-capabilities.md).
Source-aware policy: [public-web-source-policy.md](public-web-source-policy.md).
Historical checkpoints in those documents intentionally retain their original
not-installed/not-qualified statements. The current trial and operator disposition
are this additive record, not retroactive edits to original evidence.

## PR verification and delivery

Record exact integration checks, current PR/CI and merge result in the PR and
PAP-289 ticket. Source build/typecheck/tests, hosted code-only CI and manual
installed/full-suite gates remain distinct. A green code-only lane cannot be
reported as a full manual integration pass. Do not bypass a failing required
check, force-push, rewrite trial history or use administrator merge overrides.
