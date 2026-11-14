# PAP-298 Phase 3a — approved host input and release-source qualification

Parent: `4bc27172c310ce4d0ab38eee0dafe7a578fa20b5`; same ticket worktree/branch.
Sinh approved the next work: the exact separate host dependency and scoped
bootstrap qualification proposed in `PAP-298-pi-1.4.0-packaging-proposal.md`.
This does not authorize installation, active runtime switching or positive
hard-link access. SR-1 remains an enabling gate; SR-3's later exact code still
needs independent review.

## Implemented selection boundary

`flake.lock` adds only `piHostNixpkgs`, fixed to NixOS/nixpkgs
`0bb2eedc20e4739f29e8045034f2828ad7054f8f`, NAR
`sha256-fiPJ88izTVucjeo2EQ3jk4aWmLg03I1D4vxnX2QjEgE=`.
The original main Nixpkgs and other inputs are unchanged. `nix/selected-pi-host.nix`
asserts Pi1.4.0 and Node24.21.0 and explicitly reports `enabled = false`.
`lib.selectedPiHostFor` exposes these qualification inputs; the new host-pin check
asserts the selection. No PPA wrapper, PATH, spawn, preflight, start gate, supervisor,
capability, read implementation, artifact owner or runtime configuration changed.

Actual commands/results:

- `nix flake lock --offline`: exit0; only the approved input added.
- `nix eval --offline --no-write-lock-file --json .#lib.selectedPiHostFor --apply 'f: let h = f "x86_64-linux"; in { piVersion = h.pi.version; piOutput = h.pi.outPath; nodeVersion = h.node.version; nodeOutput = h.node.outPath; enabled = h.enabled; }'`: exit0.
  Pi/Node outputs match the proposal, enabled=false. Log `/tmp/pap298-host-selection-eval.json`.
- `nix build --offline --no-link .#checks.x86_64-linux.selected-pi-host-pin`: exit0;
  log `/tmp/pap298-host-pin-check.log`. This check builds a contract marker, not
  pa-platform or an installed/selected runtime. Other architectures are untested.

## Permitted release source, not a denied-document fallback

The newly approved fixed source input was realized through normal Nix source
substitution, not copied from the denied installed documentation. A `nix build
--no-link --print-out-paths --expr` selecting `p.pi-coding-agent.src` under the exact
approved `fetchTree` revision/NAR completed exit0. Native log
`/tmp/pap298-host-source-fetch.log` records cache.nixos.org substitution, 7.6MiB
compressed / 24.7MiB source output:
`/nix/store/1rgrrvwdr0pjhkwh5havmb5z8dskm8lz-source`.
No package installation or active runtime selection occurred.

Normal guarded reads admitted the release's `packages/coding-agent/src/cli.ts`,
package manifest, setup/config/main/extension-loader/interactive lifecycle source
and `scripts/build-coding-agent-bundle.mjs`. Only required source slices were
inspected in the large implementation files. No installed launcher/CLI module,
README, docs or examples was obtained through another reader; the fetched source's
README/docs/examples were not used as substitutes for denied installed docs.

Source findings:

1. The source manifest's bin is `dist/bundle/cli.js`. The bundler emits a small
   launcher using compile-cache plus `createRequire(...)("./cli-runtime.js")`.
   The bundled CLI runtime comes from `src/cli.ts`.
2. `src/cli.ts` calls `setupCli(); main(process.argv.slice(2));` **without await**.
   Merely importing the normal launcher/runtime therefore does not supply a
   session-lifetime promise. The prior abstract import-lifetime premise must not
   be enabled as written.
3. Public `main` is exported by the package index. `MainOptions.extensionFactories`
   passes native inline extension factories into the actual resource loader;
   `loadExtensionFromFactory` invokes them directly, whereas path factories go
   through Jiti with moduleCache=false. A bootstrap-created inline factory can
   preserve native closure custody without assuming a shared Jiti ESM singleton.
4. `main` awaits print/RPC execution. Interactive `run()` has an endless input loop,
   with shutdown disposing the runtime then exiting the process. Print returns;
   help/version explicitly exit. Directly awaiting main is the concrete candidate
   lifecycle boundary, with explicit shutdown/process-exit revocation still needed.
5. CLI setup sets process title, PI_CODING_AGENT/AI_AGENT and suppresses warnings,
   then configures HTTP dispatch. Main itself also configures dispatch. A future
   real launcher must preserve reviewed CLI setup semantics rather than silently
   omit or invent them. A fixed offline qualification harness is not that rollout.
6. `getPackageDir()` honors **PI_PACKAGE_DIR** before deriving its package root.
   The candidate must reject that conflicting environment override and compare
   the actual imported host's root with its fixed build-selected package. Environment
   text must not become provenance. Other preload/loader/startup conflicts still deny.

Native source-file SHA-256 observations:

```text
bb46a9e981c56b15d35858ec1ddbf629a9125eecb2b8b78ec4ac6e033d2b0d47  packages/coding-agent/src/cli.ts
bc76d755332764fc80eddc9c1bfb84f70e70c2b55d958e44f98000b05f08930c  packages/coding-agent/src/main.ts
bb8134c84faa8b0e7d9f7af9e127b33dc09c79243ecee666e526ff43961f2335  scripts/build-coding-agent-bundle.mjs
```

## Next candidate and limits

Next scoped work is a **non-default qualification harness**, not a PPA launcher
switch: fixed selected Node/module/root, native producer invoking the actual host
main with a fixed offline metadata/help operation and an inline closure, no root
arguments, no caller grant, no model/provider request, no positive read exception.
Its exact code and the revised main/inline-factory lifecycle approach must return
for independent review. Real PPA launch/setup/resume integration, cryptographic
installed custody, positive immutable text policy and live guarded-document reads
remain unimplemented/unqualified. No claim here unblocks PAP-287/PAPC-064 or supplies
final security acceptance, hosted CI, installed reader qualification or human UAT.
