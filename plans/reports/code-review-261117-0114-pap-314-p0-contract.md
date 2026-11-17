# PAP-314 independent P0 review

## Code Review Summary

**P0 needs three contract corrections before implementation.** The requested unauthenticated local-confirmation model is accepted; lack of authentication is not a finding. Runtime-only delivery and the PAPC-090 configuration boundary are consistent with the requested scope.

### Scope

- Reviewed HEAD: `c2114f174405cc81baa1aa61a5bf3227c5fafe02`.
- Candidate: `docs/PAP-314-local-review-contract.md` and `plans/261117-PAP-314-requirements-review-approval/plan.md`, 68 lines total, both untracked at review time. No PAP-314 implementation diff exists yet.
- Contract SHA-256: `18032851b47264a74ef5ded6d77e475b4af2334dc04c31ead64bfb4d2a10c0d2`.
- Plan SHA-256: `ce8c60deafc1dbc4aa951037cc365d337a91af57540250c110564239354d4f95`.
- Source owner paths below are relative to `packages/pa-core/src/` unless otherwise specified.
- Scouted existing review/journal, native Pi caller/selection/tool/UI, planning/intake/lifecycle, TicketStore intent/publication, Git/ref/link, reader/worker/publication, CLI and general API owners. Read repository instructions, CLI message standard, PAP-312 handoff documentation and relevant historical design/progress.
- Checks ran in disposable fixtures with `TZ=Asia/Saigon LANG=en_US.UTF-8`. No delegates, code/plan edits, live database changes, builds, activation, PAPC source access or commits.

### Overall assessment

The proposed finite effect set and separation between local confirmation, actual effects, viewing and product acceptance are appropriate to the changed scope. Reusing the existing owners is feasible, but not by simply adding an outcome input and allowing another caller identity. Current owners deliberately reject several required v2 transitions. The following findings concern missing transition contracts, not missing P1–P5 implementation.

### Critical Issues

No implemented critical vulnerability is established by this preimplementation review. The version boundary and finite-effect admission must not be weakened to resolve the feasibility findings below.

### High Priority — blocking P0 contract gaps

#### 1. Develop drift has no executable refresh or pending-request settlement path

**Contract:** `docs/PAP-314-local-review-contract.md:35`; plan P3 at `plans/261117-PAP-314-requirements-review-approval/plan.md:17`.

The contract requires a refreshed immutable intent after drift, but does not define its producer or how the old pending review becomes settled. Current plan replay deliberately retains the old pin (`documents/handoff-planning.ts:120–126,168–175`). A new request ID cannot replace the existing planned branch: the fresh planner requires a materialized link (`handoff-planning.ts:132–133`), and `tickets/handoff-intent.ts:84` rejects create-with-existing-link. The review journal also blocks a different subject while the old request remains pending (`registry/handoff-reviews.ts:139–152`). Preserving the pending request without a terminal disposition can therefore prevent the required new review indefinitely.

A disposable real-Git/TicketStore/registry probe confirmed both original-pin replay after develop drift and `DOCUMENT_CONFLICT` for a fresh plan ID with the current ticket CAS and same native planned branch.

**Exact suggested contract addition:**

> For an unissued v2 capture, compare the current local develop observation with `intent.base.observedDevelopSha`, not with the original reuse base. Drift records an append-only stale/non-grant disposition of the exact pending request and returns the old and observed full SHAs; it never records an invented user decision. Only a selected native Pi refresh/prepare owner may produce the successor plan and review subject. It must prove the predecessor native plan and unchanged planned link under repository→ticket→journal serialization, use complete-ticket CAS, and preserve the original plan, request, audit and link attribution. It must reject partial or uncertain effects rather than bypass them. CLI/API only report stale state; they do not invoke planning or dependent effects. A successor requires a new deliberate decision. Reuse preserves its original base and proven ancestry. Replay of an already issued decision returns its original boundary and pin without reapproval or retargeting.

Implement this as a narrowly versioned extension of the existing plan/TicketStore/journal owners, not deletion of the planned link or a new approval ledger. Required tests include repeated drift, stale-request response loss, refresh response loss, incompatible links, partial effects and issued-decision replay after later movement.

#### 2. Fresh-session continuation conflicts with both caller identity and historical ticket-owner admission

