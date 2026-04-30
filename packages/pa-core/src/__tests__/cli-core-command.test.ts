import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendRegistryEvent, closeDb, runCoreCommand, TicketStore } from "../index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

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

function listPackageGuidanceFiles(dir: string): string[] {
  const entries = readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return listPackageGuidanceFiles(path);
    return /\.(md|yaml)$/.test(path) ? [path] : [];
  });
  return entries;
}

test("runCoreCommand exposes repos list", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["repos", "list"], { io: captured.io }), 0);
    assert.match(captured.stdout.join("\n"), /pa-platform/);
    assert.match(captured.stdout.join("\n"), /Test repo/);
    assert.deepEqual(captured.stderr, []);

    const json = capture();
    assert.equal(await runCoreCommand(["repos", "list", "--json"], { io: json.io }), 0);
    assert.equal(JSON.parse(json.stdout.join("\n"))[0].name, "pa-platform");
  });
});

test("runCoreCommand help uses invoking binary fallback", async () => {
  const captured = capture();
  const previousArgv = process.argv[1];
  process.argv[1] = "/nix/store/bin/opa";
  try {
    assert.equal(await runCoreCommand(["help"], { io: captured.io }), 0);
  } finally {
    process.argv[1] = previousArgv;
  }
  assert.match(captured.stdout.join("\n"), /Usage: opa /);
});

test("packaged team and skill guidance avoids removed deploy mode flags", () => {
  const files = [...listPackageGuidanceFiles(join(REPO_ROOT, "teams")), ...listPackageGuidanceFiles(join(REPO_ROOT, "skills"))];
  const offenders = files.flatMap((file) => {
    const matches = readFileSync(file, "utf-8").split("\n").flatMap((line, index) => /--(?:interactive|direct)\b/.test(line) ? [`${file.slice(REPO_ROOT.length + 1)}:${index + 1}: ${line.trim()}`] : []);
    return matches;
  });
  assert.deepEqual(offenders, []);
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
    const previousTz = process.env["TZ"];
    try {
      process.env["TZ"] = "Asia/Bangkok";
      assert.equal(await runCoreCommand(["status", "d-cli-1", "--activity"], { io: activity.io }), 0);
    } finally {
      if (previousTz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = previousTz;
    }
    assert.match(activity.stdout.join("\n"), /2026-04-26 07:00:01 \+07:00/);
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

    const listJson = capture();
    assert.equal(await runCoreCommand(["registry", "list", "--team", "builder", "--json"], { io: listJson.io }), 0);
    assert.equal(JSON.parse(listJson.stdout.join("\n"))[0].deploy_id, "d-reg-1");

    const complete = capture();
    assert.equal(await runCoreCommand(["registry", "complete", "d-reg-1", "--status", "success", "--summary", "done"], { io: complete.io }), 0);
    assert.match(complete.stdout.join("\n"), /Completed d-reg-1/);

    const show = capture();
    assert.equal(await runCoreCommand(["registry", "show", "d-reg-1"], { io: show.io }), 0);
    assert.match(show.stdout.join("\n"), /Status:\s+success/);
    assert.match(show.stdout.join("\n"), /Summary:\s+done/);

    const showJson = capture();
    assert.equal(await runCoreCommand(["registry", "show", "d-reg-1", "--json"], { io: showJson.io }), 0);
    assert.equal(JSON.parse(showJson.stdout.join("\n")).status, "success");
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
    const help = capture();
    assert.equal(await runCoreCommand(["deploy", "--help"], { io: help.io }), 0);
    assert.match(help.stdout.join("\n"), /--background/);
    assert.match(help.stdout.join("\n"), /--dry-run/);
    assert.doesNotMatch(help.stdout.join("\n"), /--interactive|--direct/);

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

    const missingYes = capture();
    assert.equal(await runCoreCommand(["remove-timer", "builder-daily"], { io: missingYes.io }), 1);
    assert.match(missingYes.stderr.join("\n"), /--yes/);
  });
});

