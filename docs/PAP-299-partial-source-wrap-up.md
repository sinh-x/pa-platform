# PAP-299 partial-source wrap-up and follow-up

## Operator direction and limits

In d-9a286d, after the implementation checkpoint and explicit report that PAP-299
was incomplete/not PR-ready, Sinh requested: “can we wrap this work up merge and
create new follow up ticket for this”, then “please finish with noted gap/missing”.
This changes the requested integration outcome from the earlier resolve-everything-
before-PR preference to a **partial-source PR/merge to develop with explicit
follow-up**, not a statement that requirements are delivered or tests passed.

Keep new handoff/reader/opener capabilities unselected. No install, production
activation, default selection, live publication/ref/link/queue/browser effect,
implementation-agent launch, resource action or human acceptance follows. Original
PAP-299 primary refs, native decisions, ticket base, branch and lease history stay
intact. Administrative Done is not requested by this wrap-up.

After an explicit question naming the active deployment-timeout change, the
600s/incomplete full local regression and missing independent protected review,
Sinh selected **“Yes—merge partial source after green CI”**. This expressly defers
those full manual-validation/protected-review gaps to PAP-312 for this source-only
integration; it does not label them passed, issue reviewer admission, or relax
later production/activation/acceptance gates. Hosted CI must pass and no branch-
protection/admin override is authorized. No protected reviewer is launched or
rogue/self-review adopted as protected acceptance.

## Delivered source to retain

Reuse all already implemented contracts, intake/association, finite TicketStore
intent/lifecycle services, repository exclusion and correlated Git/ref/link
transaction/recovery, native finite review/capture journal, explicit new-provenance
publication/optional-queue consumer, complete offline reader/publisher/worker,
bound-opening journal, and selected completion-fragment consumption. The latest
local slice adds real registered fresh-create observation/planning and original
pin/CAS/reply-loss tests. Do not restart from historical lists of missing cores.

The branch also contains the separately operator-requested deployment-lifetime
change 9b1cb43. It affects Pi/OpenCode/deploy/status/wait behavior and needs real
cross-runtime review; this is not a reader-only diff and not every change is dormant.

## Follow-up scope — no obligation waived

The implementation continuation ticket must carry the **complete** immutable
pap299-runtime-handoff-reader authored revision3, snapshot
`registry-document-package:199b08758ff45b8c73418f1da4acfa699fde5e839520e98c36e5370560fbd3c3`.
All five required members are under effective ai-usage at:

`agent-teams/requirements/artifacts/presentations/199b08758ff45b8c73418f1da4acfa699fde5e839520e98c36e5370560fbd3c3/52297d46b8024ddf543eba17e965cb8812fd4d48ce0259401f900e47e9608dd4/`

Read brief.md, requirements.md, uat.md, owner-reader-spec.md and
implementation-plan.md in full. Preserve all16FR/5NFR/16AC/18TS, IP-0–7 and V-1–12,
PAPC-079 r003 and its branch-ref-only clarification c-20261113010433988. The
content-only native decision decision-7a18c41f-7a52-415a-ac0e-5a8a342808af must be
freshly verified through the native owner before dependent protected effects;
file possession, this report and the follow-up ticket transfer no approval/grant.
Static UNAPPROVED labels remain generation history.

Remaining work:

1. **Actual fresh selected native route and one real review:** reviewed final
   selector/actions/capabilities, genuine process/session/immutable selection and
   supplied/ticketless association; full document + branch/base/finite-effects
   foreground capture/revocation with default Cancel and original-coordinate
   lost-reply recovery. Preserve retained profiles/scopes/registered producers;
   no caller actor/outcome/provenance/grant imports. No reload widens old sessions.
2. **Finish production planning/stages/refs:** compose authenticated advanced
   native lineage, eligible stage/assignment/ref ordering and source-bound plan
   consumers. Fresh planner is an implementation slice, not a fresh-only scope
   waiver. Reject legacy name-only adoption; preserve original base/current
   descendants, complete CAS/readback and original intent/audit identity.
3. **Production full reader and trusted opener:** wire immutable full reader and
   verified bound entry into the selected host; fix trusted packaged browser,
   display/network/executable custody, child readiness/exit/timeout/cancellation/
   cleanup and unknown-result reconciliation. Qualify worker uncertain cleanup
   and actual resource budgets. No shell/xdg-open/arbitrary URL/path/program/
   environment/callback, headless substitute or duplicate after unknown. Retain
   complete semantic/no-JS/offline/image/search/print/accessibility behavior and
   truthful generation/open-request/viewing distinctions.
