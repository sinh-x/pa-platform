# Release Process

Use `develop` for integration and `main` for releases.

## Develop Auto Patch Bumps

After CI passes for a PR-originated push to `develop`, the `version-bump` workflow runs `corepack pnpm bump:patch:ci` and commits only deterministic package version edits back to `develop` with `[skip version-bump]` in the commit message.

The auto bump path is intentionally not a release path. It does not generate a changelog, create a release commit, create a git tag, or push tags.

The CI helper updates `package.json`, `packages/pa-core/package.json`, and `packages/opencode-pa/package.json` together. It does not edit `pnpm-lock.yaml` or `flake.nix`; Nix package builds read the top-level package version from `package.json`, so an auto patch bump changes the derivation version without requiring a `pnpmDeps.hash` refresh unless dependency or lockfile content changes separately.

## Manual Release

Manual releases are the boundary for publishing from `main` and creating tags.

1. Merge approved feature branches into `develop` and complete any expected auto patch bump commits there.
2. Run `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm test`.
3. Pick version bump level from committed changes.
4. Run one of:
   ```bash
   corepack pnpm bump:patch
   corepack pnpm bump:minor
   corepack pnpm bump:major
   ```
5. Review generated changelog if `git-cliff` is available. The manual script also refreshes `flake.nix` `pnpmDeps.hash` when `pnpm-lock.yaml` changed.
6. Confirm the release commit and annotated tag were pushed by `scripts/dev/version_bump.sh`.
7. Merge `develop` into `main`.

Use `corepack pnpm bump:refresh-hash` when only the Nix dependency hash needs to be refreshed outside a version release.

## CI Expectations

CI verifies typecheck, build, tests, generated completions, and fish syntax on pushes and pull requests targeting `develop` or `main`.

Version tagging remains an explicit manual release step so package version, changelog, Nix hash refresh, release commit, annotated tag, and tag push happen together through `scripts/dev/version_bump.sh`.

## Timestamp Policy

All persisted timestamps must be UTC ISO 8601 strings with a `Z` suffix. Use `nowUtc()` for writes, `parseTimestamp()` for reads, and `formatLocal()` / `formatLocalShort()` only at display boundaries so CLI output renders in the host local timezone with an explicit offset.
