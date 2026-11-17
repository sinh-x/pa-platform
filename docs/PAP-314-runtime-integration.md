# PAP-314 runtime integration and client handoff

**Runtime source support only.** P0–P3 are committed at `b537789`; this P4 handoff adds discovery, examples and verification, not an installed/default selection. **PAPC-090** owns later process/default integration. No external PAPC source, installation, activation or human UAT is delivered here.

## Authority and trust

- [P0 contract](PAP-314-local-review-contract.md) records the accepted deliberately unauthenticated design. Decisions say `local-unverified`, `authentication: not-provided`, `method: unauthenticated-local-confirmation`; they are **not authenticated human consent**. Any local process reaching the explicit listener can read eligible v2 reviews and submit decisions. Hashes identify subjects; they are not credentials.
- [PAP-312 native integration](PAP-312-native-handoff.md) owns the retained v1 route and system-default-browser limitation. Its v1 pending-review uncertainty must not be applied to intentionally pending v2 requests, or vice versa.
- [P3 repair report](../plans/reports/repair-261117-0434-pap-314-p3-r1-r4.md) retains original failures. The final section of the [independent review](../plans/reports/code-review-261117-0102-pap-314-p3.md) accepts the repaired **source** seams; it does not qualify an installation.
- Executable owners: [capability policy](../packages/pa-core/src/mode-capabilities.ts), [immutable selection](../packages/pa-core/src/mode-capability-selection.ts), [native dispatcher](../packages/pi-pa/src/handoff-native.ts), [strict local schema](../packages/pa-core/src/documents/handoff-contract.ts) (`parseLocalReviewRequest`), [shared local owner](../packages/pa-core/src/documents/local-review.ts), [review service](../packages/pa-core/src/documents/handoff-review.ts) and [journal](../packages/pa-core/src/registry/handoff-reviews.ts). Source discovery never grants execution.

The native caller is still authenticated as a runtime process/session. That does **not** turn a v2 local decision, even one captured in Pi foreground, into authenticated human identity evidence. No actor, credential, receipt, program, shell command, root, base SHA or provenance field may be supplied to the local request API. Historical v1 evidence and old document scopes remain unchanged.

## Source coverage matrix

### Selection and version boundary

| Surface/selection | Source coverage | Not implied |
| --- | --- | --- |
| Fresh supported Pi `requirements/analyze`, immutable `pa-document-policy/v1`, `document.handoff` | Registers `pa_handoff`; `pa-handoff-native/v1` keeps original-caller/native-foreground behavior | No automatic v2 selection |
| Same qualified fresh route selecting **all** `document.local-review`, `document.handoff`, `document.package` | Explicit `pa-handoff-native/v2`, persisted `pa-handoff-review/v2`; local request schema remains `pa-local-review/v1` | No default selection, installation or human authentication |
| `document.local-review` missing either dependency | Policy parser rejects | No inferred dependencies |
| Omitted capability, retained v1 subject/session, old document profiles/receipts, config edited after session start | No upgrade to local review or cross-session continuation | A new tool call/version string is not authority |
| OPA/OpenCode, background, resume, inherited/parent, rogue, pinned or ticket-worktree launch | No new qualified local-review session through this selection route | No adapter parity or fallback |
| Local CLI/API with a persisted eligible v2 subject | Verifies the **saved origin** and original selection, without authenticating the local decision submitter | Cannot mint a subject, select a policy, impersonate a running origin or obtain writer custody |

The policy/selection symbols above, `selectsDocumentSession` in [document-session.ts](../packages/pi-pa/src/document-session.ts), and registered tests are authoritative. Nothing here amends admission to make a client fixture work.

### Actual operations

`pa_handoff` accepts exactly `{ "request": "<strict JSON>" }`; v2 native JSON uses `schemaVersion: pa-handoff-native/v2`. Normal native responses use `pa-handoff-result/v1` with the owner's payload in `result`. CLI/HTTP return the local owner's payload directly, not that native envelope.

The native tool replaces results above its existing **50 KiB text threshold** with `output: bounded-summary-use-status-and-document-read` and selected coordinates/status, not the complete documents or history. Use supported document reads or CLI/API `show` for complete content within their 32 MiB response limit; over-limit CLI/API results reject rather than truncate. Native `show`/`status` therefore do not promise full-content delivery for a large package. This introduces no chunking or new read authority.

