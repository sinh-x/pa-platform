import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { appendActivityEvent, appendEvaluatorResult, appendRegistryEvent, BulletinStore, closeDb, createActivityEvent, createAgentApiApp, hub, startWatchers, TicketStore, WsHub } from "../index.js";
import type { WsClient, WsEvent } from "../index.js";
import { PA_OPENCODE_BINARY_ENV } from "../agent-api/ws/session-hub.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value !== undefined) return value;
    await sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}

class FakeWsClient implements WsClient {
  readyState = 1;
  readonly messages: string[] = [];
  closed = false;

  send(message: string): void {
    this.messages.push(message);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function withApiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-agent-api-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "config.yaml"), `defaults:\n  runtime: opencode\n  opencode:\n    provider: openai\n    model: gpt-5.5\nprovider_defaults:\n  providers:\n    minimax:\n      models:\n        opus: minimax-coding-plan/MiniMax-M2.7\n    openai:\n      models:\n        opus: openai/gpt-5.5\n`);
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), `name: builder\ndescription: Builder\ndefault_mode: plan\ntimeout: 600\nobjective: Build\nagents:\n  - name: implementer\n    role: Writes code\n    model: opus\ndeploy_modes:\n  - id: plan\n    label: Plan\n    mode_type: work\n    provider: minimax\n    model: opus\n    timeout: 900\n  - id: hidden\n    label: Hidden\n    mode_type: work\n    phone_visible: false\n  - id: chat\n    label: Chat\n    mode_type: interactive\n`);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousTeams = process.env["PA_PLATFORM_TEAMS"];
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousTeams === undefined) delete process.env["PA_PLATFORM_TEAMS"];
    else process.env["PA_PLATFORM_TEAMS"] = previousTeams;
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    rmSync(root, { recursive: true, force: true });
  });
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

test("agent API exposes health, tickets, bulletins, teams, and documents", async () => {
  await withApiEnv(async (root) => {
    const { app } = createAgentApiApp();
    const health = await app.request("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const created = await app.request("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "pa-platform", title: "API ticket", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { ticket: { id: string } };
    assert.match(createdBody.ticket.id, /^PAP-/);
    const listed = await app.request("/api/tickets?project=pa-platform");
    assert.equal((await listed.json() as { count: number }).count, 1);

    const bulletin = await app.request("/api/bulletin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Stop", block: "all", message: "Pause" }) });
    assert.equal(bulletin.status, 201);
    assert.equal((await app.request("/api/bulletin")).status, 200);

    mkdirSync(join(root, "agent-teams", "builder", "inbox"), { recursive: true });
    mkdirSync(join(root, "agent-teams", "builder", "waiting-for-response"), { recursive: true });
    writeFileSync(join(root, "agent-teams", "builder", "inbox", "request.md"), "request");

    const workspaces = await app.request("/api/teams");
    const workspaceBody = await workspaces.json() as { teams: Array<{ name: string; inbox_count: number; wfr_count: number; waiting_for_response_count: number; path: string }> };
    assert.equal(workspaceBody.teams[0]?.name, "builder");
    assert.equal(workspaceBody.teams[0]?.inbox_count, 1);
    assert.equal(workspaceBody.teams[0]?.wfr_count, 0);
    assert.equal(workspaceBody.teams[0]?.waiting_for_response_count, 0);

    const teams = await app.request("/api/pa-teams");
    const teamsBody = await teams.json() as { teams: Array<{ name: string; default_mode: string; timeout: number; agents: Array<{ name: string; role: string; model: string }>; deploy_modes: Array<{ id: string; mode_type?: string; provider?: string; model?: string; timeout?: number }> }> };
    assert.equal(teamsBody.teams[0]?.name, "builder");
    assert.equal(teamsBody.teams[0]?.default_mode, "plan");
    assert.equal(teamsBody.teams[0]?.timeout, 600);
    assert.deepEqual(teamsBody.teams[0]?.agents, [{ name: "implementer", role: "Writes code", model: "opus" }]);
    assert.deepEqual(teamsBody.teams[0]?.deploy_modes.map((mode) => mode.id), ["plan", "chat"]);
    assert.equal(teamsBody.teams[0]?.deploy_modes[0]?.provider, "minimax");

    const skills = await app.request("/api/skills");
    assert.equal(skills.status, 200);
    const skillsBody = await skills.json() as { inventory: Array<{ name: string }>; hermesDecisionMatrix: Array<{ decision: string }> };
    assert.ok(skillsBody.inventory.length >= 0);
    assert.ok(skillsBody.hermesDecisionMatrix.length >= 6);

    mkdirSync(join(root, "sessions", "2026", "05", "agent-team"), { recursive: true });
    writeFileSync(join(root, "sessions", "2026", "05", "agent-team", "2026-05-21-d-test-builder--team-manager--PAP-078--phase-2.md"), [
      "# AI Session Log",
      "> Agent: builder/team-manager",
      "",
      "## Self-Improvement",
      "### What could be improved?",
      "- tighten candidate extraction coverage",
      "",
      "## Follow-up Tasks",
      "- [ ] PAP-321 add more tests",
    ].join("\n"));
    appendRegistryEvent({ deployment_id: "d-api-1", team: "builder", event: "started", timestamp: "2026-05-21T00:00:00.000Z" });
    appendRegistryEvent({ deployment_id: "d-api-eval-1", team: "evaluator", event: "started", timestamp: "2026-05-21T00:00:30.000Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-api-1",
      evaluator_deployment_id: "d-api-eval-1",
      summary: "Evaluator finding",
      findings: "missing doc refs\nPAP-654 follow-up needed",
      evidence_refs: ["deployments/d-api-1/primer.md"],
      rating: { source: "system", overall: 3, metrics: { quality: 3 } },
    });

    const boundaries = await app.request("/api/knowledge-boundaries");
    assert.equal(boundaries.status, 200);
    const boundariesBody = await boundaries.json() as { boundaries: Array<{ itemType: string; storageLocation: string }> };
    assert.equal(boundariesBody.boundaries.length, 8);
    assert.equal(boundariesBody.boundaries.some((item) => item.itemType === "session-log"), true);

    const candidates = await app.request("/api/improvement-candidates");
    assert.equal(candidates.status, 200);
    const candidatesBody = await candidates.json() as { candidates: Array<{ sourceType: string; sourceLink: string; owner: string; status: string; decision: string; followUpReference: string | null }> };
    assert.equal(candidatesBody.candidates.some((candidate) => candidate.sourceType === "session-log" && candidate.owner === "builder/team-manager"), true);
    assert.equal(candidatesBody.candidates.some((candidate) => candidate.sourceType === "evaluator-artifact"), true);
    assert.equal(candidatesBody.candidates.every((candidate) => candidate.status === "new" && candidate.decision === "pending"), true);

    const mutateCandidates = await app.request("/api/improvement-candidates", { method: "POST" });
    assert.equal(mutateCandidates.status, 404);

    const routing = await app.request("/api/deploy-routing");
    assert.deepEqual(await routing.json(), {
      teams: [{ name: "builder", description: "Builder", default_provider: "openai", default_model: "gpt-5.5", modes: [{ id: "plan", label: "Plan", modeType: "work" }] }],
      repos: [{ name: "pa-platform", path: join(root, "repo"), description: "Test repo" }],
    });

    const agentTeams = await app.request("/api/agent-teams");
    assert.deepEqual((await agentTeams.json() as { teams: Array<{ name: string; inbox_exists: boolean; inbox_count: number }> }).teams.map((team) => ({ name: team.name, inbox_exists: team.inbox_exists, inbox_count: team.inbox_count })), [{ name: "builder", inbox_exists: true, inbox_count: 1 }]);

    mkdirSync(join(root, "agent-teams", "builder", "artifacts"), { recursive: true });
    writeFileSync(join(root, "agent-teams", "builder", "artifacts", "note.md"), "# Note\n\nBody");
    const doc = await app.request("/api/documents?path=agent-teams/builder/artifacts/note.md");
    assert.equal(doc.status, 200);
    assert.equal((await doc.json() as { metadata: { title: string } }).metadata.title, "Note");
  });
});

