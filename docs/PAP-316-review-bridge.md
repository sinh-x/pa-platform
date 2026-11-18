# PAP-316: requirements local-review bridge

Status: implemented in source, disabled by default. Requirements workflow only;
**all Builder work is deferred**. No install, activation, live ticket/database
change, publication, ref/link creation, queueing or implementation launch was
performed by this change. Disposable tests are not installed qualification.

The 2026-11-18 repair below addresses independent review **finding 5 and bridge
test isolation only**. Findings 1–4 and broader PAP-316 qualification are not
closed or claimed by this repair.

## Ownership and task state

- [x] Read repository instructions, CLI message standard, PAPC final-gate and
  runtime-handoff; verify the real general-server launch and native peer boundary.
- [x] Preserve the intended-cause HTTP red before implementation.
- [x] Add explicit production opt-in and a transport-only bridge to
  `executeLocalReview` in `pa-core/src/documents/local-review.ts`.
- [x] Qualify real HTTP parity and negative cases using disposable native fixtures.
- [x] Run focused regressions, workspace typecheck/build and document limits.
- [x] Repair finding 5 with an intended-cause raw-socket red/green and preserve
  ordinary HTTP keepalive/CORS/WebSocket behavior without shared cancellation.
- [x] Enclose every bridge test in a disposable environment before API/TicketStore
  construction or valid missing-subject dispatch.

The existing `LocalHandoffReviewService` and `RegistryHandoffReviewJournal` remain
sole decision/state owners. No owner, ledger, identity, actor, receipt import,
workflow policy, quality gate, effect runner or approval format is added.
The core document owner, Pi transports, native handoff source, protected identity,
mode, primer, deploy and ticket sources are unchanged by this bridge work.
Other concurrent work in the shared tree is not part of this report.

Policy context: PAPC's staged/unselected analyst-workflow `final-gate.md` and
`runtime-handoff.md`; this bridge does not activate that workflow or qualify
PAPC semantic findings across media. See [the existing local-review contract](PAP-314-local-review-contract.md)
and [CLI message standard](cli-message-standard.md).

## Actual production entry and endpoint

The shared CLI path is `runCoreCommand` → `runServeCommand` →
`runServeLifecycle` → Hono's Node HTTP adapter. `ppa` and `opa` both dispatch
`serve` to this owner; no adapter-specific launch changes are needed.

Supported opt-in grammar (examples only; **not executed against live state**):

```text
ppa serve --host 127.0.0.1 --port 9848 --local-review
ppa serve restart --host 127.0.0.1 --port 9848 --local-review
ppa serve --host ::1 --port 9848 --local-review
ppa serve --host 127.0.0.1 --port 9848 --background --local-review
ppa serve --help
```

`opa` uses the same shared `serve` grammar. Programmatic lifecycle callers use
`runServeLifecycle({ ..., localReview: true })`; it passes
`enableLocalReview: true` to `createAgentApiApp` and supplies the returned native
factory to the real Node server. These are different option names at their
respective boundaries, not a separate standalone core-server CLI.
The flag is valid only for start/restart. It is passed to a background child and
must be supplied again on restart. There is no environment/config opt-in.
`--local-review` with `0.0.0.0`, `::`, `localhost` or any other bind is rejected
**before** PID inspection, force/stop/restart effects, child spawning or listening.
Normal server defaults/exposure are unchanged when the flag is absent.

Implemented review endpoint:

```text
POST http://127.0.0.1:9848/api/documents/local-review
POST http://[::1]:9848/api/documents/local-review
Content-Type: application/json
```

No query, suffix, alternative effect route, enumeration or arbitrary file path is
accepted by this bridge. General server health remains `GET /api/health`;
the dedicated Pi listener's `/v1/health` and `/v1/review` are not renamed or added
as general-server aliases.

