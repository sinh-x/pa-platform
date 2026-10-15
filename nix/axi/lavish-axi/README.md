# Lavish 0.1.67 — PAP-197 phase 1 (not runtime readiness)

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
