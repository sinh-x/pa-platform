# Same-ticket Planned / Actual

PAP-327 P5 projects the exact reviewed Planned delivery beside existing Builder phase reports. It does not edit Planned bytes, rewrite an immutable report, create a second plan/report database, approve work, publish requirements, complete a ticket, or adopt external policy.

## Normal Pi dispatch

1. Use the existing `pa_phase_report` capture/publish flow. Publication returns the native `report` reference and the existing Markdown/HTML/diff locations. Existing producer schemas, orchestration templates, checks and delivery gates remain unchanged.
2. Call `pa_phase_report` with `action: "attach-actual"`, that `report`, the exact existing approval-owner `reference` (content review or retained combined handoff), `observations`, and `actualOnly`. The report owner derives the repository, ticket, candidate and immutable receipt; none is accepted as authority from tool arguments.
3. Call `pa_ticket` with `action: "read"`, `id`, and `plannedActual: true`. This discovers accessible exact Planned references independently through the existing native document/review owners, including prepared drafts, approved plans without Actual, and retained combined reviews. Choices contain `reference` and `state`; verified attachments additionally supply `candidate` and `reportId`. No latest item is selected. Only same-ticket/repository members whose original owner and complete delivery verify are disclosed; denied or unreadable entries remain typed issues, not apparent absence.
4. Repeat that ticket read with the selected `reference` alone to read Planned. No candidate or Actual is required: the result is `draft` or `no-handback`; if verified Actual candidates exist, it returns explicit choices instead of selecting one. Add the selected `candidate` to read that exact comparison. Existing read-only execution admission already permits this route; no safety guard widening is needed. Ordinary read/show/list/comment calls retain their contracts. Results are plain JSON, understandable without color.

### Complete bounded reads

Small projections retain their structured `planned`, `actuals`, `choices`, `unmatched` and `issues` fields. Every response also carries `selection`, an issue/evidence count `summary` and `pagination`. The existing global limits remain **50 KiB and 2,000 lines**; neither protected report storage nor the locator companion is a fallback read API.

A larger projection returns `content: {encoding: "json-fragment", text: "…"}`. Collect the **decoded** `content.text` strings in order. Repeat the same ticket/reference/candidate selectors with `page` set to the exact returned `pagination.next` object (`snapshot`, `offset`). Stop when `next` is null, concatenate the strings without separators, then parse the complete JSON. This includes all AC expectations, observations, Actual-only rows, structured scope details, original issues, locators and historical/current/human evidence; it is not a truncated preview. The verified selected binding and issue/evidence summaries remain visible on every page.

Offsets and `total` count JavaScript UTF-16 code units of the compact JSON, not bytes; returned boundaries never split a surrogate pair. `snapshot` is the SHA-256 of that complete JSON, including the selected binding. Invalid coordinates or changed binding/content/issues/evidence reject continuation rather than mixing pages. Repeat the original read from its first page after a change; do not replay a producer, replace a plan or re-sign content. Continuation works for discovery and plan-only reads as well as comparisons, through the same `pa_ticket` read/show route.

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

The Planned resolver uses an existing-files-only read-only registry connection and discriminates content-review v1 and retained combined-handoff v1/v2 subjects. Combined subjects accept their original SHA or `review:SHA`; their original decision ID, subject, schema and effect scope remain visible. Reading neither converts a combined grant nor creates a content decision or asks for another signature. The original journal verifies native v1 capture/history; v2 also verifies its saved native origin and plan. Current effect eligibility and new writer custody are not inferred from historical approval. A saved approval is insufficient: the supported complete reader-inspection result must verify the exact delivery, subject, revision and every ordered member. Unverified saved-history fallback is rejected. Expectations come from the immutable requirements member: top-level `AC-N: ...` bullets/paragraphs, including complete nested lists, tables and code blocks, or complete Markdown table rows whose first cell is `AC-N`. Fenced, quoted and nested example identities do not create criteria. Paragraph criteria retain subsequent blocks until an explicit next criterion or heading; mixed criterion/noncriterion sibling lists fail explicitly. Duplicate AC IDs conflict; unsupported/no AC structure fails explicitly instead of guessing expectations from report prose. Full raw requirements remain available through Planned.

Actual metadata stays in the existing protected `NativeExecutionEvidence` report owner. It references the original captured facts, report and receipt. Reads verify those native records, actor/repository/ticket/candidate linkage, exact published Markdown/HTML/receipt/diff and the existing orchestration owner's indexed receipt. Report paths are derived from native identity, never accepted from callers. Actual retains a genuinely bounded `scope` summary (at most 4,096 characters) and optional `scopeDetails`. Native reads supply `scopeDetails.admitted` (`scope` and ordered `paths`, or null when no plan exists), `scopeProven`, `custody` (`state` and full `observation`), and ordered `omissions`. These contain the full sanitized admitted facts, not a concatenated or truncated summary. Sensitive paths remain hash-labelled omissions; private values/content remain redacted or explicitly withheld by the existing policy. Empty omissions do not establish acceptance. Existing records without `scopeDetails` remain readable without invented details.