test("persistent API requires trusted caller identity for status mutation", async () => {
  await withApiEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-api-implement", team: "builder", mode: "implement", event: "started", timestamp: "2026-04-26T00:00:00.000Z", ticket_id: "PAP-001" });
    appendRegistryEvent({ deployment_id: "d-api-parent", team: "builder", mode: "orchestrator", event: "started", timestamp: "2026-04-26T00:00:01.000Z", ticket_id: "PAP-001" });
    appendRegistryEvent({ deployment_id: "d-api-stale", team: "builder", mode: "orchestrator", event: "started", timestamp: "2026-04-26T00:00:02.000Z", ticket_id: "PAP-001" });
    appendRegistryEvent({ deployment_id: "d-api-stale", team: "builder", mode: "orchestrator", event: "completed", timestamp: "2026-04-26T00:00:03.000Z", status: "success", ticket_id: "PAP-001" });
    const implementApp = createAgentApiApp({ ticketMutationAuth: { deploymentId: "d-api-implement", credential: "implement-credential", operatorCredential: "operator-credential" } });
    const staleApp = createAgentApiApp({ ticketMutationAuth: { deploymentId: "d-api-stale", credential: "stale-credential" } });
    const unknownApp = createAgentApiApp({ ticketMutationAuth: { deploymentId: "d-api-unknown", credential: "unknown-deployment-credential" } });
    const created = await implementApp.app.request("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "pa-platform", title: "Protected API ticket", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }) });
    const id = (await created.json() as { ticket: { id: string } }).ticket.id;
    const store = new TicketStore();
    const rejectedRequests: Array<{ app: ReturnType<typeof createAgentApiApp>["app"]; headers: Record<string, string> }> = [
      { app: implementApp.app, headers: { "content-type": "application/json" } },
      { app: implementApp.app, headers: { "content-type": "application/json", Authorization: "Bearer implement-credential", "X-PA-Deployment-ID": "d-api-parent" } },
      { app: implementApp.app, headers: { "content-type": "application/json", Authorization: "Bearer unknown-credential" } },
      { app: implementApp.app, headers: { "content-type": "application/json", Authorization: "Bearer implement-credential", "X-PA-Deployment-ID": "d-api-implement" } },
      { app: implementApp.app, headers: { "content-type": "application/json", Authorization: "Bearer wrong-implement-credential" } },
      { app: staleApp.app, headers: { "content-type": "application/json", Authorization: "Bearer stale-credential", "X-PA-Deployment-ID": "d-api-stale" } },
      { app: unknownApp.app, headers: { "content-type": "application/json", Authorization: "Bearer unknown-deployment-credential", "X-PA-Deployment-ID": "d-api-unknown" } },
    ];
    for (const { app, headers } of rejectedRequests) {
      const beforeTicket = store.get(id);
      const beforeAudit = store.readAudit();
      const rejected = await app.request(`/api/tickets/${id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "review-uat" }) });
      assert.equal(rejected.status, 400);
      assert.deepEqual(store.get(id), beforeTicket);
      assert.deepEqual(store.readAudit(), beforeAudit);
    }
    const parentApp = createAgentApiApp({ ticketMutationAuth: { deploymentId: "d-api-parent", credential: "parent-credential" } });
    const accepted = await parentApp.app.request(`/api/tickets/${id}`, { method: "PATCH", headers: { "content-type": "application/json", Authorization: "Bearer parent-credential", "X-PA-Deployment-ID": "d-api-parent" }, body: JSON.stringify({ status: "review-uat" }) });
    assert.equal(accepted.status, 200);
    assert.equal(store.get(id)?.status, "review-uat");
    assert.equal(store.readAudit().at(-1)?.action, "updated");
    const operatorApp = createAgentApiApp({ ticketMutationAuth: { operatorCredential: "operator-credential" } });
    const beforeOperatorMismatchTicket = store.get(id);
    const beforeOperatorMismatchAudit = store.readAudit();
    const operatorMismatch = await operatorApp.app.request(`/api/tickets/${id}`, { method: "PATCH", headers: { "content-type": "application/json", Authorization: "Bearer wrong-operator-credential" }, body: JSON.stringify({ status: "cancelled" }) });
    assert.equal(operatorMismatch.status, 400);
    assert.deepEqual(store.get(id), beforeOperatorMismatchTicket);
    assert.deepEqual(store.readAudit(), beforeOperatorMismatchAudit);
    const operatorAccepted = await operatorApp.app.request(`/api/tickets/${id}`, { method: "PATCH", headers: { "content-type": "application/json", Authorization: "Bearer operator-credential" }, body: JSON.stringify({ status: "done" }) });
    assert.equal(operatorAccepted.status, 200);
    parentApp.cleanup();
    operatorApp.cleanup();
    implementApp.cleanup();
    staleApp.cleanup();
    unknownApp.cleanup();
  });
});

test("dashboard shell endpoints are read-only, include empty states, and stay fast with local fixture sizes", async () => {
  await withApiEnv(async (root) => {
    const { app } = createAgentApiApp();

    const emptyDeployments = await app.request("/api/dashboard/views/deployments");
    assert.equal(emptyDeployments.status, 200);
    assert.equal((await emptyDeployments.json() as { count: number }).count, 0);

    const emptyImprovements = await app.request("/api/dashboard/views/improvement-candidates");
    assert.equal(emptyImprovements.status, 200);
    assert.equal((await emptyImprovements.json() as { count: number }).count, 0);

    for (let i = 0; i < 500; i++) {
      appendRegistryEvent({
        deployment_id: `d-phase1-${String(i).padStart(3, "0")}`,
        team: "builder",
        event: "started",
        timestamp: `2026-05-21T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
        ticket_id: `PAP-${i + 100}`,
      });
    }
    appendRegistryEvent({
      deployment_id: "d-opencode-view-001",
      team: "builder",
      event: "started",
      timestamp: "2026-05-21T02:00:00.000Z",
      ticket_id: "PAP-078",
      runtime: "opencode",
      binary: "opa",
    });
    mkdirSync(join(root, "deployments", "d-opencode-view-001"), { recursive: true });
    writeFileSync(join(root, "deployments", "d-opencode-view-001", "primer.md"), [
      "# PA Deployment Primer",
      "## Memory Docs",
      '<memory-doc path="/tmp/repo/CLAUDE.md">',
      "Repo memory",
      "</memory-doc>",
      '<memory-doc path="/tmp/repo/OPENCODE.md">',
      "Runtime memory",
      "</memory-doc>",
    ].join("\n"));

    const store = new TicketStore();
    for (let i = 0; i < 500; i++) {
      store.create({ project: "pa-platform", title: `Ticket ${i}`, summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
    }
    const dashboardApp = createAgentApiApp();

    const html = await dashboardApp.app.request("/dashboard");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /PA Local Dashboard/);

    const overview = await dashboardApp.app.request("/api/dashboard/overview");
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { readOnly: boolean; mutationRoutes: unknown[]; counts: { tickets: number } };
    assert.equal(overviewBody.readOnly, true);
    assert.deepEqual(overviewBody.mutationRoutes, []);
    assert.equal(overviewBody.counts.tickets, 500);

    const nonGetStatuses = await Promise.all([
      dashboardApp.app.request("/api/dashboard/overview", { method: "POST" }),
      dashboardApp.app.request("/api/dashboard/views/tickets", { method: "PATCH" }),
      dashboardApp.app.request("/api/dashboard/views/skills", { method: "DELETE" }),
    ]);
    for (const response of nonGetStatuses) assert.equal(response.status, 404);

    const paths = [
      "/api/dashboard/overview",
      "/api/dashboard/views/deployments",
      "/api/dashboard/views/tickets",
      "/api/dashboard/views/skills",
      "/api/dashboard/views/knowledge-memory",
      "/api/dashboard/views/improvement-candidates",
      "/api/dashboard/views/opencode-integration",
    ];
    const durations: number[] = [];
    for (const path of paths) {
      for (let i = 0; i < 8; i++) {
        const startedAt = performance.now();
        const response = await dashboardApp.app.request(path);
        durations.push(performance.now() - startedAt);
        assert.equal(response.status, 200);
      }
    }
    assert.ok(p95(durations) < 500);

    const opencodeView = await dashboardApp.app.request("/api/dashboard/views/opencode-integration");
    assert.equal(opencodeView.status, 200);
    const opencodeBody = await opencodeView.json() as {
      readOnly: boolean;
      runtimeOwner: string;
      deploymentContexts: Array<{ runtime: string; binary: string }>;
      memoryDocSources: string[];
      skillInjection: { source: string; primerSummaryBudgetChars: number; primerSkillSummary: string };
      opencodeSafeValidationWarnings: string[];
    };
    assert.equal(opencodeBody.readOnly, true);
    assert.match(opencodeBody.runtimeOwner, /OPA is authoritative/);
    assert.match(opencodeBody.skillInjection.source, /packaged pa-platform skills/);
    assert.ok(opencodeBody.skillInjection.primerSummaryBudgetChars <= 5000);
    assert.ok(opencodeBody.skillInjection.primerSkillSummary.length <= opencodeBody.skillInjection.primerSummaryBudgetChars);
    assert.ok(Array.isArray(opencodeBody.memoryDocSources));
    assert.ok(opencodeBody.memoryDocSources.includes("/tmp/repo/CLAUDE.md"));
    assert.ok(opencodeBody.memoryDocSources.includes("/tmp/repo/OPENCODE.md"));
    assert.ok(Array.isArray(opencodeBody.deploymentContexts));
    assert.ok(opencodeBody.deploymentContexts.some((deployment) => deployment.runtime === "opencode" && deployment.binary === "opa"));
    assert.ok(Array.isArray(opencodeBody.opencodeSafeValidationWarnings));

    const blockedControl = await dashboardApp.app.request("/api/dashboard/views/opencode-integration", { method: "POST" });
    assert.equal(blockedControl.status, 404);
  });
});

