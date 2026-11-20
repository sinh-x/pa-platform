# PAP-312 native handoff source integration

Status: **opt-in source implementation; unselected and not product acceptance**.
The existing PAP-312 requirements, ancestor specifications and validation gates
remain controlling. This continuation does not install, enable, publish live
requirements, prepare a checkout, launch implementation or complete the ticket.

## Selection and compatibility

The source implementation adds `document.handoff` to the existing immutable
`pa-document-policy/v1` capability inventory. Only a fresh authenticated Pi
requirements/analyze session whose native start record explicitly selects that
capability registers `pa_handoff`. Existing selections, retained document
profiles, OpenCode, background/resume/inherited launches and arbitrary environment
changes do not gain the tool. No external configuration or runtime pin changed.

This is an explicit proposed producer/consumer contract for independent review,
not approval to select it. The configuration owner must reconcile and qualify the
actual full process, objective, dispatch and completion resources before adoption.
`document.package` remains a separate capability for authoring/checking/freezing
packages. Existing document scopes and registered producers are unchanged.

The native caller is derived from running registry state, original start event,
actual process fingerprint/lineage, Pi session, canonical repository and canonical
immutable capability binding. A separate handoff identity excludes only the
mutable ticket association so ticketless intake retains its original session
identity. Independent association admission still permits only the original
null-to-ticket edge; it cannot replace or adopt another association's history.

The finite review/Git owners use a caller-owned FULL-synchronous connection to the
existing WAL registry. The retained singleton stays NORMAL. No global durability
setting, historical decision or event is rewritten. Existing ticket/repository
owners retain the lock order and effect admission.

## Actual native request grammar

`pa_handoff` accepts exactly one `request` string containing strict JSON with
`schemaVersion: "pa-handoff-native/v1"`, `action`, and only the fields below.
Unknown/duplicate fields and imported actors, outcomes, receipts, roots, base
commits, provenance, paths, programs, arguments and environments reject.

| Action | Additional fields | Meaning |
| --- | --- | --- |
| `intake` | `ticket` **or** `title`, `content` | Reuse/associate one supplied ticket or recover exactly one session-bound creation. Returns `ticketVersion`. |
| `stage` | `ticket`, `requestId`, `expectedTicketVersion`, `stage` | Finite `analysis`, `review` or `changes-requested` transition through the existing ticket owner. |
| `plan` | `ticket`, `requestId`, `branch`, `expectedTicketVersion` | Owner-observed fresh develop pin or proven advanced-native reuse. Returns the original intent and plan identity. |
| `prepare-review` | `documentSubjectSha256`, `planRequestId`, `effects` | Derive/publish the complete immutable reader and freeze its exact handoff subject. Does not approve or open it. |
| `review` | `subjectSha256`, `expectedRevision` | One genuine native custom-UI decision, default Cancel. |
| `revoke` | `subjectSha256`, `expectedRevision`, `decisionId` | Native revocation, not rollback of completed effects. |
| `publish` | `subjectSha256`, `decisionId` | Consume the new finite grant for exact complete publication. |
| `complete-branch` | `subjectSha256`, `decisionId` | Complete only the correlated ref/link transaction after publication. |
| `queue` | `subjectSha256`, `decisionId` | Consume separately selected queue authority after exact ref/link completion. |
| `open` | `subjectSha256`, `deliverySha256` | Request the explicitly approved system-browser fallback for the verified bound local index. |
| `status` | `subjectSha256` | Existing-only original request/latest decision readback; does not create journal tables. |

`effects` has exactly three booleans: `publish`, `branchRef`, `queue`. The finite
sets are content-only, publication-only, publication+branch, and
publication+branch+queue. Branch requires publication; queue requires branch and
the package's queue proposal. Desired effect data is never authority.

Typical source flow:

1. Intake, then eligible stages and plan using returned complete-ticket versions.
2. Author/check/freeze the immutable package with the separate document owner.
3. Prepare the reader/review subject using the saved native plan request ID.
4. Optionally request the agreed browser fallback or review full source manually.
5. Review the complete documents, exact branch/base and finite effects in **one**
   native screen. Do not separately confirm the unchanged package first.
6. Publish, complete the branch, then optionally queue through their own owners.

After response loss, keep the original request ID, subject, decision, expected
revision and effect set. `status` exposes original review coordinates. A saved
request with no captured interaction remains uncertain; ordinary replay does not
open a replacement prompt. Changed content/intent/effects needs its own review.

## Registered branch conventions (PAP-324)

Native handoff consumes the selected repository's registered
`featureBranchPattern`, including its existing alias and omitted
`feature/<ticket>-<topic>` default. It does not accept a prefix merely because
another repository uses it. For example, a registered `feat/<ticket>-<topic>`
accepts `feat/HR-005-global-meta-recents`, not the corresponding `feature/` name.
Safe literal layouts such as `work/<ticket>/<topic>` also use the existing
escaped-template matcher, not an arbitrary regular-expression configuration.
Each usable template binds one exact ticket and one nonempty lowercase kebab
topic. Invalid present policy does not silently select the default.