Programmatic consumers use `createAgentApiApp({ enableLocalReview: true })` and
pass **both** `api.app.fetch` and `api.createServer` to the Node adapter's `serve`.
The optional factory performs native HTTP ingress before general CORS/error
middleware. Omitting it fails closed: the Hono-only route returns 403, never
executes the owner and does not enable CORS. Opt-out returns 404. Embedders must
bind numeric loopback; the route independently rejects a broad actual bind even
when a client supplies a fake loopback Host.

## Same strict request and response

Use the existing `pa-local-review/v1` request, with the ORIGINAL coordinates
returned by the shared owner. Hashes identify saved subjects; they are not
credentials. Supported fields are exact, not extensible:

| Action | Required fields in addition to `schemaVersion`, `action`, `subjectSha256` |
| --- | --- |
| `show` | None |
| `request` | `expectedRevision` |
| `decide` | `expectedRevision`, `requestKey`, `outcome` |
| `revoke` | `expectedRevision`, `decisionId` |

`outcome` is `approved`, `changes-requested`, `rejected` or `cancelled`.
`expectedRevision` is the original **pre-request** revision, not a guessed current
journal length. `revoke` only saves a revocation request; its returned request key
and pre-request revision must be deliberately decided through `decide`.

A read-only request shape, with a placeholder rather than a runnable subject:

```json
{
  "schemaVersion": "pa-local-review/v1",
  "action": "show",
  "subjectSha256": "<original saved subject SHA-256>"
}
```

Successful JSON is the existing owner's result without a transport success
wrapper, imported actor or synthesized effect state. `show` includes the exact
subject/intent, complete documents, inventory/delivery, eligibility, history,
original coordinates and separately owned effect states. The response does not
manufacture a PAPC semantic quality/readiness judgment.

Native `DOCUMENT_*` failures retain their codes. HTTP statuses are 400 for input,
403 for authority, 409 for source/stale/conflict/uncertainty and 503 for owner
unavailability. Transport failures use `LOCAL_REVIEW_*`: 400 invalid headers/Host
or input, 403 peer/Origin, 404 target, 405 method, 408 input deadline, 413 body,
415 content, 431 headers, 503 busy/response limit, 504 overall deadline or 500
unknown internal failure. Failure JSON is `{ ok: false, code, message }`.
Private exceptions, request bodies and credentials are never diagnostic text.

## Ingress, resource and trust boundaries

- Trust comes from the Node server's actual bound address and native socket's
  local/remote addresses, not `Host`, proxy headers, Hono `app.request` data or an
  injected peer callback. Only exact numeric `127.0.0.1` / `::1` are supported.
- Exactly one Host must match the numeric bind and actual listening port.
  Duplicate headers, forwarded headers, Authorization, Proxy-Authorization,
  Cookie, deployment/pair credentials and trailers are rejected. Claimed actor,
  provenance, identity, roots, receipt and effects fields fail the strict schema.
- **Every Origin is rejected**, including `Origin: null` and empty Origin.
  Preflights cannot enable this route. It bypasses general `--cors` and generic
  exception wrappers; no CORS response headers are emitted by the bridge.
- Requests are streamed with a 64 KiB inclusive byte cap, fatal UTF-8 decoding,
  duplicate decoded-key rejection and the existing strict depth/field/value
  grammar. Content is JSON with optional UTF-8 charset only, without compression.
  `Expect`, upgrade and tunnelling are unsupported for review.
- Header cap: 8 KiB. Connection cap: 16. Initial header/body/write deadlines:
  5 seconds. Total review transport deadline: 30 seconds from connection start.
  One active review operation, no queued work. Before any listener or async work,
  native ingress marks a review-targeted socket as review-owned, even when the
  first review will be rejected. Every subsequent request, Expect/continue,
  upgrade or CONNECT event is discarded before general/Hono/WebSocket listeners.
  The first response still settles and closes the socket under existing deadlines;
  discarding later work neither aborts its owner nor synthesizes cancellation.
  Review-targeted upgrades also never reach general upgrade listeners.
