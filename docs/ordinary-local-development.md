# Ordinary local development — PAP-268 work in progress

This is a source capability record, **not installed policy or ticket completion**.
The canonical implementation branch is `feature/PAP-268-scoped-local-development`,
starting at `2acdc1fd59a799dd5ce611727c3949144b475e63` (package 0.1.149).

## Baseline transport slice

The ordinary direct Pi launcher now resolves `ordinary-task-baseline/v1` from
one primary `requirements` document attached to its own ticket. It validates
repository key/physical root, ticket, feature branch, exact full base and the
referenced own-ticket operator decision. The observed contract includes source
and decision digests. It is not a CLI/agent/environment SHA override or a new
ownership ledger. It does not grant source-execution permission.

The approved source preamble uses `Handoff Type: fresh` / `Approved Base SHA`,
or `Handoff Type: amendment` / `Retained Base SHA`, never both. It contains one
`Review Approval Evidence` reference (`TICKET#c-...`, the canonical ticket-comment
form, or the comment ID). The decision producer's complete comment is exactly:

```text
Approve TICKET REPO_KEY PHYSICAL_ROOT FEATURE_BRANCH exact base FULL_SHA; source requirements:agent-teams/requirements/artifacts/FILE.md.
```

`from exact base` is also accepted. This finite initial-task clause cannot be
inferred from a discussion that merely mentions or rejects the tuple. The
native reader requires operator authorship; agents cannot supply this authority
through tool parameters. PAPC-068 still needs to implement/review its producer
and guidance. This source change does not require or solicit new decisions on
unchanged phase, check, repair or commit steps.

For planned branches, a divergent configured integration tip stops before
permit/checkout acquisition. For materialized branches, compare immutable
historical base instead; later integration advances do not rewrite history.
Immediately before branch selection, under the existing repository transaction,
reread the source/decision and configured evidence and reject digest drift.
Dirty/unknown checkout work is preserved before branch creation. Independently
created branches cannot be adopted. Optional preparation retains its separate
contract and exactly-once reconciliation; legacy split-mode contracts are not
silently upgraded. No fallback launch follows an ordinary denial.

Public `ORDINARY_BASELINE_*` stops identify the action, evidence owner and
supported reconciliation without echoing source bodies or authority tokens.
Post-acquisition denials may retain their existing permit/lease for owning
reconciliation: no forced release or terminal claim is performed.

## Verification and remaining work

Disposable core and actual source-built ordinary-launch tests use real Git,
ticket storage and native custody. Provider spawn and Treehouse status are
simulated and labelled. Optional activation/grants remain absent. Existing SDK
startup/reporting and single-phase fail/repair/commit regressions are retained.
The new integration file **characterizes rejection** of generic commands and
phase changes; it does not yet prove the AC1–AC8 positive loop.

Still required before PAP-268 completion:

- Versioned validated project-command contract and non-PA real test/build path.
- Same-holder phase advance and evidence-backed diagnosis/remedy, retained limits.
- Full two-phase SDK integration, complete AC1–AC8 negatives and Markdown reports.
- Interrupted ordinary materialization reconciliation (current behavior safely
  preserves a created-but-unpublished branch and refuses automatic adoption).
- PAPC-068 reviewed producer/instructions and exact selected config pin.
- Full nine-command independent matrix, CI and human UAT, separately attributed.

Current config pin is `42aa9267a0618cdb7a92b31dd3418df137326c81`; no PAPC-068
compatibility or installed qualification is claimed. No config source mutation,
installation, live adoption, product-checkout repair, push, merge or release.
