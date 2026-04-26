import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRegistryEvent, closeDb, runCoreCommand, TicketStore } from "../index.js";

function withCliEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-cli-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), `name: builder\ndescription: Builder\nobjective: Build\nmodel: sonnet\nagents: []\n`);

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

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

test("runCoreCommand exposes repos list", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["repos", "list"], { io: captured.io }), 0);
    assert.match(captured.stdout.join("\n"), /pa-platform/);
    assert.match(captured.stdout.join("\n"), /Test repo/);
    assert.deepEqual(captured.stderr, []);
  });
});

test("runCoreCommand exposes status list and detail", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-cli-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", agents: ["team-manager"], runtime: "opencode" });
    appendRegistryEvent({ deployment_id: "d-cli-1", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", summary: "done" });
    const list = capture();
    assert.equal(await runCoreCommand(["status", "--recent", "1"], { io: list.io }), 0);
    assert.match(list.stdout.join("\n"), /d-cli-1/);
    assert.match(list.stdout.join("\n"), /success/);

    const detail = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1"], { io: detail.io }), 0);
    assert.match(detail.stdout.join("\n"), /Deployment: d-cli-1/);
    assert.match(detail.stdout.join("\n"), /Events:\s+2/);
  });
});

test("runCoreCommand exposes registry list, show, and complete", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-reg-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });

    const list = capture();
    assert.equal(await runCoreCommand(["registry", "list", "--team", "builder", "--limit", "1"], { io: list.io }), 0);
    assert.match(list.stdout.join("\n"), /d-reg-1/);

    const complete = capture();
    assert.equal(await runCoreCommand(["registry", "complete", "d-reg-1", "--status", "success", "--summary", "done"], { io: complete.io }), 0);
    assert.match(complete.stdout.join("\n"), /Completed d-reg-1/);

    const show = capture();
    assert.equal(await runCoreCommand(["registry", "show", "d-reg-1"], { io: show.io }), 0);
    assert.match(show.stdout.join("\n"), /Status:\s+success/);
    assert.match(show.stdout.join("\n"), /Summary:\s+done/);
  });
});

test("runCoreCommand routes deploy through adapter hook", async () => {
  await withCliEnv(async () => {
    const missing = capture();
    assert.equal(await runCoreCommand(["deploy", "builder"], { io: missing.io }), 1);
    assert.match(missing.stderr.join("\n"), /adapter hook/);

    const captured = capture();
    const seen: unknown[] = [];
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Ship", "--repo", "pa-platform", "--ticket", "PAP-001", "--timeout", "120"], {
      io: captured.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-hook" }; } },
    }), 0);
    assert.deepEqual(seen, [{ team: "builder", mode: "plan", objective: "Ship", repo: "pa-platform", ticket: "PAP-001", timeout: 120 }]);
    assert.match(captured.stdout.join("\n"), /d-hook/);
  });
});

test("runCoreCommand exposes board and teams views", async () => {
  await withCliEnv(async () => {
    new TicketStore().create({
      project: "pa-platform",
      title: "Build core CLI",
      summary: "Summary",
      description: "",
      status: "implementing",
      priority: "high",
      type: "task",
      assignee: "builder/team-manager",
      estimate: "S",
      from: "",
      to: "",
      tags: [],
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, "test");

    const board = capture();
    assert.equal(await runCoreCommand(["board", "--project", "pa-platform", "--assignee", "builder"], { io: board.io }), 0);
    assert.match(board.stdout.join("\n"), /Build core CLI/);

    const teams = capture();
    assert.equal(await runCoreCommand(["teams"], { io: teams.io }), 0);
    assert.match(teams.stdout.join("\n"), /builder/);
    assert.match(teams.stdout.join("\n"), /sonnet/);

    const teamDetail = capture();
    assert.equal(await runCoreCommand(["teams", "builder"], { io: teamDetail.io }), 0);
    assert.match(teamDetail.stdout.join("\n"), /Build core CLI/);
  });
});

test("runCoreCommand exposes ticket and bulletin commands", async () => {
  await withCliEnv(async () => {
    const createTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "CLI ticket", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: createTicket.io }), 0);
    assert.match(createTicket.stdout.join("\n"), /Created PAP-001/);

    const listTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "list", "--project", "pa-platform"], { io: listTicket.io }), 0);
    assert.match(listTicket.stdout.join("\n"), /CLI ticket/);

    const updateTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--status", "implementing", "--doc-ref", "implementation:agent-teams/builder/artifacts/example.md"], { io: updateTicket.io }), 0);
    assert.match(updateTicket.stdout.join("\n"), /implementing/);

    const commentTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content", "Working"], { io: commentTicket.io }), 0);
    assert.match(commentTicket.stdout.join("\n"), /Commented PAP-001/);

    const createBulletin = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Pause", "--block", "all", "--message", "Stop"], { io: createBulletin.io }), 0);
    assert.match(createBulletin.stdout.join("\n"), /Created B-001/);

    const listBulletins = capture();
    assert.equal(await runCoreCommand(["bulletin", "list"], { io: listBulletins.io }), 0);
    assert.match(listBulletins.stdout.join("\n"), /Pause/);

    const resolveBulletin = capture();
    assert.equal(await runCoreCommand(["bulletin", "resolve", "B-001"], { io: resolveBulletin.io }), 0);
    assert.match(resolveBulletin.stdout.join("\n"), /Resolved B-001/);
  });
});

test("runCoreCommand exposes health, trash, and codectx commands", async () => {
  await withCliEnv(async (root) => {
    const health = capture();
    assert.equal(await runCoreCommand(["health", "tickets", "--json"], { io: health.io }), 0);
    assert.match(health.stdout.join("\n"), /"overallScore"/);

    const filePath = join(root, "old.md");
    writeFileSync(filePath, "old");
    const trash = capture();
    assert.equal(await runCoreCommand(["trash", "move", filePath, "--reason", "test", "--actor", "builder/team-manager", "--type", "other"], { io: trash.io }), 0);
    assert.match(trash.stdout.join("\n"), /Trashed T-001/);

    const trashList = capture();
    assert.equal(await runCoreCommand(["trash", "list"], { io: trashList.io }), 0);
    assert.match(trashList.stdout.join("\n"), /old.md/);

    const sourceDir = join(root, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "index.ts"), "export function hello() { return 'hi'; }\n");
    const analyze = capture();
    assert.equal(await runCoreCommand(["codectx", "analyze", sourceDir], { io: analyze.io }), 0);
    assert.match(analyze.stdout.join("\n"), /Analyzed/);

    const summary = capture();
    assert.equal(await runCoreCommand(["codectx", "summary", sourceDir], { io: summary.io }), 0);
    assert.match(summary.stdout.join("\n"), /Functions:/);

    const query = capture();
    assert.equal(await runCoreCommand(["codectx", "query", sourceDir, "exports"], { io: query.io }), 0);
    assert.match(query.stdout.join("\n"), /hello/);
  });
});