The detail parser admits all producer scope/path sizes (4,096 characters each, up to 64 paths) with finite sanitization headroom: 40,960 characters per sanitized scope/path/custody state; 655,360 characters for the custody observation and combined omission text; up to 128 omissions. The native report's original 65,536-byte section limits remain unchanged. Larger complete details travel through the existing projection pagination, not protected-store fallback. No protected producer schema or global tool/text limit is changed.

A small absent-only `planned-actual-d-XXXXXX-DIGEST.json` companion lives beside the original report. It is a locator, not another canonical report store. Native reads reject a relocated, changed or missing companion. The existing ticket mutex/audit owner attaches three non-primary filesystem references in one update: `orch` for the existing owner index, `impl` for immutable `report.md`, and `attachment` for the locator. All are usable file references, not orphan custom URI paths. Exact replay does not churn the ticket; conflicting types/primaries are not repaired. Existing primary references, status, assignee and unrelated references are preserved.

The package exposes only `@pa-platform/pa-core/tickets/planned-actual`; no core or Pi export/composition hub wiring is required. The package previously had no wildcard subpath export, so this explicit finite export is necessary for normal Pi tool imports.

## Evidence at handback and later observations

The projection returns the complete selected binding and separates evidence class, result, locator, observation time, coverage and trust:

- **Source:** sanitized native report checks retain their original candidate and explicit `current`, `historical`, or `unverified` applicability. Only an exact output still present in native current `passedChecks`, with settled/proven source scope and a clean matching HEAD, is a current pass. A clean, settled, scope-proven matching candidate can also have a current failure: the check must match the exact output, candidate and exit code of the retained unresolved native `originalFailure`, and its named check must have no later `passedChecks` entry. A same-check pass supersedes that failure even before explicit resolution; an unrelated check's pass does not. Resolved, differently bound, dirty or unproven failures remain historical. Source Not run is added only when there is no current source observation. Invalidated passes and other historical observations remain visible but cannot conflict with or satisfy current evidence. Dirty candidates conservatively have no applicable green source facts: the retained candidate selector identifies HEAD, not changed file bytes, and Git status is not a content digest. Empty coverage means no per-AC coverage mapping was established, not that every AC passed.
- **Installed:** Not run until its own qualified owner supplies evidence. This phase adds no importer.
- **Independent:** Not run; agent narrative is not independent review.
- **Browser:** Not run; generating HTML or observing the report's reading view is not product/browser qualification. Existing report-delivery observations remain with their retained owner.
- **Human UAT:** Not run immediately at handback. It is never inferred from source checks, signing, report publication or generated HTML.

`pa_phase_report` `action: "observe-actual"` takes only the attached locator. It requires the same authenticated live report owner, foreground TUI and exact verified binding **before** showing the prompt. The operator selects AC coverage and Not run/Pending/Failed/Passed. No caller-provided result, evidence class, timestamp, identity or trust is accepted. The fixed human class is `local-unverified`; authentication is not provided. Detach/abort records nothing.

A later human observation is a separate immutable native record. Another locator appends it through the same ticket owner; prior locators, reports, Planned bytes and the original human Not run state remain readable regardless of ticket-ref ordering. Conflicting observations remain explicit, never chronological/latest-wins. Cross-owner writes into an ended deployment are not enabled.

## Failure and qualification boundaries

No plan, draft, no handback, checking, missing, denied, integrity failure, conflict, unknown and unmatched are distinct states. Wrong-ticket/subject/manifest/candidate records remain unmatched. Denied owner content is never returned; errors do not echo private exceptions. A malformed attachment is an explicit issue and does not erase separately verified matches. Attachment interruption preserves the existing immutable record/companion for exact idempotent retry; it does not replace an intent or overwrite a conflict.

Disposable tests exercise native draft/approved/retained Planned discovery before Actual, same-ticket membership and denied/mismatched labels, the reader's saved-approved-but-tampered fallback, immutable report/locator/ticket owners, bindings, conflict/order independence, append-only observations, and complete bounded normal-tool continuation with large Unicode AC expectations and later human evidence. Regressions also exercise maximum admitted 4,096-character scope, 64 long paths/omissions, paginated full custody observations, legacy records, finite detail validation, and clean-current versus resolved/superseded/dirty/stale source failures through native resolution and actual ticket attachment/dispatch. Stale snapshots, malformed coordinates and split-surrogate offsets are rejected. This is source/fixture evidence, not installed default-path qualification, a real foreground operator observation, independent product review, browser/AT acceptance or human UAT. Those remain **Not run/Pending** for P6. External PAPC policy, protected producer records/templates and live tickets/databases are unchanged.
