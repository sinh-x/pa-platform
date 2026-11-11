# Release Process

Use `develop` for integration and `main` for releases.

## Develop Auto Patch Bumps

After CI passes for a PR-originated push to `develop`, the `version-bump` workflow runs `corepack pnpm bump:patch:ci` and commits only deterministic package version edits back to `develop` with `[skip version-bump]` in the commit message.

The auto bump path is intentionally not a release path. It does not generate a changelog, create a release commit, create a git tag, or push tags.

The CI helper updates `package.json`, `packages/pa-core/package.json`, `packages/opencode-pa/package.json`, and `packages/pi-pa/package.json` together. It does not edit `pnpm-lock.yaml` or `flake.nix`; Nix package builds read the top-level package version from `package.json`, so an auto patch bump changes the derivation version without requiring a `pnpmDeps.hash` refresh unless dependency or lockfile content changes separately.

## Ticket-Local Build Labels

For an explicitly approved worktree-only build label, update the same four manifests together. The PAP-271 operator-selected development build used `0.1.153-pap271.1`, displayed by `ppa --version` and used as the Nix package version. Its integration candidate restores the plain `develop` version for the normal auto-patch flow; the installed development build retains its readable label. Rebuilding/selecting the package is still required; editing source manifests does not change an existing installation.

The PAP-273 native-confirmation/branch-inspection follow-up trial label is `0.1.158-pap273.6`, set across the same four manifests. It supersedes `.5` for this worktree's next separately selected test installation; installed `.5` is not changed by source edits. New `pa-document-confirmation/v3` opt-in and retained-profile boundaries are documented in `PAP-273-native-confirmation-follow-up.md`. Build from the clean exact label commit and check both `packageVersion` and its `sourceSha`, not a dirty/path-derived source. This suffix is not installed qualification, config activation, acceptance, release/tag or a dependency-hash change.

The earlier PAP-273 process-amendment trial label is `0.1.158-pap273.5`, set across the same four manifests for operator Nix test installation. Expect `ppa --version` to display `ppa 0.1.158-pap273.5`; verify `packageVersion` and the exact clean label commit's `sourceSha` in `share/pa-platform/review-runtime-provenance.json` as well. This is a label-only change: no build/install/activation, config-pin or dependency-hash refresh, release/tag, or acceptance is implied. The partial implementation and qualification limits remain in `PAP-273-process-amendment.md`. Restore plain `0.1.158` before normal develop integration, reconciling any newer develop version then.

The earlier PAP-273 labelled trial is `0.1.154-pap273.4`, committed at `2f2deccfea37364dadc36be1e497db3f94efbbcb` across those same four manifests (superseding `.1`–`.3`). Its integration candidate restores plain `0.1.154` for the normal `develop` auto-patch flow; this does not change the installed trial or transfer its qualification. `packages/runtime-host` remains independently versioned. See `PAP-273-integration-status.md` for retained installed-provenance and UAT gaps.

The PAP-277 worktree trial label is `0.1.155-pap277.1`, set across those same four manifests for operator trial installation and PAPC development. This label does not resolve the retained full-suite timeout or establish installed-pair, foreground-agent, CI or human-UAT acceptance; see `PAP-277-qualification.md`. Use the clean version-label commit as the exact candidate SHA when building and verifying the trial. The PAP-277 integration candidate restores plain `0.1.155` across the same four manifests for the normal `develop` auto-patch flow; the historical trial and its qualification are not changed.

The PAP-283 worktree trial label is `0.1.156-pap283.1`, set across those same four manifests for operator trial installation. `ppa --version` must display `ppa 0.1.156-pap283.1`; Nix also uses this label in the package name. `packages/runtime-host` stays independently versioned. Build the clean exact label commit, not a dirty/unversioned path. This version-only change does not alter dependency/lockfile/Nix hashes, resolve the still-pending PAPC opt-in pairing, or grant installation/activation or product acceptance.

The current PAP-289 worktree reference label is `0.1.160-pap289.5` across the four
shared manifests, selected by the operator for installation identification of the
[fixed curl/Python workflow](public-web-curl-python.md). Expect a separately rebuilt
CLI to display `ppa 0.1.160-pap289.5`; verify its exact clean source commit and worker
manifest as well. `runtime-host` is unchanged. The preceding exact-source `.4`
package attempt timed out; no `.5` package, installation or acceptance is implied.

The preceding PAP-289 worktree reference label was `0.1.160-pap289.4` across the four
shared manifests. It implements the operator-selected
[public-response content policy](public-web-source-policy.md), preserving local-file
and supplied/redirect URL protections. Expect a separately built source CLI to
display `ppa 0.1.160-pap289.4`. It retains the `.3` repair for composite provider IDs;
the previous `.2` label followed source reader enablement in
`303106e62abbdf1fe9d5e035a42df7328c817bd5`. `runtime-host` remains independently versioned.
Reader enablement and the clean exact-Git build/provenance recipe are documented in
[mode-capabilities.md](mode-capabilities.md#current-enablement-and-packaging--d-b08f19).
Use the new clean label commit as the exact build revision; `.4` is not an installed
artifact, qualification/UAT pass, release/tag or config-pin/dependency-hash change.
The installed `.3` trial is unchanged. The following historical label-only record
predates enablement; its outstanding-policy/gate statements describe that earlier
checkpoint, not the new source candidate.

The PAP-289 worktree trial label is `0.1.160-pap289.1`, set across the same four manifests at the operator's request so a separately installed worktree build is identifiable. Expect `ppa --version` to display `ppa 0.1.160-pap289.1`; verify `packageVersion` and the clean label commit's exact `sourceSha` in `share/pa-platform/review-runtime-provenance.json` as well. `packages/runtime-host` remains independently versioned. This label does not enable the staged public reader or complete PAPC composition, egress/retention approval, independent review/CI, installed qualification or human UAT. No installation, config-pin, dependency/lockfile/Nix hash, release/tag or rebase change follows from this version-only update. Restore the current plain develop version before integration; the requested updated-develop rebase remains outstanding.

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
