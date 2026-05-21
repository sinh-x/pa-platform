# Dashboard Phase 1 UAT Notes

Phase 1 dashboard is local and read-only.

## Scope

- Views: deployments, tickets, skills, knowledge and memory areas, improvement candidates.
- Server binding: `127.0.0.1` by default via `pa-core serve` lifecycle defaults.
- Mutation policy: no Phase 1 mutation routes are exposed under `/api/dashboard/*`.

## Local Commands

```bash
corepack pnpm --filter @pa-platform/pa-core typecheck
corepack pnpm --filter @pa-platform/pa-core test
```

Full branch verification (Phase 5 handoff):

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm completions
corepack pnpm secrets:scan
```

Optional local serve smoke:

```bash
pa-core serve --host 127.0.0.1 --port 4096
# open http://127.0.0.1:4096/dashboard
```

## Route Checks

- Dashboard shell: `GET /dashboard`
- Read-only data:
  - `GET /api/dashboard/overview`
  - `GET /api/dashboard/views/deployments`
  - `GET /api/dashboard/views/tickets`
  - `GET /api/dashboard/views/skills`
  - `GET /api/dashboard/views/knowledge-memory`
  - `GET /api/dashboard/views/improvement-candidates`
- Mutation denial smoke:
  - `POST /api/dashboard/overview` -> `404`
  - `PATCH /api/dashboard/views/tickets` -> `404`
  - `DELETE /api/dashboard/views/skills` -> `404`

## Performance Note

The `agent-api` test suite includes fixture-backed p95 response checks for the dashboard routes using local fixture sizes aligned with NFR-2 budgets.

## Fixture Sources

- `packages/pa-core/src/__tests__/skills.test.ts`
- `packages/pa-core/src/__tests__/knowledge.test.ts`
- `packages/pa-core/src/__tests__/agent-api.test.ts`

The fixture suites cover skill registry shape/validation, knowledge boundaries, improvement-candidate extraction, empty-state handling, read-only route enforcement, and local p95 route response checks.
