# Lavish 0.1.67 — PAP-197 managed adaptation (not runtime readiness)

The Phase 1 record below is historical provenance. Phase 3 adds the selective
adaptation and core-owned lifecycle described at the end; it does not qualify
installed/browser behavior or supersede the independent acceptance gates.

`enableLavishAxi` is an independent **strict boolean**, default `false`, in
`lib.mkPaPlatform`. Default aliases and overlay select no Lavish. Explicit
`packages.<system>.lavish-axi` is the separate pinned closure. Selected PPA
exposes only its native managed gate, not `dist/cli.mjs`. Other AXI versions,
wrappers and PPA-only selection are unchanged. OPA/CPA runtime integration is
not implemented in this phase. Supported packaging evaluation targets are
x86_64-linux and aarch64-linux; neither constitutes installed/native acceptance.

## Immutable source and resolved closure

- Archive: https://registry.npmjs.org/lavish-axi/-/lavish-axi-0.1.67.tgz
- SHA-256: `b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd`
- SRI: `sha512-7qU7tF1ShNQEQY3SMceNkIR2T1Iuy3kOvatoOgPwUW1QJuXoi+vzF5NOiDSt7xMfNaKJMNLefY856yylFxOxHg==`
- Original manifest: `upstream-package.json`; original bin `dist/cli.mjs`,
  Node >=22, MIT. Original archive bytes are never patched or republished.