| Operation | Native v2 | CLI stdin / POST API | Effect/limit |
| --- | --- | --- | --- |
| `intake`, `stage`, `plan` | Yes | No | Native ticket association/creation, finite lifecycle or exact plan/CAS writes |
| `prepare-review` | Yes | No | Derives complete reader, freezes bound subject; effect-bearing preparation performs settling preflight, potentially appending stale history; no decision |
| `show` | Yes | `show` | Full exact saved package, all text/binary content, inventory, delivery, intent, history, eligibility and separate effects; existing-only |
| `status` | Alias to local `show` | Use **`show`**, not `status` | Native v1 status remains its narrower original-caller contract |
| `preflight` | Yes | No | Read-only eligibility/local-develop observation; standalone native call does not append stale history |
| `refresh` | Yes | No | Exact stale predecessor and complete-ticket CAS successor; may append a further stale disposition during successor preparation; never approves |
| `request` | Yes | `request` | Persists/reuses original pending capture; no UI or publication/ref/queue effects |
| `decide` | Yes | `decide` | Issues/replays one exact outcome atomically with generated provenance |
| `review` | Yes, foreground UI | No | Same v2 request/issue owner with native UI, default Cancel; no lock across reading |
| `revoke` | **Request-only in v2** | `revoke` | Distinct pending revocation request, finalized by `decide`; v1 retains foreground revocation |
| `publish`, `complete-branch`, `queue` | Yes, finite Pi owners | **No** | Independently admitted ordered publication/ref-link/optional queue; no launch |
| `open` | Yes | No | Bound system-default-browser request only; not viewing, isolation or browser lifecycle ownership |
| Interface discovery | Native tool description; capability catalogue | `ppa document review --help`; `ppa document describe --format json` describes **pa_document**, not a handoff schema endpoint | Static metadata, not installed availability |
| Dedicated listener | No native listener action | `ppa document review serve --port N` | **Resource allocation**, not a read; explicit loopback exposure |

[Interaction catalogue](../packages/pa-core/src/interactions/catalogue.ts) is source-only, with null live bindings. Its stdin form is conservatively `write` because the action may persist a request or decision; `show` alone is observational. Native preflight is `read`; refresh/request/decide/revoke are `write`. There are no fabricated `ppa document review publish`, refresh or queue commands. Fish completion is generated by [generate_completions.sh](../scripts/dev/generate_completions.sh); the exact `document review` path is separate from protected `ppa review preflight` and `ppa artifact review`.

## Client transport contract (Avodah-ready, inert)

This is a contract/example for an Avodah-owned local client, **not an Avodah UI, app, proxy or integration deployment**. The executable example data is [local-review-client.json](../packages/pi-pa/src/__tests__/fixtures/local-review-client.json). Its wrapper is test metadata, not a wire schema. Never send its illustrative hashes/decision IDs to live stores. Tests replace coordinates only with actual fixture-owner results; no secrets are present.

A client needs the exact `subjectSha256` from native preparation and access to the same existing local registry, ticket directory and artifact store as that runtime. It must not supply alternative roots or import receipts. Default store paths remain owned by the runtime, not a request parameter. A copied JSON decision or health reply is not a replacement journal.

Supported CLI grammar:

```text
ppa document review --request-stdin
ppa document review serve --port N
ppa document review --help
ppa document review serve --help
```

`N` is decimal 1–65535 without leading zeroes. There is no `--host`, actor/auth flag, background/stop/restart command or general Agent API route here. The explicit foreground server reports its numeric listening URL and trust as one JSON line; SIGINT/SIGTERM closes its listener/connections. Closing transport does not undo or prove cancellation of an already-started core operation.

For HTTP use **only** `http://127.0.0.1:N`:

| Route | Request | Result |
| --- | --- | --- |
| `GET /v1/health` | Exact numeric Host, no body | Constant `{schemaVersion: pa-local-review/v1, trust: local-unverified}`; does not open stores or prove subject eligibility |
| `POST /v1/review` | Exact numeric Host and `Content-Type: application/json` (optional UTF-8 charset); one strict request below | Same shared local-owner result as stdin |

No CORS, cookies or authentication. **Any Origin, including `null` and same-origin, rejects**; a browser page must not directly fetch this endpoint. An Avodah-owned local host process could use stdin or non-browser HTTP under its own separately authorized integration; this task supplies no bridge or exception. Do not send Authorization, Proxy-Authorization, Cookie, trailers, compression/content-encoding, query strings, Expect, upgrade or CONNECT requests. No enumeration, arbitrary file route, `OPTIONS` or `HEAD` interface exists.

