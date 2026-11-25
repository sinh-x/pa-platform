# Local PPA session dashboard

## Contract and capability map (PAP-286)

The dashboard is a separate read-only reader of PAP-281's exported `captureSessions`
projection (`ppa-sessions/v1`). It does not own a registry, infer activity, or change
process verification or HerdR mapping rules. See [the inventory contract](live-session-inventory.md)
for identity, privacy, coverage and observation-window semantics.

Existing surfaces reviewed:

- `session-capture.ts`: supported shared factual projection, fresh per call.
- `session-cli.ts`: exact filters, safe presentation and independent registry/process states.
- Agent API: broader authenticated agent operations; not a dashboard transport.
- `local-review-server.ts`: bounded loopback transport for review decisions, not a
  read-only inventory API. Its review/auth semantics must not leak into this feature.
- No existing dashboard page provides this verified projection.

Sinh selected the loopback/manual-refresh option during deployment d-9b3944 on
2026-11-25. This design observation is not independent Review or UAT.

## Local binding, privacy and trust

A dedicated foreground server binds only numeric `127.0.0.1` on an explicitly
selected port. It never launches a browser. There is no separate user authentication:
local OS users/processes that can connect to the port are trusted and can read the
minimized inventory. Do not use this on an untrusted multi-user host, publish it,
proxy it, forward the port or treat loopback as user isolation.

Exact Host validation prevents DNS-rebinding names. Cross-origin Origin and
Sec-Fetch-Site values are rejected. The JSON route also requires a custom request
header, so a cross-origin page cannot trigger collection through an image/form or
simple request. There is no CORS/preflight grant. These checks constrain browsers;
they are not authentication against local programs that can forge headers.

Only GET is supported, with no request body, credentials, cookies, control routes,
file routes, terminal contents or scrollback. All output uses no-store, nosniff,
no-referrer and a restrictive CSP/frame policy. No objectives, environment, launch
arguments, private process fingerprints or socket paths are added to the shared
projection. No dashboard data, browser filters or history is persisted.

## Transport and refresh

`GET /` serves a bundled page; `/dashboard.js` and `/dashboard.css` are its only
assets. `GET /v1/sessions` requires `X-PPA-Sessions: 1`. Allowed query parameters
are `deployment`, `ticket`, `repo` and `all=true|false`, each once. Exact AND filters
use the CLI validator; unknown or duplicate parameters fail before collection.
Success is exactly the shared `ppa-sessions/v1` JSON, not a second projection.
Failures use bounded fixed codes, never arbitrary exceptions.

Each accepted refresh captures anew. No polling, cache, background collector or
lifecycle repair exists. At most one capture runs per server; overlapping requests
receive 503, including after a disconnected/timed-out caller until its capture
settles. A late result is discarded, never cached. Limits: 16 sockets, 8 KiB headers,
2-second header and 15-second overall connection deadlines, 32 MiB response cap.
The collector retains PAP-281's bounds. Synchronous OS reads cannot be preempted
by Node timers, so those deadlines are best-effort rather than a hard CPU/I/O bound.

The page must distinguish initial loading, refreshing, last successful capture,
stale data, unavailable refresh, incomplete coverage and empty filtered results.
Old rows remain labelled historical on refresh failure, never as a new observation.
Open means alive, not actively working; registry status stays independent.
Grouping uses scoped HerdR identity or explicit no-location states, with optional
repository/ticket grouping. Large views paginate without silently dropping rows.
A capture is an observation window, not a promise that a process has not exited or
moved since then. Missing or ambiguous locations must not select a pane.

## Scope exclusions and qualification

No start/stop/focus/attach, pane input, browser launch, deployment reconciliation,
registry/ticket/configuration writes or general Agent API exposure. Closing this
foreground server must not control any displayed session.

Positive/negative checks cover exact projection parity, filters, hostile HTTP
requests, concurrent refresh/disconnect, capture failure/deadline, PID reuse,
concurrent exit/move, unavailable HerdR, stale/empty/large UI states and safe text
rendering. Source and loopback fixtures are not installed verification, actual
HerdR topology observation, browser usability, independent Review or human UAT.
