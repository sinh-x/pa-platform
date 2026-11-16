# PAP-298 — production reader continuation requirements

Status: requirements draft; no implementation or installed acceptance claimed.
Date: 2026-11-15. Source baseline: `21530bc1912ea342b8cdbb679514b397c71d8f67`.
Audience: Sinh, implementer, independent reviewer and installed qualification owner.

## Outcome and controlling scope

Normal PPA guarded reads must return checked text from the actual selected Pi
installation's `README.md`, `docs/` and `examples/`, including legitimate immutable
Nix hard links. Success must come through the production registered reader, not a
standalone qualification executable, alternate reader or copied document.

Continue the published `pap-298-selected-pi-docs/r001` package attached to PAP-298.
Its FR-1–7, NFR-1–5, AC-1–9, TS-1–9 and V-1–8 remain applicable. This draft adds
concrete completion criteria for the remaining production work; it does not
rewrite that immutable package, mint a native decision or declare a new revision
published. Earlier partial source integration and qualification evidence remain
valid only for their recorded scope.

Sinh selected the cancellation definition below in this session. That decision
settles the intended O-1 requirement interpretation; it does not establish that
the current implementation meets it or close the independent review finding.

## Scope boundaries

- Keep selected-Pi-only scope. Do not allow other packages or all of `/nix/store`.
- Preserve strict artifact/manifest/package adoption, protected logical/resolved
  paths, full-file security projection, invalid-policy denial and existing limits.
- No new model tool, caller-supplied root/grant, runtime allowlist, exception prompt,
  source-label exemption, shell fallback or multi-link media support.
- Reuse the existing selected-host qualification work and recorded Pi 1.4.0 /
  Node 24.21.0 selection; no unrelated dependency upgrade or new controller.
- Ordinary external-Pi launches without authenticated selected-host support keep
  their existing single-link behavior. Do not silently upgrade retained sessions.
- PAPC compatibility, PAP-312 handoff/browser work and downstream API qualification
  are not absorbed into this repair. Installation and default runtime selection
  remain later rollout actions, not effects of writing these requirements.

## Accepted cancellation and publication contract

**Publication is the runtime's actual submission of checked read content to a
consumer-visible sink**, including model/session output, persisted tool output and
interactive output where applicable. Returning from an inner tool callback is not
proof that publication occurred.

If cancellation, session revocation or loss of required source/host validity is
established before publication, the runtime must withhold that operation's content
and return the existing bounded failure. Final validity checks and submission must
share an owned boundary with no unguarded asynchronous handoff between them.

Content already published while valid is not retractable. A caller observing that
previously published result after shutdown starts is not, by itself, a violation.
No retroactive revocation, arbitrary Promise-observation ordering or synchronous
interruption guarantee is promised.

Tests must observe the real submission boundary and distinguish:

1. Cancellation before acquisition: no content read or published.
2. Cancellation during processing or after result construction but before
   submission: content withheld; all owned resources settled or reported unknown.
3. Submission before cancellation, followed by late caller observation: an already
   published checked result, not a new post-cancellation emission.
4. A request made after session revocation: denied without reopening access.

Repeated inner checks or a qualifier-only sink cannot close O-1. If the selected
Pi integration lacks the required production hook, implement a reviewed owned hook
or report that precise missing boundary; do not invent a passing guarantee.

## Remaining requirements and exit evidence

| ID | Required continuation | Observable acceptance and original trace |
| --- | --- | --- |
| CR-1 | Connect an authenticated selected-host producer to the actual production registered reader. Derive the documentation root from the executing build-selected host, never PATH prose, a peer import, environment, JSON or metadata alone. | Normal registered reads succeed for selected README/docs/examples. Wrong/absent/forged/changed producer and duplicate-loader state deny. AC-1/2/7/8; TS-1/2/7/8. |
| CR-2 | Apply the accepted publication/cancellation contract to ordinary and qualified guarded reads, including actual registration and result transport. Retain required source/lifetime validation through the real submission boundary and release every owned descriptor. | Instrumented actual transport covers all four ordering cases above, every supported session shutdown reason, close failure and source/host drift. No unchecked progress, result or spill escapes. AC-3/4/7; TS-3/4/7. |
| CR-3 | Make every route that selects the production producer use a consistent Pi/Node/build/reader identity. Cover foreground/PTY, background/supervisor, direct child, start gate, native-addon/version/tool probes and resume. | Each supported selected route proves the same tuple; mismatched or unsupported routes fail closed without borrowing a probe/parent identity. Retained routes remain unchanged. AC-2/5/7/8; TS-2/5/7/8. |
| CR-4 | Preserve real execution and lifecycle contracts when integrating the supervisor: process-incarnation/admission checks, session lifetime, matching native SQLite ABI, environment handling, signal forwarding and shutdown ownership. | Production tests exercise actual topology and normal session setup, not offline help alone. Required provider environment works without echoing secrets; conflicting startup loaders/preloads deny before execution. Unknown child settlement is not success or permission to duplicate launch. AC-2/4/5/7; TS-2/4/5/7. |
| CR-5 | Preserve descriptor/path/link/text admission, complete-file scanning before pagination, current limits and ordinary text/image compatibility. A qualified acquisition failure never falls back to another reader. | Actual-tool positive and hostile/race/cancellation cases pass; unrelated/mutable multi-links and multi-link media deny; strict artifact assertions remain unchanged. AC-1–5/7; TS-1–5/7. |
| CR-6 | Keep typed failure causes and existing result/stream/exit contracts. Explain whether the read was blocked, unavailable or already published, without suggesting another coding approval would repair infrastructure. | Returned/thrown normal paths retain safe codes and fields; touched messages pass CLI-standard checks and separate human clarity review. AC-6/7; TS-6/7. |
| CR-7 | Qualify the exact installed production reader after source review/CI and authorized rollout. Only then report permitted documentation access to dependent owners. | Normal guarded README/extensions/example reads complete across all pages with exact host/config/loaded-reader provenance. Installed, human and downstream results remain separate. AC-8/9; TS-8/9. |

