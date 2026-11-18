# PAP-316 requirements handoff implementation

## Outcome and scope

Requirements-side runtime source support is implemented and committed in phases. Builder changes are deferred by Sinh's explicit session instruction. No installation, configuration activation, protected review-team migration, live handoff, checkout allocation, push/merge or implementation launch was performed. The ticket is not claimed fully product-qualified.

PAPC remains workflow/quality policy owner. Runtime retains the existing finite journal, integrity, CAS, custody, eligibility and effect owners. Confirmation remains deliberately **local-unverified**, not authenticated human consent. The existing linked complete HTML bundle format is reused.

## Phase commits

| Phase | Commit | Result |
| --- | --- | --- |
| P1 | `67cd383` | Intended-cause CLI/API red: canonical approval persisted while the open Pi review stayed waiting. |
| P2 | `993ec04` | Same-request journal convergence, first-issuance wins, explicit Cancel versus client detachment. |
| P3 | `8d2fd8b` | Qualified own-deployment draft/check/freeze without relocating bytes; historical roots and snapshot/continuation remain valid. |
| P4 | `244c615` | Trusted public/effective Analyst binding/resource closure, real opt-in PA-server transport, quality-member parity, review repairs, catalogue and completions. |
| P5 | Final documentation commit | Final checks, independent disposition and qualification handoff. |

## Delivered requirements support

- Waiting Pi clients reconcile canonical decisions during request, view and capture loading, including failed/delayed views, stale results, revocation, competing inputs and lost replies. One original request/history is retained. Closing a client does not submit shared Cancel.
- Native policy-profile requirements intake admits only its exact `deployments/<native deployment>/artifacts/...` sources, checking every owner before reading member bytes. Arbitrary roots, traversal, foreign authoring/intake, links, sensitive input and changed bytes reject. Derived publication/reader destinations remain unchanged.
- Explicit future `analyst/analyze` selection uses strict binding v2: public registry/environment identity stays Analyst, effective native owner/audit actor remains explicitly requirements/analyze. One committed source binds exact selected/transitive resources; captured content and production child-start checks prevent mutable skill substitution. Generic Analyst ticket lifecycle privilege is denied; selected finite native owners still perform their own admission.
- The current omitted-profile Analyst configuration remains unsupported before allocation/spawn. Offline Pi/OPA composition remains compatible. No environment alias, draft-consumer-map authority or retained-session widening is introduced.
- Disabled-by-default `serve --local-review` exposes the actual `POST /api/documents/local-review` through the existing shared owner. Numeric native loopback, exact Host, no Origin/credentials/forwarded trust, strict bounded input/output, connection isolation and independent owner settlement remain enforced. It adds no publication/ref/link/queue or runner authority.
- PAPC-authored quality judgments already fit required hash-bound specification members. One shape-valid contradiction proves exact findings/readiness/coverage transport through registered Pi, CLI, dedicated API, general API and HTML while structural pass still says semantic completeness is not assessed. No runtime semantic gate/score/second ledger was built.
- Builder and protected legacy review/focus/OPA authority are unchanged. Existing finite publication, physical pinned ref/full attributed link, queue and partial-operation recovery owners are reused.

## Test-first and independent review

Original reds and intermediate failures/timeouts remain recorded, not counted as passes:

- `/tmp/pap316-p1-red.log`: 0/2 passed; open dialog remained waiting after real CLI/API issuance.
- `/tmp/pap316-p3-red.log`: 21 intended source-boundary failures; final focused 30/30, affected core 359/359, Pi document 42/42.
- `/tmp/pap316-p4-identity-red.log` and `/tmp/pap316-p4-bridge-red.log`: missing native identity/server integration reproduced before implementation.
- Independent review initially found five defects despite focused green: production process anchor, actual-start resource drift, canonical offline composition, view-time convergence and pipelined connection isolation. The original report is preserved at `plans/reports/review-261118-pap316.md`.
- Repair reds include `/tmp/pap316-view-race-red.log` (0/8), `/tmp/pap316-p4-identity-review-red.log` and `/tmp/pap316-p4-bridge-review-red.log`. Final view-loading suite passed 10/10.
- Final independent source re-review at `244c615` found no remaining blocking/high findings and passed 127 focused tests: `plans/reports/review-261118-pap316-final.md`. This is independent source review, not human acceptance.
- Canonical PAPC actual composer passed; all-mode source sweep passed 118/118 and compatibility validator passed 59/59 modes plus 269/269 references. Observed PAPC SHA: `3ed0496880ee7c968ee90c40df94944b13e72f9f`.

