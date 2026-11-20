# Same-ticket Planned / Actual

PAP-327 P5 projects the exact reviewed Planned delivery beside existing Builder phase reports. It does not edit Planned bytes, rewrite an immutable report, create a second plan/report database, approve work, publish requirements, complete a ticket, or adopt external policy.

## Normal Pi dispatch

1. Use the existing `pa_phase_report` capture/publish flow. Publication returns the native `report` reference and the existing Markdown/HTML/diff locations. Existing producer schemas, orchestration templates, checks and delivery gates remain unchanged.
2. Call `pa_phase_report` with `action: "attach-actual"`, that `report`, the exact content-review `reference`, `observations`, and `actualOnly`. The report owner derives the repository, ticket, candidate and immutable receipt; none is accepted as authority from tool arguments.
3. Call `pa_ticket` with `action: "read"`, `id`, and `plannedActual: true`. This discovers accessible exact `{reference, candidate, reportId}` choices without selecting a latest item.
4. Repeat that ticket read with the selected `reference` and `candidate`. Existing read-only execution admission already permits this route; no safety guard widening is needed. Ordinary read/show/list/comment calls retain their contracts. Results are plain JSON, understandable without color. The normal tool's existing bounded-output/truncation contract still applies.

An observation has these fields:

```json
{
  "ac": "AC-01",
  "observation": "Closed content was present in the fixture printout.",
  "disposition": "matches",
  "difference": "None observed in this check",
  "impact": "No observed print-content loss",
  "owner": "Builder"
}
```

`disposition` is `matches`, `deviates`, `unmet`, or `unverified`. These rows and `actualOnly` are **agent-labelled narrative, not acceptance evidence**. They cannot create native checks, installed qualification, independent review, browser testing or human authority. Missing AC observations remain unverified. Deviation/difference, impact and follow-up owner are always present.

## Binding and immutable owners

Every applicable comparison matches repository key **and canonical root**, ticket, exact reviewed document subject/revision, manifest SHA-256, exact review reference and report candidate SHA. The manifest commits the ordered full member identities. Neither dates, paths, comments, text labels, branch names nor a newer green report select a binding.

The Planned resolver uses the existing content-review owner with an existing-files-only read-only registry connection. A saved approval is insufficient: the supported complete reader-inspection result must verify the exact delivery, subject, revision and every ordered member. Unverified saved-history fallback is rejected. Expectations come from the immutable requirements member: explicit `AC-N: ...` bullets/paragraphs, including continuations, or complete Markdown table rows whose first cell is `AC-N`. Duplicate AC IDs conflict; unsupported/no AC structure fails explicitly instead of guessing expectations from report prose. Full raw requirements remain available through Planned.

Actual metadata stays in the existing protected `NativeExecutionEvidence` report owner. It references the original captured facts, report and receipt. Reads verify those native records, actor/repository/ticket/candidate linkage, exact published Markdown/HTML/receipt/diff and the existing orchestration owner's indexed receipt. Report paths are derived from native identity, never accepted from callers.

A small absent-only `planned-actual-d-XXXXXX-DIGEST.json` companion lives beside the original report. It is a locator, not another canonical report store. Native reads reject a relocated, changed or missing companion. The existing ticket mutex/audit owner attaches three non-primary filesystem references in one update: `orch` for the existing owner index, `impl` for immutable `report.md`, and `attachment` for the locator. All are usable file references, not orphan custom URI paths. Exact replay does not churn the ticket; conflicting types/primaries are not repaired. Existing primary references, status, assignee and unrelated references are preserved.

The package exposes only `@pa-platform/pa-core/tickets/planned-actual`; no core or Pi export/composition hub wiring is required. The package previously had no wildcard subpath export, so this explicit finite export is necessary for normal Pi tool imports.

## Evidence at handback and later observations

The projection returns the complete selected binding and separates evidence class, result, locator, observation time, coverage and trust:

- **Source:** sanitized native report checks for that exact candidate. Empty coverage means no per-AC coverage mapping was established, not that every AC passed.
- **Installed:** Not run until its own qualified owner supplies evidence. This phase adds no importer.
- **Independent:** Not run; agent narrative is not independent review.
- **Browser:** Not run; generating HTML or observing the report's reading view is not product/browser qualification. Existing report-delivery observations remain with their retained owner.
- **Human UAT:** Not run immediately at handback. It is never inferred from source checks, signing, report publication or generated HTML.

`pa_phase_report` `action: "observe-actual"` takes only the attached locator. It requires the same authenticated live report owner, foreground TUI and exact verified binding **before** showing the prompt. The operator selects AC coverage and Not run/Pending/Failed/Passed. No caller-provided result, evidence class, timestamp, identity or trust is accepted. The fixed human class is `local-unverified`; authentication is not provided. Detach/abort records nothing.

A later human observation is a separate immutable native record. Another locator appends it through the same ticket owner; prior locators, reports, Planned bytes and the original human Not run state remain readable regardless of ticket-ref ordering. Conflicting observations remain explicit, never chronological/latest-wins. Cross-owner writes into an ended deployment are not enabled.

## Failure and qualification boundaries

No plan, draft, no handback, checking, missing, denied, integrity failure, conflict, unknown and unmatched are distinct states. Wrong-ticket/subject/manifest/candidate records remain unmatched. Denied owner content is never returned; errors do not echo private exceptions. A malformed attachment is an explicit issue and does not erase separately verified matches. Attachment interruption preserves the existing immutable record/companion for exact idempotent retry; it does not replace an intent or overwrite a conflict.

Disposable tests exercise the native reader's saved-approved-but-tampered fallback, immutable report/locator/ticket owners, bindings, conflict/order independence, append-only observations and normal tool dispatch. This is source/fixture evidence, not installed default-path qualification, a real foreground operator observation, independent product review, browser/AT acceptance or human UAT. Those remain **Not run/Pending** for P6. External PAPC policy, protected producer records/templates and live tickets/databases are unchanged.