- With opt-in, the parser header cap, connection cap and initial-header deadline
  necessarily protect the **whole listener**, before a route can be identified.
  The review admission slot/body/write/overall deadlines apply only to review.
  Existing general HTTP/CORS, health and WebSocket routes retain their owners;
  a WebSocket upgrade clears the initial HTTP header timer.
- Serialized replies are at most 32 MiB, checked before sending, never truncated.
  Deadline callbacks cannot preempt synchronous core work; elapsed time is also
  checked before dispatch and before a successful reply. This is not a hard
  execution cancellation mechanism.
- The dispatcher is dynamically imported only after native ingress, bounded body,
  fatal decoding and strict schema validation. Rejected ingress does not call it
  or initialize/migrate a review database.

**Trust remains local-unverified / authentication-not-provided /
unauthenticated-local-confirmation.** Any local process able to reach this
explicit listener can read eligible v2 subjects and submit decisions. Existing
authenticated ticket/deployment boundaries are unchanged, but their credentials
are deliberately not accepted here and do not authenticate human consent.
Loopback and browser-request checks are not hostile same-user isolation. A local
proxy that hides its existence is indistinguishable from another local process;
this is not a forwarded/network review product.

## Disconnects, approval and execution

Closing a client, abandoning input, timing out or losing a reply is **not** an
explicit `cancelled` decision and never triggers cancellation of the shared
review. Once dispatched, the owner settles independently. The admission slot is
held until that owner settles even if the response has already closed/timed out.

A reply can be lost after persistence. Retain the ORIGINAL subject, request key
and pre-request revision. Inspect the same owner's `show` result before another
write; an identical decision replay returns the same saved result, while a changed
outcome conflicts. Do not create a new intent, ask for replacement approval or
infer rollback from a transport failure.

Approval without a runner stays approved. The shared `show` result identifies
`launchReady: false`, `firstUnprovenEffect` and `nextOwner`; the bridge adds no
publication, repository-ref/link, queue or runner authority. These effects remain
separately admitted native operations. No advice in this document invents an HTTP
effect endpoint or a CLI effect command.

## Messages and review evidence

Changed categories: **information/help** (`serve --help`) and **failure/blocker**
(new opt-in validation and HTTP failures). Routine success/progress/warnings and
existing machine success results are not rewritten.

Before → after examples:

- Help: no general-server review option → `--local-review: opt in to POST
  /api/documents/local-review; requires --host 127.0.0.1 or ::1`, followed by
  local-unverified/no-browser/no-effects limits.
- Attempted opt-in: `Unsupported serve option: --local-review` →
  `Local review server not started.`, with a typed numeric-bind/options reason
  and the five-label diagnostic below.
- Review request: general-server 404 → native owner JSON on valid enabled ingress;
  Origin failure becomes a bounded `LOCAL_REVIEW_ORIGIN` diagnostic, not a raw
  exception or a claim that an approval was undone.

Example new Origin blocker (plain text; no source/context needed to read it):

```text
Local review did not return a complete result.
Condition: The requested review transport is blocked or its result is unproven; a lost reply does not cancel a shared review.
Source: General PA-server local review bridge and existing document owner.
Reason: Any Origin header is forbidden, including an empty value or null. Browser requests and CORS are unsupported.
Correction: Ask the server owner to inspect the supported input, bind and original request. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: retain the original subject, request key and pre-request revision; inspection or repair needs its own authority.
Resume Action: Correct the failed prerequisite before retrying. If an operation started or its reply was lost, establish its result through the same owner's show action using the ORIGINAL coordinates before another write. Do not request a replacement approval. Any resumed effect request rechecks admission.
```

All new failure causes are static, with exactly one each of Condition, Source,
Reason, Correction and Resume Action and `message.length <= 2000` assertions.
The operator's recommended action is inspection coordination, not repair or
permission to execute effects. Plain-text readability was self-reviewed; this is
not an independent review or genuine human acceptance.