**Contract:** `docs/PAP-314-local-review-contract.md:16`.

Binding original caller coordinates does not specify how another selected Pi session can consume them. `HandoffReviewService.current/authorize` require the original identity, selection, deployment and session (`documents/handoff-review.ts:34–40,56–60`). Publication and branch completion independently repeat original-identity checks. Native plan identity includes original deployment/session (`handoff-planning.ts:27–30`). Separately, `registry/index.ts:810–817` counts historical ticket associations even after completion, and intake rejects another historical owner (`documents/handoff-intake.ts:91–94`). A fresh session consequently fails before finite-effect admission. A disposable probe confirmed that even a completed original deployment still causes `DOCUMENT_CONFLICT` for the new native host.

Returning the original caller from `authenticate()` or removing historical-owner checks globally would make the feature appear to work by falsifying custody or widening retained authority.

**Exact suggested contract addition:**

> A v2 subject immutably binds the original native deployment, session, identity, selection and plan identity, separately from the currently authenticated effect caller. Local review/status validates saved origin provenance but never represents the ended origin as a running authenticated caller. A dedicated v2 admission branch in the existing owners may allow a fresh, explicitly selected local-review Pi caller to continue only this exact subject's remaining finite effects after the existing repository/ticket owners prove no live or uncertain custody and validate the original plan/link/history. Only the exact proven origin history is eligible for this exception; unrelated histories still block. The original registry association, request/effect IDs and audit attribution remain unchanged. Current caller identity is never replaced with origin identity. v1 and omitted/retained selections use unchanged admission.

Specify this seam across intake/availability, review authorization, publication caller checks, plan lookup and branch completion before P1. Tests must cover an ended origin, live/uncertain origin, unrelated historical owner, two fresh contenders and same-operation recovery. A terminal registry event alone is not proof of released resource custody.

#### 3. Two-step revocation and decision replay coordinates are ambiguous

**Contract:** `docs/PAP-314-local-review-contract.md:25–29`.

`request` has no revocation target; `decide` finalizes an already pending request; `revoke` accepts “same coordinates plus decisionId” while also needing a separate exact request and explicit decision. It is unspecified whether `revoke` creates that request or issues it, and which request key/revision a client supplies. It is also unclear whether `decide.expectedRevision` is the pre-request revision or the post-request revision. The current key includes subject, original revision, operation and target (`registry/handoff-reviews.ts:25–27`), so these are not interchangeable coordinates.

Current native review deliberately treats a saved request without capture as uncertain (`handoff-review.ts:84–87,102–105`). That v1 rule cannot be reused unchanged for intentionally pending external v2 requests. Capture persistence and issuance are separate current operations; response loss between them must not generate another interaction or permit a different outcome.

**Exact suggested replacement for the shared operation definitions:**

> `request(subjectSha256, expectedRevision)` creates or returns the original capture request. `revoke(subjectSha256, expectedRevision, decisionId)` is request-only: it creates or returns a distinct pending revocation request bound to that exact issued decision, with no immediate revocation or dependent effect. Both return the server-derived `requestKey` and original pre-request `expectedRevision`. `decide(subjectSha256, expectedRevision, requestKey, outcome)` uses those original coordinates, not the journal revision after request creation. Its operation and target come only from the persisted request. `approved` on a revocation request revokes the target; other outcomes do not. Revocation never rolls back completed effects.
>
> An uncaptured v2 local request is intentionally pending and decidable; an uncaptured v1 foreground request retains its uncertainty behavior. Accepting an outcome durably binds the exact request, outcome, generated interaction ID and server timestamps before success. Issuance is atomic with that binding or recovers only those same saved bytes after interruption. Identical retries return the original decision; a different outcome conflicts even if the first response or issuance was interrupted. Concurrent decisions, capture/revoke races and revocation versus remaining effect writes use the shared owner serialization and existing fences.

This retains the simple public action set without adding actor, receipt or provenance inputs. Add explicit examples for the initial request, decision, revocation request, revocation decision and response-loss replay.

### Medium Priority — implementation gates and clarifications

#### 4. Make the already-required version isolation explicit at every local target

**Contract:** `docs/PAP-314-local-review-contract.md:14,22–29`.

