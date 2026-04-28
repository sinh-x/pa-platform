# pa-platform Architecture Notes

## Branch Strategy

- Base branch: `develop`
- Release branch: `main`
- Feature branches: `feature/<ticket>-<topic>`
- Do not work directly on `main` or `develop`.

## Repository Layout

- `packages/pa-core` contains runtime-neutral PA state, CLI, registry, ticket, bulletin, health, codectx, signal, team, and API logic.
- `packages/opencode-pa` contains the OpenCode adapter and the `opa` runtime CLI.
- `teams/`, `skills/`, and `completions/` are packaged into the Nix output.
- `docs/` contains non-active explanatory material and examples.

## Development Checks

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm completions
```

Run `corepack pnpm secrets:scan` before committing sensitive workflow changes.

## Release

Use `docs/release-process.md` for version bumping, Nix hash refresh, changelog, and tag flow.
