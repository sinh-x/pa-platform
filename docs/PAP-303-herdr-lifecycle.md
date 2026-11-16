# PAP-303 — trusted Herdr lifecycle bridge (P1 audit, P2 implementation)

Date: 2026-11-16. Branch: `feature/PAP-303-herdr-trusted-bridge` (develop v0.1.170
merged). Deployment `d-4b9ba1` runs the installed 0.1.170 build, not this source.

Status: **P1 lifecycle/API audit complete for the installed integration; P2
implemented default-off with source tests; P3 peer messaging deliberately
unavailable; P4 qualification not run.**

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
- Privileges: write-only datagrams to the operator's own Herdr socket plus
  session id/path reporting. No prompt submission, no pane creation, no terminal
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

## P3 — peer messaging remains unavailable

The installed integration exposes no prompt or message submission method:
its only writes are the two lifecycle reports. The ticket's required contract
(source/target deployment and pane binding, self/stale/ambiguous/busy/blocked
rejection, native-dialog exclusion, request/reply correlation, one-in-flight
budget, no automatic resend) therefore has no proven submission path. `herdr
prompt --wait` is not turn-correlated and `--wait` without a timeout is
indefinite, so it is not a substitute. Per the ticket, messaging stays
unavailable rather than falling back to terminal input or raw send-keys.

## P4 — not run

No installed build/deployment of this branch, no default-entry enablement, no
live Herdr pane observation, no standalone/non-Herdr regression run, no NX-069
pairing, no independent review, no hosted CI and no human UAT. The module is
selected only by explicit environment, so enabling it in a deployment is a
separate operator decision after those gates.

## Checks actually run

```sh
corepack pnpm typecheck
corepack pnpm --filter @pa-platform/pi-pa build
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts
```

Results: workspace typecheck passed; pi-pa build passed (extension-source
validation included); 7/7 focused cases passed. A separate inert probe read the
store source through `acquireLocalSourceFile` (6,694 bytes, SHA-256 above) and
confirmed the symlink spelling is still denied. No live socket, deployment,
installation or messaging effect occurred.