The isolation intent is present, so this is not a separate blocker or a request to reintroduce authentication. The practical risk is checking only the incoming local schema or Pi selection while loading an arbitrary subject from the shared journal. Existing request/evidence parsers are v1-only, including `local-uid` and `pi-native-handoff-review` provenance (`registry/handoff-reviews.ts:29–46,98–108`). Broadening those parsers unconditionally would change retained semantics.

**Suggested clause:**

> Every local `show`, `request`, `decide` and `revoke` requires a persisted v2 subject with verified native origin selection of all three required capabilities. A local request cannot read, decide or revoke a v1/unselected subject. Journal request/evidence variants are discriminated by that persisted subject version; the v1 evidence parser and consumers remain unchanged. v2 local evidence uses a distinct schema/method, `principal: local-unverified`, and server-generated coordinates. Results and published tracking preserve that trust label on Pi as well as CLI/API. Local evidence is never promoted into a native-human receipt or historical authenticated evidence.

Negative tests should use valid v1 subjects through every local action, not only reject `pa-handoff-native/v1` request strings. Also test omitted dependencies, retained/background/resume/OPA callers, cross-subject keys and local evidence offered to v1/legacy consumers.

#### 5. Complete finite transport/output limits and disclose the local read boundary

**Contract:** `docs/PAP-314-local-review-contract.md:20,24`.

Header/body/idle limits do not bound active connections, verification work, queued requests, response serialization or a slow reader. `show` returns complete content and history. Existing legal packages permit 16 MiB of source bytes (`documents/package-contract.ts:6`); the reader permits 64 MiB of derived outputs and two active workers per process (`reader.ts:14`; `reader-worker-owner.ts:74–75`). Repeated unauthenticated reads need aggregate work/output limits, not just an input-body cap.

**Suggested clause:**

> CLI and HTTP reuse the 64 KiB/depth-64 strict request parser and reject invalid UTF-8 and duplicate decoded keys. Before serving, define explicit finite header, body-read, total-operation and response-write deadlines, maximum sockets/in-flight work, and bounded response serialization/history delivery. Reject overload without an unbounded request queue. Full results are never silently truncated; any pagination is exact and versioned. Health is constant-size and does not initialize stores or verify documents. Reject nonexact numeric loopback Host/port, duplicate Host headers, any Origin including `null`, unsupported methods/paths and compressed/non-JSON bodies. Responses use `Cache-Control: no-store`; errors/logs never echo raw request bodies, document content, paths from exceptions or stack traces. Help/show/status do not initialize journals, migrate stores, render repairs, open browsers or consume effects.
>
> The unauthenticated HTTP `show` deliberately exposes eligible v2 review contents to every local process able to connect, including other OS users; filesystem mode 0600 is not preserved by this transport. Subject hashes are identifiers, not credentials. This does not permit v1 access, subject enumeration, arbitrary file serving or general API routes. Starting the dedicated server is explicit; it is never attached automatically to ordinary agent API/default selection.

The disclosure statement distinguishes the accepted no-auth model from accidental access to unrelated documents. No authorization layer is requested. Add raw-socket Host/header, Origin, slow-body/slow-reader, overload, large-show and sanitized-error tests alongside owner-level tests.

### Edge Cases Found by Scout

- A stale pending review can block its refreshed successor through existing cross-subject uncertainty checks.
- A completed historical association is still a conflicting owner; another session does not inherit it.
- Retried issued approval must retain its successful historical boundary even when develop later moves.
- Revocation must remain possible during partial effects without authorizing their remaining writes.
- Existing journal subject scans have a registry-wide 1,024-subject fail-closed ceiling (`registry/handoff-reviews.ts:143–144,206–207`). Reuse is not proof of indefinite scalability; retain honest capacity errors and do not remove bounds to make local review work.

### Verification and Metrics

