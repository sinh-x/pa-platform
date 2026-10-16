# Pinned AXI package inputs

PAP-197 adds the separate default-off [Lavish 0.1.67 closure](lavish-axi/README.md).
Its standalone/selected entrypoint is a native fail-closed metadata gate, never
raw upstream. Review runtime readiness and cross-adapter integration are not
claimed. The remaining sections describe the original PAP-240 inputs only.

These independent closures are not PA workspace dependencies:

| Output | Pin | Resolved npm packages |
| --- | --- | --- |
| gh-axi | 0.1.35 | 3 |
| chrome-devtools-axi | 0.1.38 | 98 |
| quota-axi | 0.1.56 | 5 |
| chrome-devtools-mcp | 1.10.1 | 1 (upstream bundles its dependencies) |

Each directory contains an exact root manifest, npm lockfile v3, original
upstream manifest, integrity inventory, and extracted license texts. Resolution
was performed on 2026-10-10 using Node 22.23.2's npm with:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
```

All resolved tarballs were downloaded and verified against the lockfile SRI
before recording their SHA-256 and license-file digests. No lifecycle scripts
were executed. Nix fetches each archive using the committed SHA-512 SRI and
extracts it at the committed npm node_modules path, including nested versions.
There is no npm install, build-time version resolution, development dependency
installation, or dependency-cache reliance in the derivations. Published JS is
installed directly; no application source recompilation is necessary.

MCP 1.10.1 includes prebundled third-party code inside its integrity-pinned
archive. Its upstream `bundled-packages.json` and full `THIRD_PARTY_NOTICES` are
recorded here; it declares no external npm runtime dependencies. The tarball
integrity covers those bundled sources as well as the main entrypoints.

The Node and gh derivations come exclusively from the unchanged flake.lock
nixpkgs pin. Node is asserted >=22.19. MCP update checks and usage statistics are
disabled in the tool wrappers. The browser AXI wrapper always supplies the pinned
MCP script and Node PATH, avoiding its upstream npx bootstrap fallback. No Chrome
browser is packaged or provisioned.

`lib.mkPaPlatform` takes strict default-false `enableGhAxi`,
`enableChromeDevtoolsAxi`, and `enableQuotaAxi`. Its `axiSelection` and
`selectedAxiTools` passthru describe the chosen closure. Selected tools are
referenced under `share/pa-platform/axi-tools/`; default aliases and the default
overlay select none. All four tools also have explicit standalone package
outputs. Phase 1 does not expose these tools on adapter PATH or enforce managed
browser/quota policy: that belongs to later phases. Standalone upstream CLIs
are not the managed consent/lifecycle policy boundary.

Updating a top-level approved pin requires fresh approval. To refresh an
approved closure, resolve its isolated manifest with the command above, verify
every tarball SRI, regenerate the inventory and extracted license records, and
retain exact upstream bin/manifest checks. Do not resolve versions during a Nix
build or silently change the approved pins. The phase-1 flake evaluation
assertions check defaults, independent single-tool selection, invalid types,
pins and declared dependencies; they do not substitute for the later native
installed-output/eight-selection matrix.
