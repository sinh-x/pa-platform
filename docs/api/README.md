# pa-platform Agent API Documentation

Comprehensive documentation for the pa-platform Agent API — the HTTP and WebSocket interface served by `pa-core` on port `9848`. The API exposes tickets, bulletins, deployments, repos, sessions, dashboards, configuration, and related platform resources to clients such as the Avodah phone app, the `opa` CLI, and external integrators.

> **Source of truth:** `packages/pa-core/src/agent-api/routes/` (route handlers).
> **Cross-reference:** `docs/contracts/avodah-agent-api.v1.json` (Avodah compatibility contract — kept as-is alongside this documentation).
> **Last updated:** 2026-08-13

## Documentation Sections

| # | Section | File | Description |
|---|---------|------|-------------|
| 1 | REST API Reference | [rest-api.md](./rest-api.md) | All 68 REST endpoints grouped by domain — method, path, query parameters, request body schema, response schema, and error codes. Domains: tickets, bulletins, focus, teams, documents, folders, config, repos, deployments, deploy routing/control/status, repo deployments/commits/git-ext, timers, actions, skills, knowledge, dashboard, sessions. |
| 2 | WebSocket Protocol | [websocket.md](./websocket.md) | WebSocket hub with 6 event types and payloads, session protocol (start/resume/stop messages), SSE stream format, ping/pong behavior, reconnection notes, and session lifecycle/capacity limits. |
| 3 | Data Models | [data-models.md](./data-models.md) | Field-level type definitions and descriptions for all core types: Ticket, Bulletin, Deployment, Registry, Health, Signal, CodeCtx, and related resources. |
| 4 | CLI Reference | [cli-reference.md](./cli-reference.md) | All 19 top-level commands and 46 subcommands (50 including ticket subticket) with flags, defaults, and usage examples. Covers `pa-core` and the `opa` adapter CLI. |
| 5 | Configuration | [configuration.md](./configuration.md) | Schemas and defaults for `config.yaml`, `repos.yaml`, `health.yaml`, and all environment variables consumed by `pa-core` and `opa`. |
| 6 | Auth & Security | [auth-security.md](./auth-security.md) | CORS configuration (`--cors`), allowed headers, path traversal guards, and security considerations for serving the Agent API. |
| 7 | Server Lifecycle | [server-lifecycle.md](./server-lifecycle.md) | `pa-core serve` start/stop/restart/status, default port `9848`, PID file location, background mode, and dev mode. |
| 8 | Examples & Recipes | [examples.md](./examples.md) | Runnable `curl` and TypeScript code examples for common workflows — deploy, list tickets, check deployment status — against `http://127.0.0.1:9848`. |

## Quick Navigation

**By audience:**

- **External app developers** — start with [REST API Reference](./rest-api.md), then [Data Models](./data-models.md) and [Auth & Security](./auth-security.md).
- **PA platform contributors** — see [CLI Reference](./cli-reference.md), [Configuration](./configuration.md), and [Server Lifecycle](./server-lifecycle.md).
- **Integrators** — jump to [Examples & Recipes](./examples.md) for runnable snippets.

**By resource domain:**

| Domain | Route file(s) | Documented in |
|--------|---------------|---------------|
| Tickets | `tickets.ts` | [REST API Reference](./rest-api.md) |
| Bulletins | `bulletin.ts` | [REST API Reference](./rest-api.md) |
| Focus | `focus.ts` | [REST API Reference](./rest-api.md) |
| Teams | `teams.ts` | [REST API Reference](./rest-api.md) |
| Documents | `documents.ts` | [REST API Reference](./rest-api.md) |
| Folders | `folders.ts` | [REST API Reference](./rest-api.md) |
| Config | `config.ts` | [REST API Reference](./rest-api.md), [Configuration](./configuration.md) |
| Repos | `repos.ts` | [REST API Reference](./rest-api.md) |
| Deployments | `deployments.ts`, `deploy-routing.ts`, `deploy-control.ts`, `deploy-status.ts` | [REST API Reference](./rest-api.md) |
| Repo deployments | `repo-deployments.ts` | [REST API Reference](./rest-api.md) |
| Repo commits | `repo-commits.ts` | [REST API Reference](./rest-api.md) |
| Repo git ext | `repo-git-ext.ts` | [REST API Reference](./rest-api.md) |
| Timers | `timers.ts` | [REST API Reference](./rest-api.md) |
| Actions | `actions.ts` | [REST API Reference](./rest-api.md) |
| Skills | `skills.ts` | [REST API Reference](./rest-api.md) |
| Knowledge | `knowledge.ts` | [REST API Reference](./rest-api.md) |
| Dashboard | `dashboard.ts` | [REST API Reference](./rest-api.md) |
| Sessions | `sessions.ts` | [REST API Reference](./rest-api.md), [WebSocket Protocol](./websocket.md) |

## Conventions

- All endpoints are served under the `/api` base path unless noted otherwise.
- Default server port: `9848` (loopback `127.0.0.1`).
- Request and response bodies use JSON (`Content-Type: application/json`) unless documented otherwise (e.g., SSE streams).
- Error responses follow a consistent shape documented in the [REST API Reference](./rest-api.md).
- Documentation reflects the codebase state as of 2026-08-13. The existing Avodah compatibility contract at `docs/contracts/avodah-agent-api.v1.json` is preserved as-is and is not modified by this documentation effort.