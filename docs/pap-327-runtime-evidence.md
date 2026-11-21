# PAP-327 runtime implementation and qualification

This document records source-level phase exits. It is not installed qualification, workflow adoption, or human acceptance. PAPC owns workflow policy and any future sign-only selection. Existing combined scopes and historical native records remain authoritative for their original operations.

## P0: Baseline controls

Baseline source: `8420ccc615745c6cee8b1173e817b9a037bc38ba`.

Before rebuilding, the compiled worker was SHA-256 `a719ed5a3482a952ef321e15475fb55919fd299d2eaafc89473087d5e86a9cfb`, renderer `bdd9e514bd5681d5df3aa5b51ab1c38b20a12ab35ce96d876720e2179000d55d`, and package contract `d7074ddc5bcdb50fa49b38d9a3c867233892ce35e649bfb6d31194cd9b2f42fb`. The compiled package contract includes deployment-source grammar.

The exact named PAP-316 frozen deployment snapshot/delivery fixture passed (1/1). The deployment-source, handoff-intake and reader-worker controls passed (51/51). Thus this pairing does not reproduce the historical DOCUMENT_INPUT; no speculative parser/rendering fix was applied. The historical 42/43 result is not erased or diagnosed solely from this control.

The combined handoff/local review suites completed 74/74 in 137.7 seconds under a 180-second bound. An initial 55-second bound expired after 25 completed cases, without an observed failing case. A 90-second wrapper is insufficient for this measured source run. This does not prove the historical timeout's sole cause, installed parity, or actual two-client interaction.

Full commands, exits and source/compiled hashes are preserved in deployment `d-5ee695`, `artifacts/checks/pap-327-p0/baseline.json`.

## P1–P5: Source implementation

Each implementation slice was committed separately:

| Phase | Principal commits | Maintained contract |
| --- | --- | --- |
| P1: exact sign-only reference | `4e1be21` | [Review reference](document-review-reference.md) |
| P2: separately authorized Publish | `6727382` | [Publication](content-publication.md) |
| P3: lean immutable primer and registered read | `9c155b3`, `0895b21` | [Primer](lean-immutable-primer.md) |
| P4: complete collapsible Planned reader | `407dba7` | [Reader](planned-reader.md) |
| P5: same-ticket exact Planned/Actual | `bad88cd` | [Comparison](planned-actual.md) |

Independent source review required corrections, retained as separate commits rather than rewritten history. These cover pending ticket-intent admission, canonical guided decisions across asynchronous output, supersession aliases, honest publication history, retained combined approvals, current versus historical checks, independent Planned discovery, full AC blocks, bounded complete continuation, full structured scope, and current negative evidence. The final reviewed runtime candidate is `2eceb05d9d2610b2dbe45406df64397a37da0e6f`.

The final bounded closure review found no remaining source blocker in its three-finding scope: 102 focused tests passed (34 CLI, 45 comparison/report, 23 catalogue), plus three disposable real-journal output-boundary probes. This follows the earlier P1/P2 and P3–P5 reviews; it is not a fresh independent full-product acceptance run. No new decision ledger or workflow controller was introduced. Source catalogue entries remain non-authoritative; audited source digests and finite effect variants are reconciled without widening admission.

## P6: Qualification remains incomplete

Build, typecheck, completions, focused regressions, staged secret scanning and source-review corrections passed. Actual checks are separately scoped and candidate-bound:

- At `692f680`, the root test command completed its scripts (43 passed) and core (2,564 passed, two failed, 19 skipped). Only the two previously reproduced baseline failures remained: bounded repository-admission diagnostic content and validation-executor ledger observation. OpenCode passed 109 tests with one skip; runtime-host passed one. This is not a root/workspace pass.
- At `2eceb05`, the corrected short-socket-path full Pi run still reached its 1,800-second deadline. Scripts passed 11/11. Before termination the source stream emitted 882 top-level passes, one failure and five skips, plus 99 nested passes. These are partial observations, not final suite totals. The diagnostics pipe-order assertion failed in that run, then passed its isolated one-case control; its cause is unproven. The relevant test/owner sources were unchanged by this ticket. Default bundles were restored, final build/typecheck/completions passed, tracked fingerprints stayed unchanged, and no owned processes or zombies remained.
- A privacy gate withheld the tester's final administrative-summary command. No bypass, alternate read or approval was used; existing check receipts remain preserved. This does not invalidate observed exits or turn the incomplete suite into success.

Automated Chromium evidence covers fragment reveal, collapsed-content printing, focus and a 375px layout. Actual screen-reader use, actual 200% zoom, other-engine qualification, exact installed/default-path real-client journeys, hosted CI and human product UAT remain unperformed. PAPC owns deliberate policy alignment/future selection; PAP-317/PAPC-092 retain installed/journey coordination. No installation, adoption, push, live historical repair, queue or launch occurred. P6 must not be marked accepted from this source implementation.

Evidence is retained under deployment `d-5ee695/artifacts`: the final source closure review is `reports/2026-11-20-PAP-327-correction-closure-review.md`; broad source attempts and cleanup receipts are under `checks/pap-327-p6/`. The implementation handback is `reports/2026-11-20-PAP-327-implementation-handback.md`. These are administrative evidence, not native permission or acceptance records.

## Human-facing messages

Affected paths include guided PPA, `/pa-review`, native document/handoff signing, primer reference guidance and optional ticket comparison reads. Categories are discovery/help, decision acknowledgement, information/status and bounded blockers. Legacy machine JSON/streams and retained combined-effect entrypoints remain separate.

Examples reviewed without relying on color:

- Previously, an already completed publication could still acknowledge “Approved · Not published.” It now says “Approved · Publication recorded complete” and explicitly distinguishes saved history from fresh physical verification. An incomplete original operation instead reports partial effects and directs inspection of that same operation.
- Previously, ticket discovery could say `no-plan` when an approved Planned existed without Actual. It now offers exact draft/approved choices and a candidate-free `no-handback` view. Large comparisons provide complete snapshot-bound continuation rather than a truncated preview.
- Previously, optional immutable resource bodies were dumped with a static 1,200 budget. Fresh selected composition now projects exact reference-only locators and reports its verified committed budget (9,000 in the qualified source pair). Reading a reference does not activate obligations or capabilities.

Software/structural checks and independent code review are recorded separately from installed verification and human readability/UAT. No startup-latency claim follows from smaller primers.

## Historical boundary

The d-f04824 DOCUMENT_CONFLICT happened during intake, before a review subject/reference existed. Its cause remains unproven. The original native intake owner must inspect the original association, intent and custody; no live replay, replacement request/package, refreshed CAS or status workaround was performed. PAP-300 remains responsible for applicable historical custody recovery, not a blanket prerequisite or bypass.
