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
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-cli-1", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", agents: ["team-manager"], runtime: "opencode", provider: "minimax", models: { team: "minimax-coding-plan/MiniMax-M2.7" } });
    appendRegistryEvent({ deployment_id: "d-cli-1", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", summary: "done" });
    const list = capture();
    assert.equal(await runCoreCommand(["status", "--recent", "1"], { io: list.io }), 0);
    assert.match(list.stdout.join("\n"), /d-cli-1/);
    assert.match(list.stdout.join("\n"), /success/);

    const detail = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1"], { io: detail.io }), 0);
    assert.match(detail.stdout.join("\n"), /Deployment: d-cli-1/);
    assert.match(detail.stdout.join("\n"), /Provider:\s+minimax/);
    assert.match(detail.stdout.join("\n"), /Model:\s+minimax-coding-plan\/MiniMax-M2\.7/);
    assert.match(detail.stdout.join("\n"), /Events:\s+2/);

    const wait = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1", "--wait"], { io: wait.io }), 0);
    assert.match(wait.stdout.join("\n"), /success - done/);

    const deployDir = join(root, "deployments", "d-cli-1");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "artifact.txt"), "artifact");
    writeFileSync(join(deployDir, "activity.jsonl"), JSON.stringify({ deployId: "d-cli-1", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "hello", partType: "text" }) + "\n");
    const reportDir = join(root, "agent-teams", "builder", "done");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "report.md"), "Report for d-cli-1");

    const artifacts = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1", "--artifacts"], { io: artifacts.io }), 0);
    assert.match(artifacts.stdout.join("\n"), /artifact\.txt/);

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1", "--activity"], { io: activity.io }), 0);
    assert.match(activity.stdout.join("\n"), /text\/text/);
    assert.match(activity.stdout.join("\n"), /hello/);

    const report = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-1", "--report"], { io: report.io }), 0);
    assert.match(report.stdout.join("\n"), /Report for d-cli-1/);
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

test("runCoreCommand exposes registry update, search, analytics, clean, and sweep", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-reg-extra", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", pid: 999999, summary: "build registry parity" });

    const update = capture();
    assert.equal(await runCoreCommand(["registry", "update", "d-reg-extra", "--summary", "updated", "--rating-overall", "4"], { io: update.io }), 0);
    assert.match(update.stdout.join("\n"), /Updated: d-reg-extra/);

    const search = capture();
    assert.equal(await runCoreCommand(["registry", "search", "registry", "--limit", "5"], { io: search.io }), 0);
    assert.match(search.stdout.join("\n"), /d-reg-extra/);

    const analytics = capture();
    assert.equal(await runCoreCommand(["registry", "analytics", "--view", "teams"], { io: analytics.io }), 0);
    assert.match(analytics.stdout.join("\n"), /Team Activity/);

    const sweep = capture();
    assert.equal(await runCoreCommand(["registry", "sweep"], { io: sweep.io }), 0);
    assert.match(sweep.stdout.join("\n"), /orphaned deployment/);

    const clean = capture();
    assert.equal(await runCoreCommand(["registry", "clean", "--threshold", "1"], { io: clean.io }), 0);
    assert.match(clean.stdout.join("\n"), /orphaned deployment|No orphaned/);
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

test("runCoreCommand routes serve process management through adapter hook", async () => {
  await withCliEnv(async () => {
    const missing = capture();
    assert.equal(await runCoreCommand(["serve"], { io: missing.io }), 1);
    assert.match(missing.stderr.join("\n"), /adapter hook/);

    const seen: string[] = [];
    const served = capture();
    assert.equal(await runCoreCommand(["restart"], { io: served.io, hooks: { serve: (action) => { seen.push(action); return { status: "ok", message: `served ${action}` }; } } }), 0);
    assert.deepEqual(seen, ["restart"]);
    assert.match(served.stdout.join("\n"), /served restart/);

    const nested = capture();
    assert.equal(await runCoreCommand(["serve", "status"], { io: nested.io, hooks: { serve: (action) => ({ status: "ok", message: `served ${action}` }) } }), 0);
    assert.match(nested.stdout.join("\n"), /served status/);
  });
});