Full command groups, repaired fixture mistakes and exact focused outputs are in `docs/PAP-316-{deployment-sources,analyst-identity,review-bridge,source-inventory}.md` and the implementation reports.

## Final repository checks

Working directory: selected PAP-316 worktree. Final checks use `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1` where applicable.

- `corepack pnpm typecheck`: passed; `/tmp/pap316-typecheck-final.log`.
- `corepack pnpm build`: passed; `/tmp/pap316-build-final.log`.
- `corepack pnpm completions`: passed; `/tmp/pap316-completions-final.log`. Source reconciliation also passed Fish syntax and 39 focused completion checks.
- `corepack pnpm secrets:scan`: passed before P1–P4 commits. One P4 attempt correctly rejected an overly long synthetic credential fixture; the fixture was shortened, its rejection/no-echo test rerun and the official scan passed without exceptions or scanner changes.
- Initial `corepack pnpm test` failed two conservative source snapshot/regex guards after 2,398 core tests; the changed dispatch semantics were reviewed/reconciled, not blindly rehashed. Original log: `/tmp/pap316-full-test.log`.
- Final `corepack pnpm test`: **passed, exit 0**, at code candidate `244c61543c5a240ee3aafbe732f6d8b93939fa5b`; `/tmp/pap316-full-final.log`. Across the six completed TAP groups: **4,265 passed, zero failed, 20 skipped** (4,285 total). Core: 2,424 passed/14 skipped; OpenCode: 109/1; Pi: 1,678/5; root/script/runtime-host groups: 54 passed. Skipped cases concern optional external configuration fixtures, pinned AXI/Chrome/quota dependencies and installed dual-host evidence; they are not passed qualification. The complete sequential run took about 64 minutes.

## Human-facing message evidence

Affected categories: native selection blockers, public/effective primer information, finite ticket-status help, general-server help and bridge failures. Existing machine result shapes/exit/stream owners remain unchanged.

- Before: no supported general-server review option or endpoint. After: help documents the real opt-in flag/endpoint, numeric-loopback restriction, local-unverified trust and no runner authority.
- Before: public Analyst could fall through generic launch and fail later. After: omitted native selection stops before allocation with the existing bounded `CAPABILITY_PROFILE` diagnostic and owner-inspection next action.
- Before: help named only requirements/analyze. After: it names natively bound Analyst while explicitly disclosing public/effective attribution and withholding generic ticket privilege.

Changed blocker messages retain exactly one Condition/Source/Reason/Correction/Resume Action envelope, at most 2,000 JavaScript characters, fixed safe cause text and no raw exception/body echo. Structural tests and agent plain-text readability review passed. Installed propagation and genuine human comprehension/UAT were not performed; these are separate evidence classes.

## Remaining qualification and next owners

1. PAPC owner must supply a separately authorized explicit resource contract: the hypothetical native closure currently reaches missing `docs/json-workflow-runtime.md` through retained references. Ordinary composer success is not native selection readiness; no guard was weakened or external file copied to conceal it.
2. Exact installed runtime/PAPC/default-entry, actual provider/selected-host supplied-ticket and ticketless foreground journeys, real forwarding, browser/accessibility, hosted CI and Sinh UAT remain unperformed. PATH `ppa --version` reports 0.1.173; that is discovery, not exact source/build provenance. Production PTY tests use an inert executable and controlled probes, not product UAT.
3. Future-start adoption/install/activation remains separately authorized. Existing sessions and protected review owners must not migrate from source support alone.
4. Builder proof/admission changes remain deferred to later Builder-focused work, per Sinh.

No unresolved source defect is currently known within the independently reviewed requirements scope. The resource-selection and genuine installed/human qualification prerequisites above remain unresolved; no ticket acceptance or deployment readiness follows from these commits.