Transport owners: [stdin/CLI](../packages/pi-pa/src/local-review-cli.ts), [dedicated server](../packages/pi-pa/src/local-review-server.ts). Limits are 64 KiB strict UTF-8 request JSON, depth 64, 8 KiB headers, 16 sockets, one active operation and **no queue**, 5-second header/body/write deadlines, 30-second total operation, 32 MiB serialized response. Unknown/duplicate decoded fields and over-limit results reject, not truncate. Replies are `Cache-Control: no-store`, connections close. An uncertain timed-out/disconnected operation retains the server's active slot until the owner settles.

HTTP 200 means a transport result, **not approval/effect success**: inspect `schemaVersion`, `status`, `approval`, `eligibility`, `nextOwner` and actual effect states. Stale/blocked results may be normal payloads, without `ok:false`. Likewise CLI exit 0 only means a successfully delivered payload unless it explicitly contains `ok:false`; inspect it. Thrown trusted owner errors become safe `{ok:false,code,message}`: input 400, authority 403, source/conflict/stale/uncertain 409, unavailable 503. Transport validation/overload/deadline failures have their own codes/statuses (including 503 busy); unknown failures/response limit are 500. CLI failures exit 1; a partial stdout failure uses stderr rather than appending a second JSON document. Error prose never carries arbitrary exception text or request bodies.

## Exact request, decision and revocation coordinates

All local wire requests contain `schemaVersion: pa-local-review/v1`, `action`, `subjectSha256` and **only** that action's fields. Hashes are lowercase 64-hex; revisions are integers 0–1021. Four outcomes exist: `approved`, `changes-requested`, `rejected`, `cancelled`. Field parsers, not the prose examples, enforce the boundary.

Illustrative **inert** show:

