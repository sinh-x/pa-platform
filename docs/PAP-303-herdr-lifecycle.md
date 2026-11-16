# PAP-303 — trusted Herdr lifecycle bridge (P1 audit, P2 implementation)

Date: 2026-11-16. Branch: `feature/PAP-303-herdr-trusted-bridge` (develop v0.1.170
merged). The original audit was attributed to `d-4b9ba1`; W1 hardening continues
in `d-b59414` at Sinh's explicit direction, without installing this source.

Status: **historical lifecycle audit and default-off P2 implementation; W1
helper hardening source-tested; full six-item P1 contract still incomplete;
P3 peer messaging deliberately unavailable; P4 qualification not run.**

Current source checkpoints: [W1 helper hardening](PAP-303-W1-helper-hardening.md),
[W2 source/composition reconciliation](PAP-303-W2-source-composition.md), and the
[feasibility-blocked W3/P1 contract proposal](PAP-303-P1-contract-draft.md).
Earlier observations below are not an installed/current full-P1 acceptance claim.
Sinh subsequently selected finite source scope: ordinary reads require one link;
the former general-store route is withdrawn. The Herdr source audit below is
historical and does not establish a current admitted Herdr-source route.

## P1 — exact integration audit

Source of record (read through the repaired PA source route, exact store
spelling): `/nix/store/x78xy43yn8lhlc64mh8d98agni3v8cla-herdr-agent-state.ts`,
6,694 bytes, SHA-256 `2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4`,
integration `HERDR_INTEGRATION_ID=pi`, `HERDR_INTEGRATION_VERSION=9`, marked
"installed by herdr; managed by herdr". The Home Manager symlink spelling
`~/.pi/agent/extensions/herdr-agent-state.ts` remains denied by PA policy; only
the exact immutable store path is admitted.

Observed contract:

- Selection inputs: `HERDR_ENV=1`, `HERDR_SOCKET_PATH` (unix socket), `HERDR_PANE_ID`.
  The integration is inert when any is missing.
- Transport: one `net.createConnection(socketPath)` per request, one
  newline-delimited JSON object, no authentication of its own, reply bytes are
  ignored. Attempts are bounded at 500 ms then 1,500 ms.
- Methods used: `pane.report_agent_session` and `pane.report_agent` with
  `pane_id`, `source: "herdr:pi"`, `agent: "pi"`, `seq`, and an optional
  `agent_session_path`/`agent_session_id` and `state`/`message`.
- States published: `working`, `blocked`, `idle`; TUI-only (`ctx.mode === "tui"`);
  `herdr:blocked` events increment/decrement a blocked counter.
- Privileges: advisory newline-delimited JSON requests over the operator's local
  Herdr stream socket plus session id/path reporting. No prompt submission, no pane creation, no terminal
  input, no file or process authority, no model-input surface.

What the audit cannot establish: the Herdr server's own authentication and
authorization of these methods, the generated NX/Home Manager wiring's exact
pin, and whether Pi 1.4.0 exposes the same event set in every mode. Those remain
owner/NX and installed-qualification questions.

## P2 — implemented lifecycle bridge (default off)

`packages/pi-pa/src/pi-extension/herdr-lifecycle.ts` is part of PA's trusted
extension composition; it does not load, import or execute the HOME extension and
adds no role permission. Selection is explicit:

- `PA_HERDR_LIFECYCLE=1`, plus a complete `HERDR_ENV=1`,
  `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` binding.
- The socket must be an exact, existing unix socket path (no symlink spelling),
  owned by the current user or root, with a bounded path and a bounded pane id.
  Any failure disables the bridge instead of guessing.

Behaviour: reports session and working/blocked/idle transitions using the same
two methods; payloads are fixed-shape, bounded to 4,096 encoded bytes and drop
unprintable text; one bounded attempt per payload with a latest-wins queue (one
in-flight, superseded states dropped); failures are silent because lifecycle
reporting is advisory; every owned socket is destroyed and shutdown closes the
bridge; reply bytes are never retained or shown. No tool, command or prompt
surface is registered.

Source tests: `packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts` (4/4), plus
the existing extension-composition suite (3/3) with the new module installed.

## P3 — peer messaging still unavailable, but the substrate is now audited

The installed *extension* exposes no prompt or message submission method: its
only writes are the two lifecycle reports. The Herdr **server API** does expose
one, and the bundled protocol-22 schema makes its contract exact:

