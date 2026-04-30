import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendActivityEvent, appendRegistryEvent, closeDb, createActivityEvent, createAgentApiApp, TicketStore } from "../index.js";

function withApiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-agent-api-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), `name: builder\ndescription: Builder\nobjective: Build\nagents: []\ndeploy_modes:\n  - id: plan\n    label: Plan\n  - id: chat\n    label: Chat\n    mode_type: interactive\n`);
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

    const teams = await app.request("/api/pa-teams");
    assert.equal((await teams.json() as { teams: Array<{ name: string }> }).teams[0]?.name, "builder");

    const routing = await app.request("/api/deploy-routing");
    assert.deepEqual(await routing.json(), { teams: [{ name: "builder", description: "Builder", modes: [{ id: "plan", label: "Plan", modeType: null }] }], repos: [{ name: "pa-platform", path: join(root, "repo"), description: "Test repo" }] });

    mkdirSync(join(root, "agent-teams", "builder", "artifacts"), { recursive: true });
    writeFileSync(join(root, "agent-teams", "builder", "artifacts", "note.md"), "# Note\n\nBody");
    const doc = await app.request("/api/documents?path=agent-teams/builder/artifacts/note.md");
    assert.equal(doc.status, 200);
    assert.equal((await doc.json() as { metadata: { title: string } }).metadata.title, "Note");
  });
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

    const assigneeResponse = await app.request("/api/board?project=PAP&assignee=builder");
    assert.equal(assigneeResponse.status, 200);
    const assigneeBoard = await assigneeResponse.json() as typeof allBoard;
    assert.deepEqual(assigneeBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title)), ["API visible"]);

    const emptyExclusionsResponse = await app.request("/api/board?excludeTags=&excludeTypes=");
    assert.equal(emptyExclusionsResponse.status, 200);
    const emptyExclusionsBoard = await emptyExclusionsResponse.json() as typeof allBoard;
    const emptyExclusionTitles = emptyExclusionsBoard.board.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title));
    assert.doesNotMatch(emptyExclusionTitles.join("\n"), /API backlog/);
    assert.match(emptyExclusionTitles.join("\n"), /API FYI/);

    const unknownResponse = await app.request("/api/board?project=unknown");
    assert.equal(unknownResponse.status, 400);
    const unknownBody = await unknownResponse.json() as { error: string; code: string };
    assert.equal(unknownBody.code, "BOARD_FAILED");
    assert.match(unknownBody.error, /Unknown project "unknown"/);
    assert.match(unknownBody.error, /Valid project keys: pa-platform, personal/);
  });
});

test("agent API rejects path traversal query params", async () => {
  await withApiEnv(async () => {
    const { app } = createAgentApiApp();
    const response = await app.request("/api/documents?path=/tmp/outside.md");
    assert.equal(response.status, 403);
  });
});

test("agent API exposes deployment lists, detail, and activity", async () => {
  await withApiEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-api-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", ticket_id: "PAP-001", agents: ["team-manager"] });
    appendRegistryEvent({ deployment_id: "d-api-1", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", summary: "done" });
    appendActivityEvent(createActivityEvent({ deployId: "d-api-1", timestamp: "2026-04-26T00:00:30.000Z", kind: "text", source: "opencode", body: "hello" }));
    const { app } = createAgentApiApp();
    const list = await app.request("/api/deployments?all=true&ticket_id=PAP-001");
    assert.equal(list.status, 200);
    const listBody = await list.json() as { deployments: Array<{ deploy_id: string }>; total: number };
    assert.equal(listBody.total, 1);
    assert.equal(listBody.deployments[0]?.deploy_id, "d-api-1");
    const detail = await app.request("/api/deployments/d-api-1");
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { deployment: { status: string }; activity_events: unknown[] };
    assert.equal(detailBody.deployment.status, "success");
    assert.equal(detailBody.activity_events.length, 1);
    const activity = await app.request("/api/deployments/d-api-1/activity");
    assert.equal((await activity.json() as { events: unknown[]; activity_events: unknown[] }).events.length, 2);
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
    assert.deepEqual(await deploy.json(), { team: "builder", mode: "plan", status: "pending", deploymentId: "d-hook" });
    assert.equal((await app.request("/api/self-update", { method: "POST" })).status, 202);
    assert.deepEqual(await (await app.request("/api/self-update/status")).json(), { status: "building", startedAt: "2026-04-26T00:00:00.000Z", completedAt: null, log: ["running"] });

    const started = await app.request("/api/deploy/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deploymentId: "d-status", team: "builder", runtime: "opencode" }) });
    assert.equal(started.status, 200);
    const status = await app.request("/api/deploy/status/d-status");
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { status: { deploy_id: string; status: string } }).status.deploy_id, "d-status");
    assert.equal((await app.request("/api/deploy/events/d-status")).status, 200);
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
    const branches = await app.request("/api/repos/pa-platform/branches");
    assert.equal(branches.status, 200);
    assert.equal((await branches.json() as { branches: unknown[] }).branches.length, 1);
    const commits = await app.request("/api/repos/pa-platform/commits?limit=5");
    assert.equal((await commits.json() as { commits: Array<{ message: string }> }).commits[0]?.message, "initial");
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
    assert.equal((await diff.json() as { filesChanged: number }).filesChanged, 1);
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
