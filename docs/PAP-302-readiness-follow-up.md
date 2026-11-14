# PAP-302 readiness follow-up: native draft safety hold

This is a runtime-source follow-up to the readiness report from `d-d65cb4`, not
activation or acceptance. The retained PAP-302 feature checkout remains the
implementation lineage. PAPC's effective contract must remain disabled pending its
own authorized amendment and exact-pair qualification.

## Reconciled facts and source changes

- The approved PAP-302 FR-4 / AC-3 require unsigned drafting without product
  writes; NFR-4 provides finite run bounds. The historical paired C0 record asks
  the runtime/config owners to agree finite CPU and process bounds. It does not
  specify a reviewed numeric CPU quota. PAPC's delivered pairing record explicitly
  does **not** claim CPU quota, process-tree sandbox or generic-deploy isolation.
- `nativeAutoDraftDriver` previously used a tool-less Pi CLI with a synchronous
  direct-child timeout and bounded captured output. Those are useful constraints,
  but a direct-child exit or timeout is not proof that a descendant tree settled;
  the CLI flags are not an OS filesystem sandbox. The producer had no separate CPU
  quota. No such properties are inferred from a successful help probe.
- Native draft admission now refuses a real provider before saving a new draft
  effect or starting a subprocess. Existing effects remain available to their
  original observation/reconciliation owner. The injected driver is an internal
  fixture seam, not a public configuration flag or user approval. This intentional
  safety hold must be replaced with an implemented and qualified process owner;
  it is not a supported way to run an actual draft.
- Generic deploy mode resolution now reserves `requirements/auto-draft` and
  its `auto-draft-...` family for the dedicated native data-only loader, with no
  environment/CLI override. Explicit, default, force, background and planning
  routes are rejected for both Pi and OpenCode before generic planning effects.
  The native pair parser reads exactly one configured profile directly and still
  authenticates selected committed resources, version, provider/model and objective.
  Existing analyze/analyze-auto and document approval scopes are not promoted.
- Historical local failure: the first focused run after reserving the generic
  resolver failed the positive paired fixture (`AUTO_UNAVAILABLE`), because the
  native data loader also reused that resolver. The follow-up splits the private
  exact lookup from generic deployment; the same positive fixture and the new
  safety cases subsequently passed. This failure is not erased.

## Focused source verification

On the follow-up candidate: workspace typecheck and build passed; core execution
plan + auto + interaction tests passed 89/89; Pi auto tests passed 30/30; focused
Pi deploy gates passed 2/2. The OPA adapter suite passed 94 with one external
config fixture skipped, zero failures; a skip is not a pass. Logs are
`/tmp/pap302-readiness-{typecheck,build,core,pi,pi-deploy,opa}.log`.
The first PAPC actual-pair fixture attempt refused the dirty runtime checkout by
its existing clean-source guard (zero fixture cases executed); preserve that result
and re-run only against the exact committed candidate. This is not a full regression,
independent review or installed qualification.

Interaction catalogue review: generic deployment has a stricter pre-planning
refusal, no new capability or effect; the existing foreground launch classification
is retained and its reason now states the real producer hold. Inventory digests
were renewed after this reconciliation.

## Human-facing blocker review

Affected paths/categories: PPA and OPA generic deploy returned/preflight failures
for a selected native-only draft mode. Previously that selection could proceed as
an ordinary deployment; it had no dedicated blocker message. The new outcome-first
blocker says `Draft not started: this mode cannot run through ordinary deployment`,
then supplies one each of Condition, Source, Reason, Correction and Resume Action.
The recommended action is to ask the runtime owner to qualify the native workflow;
asking has no effect and needs no approval. Repairs require separate authority,
and any later native use requires qualified pairing and renewed admission. The
new wording contains no supplied mode, objective, exception or secret; source
checks cover the bound, label counts and adapter propagation. This is author
readability review, not operator comprehension or installed verification.

## Remaining prerequisite — do not enable

A supported real producer must enforce a reviewed finite CPU/resource policy,
constrain writes and descendants while still permitting the configured provider
connection, and prove process-tree settlement on normal exit, timeout, interruption,
output limit and host loss. Verify no product/ticket/Git effects, no leaked or
unsettled process can release the active slot, and no PID-only inferred cleanup.
The existing document-workspace helper's offline sandbox is useful design evidence,
not a drop-in guarantee for a networked Pi/provider process. Avoid inventing CPU
numbers, weakening provider authentication, removing the safety hold, or treating
a group signal as proof of whole-tree settlement.

Complete the full regression/teardown matrix, independent safety review, exact
installed/config/resource qualification, genuine foreground prompt/reading and
useful separately authorized canaries before a PAPC activation amendment. Timer,
desktop observation and human UAT remain separate. This source change does not
select a ticket, capture a decision, start a provider, enable controls, install a
service, repair custody or alter a config source. Existing snapshot and historical
failures remain intact.