- `agent.prompt` (`AgentPromptParams`: `target`, `text`, optional
  `wait: { until?: AgentStatus[], timeout_ms?: uint64 }`). Documented CLI
  behaviour: an already-blocked agent is rejected with `agent_blocked` before any
  input; a submission accepted from a non-working state must observe working or
  blocked within 5,000 ms or return `agent_prompt_stalled`; a caller timeout
  returns `timeout`; and **it does not track turns** — if the agent is already
  working, that turn's completion may match.
- `agent.wait` (`until`, `timeout_ms`; no timeout means indefinite) and
  `agent.read` (`source: visible|recent|recent_unwrapped|detection`, bounded
  `lines`, ANSI-stripped text) provide the settle and reply channels.
- `agent.get`/`agent.list` return `AgentInfo` with `pane_id`, `agent_status`,
  `completion_seq` ("the current idle transition completed work, independently of
  who has viewed it"), `state_change_seq`, `interactive_ready`, `launch_pending`,
  `cwd`/`foreground_cwd` and `agent_session`.
- Transport is the same-user unix socket with private protocol 22 (`herdr status`
  reports it). There is no additional token; OS file ownership is the boundary.

That is a supported submission API, so the earlier "no submission method"
conclusion was true only of the extension. What is still missing is the ticket's
guard contract, not an API: turn correlation is not request-specific
(`completion_seq` only proves *a* turn completed), there is no revocation-capable
human consent bound to a live pair, and no PA-owned mapping from a Herdr pane to a
target PA deployment.

Implemented as a pure preliminary observation filter, `observePeerTarget` in
`packages/pi-pa/src/pi-extension/herdr-peer-admission.ts`. It rejects self,
malformed, unknown or ambiguous targets; requires explicit readiness and no pending
launch, supported settled state, known nonnegative safe-integer ordering counters
and a supported session-path observation. It never fabricates absent counters.
An optional checkout comparison is observation only, not authentication.

Even a positive observation reports `sendAdmission: "unavailable"`: no deployment,
incarnation or read-only authority is established by a cwd/session path. The old
`admitPeerTarget`/`admission` surface has been replaced to avoid implying otherwise.
The filter registers no tool, submits nothing, reads nothing and grants nothing.

Messaging remains unavailable because a request/reply effect without consent,
request-specific correlation and a target-deployment binding would violate the
ticket's own contract. `herdr prompt --wait` is not turn-correlated and
`--wait` without a timeout is indefinite, so it is not a substitute. No terminal
input, send-keys or raw socket write was added.

Also implemented as pure helpers (`herdr-peer-exchange.ts`), still unwired:
request planning preserves the body intact, adds a `[[pa-peer:<uuid>]]` nonce,
and caps the complete planned JSON parameters (target, text and wait) at 4,096
UTF-8 bytes. JSON escaping and nonce/envelope overhead count. Any future transport
owner must also budget its RPC framing; no wire submission exists here. The
60-second value is only a planned wait ceiling, not an implemented total deadline.

The classifier privately measures a code-point-safe 16 KiB / 80-line observation
and returns **metadata only**, never terminal text on any outcome. Supported
settled states and explicit safe-integer counter advancement are required. Even
with a nonce and a new completion, the result is `unverified/unframed-channel`,
never `correlated`: echoed input and unrelated turns cannot prove an explicit
response. Other invalid observations return truthful typed `uncertain` reasons.
CSI removal is not a complete terminal sanitizer or a response channel. Nothing
is automatically resent, registered as a request tool or wired to an effect.

Read-only peer inventory belongs to PAP-281/PAP-286, not this ticket.

## P4 — not run

No installed build/deployment of this branch, no default-entry enablement, no
live Herdr pane observation, no standalone/non-Herdr regression run, no NX-069
pairing, no independent review, no hosted CI and no human UAT. The module is
selected only by explicit environment, so enabling it in a deployment is a
separate operator decision after those gates.

## Historical pre-W1 checks

These results describe the earlier committed checkpoint, not the current dirty
W1 source. The adopted unfinished rewrite initially reproduced 12 pass / 2 fail;
see the linked W1 checkpoint for current results.

```sh
corepack pnpm typecheck
corepack pnpm --filter @pa-platform/pi-pa build
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts
```

Results: workspace typecheck passed; pi-pa build passed (extension-source
validation included); 14/14 focused cases passed. Protocol conformance validates
our lifecycle params against a vendored subset of the installed Herdr 0.9.5
schema (`protocol: 22`, extracted 2026-11-16) and rejects deliberately broken
payloads. A separate inert probe read the store source through
`acquireLocalSourceFile` (6,694 bytes, SHA-256 above) and confirmed the symlink
spelling is still denied. No live socket, deployment, installation or messaging
effect occurred.