test("agent API CORS matches Avodah phone proxy contract", async () => {
  const { app } = createAgentApiApp({ enableCors: true });
  const preflight = await app.request("/api/projects", {
    method: "OPTIONS",
    headers: {
      origin: "https://drgnfly.tail10c2c6.ts.net",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type,x-av-pair-token,x-av-node-id",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /OPTIONS/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Av-Pair-Token/);
  assert.equal(preflight.headers.get("access-control-max-age"), "600");

  const get = await app.request("/api/health", { headers: { origin: "https://drgnfly.tail10c2c6.ts.net" } });
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  assert.match(get.headers.get("access-control-expose-headers") ?? "", /Content-Length/);
});

test("agent API board resolves projects, applies legacy filters, and includes doc ref titles", async () => {
  await withApiEnv(async (root) => {
    const personalRepo = join(root, "personal-assistant");
    mkdirSync(personalRepo, { recursive: true });
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  pa-platform:\n    path: ${join(root, "repo")}\n    description: Test repo\n    prefix: PAP\n  personal:\n    path: ${personalRepo}\n    description: Personal repo\n    prefix: PA\n`);
    const store = new TicketStore();
    store.create({ project: "pa-platform", title: "API visible", summary: "Summary", description: "", status: "implementing", priority: "high", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [{ type: "requirements", path: "agent-teams/requirements/artifacts/2026-04-27-api-visible.md", primary: true, addedAt: "2026-04-27T00:00:00.000Z", addedBy: "test" }], comments: [] }, "test");
    store.create({ project: "pa-platform", title: "API backlog", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: ["backlog"], blockedBy: [], doc_refs: [], comments: [] }, "test");
    store.create({ project: "pa-platform", title: "API FYI", summary: "Summary", description: "", status: "idea", priority: "medium", type: "fyi", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
    store.create({ project: "personal", title: "API personal", summary: "Summary", description: "", status: "idea", priority: "low", type: "task", assignee: "sinh", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");

    const { app } = createAgentApiApp();
    const allResponse = await app.request("/api/board");
    assert.equal(allResponse.status, 200);
    const allBoard = await allResponse.json() as { board: { project: string; total: number; columns: Array<{ tickets: Array<{ title: string; doc_refs: Array<{ title?: string }> }> }> } };
    const allTitles = allBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title));
    assert.equal(allBoard.board.project, "all");
    assert.match(allTitles.join("\n"), /API visible/);
    assert.match(allTitles.join("\n"), /API personal/);
    assert.doesNotMatch(allTitles.join("\n"), /API backlog|API FYI/);
    assert.equal(allBoard.board.columns.flatMap((column) => column.tickets.flatMap((ticket) => ticket.doc_refs))[0]?.title, "api-visible");

    const prefixResponse = await app.request("/api/board?project=PAP");
    assert.equal(prefixResponse.status, 200);
    const prefixBoard = await prefixResponse.json() as typeof allBoard;
    assert.equal(prefixBoard.board.project, "pa-platform");
    assert.deepEqual(prefixBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title)), ["API visible"]);

    const canonicalResponse = await app.request("/api/board?project=pa-platform");
    assert.equal(canonicalResponse.status, 200);
    assert.deepEqual(await canonicalResponse.json(), prefixBoard);

    const projectsResponse = await app.request("/api/projects");
    assert.equal(projectsResponse.status, 200);
    const projectsBody = await projectsResponse.json() as { projects: Array<{ key: string; activeTicketCount: number; active_ticket_count?: number }> };
    const paPlatformProject = projectsBody.projects.find((project) => project.key === "pa-platform");
    assert.equal(paPlatformProject?.activeTicketCount, 2);
    assert.equal(paPlatformProject?.active_ticket_count, undefined);

    const assigneeResponse = await app.request("/api/board?project=PAP&assignee=builder");
    assert.equal(assigneeResponse.status, 200);
    const assigneeBoard = await assigneeResponse.json() as typeof allBoard;
    assert.deepEqual(assigneeBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title)), ["API visible"]);

    const emptyExclusionsResponse = await app.request("/api/board?excludeTags=&excludeTypes=");
    assert.equal(emptyExclusionsResponse.status, 200);
    const emptyExclusionsBoard = await emptyExclusionsResponse.json() as typeof allBoard;
    const emptyExclusionTitles = emptyExclusionsBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title));
    assert.match(emptyExclusionTitles.join("\n"), /API backlog/);
    assert.match(emptyExclusionTitles.join("\n"), /API FYI/);

    const unknownResponse = await app.request("/api/board?project=unknown");
    assert.equal(unknownResponse.status, 400);
    const unknownBody = await unknownResponse.json() as { error: string; code: string };
    assert.equal(unknownBody.code, "BOARD_FAILED");
    assert.match(unknownBody.error, /Unknown project "unknown"/);
    assert.match(unknownBody.error, /Valid project keys: pa-platform, personal/);
  });
});

test("agent API document, image, and folder routes reject outside-root paths with sandbox violations", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp();
    const documentResponse = await app.request("/api/documents?path=/tmp/outside.md");
    assert.equal(documentResponse.status, 403);
    assert.equal((await documentResponse.json() as { code: string }).code, "SANDBOX_VIOLATION");

    const imageResponse = await app.request("/api/images?path=/tmp/outside.png");
    assert.equal(imageResponse.status, 403);
    assert.equal((await imageResponse.json() as { code: string }).code, "SANDBOX_VIOLATION");

    const folderResponse = await app.request("/api/folders/teams/builder/inbox%2Foutside");
    assert.equal(folderResponse.status, 403);
    assert.equal((await folderResponse.json() as { code: string }).code, "SANDBOX_VIOLATION");
  });
});

test("agent API exposes deployment lists, detail, and activity", async () => {
  await withApiEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-api-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", ticket_id: "PAP-001", agents: ["team-manager"], provider: "openai", models: { team: "openai/gpt-5.5" }, runtime: "opencode", binary: "opa", effective_timeout_seconds: 1200 });
    appendRegistryEvent({ deployment_id: "d-api-1", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", summary: "done" });
    appendRegistryEvent({ deployment_id: "d-api-eval-1", team: "builder", event: "started", timestamp: "2026-04-26T00:02:00.000Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-api-1",
      evaluator_deployment_id: "d-api-eval-1",
      summary: "Evaluator row",
      evidence_refs: ["deployments/d-api-1/primer.md"],
      rating: { source: "system", overall: 4, metrics: { human_agency: 5, quality: 4 } },
    });
    appendActivityEvent(createActivityEvent({ deployId: "d-api-1", timestamp: "2026-04-26T00:00:30.000Z", kind: "text", source: "opencode", body: "hello" }));
    const { app } = createAgentApiApp();
    const list = await app.request("/api/deployments?all=true&ticket_id=PAP-001");
    assert.equal(list.status, 200);
    const listBody = await list.json() as { deployments: Array<{ deploy_id: string; provider?: string; runtime?: string; binary?: string; effective_timeout_seconds?: number; models?: Record<string, string> }>; total: number; filter: { ticket_id: string | null } };
    assert.equal(listBody.total, 1);
    assert.equal(listBody.deployments[0]?.deploy_id, "d-api-1");
    assert.equal(listBody.deployments[0]?.provider, "openai");
    assert.equal(listBody.deployments[0]?.runtime, "opencode");
    assert.equal(listBody.deployments[0]?.binary, "opa");
    assert.equal(listBody.deployments[0]?.effective_timeout_seconds, 1200);
    assert.deepEqual(listBody.deployments[0]?.models, { team: "openai/gpt-5.5" });
    assert.equal(listBody.filter.ticket_id, "PAP-001");
    const detail = await app.request("/api/deployments/d-api-1");
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { status: string; provider?: string; runtime?: string; binary?: string; effective_timeout_seconds?: number; deployment?: unknown; activity_events?: unknown[]; evaluator_results?: Array<{ evaluator_deployment_id: string; rating: { metrics: { human_agency?: number } } }> };
    assert.equal(detailBody.status, "success");
    assert.equal(detailBody.provider, "openai");
    assert.equal(detailBody.runtime, "opencode");
    assert.equal(detailBody.binary, "opa");
    assert.equal(detailBody.effective_timeout_seconds, 1200);
    assert.equal(detailBody.evaluator_results?.[0]?.evaluator_deployment_id, "d-api-eval-1");
    assert.equal(detailBody.evaluator_results?.[0]?.rating.metrics.human_agency, 5);
    assert.equal(detailBody.deployment, undefined);
    assert.equal(detailBody.activity_events, undefined);
    const activity = await app.request("/api/deployments/d-api-1/activity");
    const activityBody = await activity.json() as { events?: unknown[]; activity_events: Array<{ ts: string; deploy_id: string; agent: string; event: string; data: { body?: string } }> };
    assert.equal(activityBody.events, undefined);
    assert.equal(activityBody.activity_events[0]?.ts, "2026-04-26T00:00:30.000Z");
    assert.equal(activityBody.activity_events[0]?.deploy_id, "d-api-1");
    assert.equal(activityBody.activity_events[0]?.agent, "opencode");
    assert.equal(activityBody.activity_events[0]?.event, "text");
    assert.equal(activityBody.activity_events[0]?.data.body, "hello");
    const filteredActivity = await app.request("/api/deployments/d-api-1/activity?since=2026-04-26T00:00:00.000Z");
    assert.equal((await filteredActivity.json() as { activity_events: unknown[] }).activity_events.length, 1);

    assert.equal((await app.request("/api/deployments?since=not-a-date")).status, 400);
    assert.equal((await app.request("/api/deployments/d_bad")).status, 400);
  });
});

test("agent API exposes deploy control hooks and deployment status events", async () => {
  await withApiEnv(async () => {
    const missingHooks = createAgentApiApp();
    const missingDeploy = await missingHooks.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder" }) });
    assert.equal(missingDeploy.status, 501);
    assert.equal((await missingDeploy.json() as { code: string }).code, "NOT_IMPLEMENTED");
    assert.equal((await missingHooks.app.request("/api/self-update", { method: "POST" })).status, 501);
    assert.equal((await missingHooks.app.request("/api/self-update/status")).status, 501);

    const { app } = createAgentApiApp({ hooks: {
      deploy: (request) => ({ status: "pending", team: request.team, mode: request.mode ?? null, deploymentId: "d-hook" }),
      selfUpdate: () => ({ status: "building", startedAt: "2026-04-26T00:00:00.000Z", completedAt: null, log: [] }),
      getSelfUpdateStatus: () => ({ status: "building", startedAt: "2026-04-26T00:00:00.000Z", completedAt: null, log: ["running"] }),
    } });
    const deploy = await app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", mode: "plan", objective: "Ship route", repo: "pa-platform", ticket: "PAP-001", timeout: 120 }) });
    assert.equal(deploy.status, 202);
    assert.deepEqual(await deploy.json(), { team: "builder", mode: "plan", status: "pending", deployment_id: "d-hook" });
    assert.equal((await app.request("/api/self-update", { method: "POST" })).status, 202);
    assert.deepEqual(await (await app.request("/api/self-update/status")).json(), { status: "building", startedAt: "2026-04-26T00:00:00.000Z", completedAt: null, log: ["running"] });

    const failing = createAgentApiApp({ hooks: { deploy: () => { throw new Error("adapter unavailable"); } } });
    const failedDeploy = await failing.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", mode: "plan" }) });
    assert.equal(failedDeploy.status, 202);
    assert.deepEqual(await failedDeploy.json(), { status: "failed", reason: "adapter unavailable", team: "builder", mode: "plan" });

    const started = await app.request("/api/deploy/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deploymentId: "d-status", team: "builder", runtime: "opencode" }) });
    assert.equal(started.status, 200);
    const status = await app.request("/api/deploy/status/d-status");
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { status: { deploy_id: string; status: string } }).status.deploy_id, "d-status");
    assert.equal((await app.request("/api/deploy/events/d-status")).status, 200);
  });
});

test("agent API deploy validates requests and routes through deploy hook without serve hook", async () => {
  await withApiEnv(async () => {
    const received: unknown[] = [];
    const { app } = createAgentApiApp({ hooks: {
      deploy: (request) => {
        received.push(request);
        return { status: "pending", deploymentId: "d-default-adapter" };
      },
    } });

    const valid = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder", mode: "plan", objective: "Ship route", repo: "pa-platform", ticket: "PAP-001", provider: "openai", teamModel: "gpt-5.5", timeout: 120 }),
    });
    assert.equal(valid.status, 202);
    assert.deepEqual(await valid.json(), { team: "builder", mode: "plan", status: "pending", deployment_id: "d-default-adapter" });
    assert.deepEqual(received, [{
      team: "builder",
      mode: "plan",
      objective: "Ship route",
      repo: "pa-platform",
      ticket: "PAP-001",
      timeout: 120,
      provider: "openai",
      teamModel: "gpt-5.5",
      background: true,
    }]);

    const invalid = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "../builder" }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "Invalid team name", code: "BAD_REQUEST" });
    assert.equal(received.length, 1);
  });
});

test("agent API deploy routes deepseek provider and model through deploy hook", async () => {
  await withApiEnv(async () => {
    const received: unknown[] = [];
    const { app } = createAgentApiApp({ hooks: {
      deploy: (request) => {
        received.push(request);
        return { status: "pending", deploymentId: "d-deepseek-test" };
      },
    } });

    const deepseek = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder", mode: "plan", objective: "Ship route", repo: "pa-platform", ticket: "PAP-001", provider: "deepseek", teamModel: "deepseek/deepseek-v4-pro", timeout: 120 }),
    });
    assert.equal(deepseek.status, 202);
    assert.deepEqual(await deepseek.json(), { team: "builder", mode: "plan", status: "pending", deployment_id: "d-deepseek-test" });
    assert.deepEqual(received, [{
      team: "builder",
      mode: "plan",
      objective: "Ship route",
      repo: "pa-platform",
      ticket: "PAP-001",
      timeout: 120,
      provider: "deepseek",
      teamModel: "deepseek/deepseek-v4-pro",
      background: true,
    }]);
  });
});

test("agent API defaults deploy requests to background mode when omitted", async () => {
  await withApiEnv(async () => {
    const received: unknown[] = [];
    const { app } = createAgentApiApp({ hooks: {
      deploy: (request) => {
        received.push(request);
        return { status: "pending", deploymentId: "d-fg-fallback" };
      },
    } });

    const response = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder", mode: "plan", timeout: 120 }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { team: "builder", mode: "plan", status: "pending", deployment_id: "d-fg-fallback" });
    assert.deepEqual(received, [{ team: "builder", mode: "plan", timeout: 120, background: true }]);
  });
});

test("agent API /api/deploy registers deploy session with SessionManager on success (PAP-131 FR2/AC1)", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp({ hooks: {
      deploy: () => ({ status: "pending", deploymentId: "d-deploy-register" }),
    } });

    const deploy = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "builder", mode: "plan", objective: "Ship route", repo: "pa-platform", ticket: "PAP-001", teamModel: "ollama-cloud/glm-5.2", timeout: 120 }),
    });
    assert.equal(deploy.status, 202);
    assert.deepEqual(await deploy.json(), { team: "builder", mode: "plan", status: "pending", deployment_id: "d-deploy-register" });

    const sessions = await app.request("/api/sessions");
    assert.equal(sessions.status, 200);
    const list = await sessions.json() as { id: string; deploymentId: string; model: string; status: string }[];
    const deploySession = list.find((s) => s.deploymentId === "d-deploy-register");
    assert.ok(deploySession, "deploy session must appear in GET /api/sessions");
    assert.equal(deploySession?.model, "ollama-cloud/glm-5.2");
    assert.equal(deploySession?.status, "running");
  });
});

test("agent API /api/deploy does not register session on failed deploy (PAP-131 FR2)", async () => {
  await withApiEnv(async () => {
    const failing = createAgentApiApp({ hooks: { deploy: () => { throw new Error("adapter unavailable"); } } });
    const failedDeploy = await failing.app.request("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "builder", mode: "plan" }) });
    assert.equal(failedDeploy.status, 202);

    const sessions = await failing.app.request("/api/sessions");
    const list = await sessions.json() as unknown[];
    assert.equal(list.length, 0, "no session should be registered for a failed deploy");
  });
});

test("agent API exposes /ws and broadcasts typed events to connected clients", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp({ enableLiveUpdates: true });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const address = server.address();
      assert.equal(typeof address, "object");
      assert.ok(address);
      const port = address.port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("websocket connection failed")), { once: true });
      });
      const received = new Promise<WsEvent>((resolveMessage) => {
        ws.addEventListener("message", (event) => resolveMessage(JSON.parse(String(event.data)) as WsEvent), { once: true });
      });
      hub.broadcast({ type: "ticket-changed", data: { ticketId: "PAP-005" }, timestamp: "2026-04-30T00:00:00.000Z" });
      assert.deepEqual(await received, { type: "ticket-changed", data: { ticketId: "PAP-005" }, timestamp: "2026-04-30T00:00:00.000Z" });
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

test("WebSocket hub sends ping heartbeats and honors pong compatibility", async () => {
  const ws = new FakeWsClient();
  const hubForTest = new WsHub({ pingIntervalMs: 5, pongTimeoutMs: 50 });
  hubForTest.addClient(ws);
  hubForTest.startPing();
  await waitFor(() => ws.messages.some((message) => (JSON.parse(message) as WsEvent).type === "ping") ? true : undefined);
  hubForTest.recordPong(ws);
  assert.equal(hubForTest.size, 1);
  hubForTest.cleanup();
  assert.equal(ws.closed, true);
});

test("WebSocket hub closes clients that miss pong timeout", async () => {
  let now = 0;
  const ws = new FakeWsClient();
  const hubForTest = new WsHub({ pingIntervalMs: 5, pongTimeoutMs: 10, now: () => now });
  hubForTest.addClient(ws);
  now = 20;
  hubForTest.startPing();
  await waitFor(() => ws.closed ? true : undefined);
  assert.equal(hubForTest.size, 0);
  hubForTest.cleanup();
});

test("agent API watchers emit deployment, ticket, bulletin, and inbox events and clean up", async () => {
  await withApiEnv(async (root) => {
    mkdirSync(join(root, "sinh-inputs", "inbox"), { recursive: true });
    const events: WsEvent[] = [];
    const watchers = startWatchers({ broadcast: (event) => events.push(event) }, { debounceMs: 5, pollIntervalMs: 10, ensureDirs: true });
    try {
      writeFileSync(join(root, "sinh-inputs", "inbox", "hello.md"), "# Hello\n");
      await waitFor(() => events.find((event) => event.type === "new-inbox-item"));

      new TicketStore().create({ project: "pa-platform", title: "Watcher ticket", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
      await waitFor(() => events.find((event) => event.type === "ticket-changed"));

      new BulletinStore().create({ title: "Watcher bulletin", block: "all", body: "Pause" });
      await waitFor(() => events.find((event) => event.type === "bulletin-update"));

      appendRegistryEvent({ deployment_id: "d-watch", team: "builder", event: "started", timestamp: "2026-04-30T00:00:00.000Z" });
      await waitFor(() => events.find((event) => event.type === "deployment-status-change"));
    } finally {
      watchers.cleanup();
    }

    const countAfterCleanup = events.length;
    writeFileSync(join(root, "sinh-inputs", "inbox", "after-cleanup.md"), "# After\n");
    await sleep(50);
    assert.equal(events.length, countAfterCleanup);
  });
});

test("agent API action routes mutate inbox, sinh-inputs, ideas, tickets, and attachments safely", async () => {
  await withApiEnv(async (root) => {
    const personalRepo = join(root, "personal-assistant");
    mkdirSync(personalRepo, { recursive: true });
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  pa-platform:\n    path: ${join(root, "repo")}\n    description: Test repo\n    prefix: PAP\n  personal:\n    path: ${personalRepo}\n    description: Personal repo\n    prefix: PA\n`);
    mkdirSync(join(root, "sinh-inputs", "inbox"), { recursive: true });
    mkdirSync(join(root, "sinh-inputs", "approved"), { recursive: true });
    writeFileSync(join(root, "sinh-inputs", "inbox", "request.md"), "# Request\n");
    writeFileSync(join(root, "sinh-inputs", "approved", "approved.md"), "# Approved\n");

    const events: WsEvent[] = [];
    const watchers = startWatchers({ broadcast: (event) => events.push(event) }, { debounceMs: 5, pollIntervalMs: 10, ensureDirs: true });
    try {
      const { app } = createAgentApiApp();
      const inboxList = await app.request("/api/inbox");
      assert.equal(inboxList.status, 200);
      assert.equal((await inboxList.json() as { items: unknown[]; count_by_type: Record<string, number> }).items.length, 1);

      const append = await app.request("/api/inbox/request.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "append-section", title: "Decision", content: "Approved" }) });
      assert.equal(append.status, 200);
      assert.match(readFileSync(join(root, "sinh-inputs", "inbox", "request.md"), "utf-8"), /### Decision/);

      const approve = await app.request("/api/inbox/request.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", note: "ok" }) });
      assert.equal(approve.status, 200);
      assert.equal(existsSync(join(root, "sinh-inputs", "approved", "request.md")), true);
      await waitFor(() => events.find((event) => event.type === "inbox-item-moved"));

      const requeue = await app.request("/api/sinh-inputs/approved/approved.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "requeue" }) });
      assert.equal(requeue.status, 200);
      assert.match(readFileSync(join(root, "sinh-inputs", "inbox", "approved.md"), "utf-8"), /requeued_from: approved/);

      const idea = await app.request("/api/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Phone idea", what: "Build it", tags: ["mobile"] }) });
      assert.equal(idea.status, 201);
      const ideaBody = await idea.json() as { ticket: { id: string; type: string; status: string; assignee: string; tags: string[] } };
      assert.match(ideaBody.ticket.id, /^PAP-/);
      assert.equal(ideaBody.ticket.type, "idea");
      assert.equal(ideaBody.ticket.status, "idea");
      assert.equal(ideaBody.ticket.assignee, "requirements");
      assert.deepEqual(ideaBody.ticket.tags, ["mobile"]);

      const store = new TicketStore();
      const ticket = store.create({ project: "pa-platform", title: "Action ticket", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
      const addedComment = await app.request(`/api/tickets/${ticket.id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "builder/team-manager", content: "Original" }) });
      assert.equal(addedComment.status, 201);
      const commentId = (await addedComment.json() as { comment: { id: string } }).comment.id;
      const edited = await app.request(`/api/tickets/${ticket.id}/comments/${commentId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Edited" }) });
      assert.equal(edited.status, 200);
      assert.equal((await edited.json() as { comment: { content: string; editedAt?: string } }).comment.content, "Edited");
      const deleted = await app.request(`/api/tickets/${ticket.id}/comments/${commentId}`, { method: "DELETE" });
      assert.equal(deleted.status, 204);

      const attached = await app.request(`/api/tickets/${ticket.id}/attachments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "attachments/existing.png" }) });
      assert.equal(attached.status, 200);
      assert.equal((await attached.json() as { ticket: { doc_refs: Array<{ type: string; path: string }> } }).ticket.doc_refs[0]?.type, "attachment");

      const data = new FormData();
      data.set("file", new File([new Uint8Array([1, 2, 3])], "screen shot.png", { type: "image/png" }));
      const uploaded = await app.request(`/api/tickets/${ticket.id}/attachments/upload`, { method: "POST", body: data });
      assert.equal(uploaded.status, 201);
      const uploadBody = await uploaded.json() as { docRef: string };
      assert.match(uploadBody.docRef, new RegExp(`^attachments/${ticket.id}/\\d+-screen_shot\\.png$`));
      assert.equal(existsSync(join(root, uploadBody.docRef)), true);

      const moved = await app.request(`/api/tickets/${ticket.id}/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "personal" }) });
      assert.equal(moved.status, 200);
      assert.match((await moved.json() as { ticket: { id: string; project: string } }).ticket.id, /^PA-/);
    } finally {
      watchers.cleanup();
    }
  });
});