1. `TZ=Asia/Saigon LANG=en_US.UTF-8 corepack pnpm --filter @pa-platform/pa-core typecheck` — **passed**, exit 0 (`tsc --noEmit`).
2. `TZ=Asia/Saigon LANG=en_US.UTF-8 corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-handoff-contract.test.ts src/__tests__/document-handoff-review.test.ts src/__tests__/document-handoff-planning.test.ts` — **failed**, exit 1: 42 passed, 37 failed, no skips. Contract/planning tests passed. All 37 review cases failed during fixture reader-worker startup with `DOCUMENT_UNAVAILABLE`, before proving their named review behavior. `reader-worker-owner.ts:80–84` requires owner-built JS for source fixtures; no build was performed or worker prerequisite independently qualified. This resembles the previously recorded missing-build prerequisite in `docs/PAP-312-implementation-progress.md:122–124`, but is not declared a diagnosed PAP-314 regression. Full tool log: `/tmp/pi-bash-bd41a0921573aab1.log`.
3. An inline `pnpm --filter @pa-platform/pa-core exec tsx --input-type=module -e` disposable owner probe — **passed**, exit 0, three assertions: original pin survives drift; fresh plan ID/current CAS fails on the existing planned link; a fresh native host fails on completed origin association history. Native hosts were synthetic; actual Git/TicketStore/registry owners were used. The probe created and removed only its temporary fixture.
- Type coverage and test coverage percentages: **not measured**. Lint/full workspace/Pi/installed/browser/CI/human checks: **not run**. No P1 behavior or human consent is inferred from baseline tests.
- Read-only review used native search and file reads. Two shell inventory attempts were blocked by configured exclusions for dependency/build directories; neither exclusion was bypassed or changed.

### Plan Follow-ups and Recommended Actions

1. Correct the three blocking transition contracts, then rerun independent P0 review against the revised text. Leave P0 unchecked for now; this report is not authority to mutate its status.
2. Carry the version-isolation and finite-server cases into P1/P3 validation. Keep human-facing trust/outcome messages aligned with the CLI message standard; before/after and installed/readability evidence belong to those implementation changes, not this design review.
3. P1–P5 remain unimplemented/unverified in this candidate, consistently with their unchecked state. PAPC-090/default selection/full-process closure remains external follow-up, not a runtime-source change or an acceptance claim.

### Unresolved Questions

- Will the lead adopt an explicit native v2 refresh/continuation seam, or constrain the claimed behavior until one is specified? The latter would need a user-approved scope change, not an implicit fallback.
- What numeric transport/concurrency/output limits and exact response encodings will be qualified for complete `show` results?

Status: DONE_WITH_CONCERNS
Summary: Accepted unauthenticated local confirmation and runtime-only/PAPC-090 scope; P0 still needs precise refresh, continuation and revocation/replay transitions before implementation.
Concerns/Blockers: Three blocking contract gaps; review-path baseline tests did not establish behavior because the reader-worker prerequisite was unqualified.


## P0 contract re-review — 2026-11-17 (Asia/Saigon)

**PASS at contract level.** Reviewed the revised contract against findings 1–5 above and the unchanged phase plan. Contract SHA-256: `e8f3d5a6aefb3f79223993e7a9ccff09e47ee269da6aa218eef571309bf40e0c`.

- **Develop drift:** The approval-boundary section now specifies comparison against observedDevelopSha, an append-only stale/non-grant disposition, native-only successor preparation with predecessor/link proof and complete-ticket CAS, preserved attribution, deliberate reapproval and stable recovery coordinates.
- **Fresh-session continuation:** Version and ownership now separates origin provenance from the current caller, limits the exception to exact proven origin history, requires no live/uncertain custody, rejects unrelated owners and rechecks admission at every remaining write without weakening v1.
- **Revocation/replay:** Shared operations now makes revoke request-only, defines finalization through decide using original pre-request revision/requestKey, and requires atomic issuance or recovery of identical saved outcome/interaction/time bytes. Intentionally pending v2 requests remain decidable; conflicting retries do not.
- **Medium gates:** Every local action requires a persisted v2 subject and verified original capability selection; v1 reads are excluded. Explicit finite input/header/socket/concurrency/deadline/output limits, overload rejection, browser/Host defenses, sanitized errors and disclosure of cross-user local access are now specified.

This closes the prior contract findings and related open questions, not their implementation tests. Simple unauthenticated local confirmation remains accepted; runtime-only scope and PAPC-090 ownership of defaults/full-process closure are unchanged. No tests, runtime probes or discovery rerun were performed. Only this report was appended; no code, contract or plan changes or commits were made. P0 is eligible for lead completion; plan state remains untouched, and P1–P5/installed qualification remain unverified.

Status: DONE
Summary: All three blocking transitions and both medium gates are addressed at contract level; no remaining issues in this re-review scope.
