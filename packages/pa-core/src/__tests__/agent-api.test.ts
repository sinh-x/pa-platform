import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendActivityEvent, appendRegistryEvent, closeDb, createActivityEvent, createAgentApiApp } from "../index.js";

function withApiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-agent-api-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), `name: builder\ndescription: Builder\nobjective: Build\nagents: []\ndeploy_modes:\n  - id: plan\n    label: Plan\n`);
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

    mkdirSync(join(root, "agent-teams", "builder", "artifacts"), { recursive: true });
    writeFileSync(join(root, "agent-teams", "builder", "artifacts", "note.md"), "# Note\n\nBody");
    const doc = await app.request("/api/documents?path=agent-teams/builder/artifacts/note.md");
    assert.equal(doc.status, 200);
    assert.equal((await doc.json() as { metadata: { title: string } }).metadata.title, "Note");
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
