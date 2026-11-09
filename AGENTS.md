# pa-platform Architecture Notes

## Branch Strategy

- Base branch: `develop`
- Release branch: `main`
- Feature branches: `feature/<ticket>-<topic>`, created from `develop`.
- Do not work directly on `main` or `develop`.
- Merge feature branches into `develop`; merge `develop` into `main` for releases only.
- Hotfixes branch from `main` and merge into both `main` and `develop`.

## Repository Layout

- `packages/pa-core` contains runtime-neutral PA state, CLI, registry, ticket, bulletin, health, codectx, signal, team, and API logic.
- `packages/opencode-pa` contains the OpenCode adapter and the `opa` runtime CLI.
- `teams/`, `skills/`, and `completions/` are packaged into the Nix output.
- `docs/` contains repository standards, explanatory material, and examples; it is not active runtime configuration.

## Human-Facing CLI Messages

For independently authorized work that designs, changes, or reviews human-facing PPA/OPA messages, read and follow [the CLI message standard](docs/cli-message-standard.md). It is the rule owner for success, progress, information/help, warnings, failures, and blockers; this section does not define a competing policy.

Use its agent procedure (§4) and applicable review checklist (§8). Include before/after examples, affected message paths/categories, actual focused check results, and remaining limitations in the change report. Human readability review, structural checks, software tests, and installed verification are separate evidence.

Apply the standard to messages touched by the task, not as a bulk rewrite. Preserve machine-output/exit/stream contracts and existing safety, admission, and audit owners. These repository instructions grant no execution authority, replace no task validation matrix, and do not select an external managed project guide. PAP-246 is documentation rollout only, not the superseded CLI/API implementation.

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
