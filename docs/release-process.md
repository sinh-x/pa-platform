# Release Process

Use `develop` for integration and `main` for releases.

## Develop Auto Patch Bumps

After CI passes for a PR-originated push to `develop`, the `version-bump` workflow runs `corepack pnpm bump:patch:ci` and commits only deterministic package version edits back to `develop` with `[skip version-bump]` in the commit message.

The auto bump path is intentionally not a release path. It does not generate a changelog, create a release commit, create a git tag, or push tags.

The CI helper updates `package.json`, `packages/pa-core/package.json`, `packages/opencode-pa/package.json`, and `packages/pi-pa/package.json` together. It does not edit `pnpm-lock.yaml` or `flake.nix`; Nix package builds read the top-level package version from `package.json`, so an auto patch bump changes the derivation version without requiring a `pnpmDeps.hash` refresh unless dependency or lockfile content changes separately.

## Ticket-Local Build Labels

For an explicitly approved worktree-only build label, update the same four manifests together. The PAP-271 operator-selected development build used `0.1.153-pap271.1`, displayed by `ppa --version` and used as the Nix package version. Its integration candidate restores the plain `develop` version for the normal auto-patch flow; the installed development build retains its readable label. Rebuilding/selecting the package is still required; editing source manifests does not change an existing installation.

The latest PAP-273 labelled trial is `0.1.154-pap273.4`, committed at `2f2deccfea37364dadc36be1e497db3f94efbbcb` across those same four manifests (superseding `.1`–`.3`). Its integration candidate restores plain `0.1.154` for the normal `develop` auto-patch flow; this does not change the installed trial or transfer its qualification. `packages/runtime-host` remains independently versioned. See `PAP-273-integration-status.md` for retained installed-provenance and UAT gaps.

The PAP-277 worktree trial label is `0.1.155-pap277.1`, set across those same four manifests for operator trial installation and PAPC development. This label does not resolve the retained full-suite timeout or establish installed-pair, foreground-agent, CI or human-UAT acceptance; see `PAP-277-qualification.md`. Use the clean version-label commit as the exact candidate SHA when building and verifying the trial. The PAP-277 integration candidate restores plain `0.1.155` across the same four manifests for the normal `develop` auto-patch flow; the historical trial and its qualification are not changed.

The PAP-283 worktree trial label is `0.1.156-pap283.1`, set across those same four manifests for operator trial installation. `ppa --version` must display `ppa 0.1.156-pap283.1`; Nix also uses this label in the package name. `packages/runtime-host` stays independently versioned. Build the clean exact label commit, not a dirty/unversioned path. This version-only change does not alter dependency/lockfile/Nix hashes, resolve the still-pending PAPC opt-in pairing, or grant installation/activation or product acceptance.

The PAP-283 integration candidate restores plain `0.1.156` for the normal `develop` auto-patch flow. The historical labelled artifact remains bound to `e8602d710be6faae65a81e99014c825e91058164`; neither integration nor a subsequent auto bump changes that installed trial or transfers its qualification.

After separately installing the labelled artifact, run the following to compare the selected installed package with that exact trial commit (not a moving branch HEAD):

```sh
ppa --version
python3 - <<'PY'
import json, pathlib, shutil
expected = 'e8602d710be6faae65a81e99014c825e91058164'
root = pathlib.Path(shutil.which('ppa')).resolve().parent.parent
metadata = json.loads((root / 'share/pa-platform/review-runtime-provenance.json').read_text())
assert metadata['packageVersion'] == '0.1.156-pap283.1', metadata
assert metadata['sourceSha'] == expected, metadata
print(json.dumps(metadata, indent=2))
PY
```

The readable label distinguishes this trial; `sourceSha` verifies the precise commit. Later trial source changes require a fresh exact build/provenance check (and a new suffix for another operator-selected trial). Restore the ordinary version before integration as with the previous ticket-local builds. This check is identity verification, not the full installed document-package qualifier or human UAT.

This prerelease suffix is an operator-readable label, not a release, tag, activation approval, or replacement for exact source/module provenance required by qualification. Do not run the manual release script to set it. Reconcile the worktree-only version before integration into the normal `develop` auto-patch flow. No lockfile or Nix dependency-hash refresh is needed for a version-only change.

## Manual Release

Manual releases are the boundary for publishing from `main` and creating tags.

1. Merge coordinated config changes into pa-platform-config `develop` before the consuming platform change.
2. Check out the commit pinned by `.pa-platform-config.sha`, keep it clean, fetch `origin/develop`, and set `PA_PHASE5_CONFIG_ROOT` to that checkout.
3. Run `corepack pnpm verify:paired-config -- --require-origin-develop` and `corepack pnpm test:paired`. The gate requires the exact SHA, a clean checkout, 9/9 active teams, 58/58 valid modes, no legacy or invalid pairs, the 6/6 builder-exclusive + 11/11 requirements-read-only + 41/41 other non-locking admission matrix, the direct registered-checkout/no-worktree contract, and config-first ancestry.
4. Merge approved feature branches into `develop` and complete any expected auto patch bump commits there.
5. Run `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm test`.
6. Pick version bump level from committed changes.
7. Run one of:
   ```bash
   corepack pnpm bump:patch
   corepack pnpm bump:minor
   corepack pnpm bump:major
   ```
8. Review generated changelog if `git-cliff` is available. The manual script also refreshes `flake.nix` `pnpmDeps.hash` when `pnpm-lock.yaml` changed.
9. Confirm the release commit and annotated tag were pushed by `scripts/dev/version_bump.sh`.
10. Merge `develop` into `main`.

Use `corepack pnpm bump:refresh-hash` when only the Nix dependency hash needs to be refreshed outside a version release.

## CI Expectations

CI verifies typecheck, build, tests, generated completions, fish syntax, and the exact paired config contract on pushes and pull requests targeting `develop` or `main`. Repository administrators must configure `PA_PLATFORM_CONFIG_TOKEN` with read access to the private companion repository. The paired check intentionally remains red until the pinned config commit is present on config `develop`, enforcing config-first integration before the consuming platform change.

Version tagging remains an explicit manual release step so package version, changelog, Nix hash refresh, release commit, annotated tag, and tag push happen together through `scripts/dev/version_bump.sh`.

## Timestamp Policy

All persisted timestamps must be UTC ISO 8601 strings with a `Z` suffix. Use `nowUtc()` for writes, `parseTimestamp()` for reads, and `formatLocal()` / `formatLocalShort()` only at display boundaries so CLI output renders in the host local timezone with an explicit offset.

## Registry Rollback Note

Schema v9 introduces the `evaluator_ratings` table and related indexes. If you must downgrade a local registry DB from schema v9 to v8, drop `evaluator_ratings` and its related indexes before running with v8 binaries.
