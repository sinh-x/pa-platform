import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { appendActivityEvent, appendRegistryEvent, BulletinStore, closeDb, createActivityEvent, createAgentApiApp, hub, startWatchers, TicketStore, WsHub } from "../index.js";
import type { WsClient, WsEvent } from "../index.js";

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
    const detailBody = await detail.json() as { status: string; provider?: string; runtime?: string; binary?: string; effective_timeout_seconds?: number; deployment?: unknown; activity_events?: unknown[] };
    assert.equal(detailBody.status, "success");
    assert.equal(detailBody.provider, "openai");
    assert.equal(detailBody.runtime, "opencode");
    assert.equal(detailBody.binary, "opa");
    assert.equal(detailBody.effective_timeout_seconds, 1200);
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