- Isolated manifest/lock v3: `package.json`, `package-lock.json`. Resolved on
  2026-10-15 with Node 22.23.3, npm's `install --package-lock-only
  --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org`.
  This is metadata-only lock generation, not a runtime/global installation.
- All 91 tarballs (including the root) were fetched and verified against their
  lock SRI. `integrity.json` records each exact node_modules location, version,
  URL, SHA-512, SHA-256, license and extracted license-file digest.
  `THIRD_PARTY_NOTICES.md` retains all 92 extracted license/notice texts,
  including upstream's bundled-asset notice. Licenses include MIT, ISC,
  BSD-2-Clause and BSD-3-Clause; upstream also attributes excluded fonts as OFL.
- No locked package declares preinstall/install/postinstall; none has a lock
  install-script flag. Root prepare/prepack are present in the original
  manifest but are **never executed**. Published JavaScript is extracted
  directly by Nix; npm, setup/hooks/plugins, downloads and updates never run
  during installation or managed execution.
- `generate-inventory.py` reproduces integrity/license records offline from
  the lock and a previously SRI-verified archive cache. No registry lookup or
  package execution is performed by that generator or by the derivation.
- `upstream-files.json` records every file in the approved archive, including
  excluded bundled whiteboard/fonts. The install excludes whiteboard, fonts,
  skills, plugin metadata and marketing assets. Their upstream attribution is
  retained as provenance, not a claim of complete internal bundle dependency
  resolution or readiness. Only the CLI source, chrome JS/CSS, design assets,
  package manifest and notices are extracted for the root. The CLI is inert
  provenance, **not a supported executable or import**.

## Actual source inspection and adaptation review

Source inspection used only verified bytes; no upstream code, browser, server,
setup, provider or credential operations ran. All declared Node engine ranges
admit Node 22.23.3; all tarballs have license records and no install scripts.
This establishes metadata/source compatibility only, not operational support.
No observed metadata incompatibility required a pin change.

The following upstream 0.1.67 surfaces require managed replacement/confinement:

| Verified source surface | Phase-1 disposition / later obligation |
| --- | --- |
| cli.mjs:10778–11023 telemetry initializes before dispatch, with baked-in external endpoint and website ID | Native gate never loads it; later adaptation must remove telemetry, not merely set opt-out env. |
| cli.mjs:8898–8950 server defaults include Tailscale discovery, configurable hosts/state/idle | No server reachable; later owned supervisor fixes loopback, private state and bounded lifecycle. |
| cli.mjs:9514 share route; 9903 attachments; 10685–10687 publish/attachment UI | Every runtime operation denied; later HTTP/WS/UI allowlists must omit forbidden capabilities. Hiding buttons is insufficient. |
| cli.mjs:9666–9715 artifact serving permits sibling assets, including dotfiles | No listener/file read; later immutable snapshot and exact asset allowlist must replace broad serving. |
| cli.mjs:9968–10033 WebSocket upgrade/event path | No upgrade path; later WS identity/schema/capability admission is mandatory. |
| cli.mjs:9224 poll and SessionStore persistence around 8090 | No polling; later core journal-before-ack and non-destructive export replace destructive delivery. |
| cli.mjs:11770–12038 setup hooks/plugin/profile writes; 12249 inherited child env | No import/spawn; later environment is constructed, never inherited wholesale. |
| chrome-client.js plus iframe/SDK injection in cli.mjs | UI/content/CSP and durable feedback adaptation remain phase 3; no browser compatibility claim. |

`adaptations.json` binds the reviewed files by SHA-256. The phase-1 adaptation
is a **statically linked native deny gate**, not a shell/Node wrapper. This avoids
interpreter startup hooks and dynamic-loader inherited configuration before
admission. It performs no file access, state creation, signal, subprocess,
listener or outbound operation. It reads only argv/environment and writes
constant metadata/diagnostics to stdout/stderr. It does not forward credentials,
profiles or even an ostensibly safe upstream environment. Node from the unchanged
flake lock is retained in the selected closure for later managed use, not run.

Only exact `--help` and `--version` are metadata requests. Presence (even empty)
of `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`
or any `LAVISH_AXI_*` rejects with `ARTIFACT_POLICY_REJECTED`, exit 5. Known
upstream operational/forbidden commands and the reserved managed protocol also
reject with exit 5. All other arguments reject with `ARTIFACT_USAGE_INVALID`,
exit 2. User strings, paths, secret values and underlying exceptions are never
included in diagnostics. There is no supported runtime request/path/owner to
admit yet: unconditional denial occurs before any corresponding effect.

`packages/pa-core/src/artifacts/policy.ts` supplies the shared pure policy seam:
exact approved exit mapping (0 success; 2 invalid input; 3 prerequisites; 4 stale;
5 policy; 6 owner; 7 runtime; 8 output), redacted constants, strict timeout and
lexical path/size guards, explicit missing-runtime error, and deny-all transport
capability admission even when selected. Lexical checks are not filesystem or
ownership confinement. No owner/path is accepted for runtime execution in phase 1.
The CLI interface, renderer, actual ownership validation, supervisor, journal,
HTTP/WS/UI and confinement/effect observations are intentionally not implemented.

## Verification and remaining gates

The phase checks are, in order:

1. `nix flake check '.?submodules=1' --no-build`
2. `nix eval '.?submodules=1#packages.x86_64-linux.lavish-axi.drvPath' --raw`
3. `corepack pnpm exec tsx --test packages/pa-core/src/artifacts/__tests__/policy.test.ts`

These are evaluation and policy-unit/source assertions, **not installed-output,
static-binary behavioral, browser or full-matrix proof**. Results belong in the
external deployment artifact, not fabricated here. Sensitive-workflow secret scan
is separate and required before commit. AC1, AC7 and AC8 contributions remain
partial. All NFR1–NFR6 and AC1–AC10 retain their approved obligations for later
phases/independent validation; no requirements checkbox or readiness is granted.
If actual upstream adaptation/compatibility fails, stop for operator decision:
never change 0.1.67, weaken policy or treat an env setting as confinement.

## Phase 3 — owned review and durable feedback

`pa-core` now implements the shared Interface v1 lifecycle under `ppa`, `opa`
and `cpa`. Render remains independent of selection. Review start resolves only
the installed adjacent selected `axi-tools/lavish-axi` Nix closure, never PATH,
npm, an environment-selected executable or the upstream CLI. The native public
`lavish-axi` gate remains metadata/deny-only. Selection supplies assets, not PA
approval or an action-authority bypass. Adapter launch/resume supplies only
shared adapter/owner metadata; other AXI tools remain PPA-only.

### Genuine upstream reuse and content-document boundary

`adaptations/adapt-upstream.py` verifies the complete original `dist/cli.mjs`
and `dist/chrome-client.js` digests, extracts exact uniquely bounded components,
and checks each narrow patch occurs once. It never imports/evaluates the CLI.
Retained code is the real Lavish SDK selector, range-boundary/text-selection
context, control guards and mouseup/click annotation listeners, plus chrome's
escaped queue presentation, browser persistence, removal/enqueue and
success-only queue consumption. The delivery patch supplies stable event IDs
and exact source binding and accepts consumption only after the exact durable
ACK IDs. Original MIT license/notices remain in the closure; generated
`review/provenance.json` identifies source and derived-output digests.

The SDK's ambient `document` is explicitly lexically bound to the scriptless
iframe's `contentDocument`; its selection and DOM ancestry stay in that document,
while `CSS.escape` and trusted UI execution remain in the outer realm. Table,
Mermaid, shadow/style injection, snapshots, layout audit, SDK initialization,
`window.lavish` and all message/attachment paths are omitted, not merely hidden.
No code executes in the companion. Its exact bytes and `script-src 'none'` CSP
are retained, with iframe sandbox allowing **only** `allow-same-origin` (no
scripts, forms, popups or downloads). Packaged `outer.html`, `outer.css` and the
generated `review.js` have a separate restrictive outer CSP. No postMessage
boundary is supported; every WS upgrade and unknown HTTP route is rejected.

The core supervisor contains no upstream server/CLI, arbitrary file server,
share, upload, whiteboard, setup, updater, export or browser-opening effect.
HTTP serves only the immutable validated companion and those exact three
packaged assets; source, manifest, owner state, journal and sibling files are not
served. Mutation routes require the secret session path plus exact Host/origin
and JSON schema; core controls additionally require the private bearer token.
No operator HOME, profile, provider credentials, PATH or upstream configuration
is forwarded to the supervisor.

### Lifecycle and journal

A private deployment root and session directory (0700) bind adapter, deployment,
canonical artifact digests, owner process birth/boot identity and private owner
state (0600). The supervisor chooses `127.0.0.1:0` without replacing listeners.
Owned direct loopback HTTP controls replace PID signaling and bypass inherited
proxy/global-fetch dispatchers. Denied upgrades are fully closed even for
half-open peers. Same-live-owner start and matching stop are idempotent; foreign
ownership and PID reuse reject. Explicit human end is durable before ACK and
cannot be automatically reopened; in-flight bodies cannot append after end. Owner exit and monotonic 900s
idle cleanup retain journal/exports; status/socket presence does not refresh
idle. Human activity, explicit start and feedback consumption may refresh it.
Startup and stop are bounded by the approved 10s/5s budgets. Focused synthetic
clock tests do not replace real-idle/installed proof.

Each entire feedback batch is validated before replacing a complete journal:
UTF-8 feedback <=65536 bytes, selection <=16384, journal <=1024 events or
16777216 bytes. Stable IDs deduplicate identical retries and reject changed
retry content; sequence, sourceRef/sourceSha256/htmlSha256 and exact anchor/line
or explicit document-wide targets persist. File and directory fsync precede
ACK, and upstream queue consumption follows ACK only. Rejected sends retain
browser text. Export is non-destructive and no-clobber atomic: absent or
byte-identical target only, mode 0600, no-feedback creates no output. Stale
source/HTML/manifest/renderer/policy blocks start/export and freezes browser
feedback; no regeneration or reassociation occurs. Authenticated user End is
still permitted when stale, with a durable tombstone before ACK and explicit
non-OK confirmation in the UI. Private-directory publication syncs each pinned
parent, including existing-directory recovery; byte-identical export retries
sync the validated file and parent before reporting success.

Operation serialization uses an empty private regular `operation.lock` and
kernel flock on an inherited open-file description. The fixed installed
util-linux helper is independent of PATH/environment; the file is never removed
or replaced for recovery. Holder crash releases the lock, live contention fails
closed, and generation/state rechecks protect delayed cleanup. Foreign or
malformed files and legacy directory locks are rejected without guessed repair.
Synthetic crash/race/barrier tests are not installed or host-crash acceptance.

Reconciliation is explicit data: eventId, source digest, accepted/rejected/
deferred disposition, rationale, affected FR/AC/section and renewed approval
need. Neither feedback nor this record edits Markdown, approvals, tickets or
implementation authority. Source changes require the owning workflow's new
render/review/approval.

Exact five Phase 3 checks and a staged secrets scan are recorded externally by
the implementation deployment. No installed-output, browser selection, real
900s idle, complete no-egress effects, native platform or readiness claim is
made here. Phase 4 harnesses and independent review must establish those facts.

## Phase 4 source integration (not readiness)

The single native Lavish derivation was actually built with `--no-link` using
its declared fixed inputs; generated `review.js` passed Node syntax checking
and immutable asset-reader/provenance digest validation. Static stdenv names
outputs `lavish-axi-static-x86_64-unknown-linux-musl-0.1.67`, not the previously
assumed `lavish-axi-0.1.67`. Core now admits only the exact static Linux target
names, retaining non-symlink/root-owned/non-writable store asset checks.

A focused source regression reproduced a false acknowledgement message when
pinned `submitQueuedOnce()` returned `false` after HTTP 409. Trusted outer glue
now retains the refusal/ended notice instead of claiming durable success;
queue consumption, source CSP, pin and protocol policy are unchanged. The
updated `outer.js` digest is recorded in `adaptations.json`. Generated output
and source digests, exact native store path and external receipts are indexed
in [PAP-197 readiness](../../../docs/artifacts/pap-197-runtime-readiness.md).
This is build/syntax/source evidence, not execution of the generated UI.

The [v1 consumer contract](../../../docs/contracts/lavish-artifact-review-v1.md)
and `scripts/lavish-smoke/` supply the independent validation entrypoints.
All 16 installed PA selections, installed adapters, real browser/UI, 900-second
idle/effects evidence, independent acceptance, CI and human UAT remain pending.
