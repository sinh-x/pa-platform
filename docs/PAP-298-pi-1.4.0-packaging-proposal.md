# PAP-298 Phase 2d — exact Pi 1.4.0 packaging candidate

**Proposal for owner selection, not an approved dependency/launcher change.**
Investigation authorized by Sinh after d-d30304's review. Implementer d-6cf785;
parent source candidate `1d605acc3807d865b5ce096eb8e05b4bd090acc3` in the existing
PAP-298 ticket worktree. No lockfile, dependency, launcher, active configuration,
installation or hard-link eligibility changed. The source reader still denies
all hard links. This proposal does not clear SR-1.

## Recommended selection to approve or reject

Add a **separate pinned selected-host Nixpkgs input** for Pi 1.4.0 and its matching
Node, rather than updating pa-platform's main Nixpkgs input or substituting the
adapter's development peer. Keep external Pi ordinary-only behavior until a
separately authorized pinned-host rollout; no silent default selection or retained
session upgrade. Initial concrete evaluation evidence is **x86_64-linux only**.

Proposed new host input:

```text
repository: NixOS/nixpkgs (GitHub)
revision: 0bb2eedc20e4739f29e8045034f2828ad7054f8f
source NAR hash: sha256-fiPJ88izTVucjeo2EQ3jk4aWmLg03I1D4vxnX2QjEgE=
Pi attr: pi-coding-agent
Pi version: 1.4.0
Node attr: nodejs_24
Node version: 24.21.0
```

This exact revision/hash was discovered in the host Nix registry, then independently
used as explicit `builtins.fetchTree` inputs in offline Nix evaluation. Registry
text is discovery, not authority: the explicit evaluation output equals the
recorded installed Pi derivation/output and its declared Node build input. A future
lockfile change must pin the revision/hash, never rely on mutable `flake:nixpkgs`.

### Declared source and fixed build inputs

Pinned `pkgs/by-name/pi/pi-coding-agent/package.nix` was read through the normal
file tool. It declares:

| Item | Exact candidate |
| --- | --- |
| Pi source | `earendil-works/pi`, tag `v1.4.0` (`refs/tags/v1.4.0`) |
| Source NAR hash | `sha256-N9NOpiiZTbOMDMV+CxvJAgtLjJJ1/8NJBGS0cFHkhsc=` |
| npm dependency hash | `sha256-aBzVz78IxZQlzPYC72Ufa2YFtkow6nZR24YBYZrv9W0=` |
| Provider model-data tarball | `https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz` |
| Model-data hash | `sha256-tA4rqLtvwzKQj4uW6DfcLR/ftF65zTgvWu0RFGKYHjw=` |
| Build | `npm run build:offline`, coding-agent workspace, copied runtime workspace dependencies |
| Declared wrapper extras | selected ripgrep/fd; default skip-version-check and telemetry-off |
| License metadata | MIT |

A tag plus fixed source hash is the proposed content pin; no upstream Git commit
hash was established separately. The source derivation exists but its output
`/nix/store/1rgrrvwdr0pjhkwh5havmb5z8dskm8lz-source` is not currently valid/present.
It was **not** realized, downloaded or copied for this investigation. No denied
installed document/source bytes were obtained through another tool.

### Exact evaluated x86_64-linux outputs

```text
Pi derivation:
/nix/store/ygnh67jy02r9faicp2z1r7p0vv41369z-pi-coding-agent-1.4.0.drv
Pi output:
/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0
Pi registered output NAR hash:
sha256-0UTLKVybjFL0ZBbHrYZvZS47bAejXaM6UuVEjyzBmSo=

Node derivation (Pi declared build input and explicit evaluation):
/nix/store/a7mzwdph5vkavini0lj77xph53qhgjlf-nodejs-24.21.0.drv
Node output:
/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0
Node registered output NAR hash:
sha256-35i+1DGX3BOAUlA8EMTIbW0Qnd5N0A0gI3GTBgUGCrs=
Actual canonical executable:
/nix/store/fisi9algzl2pcxb2xfhgp2yw5mzjfdwg-nodejs-slim-24.21.0/bin/node
```

A bounded process probe of that **Node only**, not Pi, returned Node 24.21.0,
module ABI **137**, V8 **13.6.233.17-node.53**, and the canonical executable above.
This is compatibility metadata, not an executing-Pi/bridge identity or installed
reader trial. The Nix database reports cache.nixos.org signatures for Pi and Node;
no content-integrity/signature-verification command was run and signatures are not
claimed verified. Node output's database-selected deriver is a different equivalent
record (`97g1hmcssw0j1b99j5g28s0kr53hz4zr-...drv`); the Pi input derivation and
explicit candidate evaluation both point to `a7mz...` and the same output. Do not
assume all same-version derivations or executable paths are interchangeable.

## Why not use the current repository input or peer?

The committed main `flake.lock` pins Nixpkgs
`d6524aaca2ff07876657ae2b323f24be4874944b`, NAR
`sha256-2V9GZGvPfrNzxFozhI9dcqV+c3QdA8YZrvAAzqEB+dI=`.
Offline evaluation gives **Pi 0.85.1** and Node **24.19.0**, not this target:

```text
/nix/store/xb8qlrizjv1hn6m3wqnpr1m2ghjwlrpd-pi-coding-agent-0.85.1.drv
/nix/store/qf702rins357mp8jlr1s5k1s3kp2d2ms-pi-coding-agent-0.85.1
/nix/store/azflkcvc103gq1ddlc5if1r8qpd1xk6c-nodejs-24.19.0.drv
/nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0
```

