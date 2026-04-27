# Release Process

Use `develop` for integration and `main` for releases.

## Manual Release

1. Merge approved feature branches into `develop`.
2. Run `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm test`.
3. Pick version bump level from committed changes.
4. Run one of:
   ```bash
   corepack pnpm bump:patch
   corepack pnpm bump:minor
   corepack pnpm bump:major
   ```
5. Review generated changelog if `git-cliff` is available.
6. Push release commit and annotated tag.
7. Merge `develop` into `main`.

## CI Expectations

CI verifies typecheck, build, tests, generated completions, and fish syntax on pushes and pull requests targeting `develop` or `main`.

Version tagging remains an explicit release step so package version, changelog, Nix hash refresh, and tag push happen together through `scripts/dev/version_bump.sh`.

## Timestamp Policy

All persisted timestamps must be UTC ISO 8601 strings with a `Z` suffix. Use `nowUtc()` for writes, `parseTimestamp()` for reads, and `formatLocal()` / `formatLocalShort()` only at display boundaries so CLI output renders in the host local timezone with an explicit offset.