test("runCoreCommand exposes schedule and remove-timer dry-runs", async () => {
  await withCliEnv(async () => {
    const schedule = capture();
    assert.equal(await runCoreCommand(["schedule", "builder:daily", "--repeat", "weekly", "--time", "10:30", "--command", "pa-core", "--dry-run"], { io: schedule.io }), 0);
    assert.match(schedule.stdout.join("\n"), /Would schedule: pa-builder-daily/);

    const positional = capture();
    assert.equal(await runCoreCommand(["schedule", "builder", "daily", "09:00", "--dry-run"], { io: positional.io }), 0);
    assert.match(positional.stdout.join("\n"), /Would schedule: pa-builder/);

    const remove = capture();
    assert.equal(await runCoreCommand(["remove-timer", "builder-daily", "--dry-run"], { io: remove.io }), 0);
    assert.match(remove.stdout.join("\n"), /Would remove timer: pa-builder-daily/);
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
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "CLI ticket", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary", "--doc-ref", "implementation:agent-teams/builder/artifacts/create.md"], { io: createTicket.io }), 0);
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

    const commentFile = join(process.env["PA_AI_USAGE_HOME"]!, "comment.md");
    writeFileSync(commentFile, "File comment");
    const commentTicketFile = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", commentFile], { io: commentTicketFile.io }), 0);
    assert.match(commentTicketFile.stdout.join("\n"), /Commented PAP-001/);

    const attachTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "attach", "PAP-001", "--file", "agent-teams/builder/artifacts/example.md"], { io: attachTicket.io }), 0);
    assert.match(attachTicket.stdout.join("\n"), /Attached to PAP-001/);

    const subCreate = capture();
    assert.equal(await runCoreCommand(["ticket", "subticket", "create", "PAP-001", "--title", "Subtask"], { io: subCreate.io }), 0);
    assert.match(subCreate.stdout.join("\n"), /PAP-001-ST-1/);

    const subComplete = capture();
    assert.equal(await runCoreCommand(["ticket", "subticket", "complete", "PAP-001", "PAP-001-ST-1"], { io: subComplete.io }), 0);
    assert.match(subComplete.stdout.join("\n"), /Completed/);

    const moveTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "move", "PAP-001", "--project", "pa-platform"], { io: moveTicket.io }), 0);
    assert.match(moveTicket.stdout.join("\n"), /Moved: PAP-001 -> PAP-002/);

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

    const primerHealth = capture();
    assert.equal(await runCoreCommand(["health", "--primer-summary"], { io: primerHealth.io }), 0);
    assert.match(primerHealth.stdout.join("\n"), /PA Health:/);

    const saveHealth = capture();
    assert.equal(await runCoreCommand(["health", "--save"], { io: saveHealth.io }), 0);
    const healthHistory = capture();
    assert.equal(await runCoreCommand(["health", "--history"], { io: healthHistory.io }), 0);
    assert.match(healthHistory.stdout.join("\n"), /Count:/);

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

    const oldStyleQuery = capture();
    assert.equal(await runCoreCommand(["codectx", "query", "fn", "hello", sourceDir], { io: oldStyleQuery.io }), 0);
    assert.match(oldStyleQuery.stdout.join("\n"), /hello/);

    const codeStatus = capture();
    assert.equal(await runCoreCommand(["codectx", "status", sourceDir], { io: codeStatus.io }), 0);
    assert.match(codeStatus.stdout.join("\n"), /Graph exists/);

    const refresh = capture();
    assert.equal(await runCoreCommand(["codectx", "refresh", sourceDir], { io: refresh.io }), 0);
    assert.match(refresh.stdout.join("\n"), /Refreshed/);
  });
});

test("runCoreCommand exposes signal collect reprocess dry-run", async () => {
  await withCliEnv(async (root) => {
    const rawDir = join(root, "signal", "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "2026-4-26-9-0-note.md"), "---\nsentAt: 1777194000000\n---\n#task follow up\n");

    const signal = capture();
    assert.equal(await runCoreCommand(["signal", "collect", "--reprocess", "--dry-run"], { io: signal.io }), 0);
    assert.match(signal.stdout.join("\n"), /ticket-task/);
  });
});