Historical intent parsing is pure: it validates bounded Git-ref/ticket structure
without consulting mutable registration. The current registered template owns
strict topic matching at preparation, approval and effect boundaries; literal
framing is not mistaken for topic syntax. Existing canonical intent/subject
identities, reviewed names/base pins, lineage and attributed links are unchanged.
Naming-policy drift can block remaining writes, but cannot rename or repin an
issued intent or erase independently verified completed effects. The existing
develop-only, files-ref and SHA-1 boundaries remain unchanged.

Selected v2 `plan-status` takes the ORIGINAL `ticket`, `requestId`,
`expectedTicketVersion` and `branch`. Its public guards authenticate the existing
process, selection and unique registered physical root without probing Git or
opening a writable registry. Non-observational owners retain physical Git
reauthentication, including after asynchronous review. Status grants no effects.

After a lost reply, observe those same coordinates before any write. Preserve
later comments and distinguish absent, partial and complete native history.
An absent intent plus changed ticket version still needs the original plan
owner; do not refresh CAS, replace the request, rename an unknown intent, adopt a
same-name branch or edit raw records. Live HR-005 continuation remains separately
owned and requires its own admitted native review/effect sequence. Source tests
and code review do not establish installed qualification or human acceptance.

## System-default browser: explicit scope disposition

During this continuation, Sinh explicitly approved **a system-default browser
fallback**, while retaining the trusted-opener requirement as unmet. This changes
the published no-xdg-open constraint **for that convenience fallback only**.
It does not approve a trusted packaged browser or waive browser/security/UAT gates.

On Linux with an available desktop launcher/display, the adapter derives and
reverifies the exact immutable local index and all output hashes. It invokes the
resolved `xdg-open` executable with one native-derived file URI, no shell command
string and no caller argument/environment/program port. The invocation is bounded
to 15 seconds and its output is not exposed as trusted evidence.

Important limits:

- The system handler and its inherited desktop configuration/environment are
  operator-controlled, not a pinned immutable browser closure.
- The default browser may use its normal profile, network, extensions and desktop
  services. There is **no network isolation or browser descendant confinement**.
- `cleanup: settled` covers the **desktop launcher only**, not the browser. Results
  explicitly return `cleanupScope: desktop-launcher-only`,
  `browserLifecycle: not-owned`, `networkIsolation: not-provided`,
  `trustedOpener: not-qualified` and `viewing: not-established`.
- Exit zero means **open-requested**, not opened, viewed, approved or accepted.
  A nonzero/unknown launcher outcome stays uncertain because a handler may have
  already received the request. Reconciliation never invokes another launcher.
- The original uncertain opening is durable before invocation. Another caller
  cannot bypass an uncertain/active opening of the same delivery with a fresh
  identity. A missing original result needs its owner, not a blind retry.

## Source verification versus acceptance

New source tests exercise the registered native route, real disposable Git,
TicketStore and SQLite owners, supplied/ticketless association, original-request
replay, full reader, finite decisions/publication/ref/link and retained omission
boundaries. Custom-UI key events are explicitly synthetic, not human consent.
Desktop-launcher tests use disposable stubs and never open a real browser.

The actual worker termination-reply-failure test retains a real worker, observes
its uncertain fence, denies another derivation and clears it only on the actual
exit event. This is not proof of every 2-second cleanup-expiry path, RSS/image
budget or parent/browser lifetime guarantee.

Current command results and original failures are recorded in
[PAP-312 implementation progress](PAP-312-implementation-progress.md). Source
checks, independent protected review, hosted CI, exact installed/default-entry
qualification and genuine foreground/browser/all-18-human-UAT/adoption remain
separate evidence. The old document qualifier is not upgraded into a handoff
qualifier by adding source tests.

## Human-facing messages

Affected new paths: `handoff-tool.ts` descriptions/results,
`handoff-review-ui.ts` overview/document/technical tabs, and `handoffFailure` in
`handoff-native.ts`. Existing CLI JSON, exits, streams and document messages are
unchanged. Catalogue entries describe source dispatch only, never installed grants.

Before: the selected interface had no native handoff action; branch inspection
could only report observed readiness and full reader cores were unregistered.
After: the opt-in source tool reports approval, publication, branch, queue,
launch/UAT and browser limitations separately. Example data after real proof is
`publication: verified`, then `completion: verified`, with `launchReady: false`.
The fallback says `open-requested` and `viewing: not-established`, never “viewed.”

Typed failures produce one bounded outcome-first five-label guidance envelope.
Malformed exceptions and hostile proxies cannot provide public diagnostic text.
Structural/plain-text software assertions are not a human readability review or
installed propagation proof; both remain unperformed.