## Finding 5 and test-isolation repair (2026-11-18)

Only these files changed for the repair:

- `packages/pa-core/src/agent-api/routes/local-review.ts`: add a per-connection
  review-owned flag and gate the native server's ingress event dispatch. A normal
  upgrade listener cannot enforce this boundary: Node still invokes later
  listeners after it returns or closes a socket. The gate runs before all such
  listeners and before the nonreview fallback, including Expect and CONNECT.
  Later input is paused/discarded while the first response/owner retains its
  existing deadline, admission-slot and close lifecycle. No integration edit,
  new owner, cancellation hook or diagnostic/machine-contract change was needed.
- `packages/pa-core/src/__tests__/agent-api-local-review.test.ts`: outer
  `beforeEach`/`afterEach` disposal sets HOME/XDG and all platform config, resources,
  data, AI-usage and registry paths before any test body. Nested native fixtures
  restore that outer environment; teardown closes the singleton before removal
  and restores the original environment. The strict-input test proves the API's
  TicketStore directory is disposable, invalid ingress creates no registry, and
  the valid missing-subject request reaches only an initialized disposable registry
  (503 `DOCUMENT_UNAVAILABLE` because no review journal exists there).
- This document: clarify the real opt-in entry and record bounded repair evidence.

The regression matrix uses **real raw sockets**, a harmless state-changing Hono
recording route, actual WebSocket injection and independent upgrade/CONNECT
listener counters. Rejected, accepted and slow-body reviews each precede ordinary
requests, `100-continue`, unsupported expectations, unrelated/review-targeted
upgrades and CONNECT. All counters must remain zero, with no interim continue or
WebSocket handshake. Accepted/slow approvals must still be canonically issued and
replay as approved; rejected input must leave the original request pending, not Cancel.
The slow case synchronizes on a separate `LOCAL_REVIEW_BUSY` response, not a sleep.
Positive tests preserve ordinary pipelining/keepalive, health/CORS and WebSocket
connections beyond the initial-header deadline, plus rejection of a first
review-targeted upgrade before any other upgrade listener.

Commands below ran with `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`. Focused
regression commands also had an outer shell-owned disposable PA/XDG environment;
bridge tests additionally have their own per-test environment. Source SHA-256
snapshots matched before/after the focused checks:
`/tmp/pap316-p4-bridge-review-sources-{before,after}.log`.

- Intended-cause red, **16 failed / 4 passed** before the route fix:
  `corepack pnpm --filter @pa-platform/pa-core exec tsx --test
  --test-concurrency=1 --test-name-pattern='review-owned socket|first review-targeted|strict streamed'
  src/__tests__/agent-api-local-review.test.ts`.
  `/tmp/pap316-p4-bridge-review-red.log` records actual Hono/upgrade/CONNECT
  invocation counts of 1 instead of 0, not an import/environment failure.
- Narrow green, **21/21 passed**, same command with
  `--test-name-pattern='review-owned socket|first review-targeted|strict streamed|ordinary nonreview'`:
  `/tmp/pap316-p4-bridge-review-green.log`.
- Final focused API/document checks, **117/117 passed (34 bridge tests)**:
  `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1
  src/__tests__/agent-api-local-review.test.ts src/__tests__/document-local-review.test.ts
  src/__tests__/agent-api.test.ts`, `/tmp/pap316-p4-bridge-review-focused.log`.
- Serve checks, **9/9 passed**: `corepack pnpm --filter @pa-platform/pa-core exec
  tsx --test --test-concurrency=1 --test-name-pattern='runCoreCommand.*serve'
  src/__tests__/cli-core-command.test.ts`, `/tmp/pap316-p4-bridge-review-serve.log`.
- Existing dedicated transport checks, **29/29 passed**: `corepack pnpm --filter
  @pa-platform/pi-pa exec tsx --test --test-concurrency=1
  src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts`,
  `/tmp/pap316-p4-bridge-review-transports.log`. No Pi source edits were made.