The qualification-only six-key offline environment is not a production provider
environment specification. Production startup must explicitly support the needed
environment while preserving the reviewed pre-execution protections.

## Verification and completion

Extend the existing r001 V-1–8 matrix rather than replace it with a smaller one.
The narrow current regression entrypoints are:

- [Core acquisition tests](../packages/pa-core/src/__tests__/local-source-file.test.ts)
  and [finite selected-document tests](../packages/pa-core/src/__tests__/immutable-document-policy.test.ts).
- [Guarded reader tests](../packages/pi-pa/src/__tests__/local-source-security.test.ts),
  [native host tests](../packages/pi-pa/src/__tests__/pi-native-host.test.ts) and
  [composition tests](../packages/pi-pa/src/__tests__/pi-extension-composition.test.ts).
- [Strict artifact tests](../packages/pa-core/src/artifacts/__tests__/manifest.test.ts),
  whose existing rejection assertions must not be weakened.

Add real production producer/dispatcher/publication-boundary integration coverage
where the implementation establishes those boundaries. Positive tests must not
substitute caller-minted bindings for production custody. Existing inert Nix
qualifiers remain useful regression evidence, not production acceptance.

Required repository gates remain typecheck, build, full workspace tests,
completions and the staged secrets scan before sensitive-workflow commits.
Give full runs measured budgets and progress evidence; record incomplete/timeouts
honestly. Focused or sharded evidence cannot silently replace required full checks.

Completion requires separate exact-candidate independent review and hosted CI,
then authorized installed qualification and actual human acceptance. A source
implementation may finish before rollout, but PAP-298's installed access criterion
must not be labelled complete at that checkpoint. Preserve all original failures,
skips, remaining findings and downstream retained-operation history.

## Implementation handoff

1. Reuse merged acquisition/qualification code. First add failing regression
   coverage at the real production reader and publication boundary.
2. Implement production producer/registration/transport and launch-route
   integration with negative cases first. Keep unsupported access denied.
3. Run focused and full validation, obtain independent review and close the
   remaining production findings with exact evidence.
4. Perform separately authorized installed qualification and human trial; notify
   dependent owners only after normal permitted access succeeds.

The existing PAP-298 implementation worktree is on a pre-squash branch; current
`develop` already contains its partial source. Before implementation, choose a
non-rewriting continuation from the current merged baseline or an explicit merge
into the existing feature. Preserve the existing checkout, lease and history; do
not replay old commits or reset/rebase it merely to update the base. That Git
integration choice does not require another approval of unchanged coding work.

## Evidence and draft limitations

Reviewed the complete published r001 brief, requirements and UAT, the latest
PAP-298 ticket evidence, current reader/registration source, and the independent
`d-9e123b` re-review of candidate `01a1e35`. The report retains O-1 and SR-1 open;
this draft does not relabel its earlier qualification as production success.
See [reader candidate evidence](PAP-298-hardlink-reader.md) and
[disabled integration evidence](PAP-298-disabled-integration.md).

Before this draft, the current-baseline core acquisition/selected-policy suites
passed 11 tests in the preceding investigation. Those are unit regressions, not
new producer/transport, installed or human acceptance evidence. No production
code, runtime selection, package publication, ticket status or installation is
changed by this requirements operation.

## Source-checkpoint integration disposition — 2026-11-16

Sinh subsequently authorized a default-off source checkpoint to merge through a
PR into `develop`, with the known gaps explicitly recorded on PAP-298. This is
not full PAP-298 completion and changes no acceptance criterion above.

CR-2 remains unmet for unchanged external Pi because that route lacks the final
owned publication fence. Actual-transport coverage of every shutdown reason,
genuine producer host drift and duplicate-loader denial also remains open.
The four optional installed AXI/quota/browser lanes, exact installed reader,
real-provider qualification, human acceptance and PAP-312 qualification are not
claimed. Do not close PAP-298 or change its status merely because source merges.

Checkpoint integration still requires review of introduced code and green CI.
It neither installs/selects the new runtime nor changes external-Pi behavior.
After merge, the canonical repository may be fast-forwarded onto `develop` as
explicitly requested; retained worktrees, deployments and leases stay untouched.
