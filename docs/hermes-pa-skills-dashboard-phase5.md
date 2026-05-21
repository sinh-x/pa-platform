# Hermes Skills Dashboard Phase 5 Handoff

This document finalizes Phase 5 for `PAP-078` on `feature/PAP-078-hermes-pa-structure`.

## Packaging and Workspace Integration

- No additional pnpm workspace package was required in Phase 5.
- Dashboard routes and shell remain implemented in `@pa-platform/pa-core` under `packages/pa-core/src/agent-api/routes/dashboard.ts`.
- Existing workspace glob in `pnpm-workspace.yaml` (`packages/*`) already covers all active packages.
- No Nix output shape changes were required for this phase because no new package or install artifact was introduced.

## Memory, Skill, and Knowledge Boundaries

The dashboard and Agent API expose read-only boundaries aligned with Phase 1-4 implementation:

- Runtime memory docs: `CLAUDE.md`/`OPENCODE.md` sources injected into primers at deployment start.
- Packaged skills: rooted in `pa-platform-config/skills/` and scanned through skill registry APIs.
- Knowledge and operations records: `knowledge-base/`, `agent-teams/*/artifacts/`, `sessions/YYYY/MM/agent-team/`, and `deployments/`.
- Improvement candidates: derived read model from session logs and evaluator artifacts, with no direct mutation endpoint.

Reference routes:

- `GET /api/skills`
- `GET /api/knowledge-boundaries`
- `GET /api/improvement-candidates`
- `GET /api/dashboard/views/knowledge-memory`
- `GET /api/dashboard/views/opencode-integration`

## Local Dashboard Usage

Start a local read-only dashboard/API instance:

```bash
pa-core serve --host 127.0.0.1 --port 4096
```

Open `http://127.0.0.1:4096/dashboard` and validate:

- Dashboard shell is reachable.
- Data views render for deployments, tickets, skills, knowledge-memory, and improvement candidates.
- Non-GET calls to dashboard routes return `404`.

## UAT Fixtures and Evidence

Fixture coverage for this feature set is implemented in:

- `packages/pa-core/src/__tests__/skills.test.ts`
- `packages/pa-core/src/__tests__/knowledge.test.ts`
- `packages/pa-core/src/__tests__/agent-api.test.ts`

These tests include:

- Hermes decision matrix and skill metadata validation.
- Knowledge boundary classification and improvement candidate extraction.
- Dashboard read-only contract checks, empty-state behavior, and p95 performance assertions under local fixture scale.

## FR/NFR/AC Traceability

- FR-8: This handoff preserves ordered phases, deliverables, traceability, and repository verification commands.
- NFR-5: Backend remains TypeScript/Node 22 and Hono/pa-core patterns.
- NFR-6: Full repository verification commands are listed below and executed in this phase.
- AC-6: Builder handoff is executable with explicit verification and pass/fail reporting.

## Repository Verification Commands

Run in repo root:

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm completions
corepack pnpm secrets:scan
```

Run this only if Nix outputs changed:

```bash
nix flake show --no-write-lock-file
```