- Workspace `corepack pnpm typecheck`: **passed**, including its existing build
  prerequisites, `/tmp/pap316-p4-bridge-review-typecheck-final.log`. No separate
  full workspace build/test/completions run or lint script is claimed.
- Owned-file whitespace checks (including these untracked files): **passed**,
  `/tmp/pap316-p4-bridge-review-whitespace.log`.

Intermediate attempts remain recorded: `red-initial.log` corrected two harness
assumptions (missing journal is unavailable; capture is bytes, not a decision);
`green-initial.log` caught a missing runtime import; `typecheck.log` caught the
HTTP server emitter's string-event signature. All have the same
`/tmp/pap316-p4-bridge-review-` prefix and were corrected before final checks.

No identity/native Pi source, config, installation, staging, commit, live-state or
Builder change was made. Existing numeric-loopback, actual bind/peer, Host, Origin,
credential, input/response limit and no-runner restrictions remain unchanged.
This evidence is source/disposable verification only; it does not close other
review findings or qualify installed/human journeys.

## Initial implementation evidence (before independent review)

The following historical checks preceded finding 5 and the ambient-test-path
finding; they did not establish those missing guarantees. The repair checks above
supersede them for the current bridge.

The test-first red is `/tmp/pap316-p4-bridge-red.log`: initialized disposable native
v2 fixture, real opted-in HTTP server, expected 200, observed **404**. It was not
an import, SQLite or environment failure. Subsequent corrections included a test
substring assertion (`::` also occurs in allowed `::1`) and factory typing.
An intermediate unrelated unowned primer type error was observed; this work did
not inspect/edit that concurrent source, and subsequent workspace checks passed.

Checks use `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`:

- Bridge suite: real shared-owner HTTP show/request/decide/revoke, exact replay,
  conflicting outcomes, approved-without-runner, unchanged tickets/refs/effects,
  disabled route, Hono-only peer failure, hostile ingress, strict limits,
  disconnect/reply loss, overload, socket cap/deadlines, and disposable production
  CLI dispatch. Key parity uses no injected handler. The native fixture backs up
  its initialized database before adding native origin/plan evidence. Some negative
  tests lacked outer isolation at this point; these historical results do not prove
  zero ambient I/O. The repair above adds that missing isolation.
- Core focused command: `corepack pnpm --filter @pa-platform/pa-core exec tsx
  --test --test-concurrency=1 src/__tests__/agent-api-local-review.test.ts
  src/__tests__/document-local-review.test.ts src/__tests__/agent-api.test.ts`:
  **97 passed**, including **14 bridge tests**, `/tmp/pap316-p4-focused.log`.
- Existing serve CLI regressions: `corepack pnpm --filter @pa-platform/pa-core
  exec tsx --test --test-concurrency=1 --test-name-pattern='runCoreCommand.*serve'
  src/__tests__/cli-core-command.test.ts`: **9 passed**,
  `/tmp/pap316-p4-serve-cli.log`.
- Dedicated transport regression command: `corepack pnpm --filter
  @pa-platform/pi-pa exec tsx --test --test-concurrency=1
  src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts`:
  **29 passed**, `/tmp/pap316-p4-transports.log`.
- Workspace `corepack pnpm typecheck` and `corepack pnpm build`: **passed**;
  logs `/tmp/pap316-p4-typecheck.log` and `/tmp/pap316-p4-build.log`.
- No repository lint script exists; owned diff whitespace checks pass.

Not claimed: installed/default-entry qualification, background/IPv6 installed
journeys, actual Avodah/tool forwarding, browser/UI/accessibility/readability UAT,
authenticated human consent, independent review, hosted CI, full workspace test
suite, normal Pi foreground cross-client convergence, PAPC adoption, publication
or effects. Background flag propagation and numeric IPv6 grammar are implemented;
source tests do not substitute for those installed journeys. Builder remains
entirely deferred. No config edits, staging, commits or installation were made.