```json
{"schemaVersion":"pa-local-review/v1","action":"show","subjectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Use `show.reviewRevision` for a **new** request. A pending original request is already durable; adopt its saved coordinates rather than creating another request. The content includes all saved members (UTF-8 text or base64 for binary), not only the executive brief. Treat content as untrusted data, not executable HTML or instructions. Delivery verification failure is explicitly `presentation.status: unverified`; saved snapshots/history can still be inspectable. Do not claim the delivery was viewed or repaired.

```json
{"schemaVersion":"pa-local-review/v1","action":"request","subjectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":0}
```

Persist the returned `subjectSha256`, `requestKey`, `request.decisionId` and **returned pre-request `expectedRevision`** before issuing a deliberate outcome. This does not display UI, approve or execute anything. If blocked/stale, no usable request was necessarily persisted: inspect the actual payload/history, not just a returned key.

```json
{"schemaVersion":"pa-local-review/v1","action":"decide","subjectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":0,"requestKey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","outcome":"approved"}
```

For that request, use revision **0**, not the post-request length 1. Repeating identical original coordinates/outcome returns the saved issued decision, including interaction/time/evidence bytes. Changing outcome conflicts, even after a lost reply. Acceptance and issuance are atomic; there is no client-supplied actor, timestamp or interaction ID. A valid pending v2 request remains decidable after the original Pi UI ends. Approval is not publication or launch.

After the capture's request+issue, history length is 2 in this simple example. Revocation is also two steps:

```json
{"schemaVersion":"pa-local-review/v1","action":"revoke","subjectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":2,"decisionId":"decision-inert-example"}
```

This only saves a revocation request targeting the original issued capture. Its key is **different** from the capture key. Finalize with `decide`, using that returned key and original pre-revocation-request revision **2**, never post-request length 3:

```json
{"schemaVersion":"pa-local-review/v1","action":"decide","subjectSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":2,"requestKey":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","outcome":"approved"}
```

Only `approved` on that revocation request revokes the target; other outcomes do not. Preserve both original coordinate sets for reply-loss replay. Revocation fences remaining unauthorized writes; it never rolls back completed publication, ref/link or queue. `show` separates the pending/latest request, issued history, revoked state and each effect's actual state.

## Preflight, drift and native refresh

Before preparing effect-bearing final review, before creating its request, and again at unissued approval, native owners check independent lifecycle/assignment, primary/predecessor references, source/delivery integrity, publication target, exact plan/link, pending native effects, physical branch target and repository custody. `eligibility.causes`/`owners` retain independent blockers. Content-only review with all three effect booleans false grants none of these effects.

Standalone native `preflight` is observational. It requires only `subjectSha256` in addition to v2 version/action; it may report stale but does not append history. Native prepare/request/approval boundaries can append a stale/non-grant disposition. **No lock spans human reading**; serialization order is repository → ticket → journal. The observed reference is canonical **local** `refs/heads/develop`, without fetch or a remote-freshness claim. A successful issuance observation is the boundary; later develop movement never retargets an issued pin.

The compare value is `intent.base.observedDevelopSha`, not necessarily `intent.base.sha`: proven advanced-native reuse retains its original base and descendant ancestry. The runtime currently qualifies the default `develop` / `feature/<ticket>-<topic>` convention, files refs and SHA-1 Git; do not infer support for another repository scheme.

If unissued approval sees drift it returns `pa-local-review-stale/v1`, `status: stale`, full `oldDevelopSha`/`newDevelopSha`, `observedAt`, original `requestKey` (possibly null if no request existed), `approval: not-issued`, `effects: not-performed`, `nextOwner: native-refresh`. This is **not an invented rejection/cancellation**. The fixture contains an inert response example. Retain that original request; CLI/API cannot plan or refresh it.

Only selected native v2 can send `refresh(subjectSha256,expectedRevision,expectedTicketVersion)`; the latter fields come from the stale subject's current `show.reviewRevision` and `show.ticketVersion` when beginning the refresh. The fixture's native examples are passed through the actual registered dispatcher in tests. The owner proves the precise predecessor plan and unchanged planned link, rejects uncertain/partial effects and uses complete-ticket CAS. Old plan/request/audit/link attribution survives; the successor has a new review subject and native plan identity. It is **not automatically approved**.

Save the original refresh fields before calling. After lost refresh reply reuse **those same fields**, not newly sampled ticket versions: the native owner recovers the same successor operation. Reobserve the returned successor preflight and complete documents/intent, then deliberately request/decide approval on the successor's own original coordinates. Further drift can require another exact successor. Issued historical decisions and completed refreshes replay their original results rather than repinning.

## Original origin versus current continuation caller

A v2 subject binds original deployment/session, immutable selection/caller hashes and native plan identity. Local show/request/decide/revoke verify that saved provenance; they do not require an ended origin to masquerade as a running process. Native mutation still authenticates the **current** selected Pi process/session independently.

Fresh continuation is a narrowly checked exception for the same original finite effects, not resume, inherited selection or custody transfer. It needs:

1. A fresh qualified explicitly selected Pi requirements/analyze caller associated with the same ticket/repository; its current immutable binding remains authenticated. No unrelated current or historical ticket owner may be ignored.
2. The exact original start/selection/association and completed native plan. The origin must have one consistent terminal record, no fallback, an absent original PID/process, and the Pi host's saved original process-death proof. Live or uncertain origin state rejects.
3. Repository/ticket custody exclusion with protected prepared-inventory checks on **every remaining write**. Same-ticket retained reservations reject; unrelated preparing/active/uncertain custody rejects. Only proven unrelated idle custody can coexist. Workflow/intent, lifecycle, original plan and full attributed link checks still apply.

The current caller is never returned as the ended origin or vice versa. Original request/audit attribution and operation IDs do not change. An environment/config edit cannot widen the old session, and an external local approval is not source/resource authority. See `assertLocalHandoffCaller`, `assertLocalHandoffRepository` in [handoff-preflight.ts](../packages/pa-core/src/documents/handoff-preflight.ts), native `reviewHost`, and [registered continuation tests](../packages/pi-pa/src/__tests__/handoff-native.test.ts).

## Publication, attachments and recovery — no launch

[Finite publication owner](../packages/pa-core/src/documents/handoff-publication.ts), [ticket publication](../packages/pa-core/src/tickets/package-publication.ts) and [native ref/link owner](../packages/pa-core/src/documents/handoff-native-branch.ts) remain controlling, in this order:

1. Publish **all** frozen source members and attach the complete verified reader bundle: index, manifest, every member HTML, every raw source, and native-derived decision tracking JSON. Tracking is derived evidence, not importable approval authority.
2. Only after that complete set is verified, promote the **requirements source** as the sole primary requirements document. Brief/other attachments are not a substitute primary; exact predecessor references remain checked.
3. Physically create/reuse only the approved pinned native branch, correlate original operation/ref evidence and the full structured ticket link including original attribution. Replaced links are rejected, not adopted/repaired. Lifecycle/link/unsettled-intent checks precede a missing ref write.
4. Queue only when exact publication/tracking and correlated branch/link are verified, and queue is in the exact approved effect scope. The outcome is `pending-implementation` assigned to `builder/team-manager`, **not a running builder**.

Separate status records use `not-started`, `partial`, `verified`, or `conflict-or-unknown` for publish, branchRef and queue. `approval`, `eligibility`, actual effects and `nextOwner` answer different questions; post-publication eligibility can be blocked while historical publication remains verified. No single green “approved” badge may imply launch readiness.

After interruption retain subject, decision, request/revision, plan and original operation IDs. Use show/status first; do not replace intent, delete evidence, force unlock, reset a counter, ask another approval to conceal uncertainty, or repeat an opening with a new identity. Resume a proven same-operation remainder only through its finite native owner and renewed admission. Missing/changed evidence routes to that owner, not an automatic retry loop.

Already-applied publication, exact completed ref/link and an already-applied **started original v2 queue** can be observed/settled without authorizing a missing external write after revocation. This does not relax retained v1 queue replay's live-grant requirement. Partial missing writes remain fenced after revocation. A transport timeout/reply-size failure can follow a committed decision; it is never proof that nothing changed.

No worktree creation, capacity/lease allocation, checkout switching, stash/reset/discard, push, merge or implementation launch is authorized. `launchReady: false` and `productUat: not-asserted` remain explicit. Optional bound `open` uses the agreed system-default-browser fallback only: `viewing: not-established`, `networkIsolation: not-provided`, `trustedOpener: not-qualified`, `browserLifecycle: not-owned`. Static reader HTML is inert; it has no decision submission controls.

## PAPC-090 compatibility and pair qualification prerequisites

PAPC-090 is the external configuration/process owner's later work, **not completed by this runtime handoff**. A policy fixture is not a change to selected `teams/requirements.yaml`, a runtime pin, deployment default or live approval process.

Before default adoption the configuration/runtime owners must jointly qualify the actual selected pair:

- Selected committed resource/revision/digest, runtime build/adapter identity and immutable start binding must agree. Unknown capability/dependency/profile fails closed. A new default applies only to a genuinely fresh supported session, never retained/resume/background/OPA routes.
- Reconcile full requirements process, objective, native dispatch and completion resources with the exact source matrix: prepare the full bundle, disclose unauthenticated confirmation, branch on blocked/stale outcomes, preserve original replay/revocation/refresh coordinates, and call only native finite effects. Do not script nonexistent CLI effect parity or infer consent from `question`/an imported receipt.
- Verify runtime/core/CLI packages and reader workers together with the real local registry/ticket/artifact layout; qualify actual normal-entry native foreground, stdin and loopback API propagation. Health/help/catalogue discovery alone is insufficient. No new setup/install command is prescribed here.
- Exercise omission/retained-version negatives, stale and repeated-refresh/reply loss, revocation-before/after-partial-effects, independent custody/lifecycle/link blockers, and ended-origin/current-caller continuation on that selected pair. Preserve safety/audit owners rather than relaxing them to fit process resources.
- Collect installed normal-entry and foreground evidence, hosted CI, real browser/keyboard/narrow-screen/zoom/accessibility/readability observations and Sinh's actual UAT separately. Synthetic key events, inert fixtures, source tests and independent source review do not supply those results.

No authentication deployment is promised; any future authenticated design needs its own explicit version/provenance rather than relabeling historical local-unverified decisions.

## Verification navigation

- [Catalogue tests](../packages/pa-core/src/__tests__/interactions-catalogue.test.ts): real operation forms/risk, no live bindings or fabricated CLI parity, conservative reviewed source guard.
- [Client/schema/completion tests](../packages/pi-pa/src/__tests__/local-review-contract.test.ts): strict examples, original revocation coordinates, generated PPA/unchanged OPA, exact fish command-path isolation.
- [Registered native tests](../packages/pi-pa/src/__tests__/handoff-native.test.ts): actual disposable Git/TicketStore/registry, default CLI/API shared state, stale native refresh, original revocation, omission/retained/continuation and ordered full-bundle effects.
- [Local core tests](../packages/pa-core/src/__tests__/document-local-review.test.ts), [CLI tests](../packages/pi-pa/src/__tests__/local-review-cli.test.ts) and [server tests](../packages/pi-pa/src/__tests__/local-review-server.test.ts): strict boundary, no-auth provenance, replay, safe diagnostics and bounded transport negatives.
- [P4 phase](../plans/261117-PAP-314-requirements-review-approval/phase-04-runtime-integration.md) and [P4 results](../plans/reports/implementation-261117-0544-pap-314-p4-runtime-integration.md) record actual commands/outcomes and unperformed qualification. This document is the runtime client handoff, not live authority or proof of default activation.
