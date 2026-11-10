# Requirements workspace integration contract (PAP-273 / PAPC-077)

Source interface only; not installed/selected capability or end-to-end acceptance.

The sections below retain the original **v2** contract, including its unavailable
capture. The approved d-199e82 follow-up adds **v3**, not a retroactive v2 upgrade;
see [the native confirmation/branch bridge follow-up](PAP-273-native-confirmation-follow-up.md).

## V3 successor — actual source interface

Fresh normal Pi requirements/analyze may opt in with
`document_profile: pa-document-confirmation/v3`; native start must be
`requirements-document-confirmation/v3`. V1/V2/resumed/retained runs do not upgrade.
In V3, `pa_document` supports strict requests:

- `confirm(sha256, expectedRevision, scope)` where scope is `content`, `publish` or
  `publish-and-queue`. One native TUI choice is the final decision; document and
  technical tabs are optional reading, not acknowledgements. No earlier chat
  attestation, typed digest, second approval, caller outcome/principal or receipt
  import is accepted.
- `confirm-revoke(sha256, expectedRevision, decisionId)` appends a native lifecycle
  record, preserving original JSON and completed effects.
- Operator `/pa-approve <raw confirm-or-confirm-revoke JSON>` calls exactly the
  same service. No standalone approval CLI/subprocess or HTTP server is introduced.
- `branch-inspect(ticket)` reobserves existing ticket intent through repository,
  Git, Treehouse and protected ownership readers. It returns specific findings,
  not preparation, custody, capacity or launch permission. The input does not
  accept branch/base/worktree paths or mutation options.

Capture requires the authenticated native custom UI. `capabilities` distinguishes
actual V3 UI availability from the retained V2 attestation limitation. A single
screen offers complete immutable text and technical/companion bindings with
Approve / Request changes / Reject / Cancel; Cancel is the default. Local native
TUI/UID is managed-agent provenance, not independent human identity proof.

Same-request retries retain the **original** expectedRevision, scope, subject and
revocation target. They reconcile an issued decision/file/ticket link without
another prompt. Status/show lists original request coordinates after interruption.
Concurrent identical tool/command requests within the same native caller share
one in-flight operation; a competing different request conflicts. Durable journal
CAS still prevents duplicate grants across processes. A crash before issuance
is not a recorded human decision.

Representations are `pa-document-approval/v1` JSON under native-derived
`agent-teams/requirements/artifacts/approvals/<ticket>/<decisionId>.json`.
Deterministic UTF-8 pretty JSON ends with one newline; its digest is outside its
hashed bytes, in native result/ticket tracking. Registry records/evidence remain
canonical authority. File/link/comment recovery is read back before reporting
complete, with no historical primary-document overwrite. Content-only decisions
cannot publish or queue. Scope never grants execution, builder launch or UAT.

PAPC-077 must update/review the complete supported instruction closure against
these interfaces before coordinated selection. No external config/pin change,
Nix installation, installed qualifier result or genuine foreground UAT follows
from source implementation or the `.6` trial label.

## Version and launch

The sole new config opt-in is `document_profile: pa-document-workspace/v2` on
`requirements/analyze`. Fresh normal foreground Pi launch records
`requirements-document-workspace/v2` in the immutable native start event.
The existing launch exclusions (retained pin/resume, inherited, background,
rogue-one, ticket-worktree) remain. Current config/env text cannot upgrade a run.
Old `pa-document-package/v1`, retained JSON workflows and OPA keep old semantics.
Do not activate this partial profile as a completed approval replacement.

## Actual supporting tools

`pa_workspace` takes one raw strict JSON `request` string. No caller root, actor,
outcome, command environment, approval or executor override is accepted.

```json
{"action":"capabilities"}
{"action":"write","path":"scripts/count.py","content":"print(2)\n","expectedSha256":null}
{"action":"import","path":"README.md","destination":"inputs/README.md"}
{"action":"run","program":"python3","path":"scripts/count.py"}
{"action":"read","path":"outputs/result.json"}
```