test("runCoreCommand scopes board by CWD, aliases, all-project, and assignee", async () => {
  await withCliEnv(async (root) => {
    const repo = join(root, "repo");
    const personalRepo = join(root, "personal-assistant");
    mkdirSync(personalRepo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n  personal:\n    path: ${personalRepo}\n    description: Personal repo\n    prefix: PA\n`);
    const store = new TicketStore();
    store.create({
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
    store.create({
      project: "pa-platform",
      title: "Builder scoped task",
      summary: "Summary",
      description: "",
      status: "pending-implementation",
      priority: "medium",
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
    store.create({
      project: "personal",
      title: "Personal assistant ticket",
      summary: "Summary",
      description: "",
      status: "idea",
      priority: "low",
      type: "task",
      assignee: "sinh",
      estimate: "S",
      from: "",
      to: "",
      tags: [],
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, "test");

    const previousCwd = process.cwd();
    try {
      process.chdir(repo);

      const cwdBoard = capture();
      assert.equal(await runCoreCommand(["board"], { io: cwdBoard.io }), 0);
      assert.match(cwdBoard.stdout.join("\n"), /Board: pa-platform/);
      assert.match(cwdBoard.stdout.join("\n"), /Build core CLI/);
      assert.doesNotMatch(cwdBoard.stdout.join("\n"), /Personal assistant ticket/);

      const allBoard = capture();
      assert.equal(await runCoreCommand(["board", "--all"], { io: allBoard.io }), 0);
      assert.match(allBoard.stdout.join("\n"), /Board: all/);
      assert.match(allBoard.stdout.join("\n"), /Build core CLI/);
      assert.match(allBoard.stdout.join("\n"), /Personal assistant ticket/);

      const allWithProject = capture();
      assert.equal(await runCoreCommand(["board", "--all", "--project", "PAP"], { io: allWithProject.io }), 0);
      assert.match(allWithProject.stdout.join("\n"), /Board: all/);
      assert.match(allWithProject.stdout.join("\n"), /Personal assistant ticket/);

      const prefixBoard = capture();
      assert.equal(await runCoreCommand(["board", "--project", "PAP"], { io: prefixBoard.io }), 0);
      assert.match(prefixBoard.stdout.join("\n"), /Board: pa-platform/);
      assert.match(prefixBoard.stdout.join("\n"), /Build core CLI/);
      assert.doesNotMatch(prefixBoard.stdout.join("\n"), /Personal assistant ticket/);

      const canonicalBoard = capture();
      assert.equal(await runCoreCommand(["board", "--project", "pa-platform"], { io: canonicalBoard.io }), 0);
      assert.equal(prefixBoard.stdout.join("\n"), canonicalBoard.stdout.join("\n"));

      const basenameBoard = capture();
      assert.equal(await runCoreCommand(["board", "--project", "personal-assistant"], { io: basenameBoard.io }), 0);
      assert.match(basenameBoard.stdout.join("\n"), /Board: personal/);
      assert.match(basenameBoard.stdout.join("\n"), /Personal assistant ticket/);

      const assigneeBoard = capture();
      assert.equal(await runCoreCommand(["board", "--project", "pa-platform", "--assignee", "builder"], { io: assigneeBoard.io }), 0);
      assert.match(assigneeBoard.stdout.join("\n"), /Builder scoped task/);
      assert.doesNotMatch(assigneeBoard.stdout.join("\n"), /Personal assistant ticket/);

      process.chdir(root);
      const outsideBoard = capture();
      assert.equal(await runCoreCommand(["board"], { io: outsideBoard.io }), 1);
      assert.match(outsideBoard.stderr.join("\n"), /Not in a registered repo\. Use --all or --project name/);
      assert.match(outsideBoard.stderr.join("\n"), /Available projects: pa-platform, personal/);

      const unknownBoard = capture();
      assert.equal(await runCoreCommand(["board", "--project", "unknown"], { io: unknownBoard.io }), 1);
      assert.match(unknownBoard.stderr.join("\n"), /Unknown project "unknown"/);
      assert.match(unknownBoard.stderr.join("\n"), /Valid project keys: pa-platform, personal/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("runCoreCommand exposes teams views", async () => {
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

    const teams = capture();
    assert.equal(await runCoreCommand(["teams"], { io: teams.io }), 0);
    assert.match(teams.stdout.join("\n"), /builder/);
    assert.match(teams.stdout.join("\n"), /sonnet/);

    const teamsJson = capture();
    assert.equal(await runCoreCommand(["teams", "--json"], { io: teamsJson.io }), 0);
    assert.equal(JSON.parse(teamsJson.stdout.join("\n"))[0].name, "builder");

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

    const listTicketJson = capture();
    assert.equal(await runCoreCommand(["ticket", "list", "--project", "pa-platform", "--json"], { io: listTicketJson.io }), 0);
    assert.equal(JSON.parse(listTicketJson.stdout.join("\n"))[0].id, "PAP-001");

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

    const listBulletinsJson = capture();
    assert.equal(await runCoreCommand(["bulletin", "list", "--json"], { io: listBulletinsJson.io }), 0);
    assert.equal(JSON.parse(listBulletinsJson.stdout.join("\n"))[0].id, "B-001");

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
    assert.equal(await runCoreCommand(["trash", "move", filePath, "--reason", "test", "--actor", "builder/team-manager", "--type", "other", "--yes"], { io: trash.io }), 0);
    assert.match(trash.stdout.join("\n"), /Trashed T-001/);

    const trashList = capture();
    assert.equal(await runCoreCommand(["trash", "list"], { io: trashList.io }), 0);
    assert.match(trashList.stdout.join("\n"), /old.md/);

    const trashListJson = capture();
    assert.equal(await runCoreCommand(["trash", "list", "--json"], { io: trashListJson.io }), 0);
    assert.equal(JSON.parse(trashListJson.stdout.join("\n"))[0].id, "T-001");

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