test("agent API action routes reject traversal, unsafe filenames, invalid actions, identifiers, and bodies", async () => {
  await withApiEnv(async (root) => {
    mkdirSync(join(root, "sinh-inputs", "inbox"), { recursive: true });
    mkdirSync(join(root, "sinh-inputs", "approved"), { recursive: true });
    writeFileSync(join(root, "sinh-inputs", "inbox", "request.md"), "# Request\n");
    writeFileSync(join(root, "sinh-inputs", "approved", "approved.md"), "# Approved\n");
    const { app } = createAgentApiApp();

    assert.equal((await app.request("/api/inbox/.hidden.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }) })).status, 403);
    assert.equal((await app.request("/api/inbox/request.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unknown" }) })).status, 400);
    assert.equal((await app.request("/api/inbox/request.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }) })).status, 400);
    assert.equal((await app.request("/api/sinh-inputs/approved/.hidden.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "archive" }) })).status, 403);
    assert.equal((await app.request("/api/sinh-inputs/done/approved.md/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-for-later" }) })).status, 404);
    assert.equal((await app.request("/api/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Missing title" }) })).status, 400);

    const store = new TicketStore();
    const ticket = store.create({ project: "pa-platform", title: "Negative ticket", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
    assert.equal((await app.request(`/api/tickets/${ticket.id}/comments/nope`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Edited" }) })).status, 404);
    assert.equal((await app.request(`/api/tickets/${ticket.id}/comments/nope`, { method: "DELETE" })).status, 404);
    assert.equal((await app.request(`/api/tickets/${ticket.id}/attachments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "../secret.png" }) })).status, 403);
    assert.equal((await app.request(`/api/tickets/${ticket.id}/attachments/upload`, { method: "POST", body: new FormData() })).status, 400);
    const badUpload = new FormData();
    badUpload.set("file", new File(["<svg />"], "vector.svg", { type: "image/svg+xml" }));
    assert.equal((await app.request(`/api/tickets/${ticket.id}/attachments/upload`, { method: "POST", body: badUpload })).status, 400);
    assert.equal((await app.request(`/api/tickets/${ticket.id}/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "unknown" }) })).status, 400);
  });
});

test("agent API exposes repo commits and repo deployment filters", async () => {
  await withApiEnv(async (root) => {
    const repo = join(root, "repo");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    appendRegistryEvent({ deployment_id: "d-repo-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", repo: "pa-platform" });
    appendRegistryEvent({ deployment_id: "d-repo-1", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success" });
    const { app } = createAgentApiApp();
    const gitInfo = await app.request("/api/repos/pa-platform/git-info");
    assert.equal(gitInfo.status, 200);
    const gitInfoBody = await gitInfo.json() as { repo: { key: string; description: string; prefix: string }; main_branch: { name: string }; develop_branch: { exists: boolean }; main_vs_develop: { diverged: boolean }; feature_branches: unknown[] };
    assert.equal(gitInfoBody.repo.key, "pa-platform");
    assert.equal(gitInfoBody.repo.description, "Test repo");
    assert.equal(gitInfoBody.repo.prefix, "PAP");
    assert.equal(gitInfoBody.main_branch.name, "main");
    assert.equal(gitInfoBody.develop_branch.exists, false);
    assert.equal(gitInfoBody.main_vs_develop.diverged, false);
    assert.ok(Array.isArray(gitInfoBody.feature_branches));
    const branches = await app.request("/api/repos/pa-platform/branches");
    assert.equal(branches.status, 200);
    assert.equal((await branches.json() as { branches: unknown[] }).branches.length, 1);
    const commits = await app.request("/api/repos/pa-platform/commits?limit=5");
    const commitsBody = await commits.json() as { commits: Array<{ message: string }>; meta: { limit: number; offset: number; total: number }; pagination?: unknown };
    assert.equal(commitsBody.commits[0]?.message, "initial");
    assert.equal(commitsBody.pagination, undefined);
    const deployments = await app.request("/api/repos/pa-platform/deployments?all=true");
    assert.equal((await deployments.json() as { total: number }).total, 1);
  });
});

test("agent API exposes repo diff and compare routes", async () => {
  await withApiEnv(async (root) => {
    const repo = join(root, "repo");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Test\n\nChange\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "change"], { cwd: repo, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const { app } = createAgentApiApp();
    const diff = await app.request(`/api/repos/pa-platform/diff?commit=${head}`);
    assert.equal(diff.status, 200);
    const diffBody = await diff.json() as { filesChanged?: number; diff_entries: unknown[]; meta: { commit: string; files_changed: number } };
    assert.equal(diffBody.filesChanged, undefined);
    assert.equal(diffBody.diff_entries.length, 1);
    assert.equal(diffBody.meta.commit, head);
    assert.equal(diffBody.meta.files_changed, 1);
    const compare = await app.request(`/api/repos/pa-platform/compare?from=${base}&to=${head}`);
    assert.equal((await compare.json() as { count: number }).count, 1);
    const remote = await app.request("/api/repos/pa-platform/branches/remote");
    assert.equal(remote.status, 200);
  });
});

test("agent API exposes timer parsing helpers", async () => {
  await withApiEnv(async () => {
    const { parseTimersOutput } = await import("../index.js");
    assert.deepEqual(parseTimersOutput("NEXT LEFT LAST PASSED UNIT ACTIVATES\nMon 2026-03-16 05:00:00 +07 6h - - pa-daily-plan.timer pa.service"), [{ unit: "pa-daily-plan.timer", team: "daily-plan", next_in: "6h" }]);
  });
});

test("agent API PATCH ticket with add_linked_branch returns warning for non-conforming branch name", async () => {
  await withApiEnv(async (root) => {
    const repo = join(root, "repo");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "my-random-name"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feature/PAP-001-fix-login"], { cwd: repo, stdio: "ignore" });

    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n    feature_branch_pattern: "feature/<ticket>-<topic>"\n`);

    const { app } = createAgentApiApp();

    const created = await app.request("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "pa-platform", title: "Branch link test", summary: "Summary", description: "", status: "idea", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { ticket: { id: string } };
    const ticketId = createdBody.ticket.id;

    const nonConforming = await app.request(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add_linked_branch: { repo: "pa-platform", branch: "my-random-name" } }),
    });
    assert.equal(nonConforming.status, 200);
    const nonConformingBody = await nonConforming.json() as { ticket: Record<string, unknown>; warning?: string };
    assert.equal(typeof nonConformingBody.warning, "string");
    assert.match(nonConformingBody.warning ?? "", /does not match/);

    const conforming = await app.request(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-fix-login" } }),
    });
    assert.equal(conforming.status, 200);
    const conformingBody = await conforming.json() as { ticket: Record<string, unknown>; warning?: string };
    assert.equal(conformingBody.warning, undefined);
  });
});

// ---- Phase 2: /ws/session integration tests ----

class FakeOpencodeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  killSignal?: string;
  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }
}

function createSessionSpawnSpy(): { fn: typeof import("node:child_process").spawn; children: FakeOpencodeChild[]; commands: string[] } {
  const list: FakeOpencodeChild[] = [];
  const commands: string[] = [];
  const fn = ((cmd: string, _args: string[], _opts: unknown): FakeOpencodeChild => {
    commands.push(cmd);
    const child = new FakeOpencodeChild();
    list.push(child);
    return child as unknown as import("node:child_process").ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { fn, children: list, commands };
}

interface SessionWsMessage {
  type: string;
  data?: Record<string, unknown>;
  message?: string;
  sessionId?: string;
  timestamp: string;
}

function openSessionWs(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/session`);
}

async function recvSessionMessages(ws: WebSocket, count: number, timeoutMs = 1500): Promise<SessionWsMessage[]> {
  const out: SessionWsMessage[] = [];
  return new Promise<SessionWsMessage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      if (out.length >= count) resolve(out);
      else reject(new Error(`Timed out waiting for ${count} messages, got ${out.length}`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      out.push(JSON.parse(String(event.data)) as SessionWsMessage);
      if (out.length >= count) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(out);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${String(e)}`));
    }, { once: true });
  });
}

test("/ws/session accepts start message and streams JSONL events back over the WebSocket", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", (e) => rejectOpen(new Error(`ws connect failed: ${String(e)}`)), { once: true });
      });

      ws.send(JSON.stringify({ type: "start", prompt: "Hello", model: "openai/gpt-5.5" }));
      const messages = await recvSessionMessages(ws, 1);
      assert.equal(messages[0]?.type, "session-id");
      const sessionId = messages[0]?.sessionId;
      assert.ok(typeof sessionId === "string" && sessionId.length > 0);

      // Emit JSONL lines from the spawned opencode process.
      const child = children[0]!;
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text: "Hi there" }) + "\n"));
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "thinking", thinking: "reasoning" }) + "\n"));
      child.emit("close", 0);

      const streamed = await recvSessionMessages(ws, 3);
      const types = streamed.map((m) => m.type);
      assert.equal(types[0], "event");
      assert.equal(types[1], "event");
      assert.equal(types[2], "end");
      const firstData = streamed[0]?.data as Record<string, unknown>;
      assert.equal(firstData?.kind, "text");
      assert.equal(firstData?.deployId, `session-${sessionId}`);
      const endData = streamed[2]?.data as Record<string, unknown>;
      assert.equal(endData?.exitCode, 0);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
    assert.equal(children.length, 1);
  });
});

test("/ws/session resume message spawns opencode with the provided session id", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });

      ws.send(JSON.stringify({ type: "resume", sessionId: "opencode-token-123", prompt: "continue" }));
      const messages = await recvSessionMessages(ws, 1);
      assert.equal(messages[0]?.type, "session-id");
      assert.ok(typeof messages[0]?.sessionId === "string");

      const child = children[0]!;
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text: "resumed" }) + "\n"));
      child.emit("close", 0);
      await recvSessionMessages(ws, 2);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
    assert.equal(children.length, 1);
  });
});

test("/ws/session auto-terminates the opencode process when the WebSocket disconnects", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });

      ws.send(JSON.stringify({ type: "start", prompt: "Hello" }));
      await recvSessionMessages(ws, 1);

      ws.close();
      await waitFor(() => (children[0]?.killed ? true : undefined), 1500);
      assert.equal(children[0]?.killed, true);
      assert.equal(children[0]?.killSignal, "SIGTERM");
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("/ws/session stop message terminates the session and emits an end event", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });

      ws.send(JSON.stringify({ type: "start", prompt: "Hello" }));
      await recvSessionMessages(ws, 1);
      ws.send(JSON.stringify({ type: "stop" }));
      const messages = await recvSessionMessages(ws, 1);
      assert.equal(messages[0]?.type, "end");
      const data = messages[0]?.data as Record<string, unknown>;
      assert.equal(data?.reason, "stopped");
      assert.equal(children[0]?.killed, true);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("/ws/session rejects invalid JSON and unknown message types with error events", async () => {
  await withApiEnv(async () => {
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });

      ws.send("not-json");
      const error1 = await recvSessionMessages(ws, 1);
      assert.equal(error1[0]?.type, "error");
      assert.match(error1[0]?.message ?? "", /Invalid JSON/);

      ws.send(JSON.stringify({ type: "bogus" }));
      const error2 = await recvSessionMessages(ws, 1);
      assert.equal(error2[0]?.type, "error");
      assert.match(error2[0]?.message ?? "", /Unknown message type/);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("/ws/session rejects start with missing prompt and resume with missing fields", async () => {
  await withApiEnv(async () => {
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });

      ws.send(JSON.stringify({ type: "start" }));
      const error1 = await recvSessionMessages(ws, 1);
      assert.match(error1[0]?.message ?? "", /Missing prompt/);

      ws.send(JSON.stringify({ type: "resume", prompt: "continue" }));
      const error2 = await recvSessionMessages(ws, 1);
      assert.match(error2[0]?.message ?? "", /Missing sessionId or prompt/);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("/ws/session respects PA_MAX_SESSIONS and emits a max-sessions error event when full", async () => {
  await withApiEnv(async () => {
    const previous = process.env["PA_MAX_SESSIONS"];
    process.env["PA_MAX_SESSIONS"] = "1";
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws1 = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws1.addEventListener("open", () => resolveOpen(), { once: true });
        ws1.addEventListener("error", () => rejectOpen(new Error("ws1 connect failed")), { once: true });
      });
      ws1.send(JSON.stringify({ type: "start", prompt: "first" }));
      await recvSessionMessages(ws1, 1);

      const ws2 = await openSessionWs(port);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws2.addEventListener("open", () => resolveOpen(), { once: true });
        ws2.addEventListener("error", () => rejectOpen(new Error("ws2 connect failed")), { once: true });
      });
      ws2.send(JSON.stringify({ type: "start", prompt: "second" }));
      const messages = await recvSessionMessages(ws2, 1);
      assert.equal(messages[0]?.type, "error");
      assert.match(messages[0]?.message ?? "", /Max sessions reached/);
      ws1.close();
      ws2.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (previous === undefined) delete process.env["PA_MAX_SESSIONS"];
      else process.env["PA_MAX_SESSIONS"] = previous;
    }
  });
});

test("existing /ws endpoint is unaffected by /ws/session addition", async () => {
  await withApiEnv(async () => {
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ enableLiveUpdates: true, sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
      });
      const received = new Promise<WsEvent>((resolveMessage) => {
        ws.addEventListener("message", (event) => resolveMessage(JSON.parse(String(event.data)) as WsEvent), { once: true });
      });
      hub.broadcast({ type: "ticket-changed", data: { ticketId: "PAP-009" }, timestamp: "2026-08-05T00:00:00.000Z" });
      assert.deepEqual(await received, { type: "ticket-changed", data: { ticketId: "PAP-009" }, timestamp: "2026-08-05T00:00:00.000Z" });
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

// ---- Phase 3: /api/sessions REST integration tests ----

async function startSessionViaWs(port: number, prompt = "Hello"): Promise<{ ws: WebSocket; sessionId: string }> {
  const ws = openSessionWs(port);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => resolveOpen(), { once: true });
    ws.addEventListener("error", () => rejectOpen(new Error("ws connect failed")), { once: true });
  });
  ws.send(JSON.stringify({ type: "start", prompt }));
  const messages = await recvSessionMessages(ws, 1);
  assert.equal(messages[0]?.type, "session-id");
  const sessionId = messages[0]?.sessionId;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0);
  return { ws, sessionId: sessionId as string };
}

function readSseStream(response: Response): Promise<string[]> {
  // Returns collected SSE event payload strings. Resolves as soon as an "end"
  // event is observed, or after a short timeout if the stream never ends.
  return new Promise<string[]>(async (resolve, reject) => {
    if (!response.body) {
      reject(new Error("No response body"));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: string[] = [];
    let sawEnd = false;
    const timeout = setTimeout(() => {
      reader.cancel().catch(() => undefined);
      resolve(events);
    }, 1500);
    const finish = (): void => {
      clearTimeout(timeout);
      reader.cancel().catch(() => undefined);
      resolve(events);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              events.push(payload);
              try {
                const msg = JSON.parse(payload) as { type?: string };
                if (msg.type === "end") sawEnd = true;
              } catch {
                // ignore non-JSON
              }
            }
          }
        }
        if (sawEnd) {
          finish();
          return;
        }
      }
      clearTimeout(timeout);
      resolve(events);
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

test("GET /api/sessions returns an empty array when no sessions are active", async () => {
  await withApiEnv(async () => {
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    try {
      const res = await api.app.request("/api/sessions");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    } finally {
      api.cleanup();
    }
  });
});

test("GET /api/sessions returns active session after WebSocket start", async () => {
  await withApiEnv(async () => {
    const { fn } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const { ws, sessionId } = await startSessionViaWs(port);

      const res = await api.app.request("/api/sessions");
      assert.equal(res.status, 200);
      const sessions = (await res.json()) as Array<Record<string, unknown>>;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, sessionId);
      assert.equal(sessions[0]?.status, "running");
      assert.ok(typeof sessions[0]?.model === "string");
      assert.ok(typeof sessions[0]?.startedAt === "string");
      assert.ok(typeof sessions[0]?.deploymentId === "string");
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("POST /api/sessions/:id/stop terminates and removes the session", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const { ws, sessionId } = await startSessionViaWs(port);

      const stopRes = await api.app.request(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
      assert.equal(stopRes.status, 200);
      assert.deepEqual(await stopRes.json(), { status: "stopped" });
      assert.equal(children[0]?.killed, true);

      const listRes = await api.app.request("/api/sessions");
      assert.deepEqual(await listRes.json(), []);
      ws.close();
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("POST /api/sessions/:id/stop returns 404 for unknown session", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    try {
      const res = await api.app.request("/api/sessions/no-such-session/stop", { method: "POST" });
      assert.equal(res.status, 404);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["error"], "Session not found");
      assert.equal(body["code"], "NOT_FOUND");
    } finally {
      api.cleanup();
    }
  });
});

test("GET /api/sessions/:id/stream serves SSE with session events", async () => {
  await withApiEnv(async () => {
    const { fn, children } = createSessionSpawnSpy();
    const api = createAgentApiApp({ sessionSpawnFn: fn });
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const { ws, sessionId } = await startSessionViaWs(port);

      // Start consuming the SSE stream before emitting events.
      const abortController = new AbortController();
      const streamRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
        headers: { Accept: "text/event-stream" },
        signal: abortController.signal,
      });
      assert.equal(streamRes.status, 200);
      assert.equal(streamRes.headers.get("content-type"), "text/event-stream");

      const eventsPromise = readSseStream(streamRes);

      // Emit JSONL lines from the spawned opencode process.
      const child = children[0]!;
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text: "streamed via SSE" }) + "\n"));
      child.emit("close", 0);

      const events = await eventsPromise;
      // Expect at least a "ready" event and an "event" event.
      const parsed = events.map((e) => JSON.parse(e) as SessionWsMessage);
      assert.ok(parsed.some((m) => m.type === "ready" && m.sessionId === sessionId), "missing ready event");
      assert.ok(parsed.some((m) => m.type === "event"), "missing event");
      assert.ok(parsed.some((m) => m.type === "end"), "missing end event");
      // Ensure the SSE connection is closed so server.close() can complete.
      abortController.abort();
      ws.close();
    } finally {
      api.cleanup();
      if (server) {
        // Force-close lingering SSE/HTTP connections before closing the server,
        // otherwise server.close() waits forever for the open SSE stream.
        server.closeAllConnections?.();
        await new Promise<void>((r) => server!.close(() => r()));
      }
    }
  });
});

test("GET /api/sessions/:id/stream returns 404 for unknown session", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/missing/stream`, {
        headers: { Accept: "text/event-stream" },
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["error"], "Session not found");
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

// ---- Phase 2 & 4: POST /api/sessions and deploy session stream behavior ----

test("POST /api/sessions registers a deploy session that appears in GET /api/sessions (PAP-131 FR3/AC2)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: "d-abc123", model: "ollama-cloud/deepseek-v4-pro" }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { sessionId: string; deploymentId: string; model: string; status: string };
      assert.ok(typeof body.sessionId === "string" && body.sessionId.length > 0);
      assert.equal(body.deploymentId, "d-abc123");
      assert.equal(body.model, "ollama-cloud/deepseek-v4-pro");
      assert.equal(body.status, "running");

      const listRes = await api.app.request("/api/sessions");
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as Array<Record<string, unknown>>;
      const deploySession = list.find((s) => s["deploymentId"] === "d-abc123");
      assert.ok(deploySession, "deploy session must appear in GET /api/sessions");
      assert.equal(deploySession?.["model"], "ollama-cloud/deepseek-v4-pro");
      assert.equal(deploySession?.["status"], "running");
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("POST /api/sessions defaults model when omitted (PAP-131 FR3)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;

      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: "d-default-model" }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { model: string };
      assert.ok(typeof body.model === "string" && body.model.length > 0);
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("POST /api/sessions rejects missing deploymentId with 400 (PAP-131 FR3)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    try {
      const res = await api.app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "some-model" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; code: string };
      assert.equal(body.code, "BAD_REQUEST");
      assert.match(body.error, /Missing deploymentId/);
    } finally {
      api.cleanup();
    }
  });
});

test("POST /api/sessions rejects invalid JSON with 400 (PAP-131 FR3)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    try {
      const res = await api.app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "BAD_REQUEST");
    } finally {
      api.cleanup();
    }
  });
});