4. **Successor publication and exact completion:** prove native completed
   predecessor publication/lifecycle/lineage/immutable bytes and current exact
   authority; preserve old history/primary ownership and recover partial writes.
   Consume the new finite decision explicitly, never forge legacy receipts.
   After exact publication, perform only authorized correlated ref/link completion
   at reviewed full develop pin. Created-ref/missing-link resumes linkage/audit
   only, never recreate/reset/reapprove/republish/requeue. Queue is independently
   finite after exact physical/full structured readback. Zero requirements-
   completion checkout/worktree/lease/capacity/stash/reset/discard/push/install/
   implementation-launch effects.
5. **Original owners, concrete intermediate outputs:** PAP-298 owns O-1/SR-1,
   actual production host/loader/reader custody and permitted selected Pi SDK
   documentation, plus its separate changed-base decision. Do not launch its
   prepared preview, bypass denied docs or edit its checkout. PAPC-087/config
   owners retain budget/current-contract and full completion/source-pair fixes;
   no foreign edits, blind repin, weakened detector or retained-fixture substitute.
   Intermediate supported owner contracts may unblock work; no circular Done gate.
6. **Publication prerequisite:** PAP-299 is idea/sinh with its historical primary
   attachment. An admitted ticket-ref/lifecycle owner must reconcile eligibility
   preserving history and obtain exact applicable publication authority. Do not
   demote/delete refs unsupportedly, status-normalize to manufacture readiness or
   replay content approval as publication/branch/queue authority. Creating this
   follow-up does not repair the prerequisite or authorize historical backfill.
7. **Complete qualification and adoption:** exact clean final-candidate focused/
   full/current/retained/PAPC validation, staged secrets scan and preserved original
   failures/skips; independent actual-contract/security/code review through its
   supported exact matrix/readiness/one-use admission; hosted CI through the
   authorized remote owner; separately authorized installed/default-entry pairing,
   genuine foreground prompt/effect evidence, real browser/network/keyboard/zoom/
   mobile/print/readability and all18 human UAT scenarios, then explicit adoption.
   Source tests, package approval, PR merge, queue/status and generated HTML never
   certify these later gates.

## Actual hosted CI finding and bounded repair

Initial head3ddeae2 hosted runs43707430821 (push) and43707436407 (PR177) both
**failed**, not timed out or passed. Typecheck/build passed. Core code tests
reported2194pass/1fail/19skip; later package/config/completion stages were not
reached. The single failure was mode-capabilities.test.ts's policy-primer fixture:
it depended on the operator's external selected completion fragment and had no
self-contained resolver. Ubuntu CI correctly rejected the missing fragment.

Original failed logs are retained at `/tmp/pap299-d9-ci-{push,pr177}-failed.log`.
The failure was reproduced locally with an explicitly empty disposable config:
`/tmp/pap299-d9-mode-fixture-reproduce.log` (0pass/1fail). Repair is **fixture-only**:
provide its own inert synthetic completion body and exact selected resolver, keep
all old assertions and add an explicit missing-resolver rejection assertion. No
production fallback, capability, external config, safety check or parser changes.

Actual empty-config rerun of mode-capabilities, primer-handoff, new native planning
and catalogue suites: **46pass/0fail/0skip**, exit0,
`/tmp/pap299-d9-mode-fixture-rerun.log`. This is not a full local regression pass.
Updated-head hosted CI must independently pass before the authorized merge;
original failures and the separate full/manual/protected-review deferrals remain.

## Evidence and handoff

- Latest checkpoint/actual results and complete trace disposition:
  `docs/PAP-299-observer-plan-progress.md`.
- Earlier exact94 full baseline:3931pass/0fail/20skip, exit0, preserved separately
  from the new changed-source600s/exit124 aggregate timeout. Latest focused
  owner129/129, retained Pi44/44 and reader22/22 pass; typecheck/build/completions/
  isolated-index staged secrets scans pass. These are not a full current pass.
- Prior source checkpoints: `docs/PAP-299-intake-review-progress.md`,
  `docs/PAP-299-native-owner-progress.md`, `docs/PAP-299-native-reuse-progress.md`,
  `docs/PAP-299-reader-worker-progress.md`, and
  `deployments/d-60da83/artifacts/pap299-final-readiness.md` under ai-usage.
- New ticket should start **idea/sinh**, unqueued, without a checkout/branch
  allocation or automatic implementation launch. Link to PAP-299 and existing
  PAP-298/PAPC-087 owner work rather than duplicating those tickets. Preserve
  requirement sources and authority at their original owners.

Created and fully read back **PAP-312 — Complete PAP-299 native handoff
integration, trusted opener and qualification**, idea/sinh, no branch/resource or
queue. Its description retains the complete source package and every missing
implementation/owner/qualification category above. Existing handoff-ticket search
found no duplicate continuation. PAP-299 lifecycle and historical primary remain
unchanged.

Exact committed candidate, actual PR/CI/merge result and remaining source-review
admission/deferral are recorded separately after those operations. Until
verified, CI and merge are not completed by this document.