`write` uses absent-only creation or exact current SHA-256 replacement. `import`
is absent-only and copies one explicitly selected safe regular repository file;
no directory, Git metadata, symlink/hardlink, secret or remote import. Helpers
support trusted Nix `node`, `python3`, `bash` only when present. Scripts choose
workspace output names. Helper environment is empty except fixed locale,
workspace-relative program PATH and isolated HOME/TMPDIR. There is no product
repository/host HOME/network/service/foreign-deployment mount. Do not promise
live household/production input, arbitrary toolchains or public external effects.

Working files are unsigned, mutable and native-deployment scoped under
`agent-teams/requirements/artifacts/drafts/<deployment>/workspace/`. They can be
saved, repaired and read without ticket/catalogue/final-package gates. Helper
records persist outside the helper mount in sibling `helper-results/` with
private permissions. A durable pre-dispatch intent and exclusive native active
marker protect interrupted/unknown helper ownership. Unsettled markers block
workspace writers (not safe reads); only native proven settlement clears them.
There is no caller cleanup/result override. Outcome,
cancellation, output-limit and cleanup facts stay distinct. No automatic cleanup
or workspace expiry is introduced. Existing historical artifact read owners are
unchanged; there is no foreign write capability or new historical-read override.

`pa_document` keeps its existing strict package/check/freeze/show/read/compare,
status/intake/publication grammar. Use `capabilities` rather than assume parity.
For v2 only, `present(sha256)` derives full immutable Markdown and safe static HTML
links plus a source/renderer-hash manifest. It neither opens nor observes a viewer.
Images and diagrams may remain opaque/inert; Okular export is unavailable. Offer
an explicit Markdown/browser fallback, never claim generated means read.

## Deliberately unavailable human confirmation

V2 capture/revoke return `DOCUMENT_UNAVAILABLE` before any legacy UI. There is no
`confirm`, `approve`, event import, conversational outcome or transcript tool.
Pi's current source label is not an authenticated original human-event receipt.
Question answers/chat/model text do not acquire authority in this implementation.
A host-owned attested event identity, exact pending-target association and native
replay/CAS protocol must be implemented before completing the proposed one-chat-
confirmation flow. V1 native paged/select capture is unchanged **for v1 only**.
Do not ask redundant or invented approval ceremonies to repair this infrastructure.

PAPC may consume safe authoring/presentation capabilities in a reviewed successor,
but must not advertise the complete proposed flow yet. Update the entire new
instruction/primer/template closure together through PAPC-077; retain old bytes.
PAP-285 owns external selection/provenance design; no build-pin refresh is made.

## Diagnostics and evidence

New workspace JSON is `pa-workspace-result/v1`; errors preserve a bounded native
code plus one operation-local Condition/Source/Reason/Correction/Resume Action
message. No formatter probes or raw error text. Before: generic route denial for
all helper work. After: supported confined workspace operations proceed; missing
trusted program yields `DOCUMENT_UNAVAILABLE` and runtime-owner inspection advice.
A nonzero helper result remains an actual failed command, not security approval.

Every reply is bounded to 50 KiB. Lost/oversized helper replies retain operation
identity and evidence locator; inspect before retrying any uncertain helper effect.
Read-only file excerpts are limited to 16,000 characters. Current file/write,
request, wall/CPU/output/descriptor/AS/shared-UID process limits are returned by
`capabilities`; see the phase report for exact values and quota limitations.

On v2, `pa_document status(ticket)` additionally reports caller association,
recorded queue state, absent/recorded-unverified/multiple-recorded-unverified
branch evidence, unsupported branch bridge, unobserved custody and
`launchReady: false`. This is readback of native ticket records, not current Git
or checkout authentication. Ticket creation does not associate the session.
The ticket/launcher owner must coordinate branch planning/readback; there is no
`pa_document branch-plan`, `associate-ticket`, `approve` or `launch` action.

This contract does not implement branch-plan writes, builder launch/custody,
installation, active config selection, foreground human evidence or product UAT.