test("POST /api/sessions returns 503 when at capacity (PAP-131 NFR4)", async () => {
  await withApiEnv(async () => {
    const previous = process.env["PA_MAX_SESSIONS"];
    process.env["PA_MAX_SESSIONS"] = "1";
    try {
      const api = createAgentApiApp();
      let server: Server | undefined;
      try {
        server = await new Promise<Server>((resolveListen) => {
          const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
          api.injectWebSocket(listening);
        });
        const port = (server.address() as { port: number }).port;

        const first = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deploymentId: "d-cap-1" }),
        });
        assert.equal(first.status, 201);

        const second = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deploymentId: "d-cap-2" }),
        });
        assert.equal(second.status, 503);
        const body = (await second.json()) as { error: string; code: string; limit: number };
        assert.equal(body.code, "CAPACITY_REACHED");
        assert.equal(body.limit, 1);
      } finally {
        api.cleanup();
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
    } finally {
      if (previous === undefined) delete process.env["PA_MAX_SESSIONS"];
      else process.env["PA_MAX_SESSIONS"] = previous;
    }
  });
});

test("POST /api/sessions/:id/stop removes a deploy session (PAP-131 AC3)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;

      const registerRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: "d-stop-test" }),
      });
      assert.equal(registerRes.status, 201);
      const { sessionId } = (await registerRes.json()) as { sessionId: string };

      const stopRes = await api.app.request(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
      assert.equal(stopRes.status, 200);
      assert.deepEqual(await stopRes.json(), { status: "stopped" });

      const listRes = await api.app.request("/api/sessions");
      assert.deepEqual(await listRes.json(), []);
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

test("GET /api/sessions/:id/stream returns 404 with distinct message for deploy sessions (PAP-131 FR6/AC4)", async () => {
  await withApiEnv(async () => {
    const api = createAgentApiApp();
    let server: Server | undefined;
    try {
      server = await new Promise<Server>((resolveListen) => {
        const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
        api.injectWebSocket(listening);
      });
      const port = (server.address() as { port: number }).port;

      const registerRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: "d-stream-test" }),
      });
      assert.equal(registerRes.status, 201);
      const { sessionId } = (await registerRes.json()) as { sessionId: string };

      const streamRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
        headers: { Accept: "text/event-stream" },
      });
      assert.equal(streamRes.status, 404);
      const body = (await streamRes.json()) as { error: string; code: string };
      assert.equal(body.error, "Deploy sessions do not support streaming");
      assert.equal(body.code, "NOT_FOUND");
    } finally {
      api.cleanup();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});

