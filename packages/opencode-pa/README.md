# @pa-platform/opencode-pa

OpenCode runtime adapter for PA platform.

## Purpose

`opencode-pa` packages the `opa` CLI. It reuses `@pa-platform/pa-core` for shared PA commands and supplies OpenCode-specific deploy, process, and activity-capture hooks.

## Runtime Notes

- `opa deploy` starts PA team deployments through OpenCode.
- `pa-core serve` manages the core-owned Agent API process; `opa` supplies the default OpenCode deployment adapter used by that server.
- OpenCode activity capture installs repo-managed hooks from this package during deployment setup.

## Development

```bash
corepack pnpm --filter @pa-platform/opencode-pa typecheck
corepack pnpm --filter @pa-platform/opencode-pa test
corepack pnpm --filter @pa-platform/opencode-pa build
```

`opencode-pa` depends on `pa-core`; test and typecheck scripts build `pa-core` first so adapter checks use current core output.
