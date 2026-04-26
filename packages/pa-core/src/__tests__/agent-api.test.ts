import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, createAgentApiApp } from "../index.js";

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
