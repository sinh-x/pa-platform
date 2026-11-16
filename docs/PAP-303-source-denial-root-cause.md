# PAP-303 — source-denial root cause and repair

Date: 2026-11-16. Deployment: `d-4b9ba1` (rogue-one, PAP-303). Branch:
`feature/PAP-303-herdr-trusted-bridge`, now merged with `develop` v0.1.170.

Status: **cause established from live evidence; PA-side repair implemented and
source-tested in this branch. The running 0.1.170 deployment is unchanged, and a
second, non-PA guard layer still blocks some paths.**

## Outcome

The denial that stopped P1 had two independent causes, not one:

1. PA's ordinary local read admits a regular file with exactly one link. Every
   `/nix/store` file with more than one link was therefore denied with
   `LOCAL_SOURCE_UNSUPPORTED_FILE`, including Pi 1.4.0's own README (`nlink=9`)
   and the Herdr extension (`nlink=8`). The selected-Pi reader that the earlier
   audit proposed as the fix was never the missing piece: its scope covers only
   one Pi's `README.md`, `docs/` and `examples/`, so it could not have admitted
   the Herdr extension at all.
2. The same code's `Reason` text said "Qualified selected Pi documentation
   eligibility was not established" for *every* unsupported file. A link-policy
   rejection therefore looked like a provenance/eligibility rejection, and the
   prior investigation reasoned from that wording. The concrete cause was the
   ordinary single-link rule.

A third layer is separate from PA and remains active: the `agentkit-hooks-engineer`
Pi plugin (`scout-block`, `privacy-block`, `context-firewall`) intercepts `read`
and `bash` on path patterns such as `node_modules`, `dist` and `.git`. It blocks
the Pi 1.4.0 docs and the installed PPA build even when PA would admit them, and
its message points to `/home/sinh/.pi/agent/extensions/agentkit-hooks-engineer/.ckignore`,
which does not exist. That plugin is not owned by this repository; PA cannot fix
its patterns or its message.

## Live evidence from `d-4b9ba1`

All probes used inert files created for this check. No secret, no denied source
body and no third-party configuration was read or modified.

| Observation | Result |
| --- | --- |
| `read /nix/store/isaxx…-pi-coding-agent-1.4.0/lib/node_modules/pi-monorepo/README.md` | `BLOCKED … Pattern: node_modules` from the AgentKit `scout-block` plugin (not PA) |
| `read ~/.pi/agent/extensions/herdr-agent-state.ts` | Delivered. Symlink → `/nix/store/x78xy…-herdr-agent-state.ts`, `uid=0`, `mode=0444`, `nlink=8` |
| `read` a two-hard-link file in `/tmp` (`nlink=2`) | Delivered, although PA's ordinary ingress rejects `nlink≠1` |
| `read /tmp/…/.npmrc` (PA built-in blocked filename) | Delivered verbatim |
| `read` a file containing a fake `BEGIN RSA PRIVATE KEY` block | Delivered unredacted |
| `read .git/HEAD` | `BLOCKED … Pattern: .git` from the AgentKit plugin |

The last three rows show that PA's guarded reader was **not** the effective
`read` implementation in that session: the results carry no PA projection or
denial, and the file content contradicts PA's coded policy. PA's guarded reader
is registered by the trusted extension, so the effective tool is decided by
extension/hook precedence inside Pi, not by PA. The earlier session in the same
deployment did produce PA denials, which is why the two layers were conflated.

## Decision points (source)

- `packages/pa-core/src/local-source-file.ts` — descriptor-pinned acquisition;
  ordinary route required `nlink === 1`, selected route required a binding and
  exact spelling.
- `packages/pa-core/src/immutable-document-policy.ts` — finite selected-Pi scope
  (`README.md`, `docs/*`, `examples/*`) plus text-only multi-link checks.
- `packages/pa-core/src/source-content-security.ts` — denial codes and the fixed
  `Reason` text that merged link policy with selected-document eligibility.
- `packages/pi-pa/src/pi-extension/bound-local-read.ts` — the guarded read that
  replaces Pi's built-in `read` when PA owns the registration.
- `packages/pi-pa/runtime/selected-pi-host.mjs` — separate default-off selected
  host; not selected by this deployment.

## Repair implemented here

1. **Immutable store text route (pa-core).** Ordinary reads now accept a
   multi-link file only when the request uses the file's own `/nix/store` spelling
   and every component of the path is root-owned, not writable, and stable. The
   bytes must be complete valid UTF-8 text with finite control characters, the
   size bound still applies, and protected path/filename rules plus content
   redaction still run. This is a source-integrity rule, not a confidentiality or
   origin grant: the store files it admits are already world-readable, and hard
   links outside `/nix/store`, symlink spellings and mutable files stay denied.
2. **Truthful denial reason (pa-core).** `LOCAL_SOURCE_UNSUPPORTED_FILE` now states
   the two supported shapes (single link, or exact immutable store text) and keeps
   the selected-document requirement as an additional condition. Machine fields,
   exit behaviour and the code enum are unchanged.
3. **Guard coverage attestation (pi-pa).** A guarded read result carries an
   in-memory `sourceGuard: pa-local-read/v1` marker. At `agent_end`, PA compares
   the session transcript with its own marker and writes one bounded activity
   event when any `read` result came from another implementation. No path, query
   or content is recorded. This makes the current silent takeover observable
   instead of repeating as an unexplained denial.

## What this does not fix

- The running deployment still executes the installed 0.1.170 code; a new build
  and a fresh deployment are required before these rules apply to a session.
- The AgentKit plugin still blocks `node_modules`, `dist` and `.git` paths for
  `read` and `bash`. Its own owner must correct the baseline patterns (or a
  project override must be added) before Pi's packaged documentation and the
  installed PPA build can be read through those tools. PA can only report that
  coverage was unverified.
- PA cannot prevent a foreign layer from replacing `read` when Pi loads it after
  the trusted extension. Attestation records the condition; it does not restore
  precedence automatically. The durable fix for precedence belongs to the Pi
  extension-composition owner.
- Reading a store file by its `/nix/store` spelling is required for the immutable
  route; the Home Manager symlink spelling stays denied so the admitted identity
  is the one that was checked.
- No installed qualification, independent review, CI run or human acceptance is
  claimed for this repair.

## Verification performed

```sh
corepack pnpm typecheck
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pa-core/src/__tests__/local-source-file.test.ts \
  packages/pa-core/src/__tests__/immutable-document-policy.test.ts \
  packages/pa-core/src/__tests__/source-content-security.test.ts
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/local-source-security.test.ts
```

Results: workspace typecheck and builds passed; 18/18 pa-core cases passed; 22/22
pi-pa local-source cases passed (including the new marker/coverage case). The new
store-route policy is unit-tested from descriptor facts, not by writing to
`/nix/store`, which this environment cannot do safely.