The adapter development peer is **0.84.4**, a third distinct selection. Neither
peer imports nor these version strings prove which host executes. The recommended
separate input limits the scope of a future build dependency change; updating the
main pin would also change unrelated pa-platform tooling/addons and is not proposed.
No manifest/peer bump is requested by this document.

## Payload and lifecycle are not yet qualified

Metadata confirms the package/document root:
`<Pi output>/lib/node_modules/pi-monorepo`.
Metadata-only discovery found these CLI-shaped files:

| Relative path | Observed file metadata |
| --- | --- |
| `dist/cli.js` | regular, root-owned, 0555, nlink2, 219 bytes |
| `dist/bundle/cli.js` | regular, root-owned, 0555, nlink2, 210 bytes |
| `dist/bun/cli.js` | regular, root-owned, 0444, nlink12, 133 bytes |

These are **candidates, not proof of the actual executable payload or lifecycle**.
No bytes from these installed files, the installed launcher, package metadata,
README, docs or examples were read to decide this proposal. Do not select a
historical peer's bin layout, guessed `main()` export or first matching filename.
A separately permitted release-source/packaging qualification must identify the
actual CLI relationship, side effects, session lifetime, loader hooks and bridge
custody before bootstrap implementation. It must not copy denied installed bytes
elsewhere or use shell/Python as an alternate content reader.

Future integration must preserve required Node/wrapper environment semantics
explicitly (including addon ABI validation), reject conflicting preload/loader
hooks under the reviewed contract, and make foreground/PTY/background/supervisor/
probes/resume agree on the same selected tuple. Metadata matching cannot replace
real native bootstrap execution and registered-reader tests. Other architectures,
provider/network behavior, loader/module singleton custody, and human UAT are
unqualified here. External Pi remains ordinary-only without the trusted producer.

## Exact observation entrypoints and preserved investigation failures

Successful metadata/source observations used:

```sh
nix-store --query --deriver /nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0
nix-store --query --references /nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0
nix path-info --json /nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0
nix path-info --json --json-format 2 /nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0
nix derivation show /nix/store/ygnh67jy02r9faicp2z1r7p0vv41369z-pi-coding-agent-1.4.0.drv
nix derivation show /nix/store/azzq4jc8lm1h1ra0dkhjfwkkrk8nxkhp-source.drv
nix derivation show /nix/store/yvj25fgz8nhipym40bwzarnxzibcffjh-pi-coding-agent-1.4.0-npm-deps.drv
nix derivation show /nix/store/a7mzwdph5vkavini0lj77xph53qhgjlf-nodejs-24.21.0.drv
```

New-format derivation JSON uses `.derivations`, not a root derivation map. Filters
selected declared versions, inputs, outputs, build/wrapper phases and hashes only.
`nix registry list` supplied discovery coordinates; then both sources were evaluated
explicitly with `nix eval --offline --json --expr` using this reusable expression:

```nix
let
  inspect = rev: hash:
    let
      src = builtins.fetchTree {
        type = "github"; owner = "NixOS"; repo = "nixpkgs";
        inherit rev; narHash = hash;
      };
      p = import src.outPath { system = "x86_64-linux"; };
      pi = p.pi-coding-agent;
    in {
      piVersion = pi.version; piOutput = pi.outPath;
      piDerivation = pi.drvPath; piNpmHash = pi.npmDepsHash;
      piSourceRev = pi.src.rev; piSourceHash = pi.src.outputHash;
      piSourceUrls = pi.src.urls;
      node24Version = p.nodejs_24.version;
      node24Output = p.nodejs_24.outPath;
      node24Derivation = p.nodejs_24.drvPath;
    };
in {
  host = inspect "0bb2eedc20e4739f29e8045034f2828ad7054f8f"
    "sha256-fiPJ88izTVucjeo2EQ3jk4aWmLg03I1D4vxnX2QjEgE=";
  repository = inspect "d6524aaca2ff07876657ae2b323f24be4874944b"
    "sha256-2V9GZGvPfrNzxFozhI9dcqV+c3QdA8YZrvAAzqEB+dI=";
}
```

Original unsuccessful/discovery observations are not product checks:

- First jq filter assumed old derivation JSON and failed (exit5); corrected to
  `.derivations`. Source derivation's direct env contains only `out`; source
  URL/revision/hash were established from the explicit pinned package evaluation
  and normally readable Nix recipe, not from a guessed empty env field.
- Querying absent source output failed as not valid. It was not realized/copied.
- `--json-format 1` on `nix derivation show` is unsupported here; rejected. That
  flag is supported by path-info, not assumed universal CLI grammar.
- Direct absolute-store import under pure evaluation was rejected; replaced by
  explicit hash/revision `fetchTree` evaluation, not an alternate denied-file read.
- Initial local-flake evaluation emitted repeated store dedup maximum-link warnings
  and serialized an attrset containing `outPath` as a string. It exited0 but was
  not sufficient comparison evidence. Explicit immutable-input evaluation above
  produced the full compared values. Evaluation may cache source/derivation data
  in the Nix store; no package build, installation or active selection occurred.

## Approval and next gate

Owner decision requested: approve/reject the exact **separate host input + Pi1.4.0 /
Node24.21.0** proposal and its limited, non-default rollout direction. That decision
would authorize only scoped dependency/bootstrap implementation and qualification,
not installation, runtime switching, positive access, or unreviewed loader/lifecycle
assumptions. A payload/lifecycle qualification still missing must block the dependent
implementation rather than be guessed.

SR-3 source candidate also needs independent exact-code re-review. Full repository
regression remains incomplete from the earlier timeout; hosted CI, genuine installed
reader/bridge/module/config provenance, normal guarded selected-document reads and
human acceptance are not performed. No evidence here unblocks PAP-287/PAPC-064 or
settles their retained effects. No production hard-link exception is enabled.
