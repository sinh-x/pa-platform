# @pa-platform/pa-core

Runtime-neutral PA platform core library.

## Purpose

`pa-core` owns shared PA behavior that runtime adapters reuse: CLI dispatch, ticket and bulletin stores, deployment registry, repository resolution, health checks, codectx, signal collection, team loading, primer rendering, and Agent API routes.

## Key Exports

- `runCoreCommand` runs the shared CLI dispatcher with runtime hooks.
- Runtime API helpers expose the Hono app used by adapters.
- Store modules manage tickets, bulletins, registry entries, and workflow state under `~/Documents/ai-usage` by default.

## Development

```bash
corepack pnpm --filter @pa-platform/pa-core typecheck
corepack pnpm --filter @pa-platform/pa-core test
corepack pnpm --filter @pa-platform/pa-core build
```

Runtime-specific execution must be supplied by an adapter. Without hooks, deploy and server commands fail explicitly instead of invoking a runtime.
