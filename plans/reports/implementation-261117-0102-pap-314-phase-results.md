# PAP-314 phase results

## Scope changes

Sinh explicitly chose unauthenticated local trigger/approval for now, with honest `local-unverified` provenance. Runtime source only; PAPC-090 owns configuration/default integration. No install, activation, push, merge, live historical repair or launch is performed.

## P0

Committed `93c8126`. Independent contract review found three transition gaps; the revised contract passed re-review. Original failures remain in the independent report.

## P1

Shared v2 review uses the existing registry journal and preserves native v1 evidence. Pi, stdin CLI and a dedicated explicit loopback server use the same strict request/decision owner. Local request/revoke are request-only; exact decisions are atomic and replayable. Any local process can read eligible v2 reviews/submit decisions by design; no authenticated-human claim is made.

Lead integration registered `document.local-review` with mandatory package/handoff dependencies. Fixed a real integration mismatch: the saved plan actor must be the planner's actual `requirements/analyze`, not a synthetic fixture's `documents/handoff`. Retained source/effect owners are unchanged; P3 admission remains closed in this phase.

Actual source checks: core build and 65 core contract/review/local tests passed; 27 transport tests passed. Full Pi handoff attempt had 11 pass/1 fail due to the actor mismatch. After correction the selected-v2 regression passed (1/1). Core local tests passed (22/22); capability inventory assertions needed dependency-aware expectations after adding the capability. These original failures are not hidden. Agent-run workspace typecheck/build passed; final broad checks follow P5. Simplifier made two scoped behavior-preserving edits (single parse and shared body-limit constant).

Messages: new CLI help/server notice/Pi review disclose unauthenticated local confirmation, separate approval/effects and PAPC activation. Before: CLI had no review operation. After: `Decisions are local-unverified, not authenticated human consent.` Fixed transport failures use one bounded five-label envelope without arbitrary exception text. Structural/plain-output tests are not independent human readability acceptance.

No actual human decisions, browser observations, installed qualification or CI pass is claimed.

## P2

The full brief is the executive entry regardless of manifest position. Index links every complete member HTML/raw source and keeps a searchable printable full-package view in manifest order. Member pages have genuine previous/next/back/skip links. Existing inert CSP, output limits and immutable renderer-derived identities remain controlling.

Actual focused reader/summary/worker/opening suites passed 34/34 (zero skips); core build/typecheck passed. Static accessibility assertions are not browser/375px/zoom/keyboard/human evidence. Opening remains a bound request through the existing owner, never a viewing claim.

## P3

Implemented eligibility preflight, serialized local-develop observations, append-only stale disposition and native plan refresh, exact publication/attachment ordering, ref/link/queue effects and fresh explicitly selected continuation. Original v1 remains isolated.

Independent review reproduced four defects in custody, pre-ref validation, replaced link attribution and revoked queue settlement. All were repaired; seven permanent regressions and the unchanged independent probes pass. Independent re-review reports no remaining source blocker in scope. Latest independent checks passed 70 registered/transport tests, 213 core/reader tests and workspace typecheck. Workspace build passed in repair verification. The simplifier ran clean with no edits. Detailed original failures and exact commands remain in P3 review/repair reports.

This source completion does not establish installed/default-entry, hosted CI, browser/accessibility or human acceptance.