// ---- Phase 3: dev mode propagation through agent-api → SessionManager (FR6) ----
//
// These tests verify that `devMode` on `AgentApiOptions` threads through to the
// `SessionManager` so that binary resolution consults `PA_OPENCODE_BINARY` only
// in dev mode (FR3) and falls back to `"opencode"` in production (FR4/NFR1).
// The /ws/session WebSocket endpoint is the observable seam: the spawn command
// captured by the injected `sessionSpawnFn` reflects the resolved binary path.

test("createAgentApiApp devMode:true propagates to SessionManager — /ws/session start spawns PA_OPENCODE_BINARY (FR3/FR6/AC1)", async () => {
  await withApiEnv(async () => {
    const previous = process.env[PA_OPENCODE_BINARY_ENV];
    process.env[PA_OPENCODE_BINARY_ENV] = "/dev/bin/opencode";
    try {
      const { fn, commands } = createSessionSpawnSpy();
      const api = createAgentApiApp({ devMode: true, sessionSpawnFn: fn });
      let server: Server | undefined;
      try {
        server = await new Promise<Server>((resolveListen) => {
          const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
          api.injectWebSocket(listening);
        });
        const port = (server.address() as { port: number }).port;
        const ws = await openSessionWs(port);
        await new Promise<void>((resolveOpen, rejectOpen) => {
          ws.addEventListener("open", () => resolveOpen(), { once: true });
          ws.addEventListener("error", (e) => rejectOpen(new Error(`ws connect failed: ${String(e)}`)), { once: true });
        });
        ws.send(JSON.stringify({ type: "start", prompt: "Hello" }));
        await recvSessionMessages(ws, 1);
        ws.close();
      } finally {
        api.cleanup();
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
      // The spawn spy captures the resolved binary path as the first arg.
      assert.equal(commands[0], "/dev/bin/opencode");
    } finally {
      if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
      else process.env[PA_OPENCODE_BINARY_ENV] = previous;
    }
  });
});

test("createAgentApiApp devMode:false ignores PA_OPENCODE_BINARY — /ws/session start spawns 'opencode' (FR4/NFR1 production no-regression)", async () => {
  await withApiEnv(async () => {
    const previous = process.env[PA_OPENCODE_BINARY_ENV];
    process.env[PA_OPENCODE_BINARY_ENV] = "/should/be/ignored/opencode";
    try {
      const { fn, commands } = createSessionSpawnSpy();
      const api = createAgentApiApp({ devMode: false, sessionSpawnFn: fn });
      let server: Server | undefined;
      try {
        server = await new Promise<Server>((resolveListen) => {
          const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
          api.injectWebSocket(listening);
        });
        const port = (server.address() as { port: number }).port;
        const ws = await openSessionWs(port);
        await new Promise<void>((resolveOpen, rejectOpen) => {
          ws.addEventListener("open", () => resolveOpen(), { once: true });
          ws.addEventListener("error", (e) => rejectOpen(new Error(`ws connect failed: ${String(e)}`)), { once: true });
        });
        ws.send(JSON.stringify({ type: "start", prompt: "Hello" }));
        await recvSessionMessages(ws, 1);
        ws.close();
      } finally {
        api.cleanup();
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
      assert.equal(commands[0], "opencode");
    } finally {
      if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
      else process.env[PA_OPENCODE_BINARY_ENV] = previous;
    }
  });
});

test("createAgentApiApp without devMode defaults to production — /ws/session start spawns 'opencode' (FR4 default)", async () => {
  await withApiEnv(async () => {
    const previous = process.env[PA_OPENCODE_BINARY_ENV];
    process.env[PA_OPENCODE_BINARY_ENV] = "/should/be/ignored/opencode";
    try {
      const { fn, commands } = createSessionSpawnSpy();
      const api = createAgentApiApp({ sessionSpawnFn: fn });
      let server: Server | undefined;
      try {
        server = await new Promise<Server>((resolveListen) => {
          const listening = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolveListen(listening));
          api.injectWebSocket(listening);
        });
        const port = (server.address() as { port: number }).port;
        const ws = await openSessionWs(port);
        await new Promise<void>((resolveOpen, rejectOpen) => {
          ws.addEventListener("open", () => resolveOpen(), { once: true });
          ws.addEventListener("error", (e) => rejectOpen(new Error(`ws connect failed: ${String(e)}`)), { once: true });
        });
        ws.send(JSON.stringify({ type: "start", prompt: "Hello" }));
        await recvSessionMessages(ws, 1);
        ws.close();
      } finally {
        api.cleanup();
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
      assert.equal(commands[0], "opencode");
    } finally {
      if (previous === undefined) delete process.env[PA_OPENCODE_BINARY_ENV];
      else process.env[PA_OPENCODE_BINARY_ENV] = previous;
    }
  });
});
