import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { appendEvaluatorResult, appendRegistryEvent, closeDb, compactActivityTail, getDeploymentEvents, getPlatformHomeDir, getServePidFilePath, queryEvaluatorResultsByTargetDeployment, runCoreCommand, TicketStore } from "../index.js";

const CONFIG_ROOT = getPlatformHomeDir();

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
  const previousData = process.env["PA_PLATFORM_DATA"];
  const previousMaxRuntime = process.env["PA_MAX_RUNTIME"];
  const previousStatusWaitTimeout = process.env["PA_STATUS_WAIT_TIMEOUT"];
  const previousTeam = process.env["PA_TEAM"];
  const previousMode = process.env["PA_MODE"];
  const previousDeploymentId = process.env["PA_DEPLOYMENT_ID"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_PLATFORM_DATA"] = join(root, "data");
  delete process.env["PA_MAX_RUNTIME"];
  delete process.env["PA_STATUS_WAIT_TIMEOUT"];
  delete process.env["PA_TEAM"];
  delete process.env["PA_MODE"];
  delete process.env["PA_DEPLOYMENT_ID"];
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
    if (previousData === undefined) delete process.env["PA_PLATFORM_DATA"];
    else process.env["PA_PLATFORM_DATA"] = previousData;
    if (previousMaxRuntime === undefined) delete process.env["PA_MAX_RUNTIME"];
    else process.env["PA_MAX_RUNTIME"] = previousMaxRuntime;
    if (previousStatusWaitTimeout === undefined) delete process.env["PA_STATUS_WAIT_TIMEOUT"];
    else process.env["PA_STATUS_WAIT_TIMEOUT"] = previousStatusWaitTimeout;
    if (previousTeam === undefined) delete process.env["PA_TEAM"];
    else process.env["PA_TEAM"] = previousTeam;
    if (previousMode === undefined) delete process.env["PA_MODE"];
    else process.env["PA_MODE"] = previousMode;
    if (previousDeploymentId === undefined) delete process.env["PA_DEPLOYMENT_ID"];
    else process.env["PA_DEPLOYMENT_ID"] = previousDeploymentId;
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

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return listFiles(path);
    return [path];
  });
}

function assertDeploymentsDoNotContain(root: string, value: string): void {
  for (const file of listFiles(join(root, "deployments"))) {
    assert.doesNotMatch(readFileSync(file, "utf-8"), new RegExp(value));
  }
}

function assertSanitizedBlockedError(stderr: string[], blockedPattern: RegExp, hiddenPattern: RegExp): void {
  const output = stderr.join("\n");
  assert.match(output, blockedPattern);
  assert.doesNotMatch(output, hiddenPattern);
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

test("runCoreCommand exposes semantic rebuild and query", async () => {
  await withCliEnv(async () => {
    const rebuild = capture();
    assert.equal(await runCoreCommand(["semantic", "rebuild"], { io: rebuild.io }), 0);
    assert.match(rebuild.stdout.join("\n"), /Semantic index rebuilt/);

    const query = capture();
    assert.equal(await runCoreCommand(["semantic", "query", "semantic", "briefing", "PAP-058", "--top-k=3"], { io: query.io }), 0);
    assert.match(query.stdout.join("\n"), /Query:/);
    assert.match(query.stdout.join("\n"), /Reflections:/);
    assert.match(query.stdout.join("\n"), /System:/);

    const briefing = capture();
    assert.equal(await runCoreCommand(["semantic", "briefing", "get", "up", "to", "date"], { io: briefing.io }), 0);
    assert.match(briefing.stdout.join("\n"), /Related context bundle:/);
    assert.match(briefing.stdout.join("\n"), /Evidence map:/);
    assert.match(briefing.stdout.join("\n"), /Confirmation gate:/);
    assert.match(briefing.stdout.join("\n"), /Write guard: blocked before confirmation/);
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

test("packaged team and skill guidance avoids removed deploy mode flags", (t) => {
  const teamsDir = join(CONFIG_ROOT, "teams");
  const skillsDir = join(CONFIG_ROOT, "skills");
  if (!existsSync(teamsDir) || !existsSync(skillsDir)) return t.skip("external pa-platform-config fixture not available");
  const files = [...listPackageGuidanceFiles(teamsDir), ...listPackageGuidanceFiles(skillsDir)];
  const offenders = files.flatMap((file) => {
    const matches = readFileSync(file, "utf-8").split("\n").flatMap((line, index) => /--(?:interactive|direct)\b/.test(line) ? [`${file.slice(CONFIG_ROOT.length + 1)}:${index + 1}: ${line.trim()}`] : []);
    return matches;
  });
  assert.deepEqual(offenders, []);
});

test("packaged PA CLI guidance describes opa adapter and core-owned serve", (t) => {
  if (!existsSync(join(CONFIG_ROOT, "skills", "global", "pa-cli", "SKILL.md"))) return t.skip("external pa-platform-config fixture not available");
  const guidance = readFileSync(join(CONFIG_ROOT, "skills", "global", "pa-cli", "SKILL.md"), "utf-8");
  assert.match(guidance, /# OPA CLI Reference/);
  assert.match(guidance, /`opa` is the default OpenCode deployment adapter/);
  assert.match(guidance, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(guidance, /\| `pa-core serve` \| Start, stop, restart, and inspect the core-owned Agent API server/);
  assert.match(guidance, /rather than restored as required direct `daily`, `requirements`, `idea`, or `report` CLI commands/);
  assert.doesNotMatch(guidance, /\| `(?:pa|opa) (?:daily|requirements|idea|report)\b/);
  assert.doesNotMatch(guidance, /`opa serve`|`pa serve`/);
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
    const artifactsReportDir = join(root, "agent-teams", "evaluator", "artifacts");
    mkdirSync(artifactsReportDir, { recursive: true });
    writeFileSync(join(artifactsReportDir, "2026-04-26-d-cli-artifact-evaluator-report.md"), "Artifact report for d-cli-artifact");

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

    appendRegistryEvent({ deployment_id: "d-cli-artifact", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const artifactReport = capture();
    assert.equal(await runCoreCommand(["status", "d-cli-artifact", "--report"], { io: artifactReport.io }), 0);
    assert.match(artifactReport.stdout.join("\n"), /Artifact report for d-cli-artifact/);
  });
});

test("status --activity filters noise events from output", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-filter", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-filter");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-filter", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "session.status: idle" }),
      JSON.stringify({ deployId: "d-act-filter", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "session.diff: diff=[]" }),
      JSON.stringify({ deployId: "d-act-filter", timestamp: "2026-04-26T00:00:02.000Z", kind: "text", source: "opencode", body: "file.watcher.updated: /some/path" }),
      JSON.stringify({ deployId: "d-act-filter", timestamp: "2026-04-26T00:00:03.000Z", kind: "text", source: "opencode", body: "session.updated: stuff" }),
      JSON.stringify({ deployId: "d-act-filter", timestamp: "2026-04-26T00:00:04.000Z", kind: "text", source: "opencode", body: "visible text event" }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-filter", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /1\/5 events/);
    assert.match(output, /visible text event/);
    assert.doesNotMatch(output, /session\.status/);
    assert.doesNotMatch(output, /session\.diff/);
    assert.doesNotMatch(output, /file\.watcher\.updated/);
    assert.doesNotMatch(output, /session\.updated/);
  });
});

test("status --activity formats reasoning events with indented content", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-reasoning", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-reasoning");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-reasoning", timestamp: "2026-04-26T00:00:00.000Z", kind: "thinking", source: "opencode", body: "part=reasoning Let me analyze the problem and find a solution." }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-reasoning", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /reasoning/);
    assert.match(output, /    Let me analyze the problem and find a solution\./);
    assert.doesNotMatch(output, /part=reasoning/);
  });
});

test("status --activity strips part=thinking role=assistant prefix for kind=thinking events", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-thinking", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-thinking");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      // Realistic opencode plugin schema: kind="thinking" with body produced by summarizeMessageData:
      // "part=thinking role=assistant <thinking content>"
      JSON.stringify({ deployId: "d-act-thinking", timestamp: "2026-04-26T00:00:00.000Z", kind: "thinking", source: "opencode", body: "part=thinking role=assistant I should consider the edge cases first." }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-thinking", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /reasoning/);
    assert.match(output, /    I should consider the edge cases first\./);
    assert.doesNotMatch(output, /part=thinking/);
    assert.doesNotMatch(output, /role=assistant/);
  });
});

test("status --report combined with --activity is a parse error", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-report-conflict", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const captured = capture();
    const code = await runCoreCommand(["status", "d-report-conflict", "--report", "--activity"], { io: captured.io });
    assert.equal(code, 1);
    assert.match(captured.stderr.join("\n"), /--report is standalone and not combinable with --activity/);
  });
});

test("status --artifacts combined with --wait is a parse error", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-artifacts-conflict", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const captured = capture();
    const code = await runCoreCommand(["status", "d-artifacts-conflict", "--artifacts", "--wait"], { io: captured.io });
    assert.equal(code, 1);
    assert.match(captured.stderr.join("\n"), /--artifacts is standalone and not combinable with --wait/);
  });
});

test("status --report combined with --artifacts is a parse error", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-both-standalone", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const captured = capture();
    const code = await runCoreCommand(["status", "d-both-standalone", "--report", "--artifacts"], { io: captured.io });
    assert.equal(code, 1);
    assert.match(captured.stderr.join("\n"), /--report is standalone and not combinable with --artifacts/);
  });
});

test("status --activity formats tool actions with concise tool name and target", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-tools", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-tools");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-tools", timestamp: "2026-04-26T00:00:00.000Z", kind: "tool_use", source: "opencode", body: "tool=bash", metadata: { tool: "bash", args: { command: "git status" } } }),
      JSON.stringify({ deployId: "d-act-tools", timestamp: "2026-04-26T00:00:01.000Z", kind: "tool_result", source: "opencode", body: "tool=bash", metadata: { tool: "bash", args: { command: "git status" } } }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-tools", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /tool\s+bash: git status/);
    assert.match(output, /result\s+bash: git status/);
    assert.doesNotMatch(output, /"command"/);
    assert.doesNotMatch(output, /"args"/);
  });
});

test("status --activity redacts secrets in tool-action target from metadata.args.command", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-secret", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-secret");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-secret", timestamp: "2026-04-26T00:00:00.000Z", kind: "tool_use", source: "opencode", body: "tool=bash", metadata: { tool: "bash", args: { command: "curl -H 'Authorization: Bearer sk-leaked-token-12345' https://api.example.com" } } }),
      JSON.stringify({ deployId: "d-act-secret", timestamp: "2026-04-26T00:00:01.000Z", kind: "tool_result", source: "opencode", body: "tool=bash", metadata: { tool: "bash", summary: "export TOKEN=sk-leaked-token-12345 && npm publish" } }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-secret", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /tool\s+bash: curl -H 'Authorization: \[REDACTED\]/);
    assert.match(output, /result\s+bash: export \[REDACTED\]/);
    assert.doesNotMatch(output, /sk-leaked-token-12345/);
  });
});

test("status --activity groups events by agent/session source", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-group", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-group");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-group", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "ses_abc", body: "event from session abc" }),
      JSON.stringify({ deployId: "d-act-group", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "ses_def", body: "event from session def" }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-group", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /--- ses_abc \(1\) ---/);
    assert.match(output, /--- ses_def \(1\) ---/);
    assert.match(output, /event from session abc/);
    assert.match(output, /event from session def/);
  });
});

test("status --activity --verbose shows all events including noise", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-verbose", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-verbose");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-verbose", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "session.status: idle" }),
      JSON.stringify({ deployId: "d-act-verbose", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "session.diff: diff=[]" }),
      JSON.stringify({ deployId: "d-act-verbose", timestamp: "2026-04-26T00:00:02.000Z", kind: "text", source: "opencode", body: "visible text event" }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-verbose", "--activity", "--verbose"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /3 events \[verbose\]/);
    assert.match(output, /session\.status/);
    assert.match(output, /session\.diff/);
    assert.match(output, /visible text event/);
  });
});

test("status --wait --activity shows activity tail during poll", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-wait-act", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const deployDir = join(root, "deployments", "d-wait-act");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-wait-act", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
      JSON.stringify({ deployId: "d-wait-act", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
      JSON.stringify({ deployId: "d-wait-act", timestamp: "2026-04-26T00:00:02.000Z", kind: "text", source: "opencode", body: "event three" }),
    ].join("\n") + "\n");

    const captured = capture();
    let sleeps = 0;
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-wait-act", "--wait", "--activity"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
        appendRegistryEvent({ deployment_id: "d-wait-act", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "success", summary: "done" });
      },
    });

    assert.equal(code, 0);
    assert.equal(sleeps, 1);
    const output = captured.stdout.join("\n");
    assert.match(output, /Waiting for deployment: d-wait-act/);
    assert.match(output, /--- activity tail/);
    assert.match(output, /event three/);
    assert.match(output, /success - done/);
  });
});

test("status --wait --activity tail is incremental across polls", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-wait-incr", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const deployDir = join(root, "deployments", "d-wait-incr");
    mkdirSync(deployDir, { recursive: true });
    const activityFile = join(deployDir, "activity.jsonl");
    writeFileSync(activityFile, [
      JSON.stringify({ deployId: "d-wait-incr", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
      JSON.stringify({ deployId: "d-wait-incr", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
    ].join("\n") + "\n");

    const captured = capture();
    let sleeps = 0;
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-wait-incr", "--wait", "--activity"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
        if (sleeps === 1) {
          // unchanged activity: no new events appended
          return;
        }
        if (sleeps === 2) {
          // append a new event then mark completed on the third sleep
          writeFileSync(activityFile, [
            JSON.stringify({ deployId: "d-wait-incr", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
            JSON.stringify({ deployId: "d-wait-incr", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
            JSON.stringify({ deployId: "d-wait-incr", timestamp: "2026-04-26T00:00:20.000Z", kind: "text", source: "opencode", body: "event three" }),
          ].join("\n") + "\n");
          return;
        }
        appendRegistryEvent({ deployment_id: "d-wait-incr", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:30.000Z", status: "success", summary: "done" });
      },
    });

    assert.equal(code, 0);
    assert.equal(sleeps, 3);
    const output = captured.stdout.join("\n");
    // first poll prints initial tail (last 10 of visible = 2 events)
    // second poll: unchanged activity prints nothing (incremental)
    // third poll: only the new event three is emitted
    const tailHeaders = output.match(/--- activity tail/g) ?? [];
    assert.equal(tailHeaders.length, 2, "should print tail only when there is something new to show");
    // event two must appear exactly once (initial tail, not reprinted on unchanged poll)
    const eventTwoOccurrences = output.match(/event two/g) ?? [];
    assert.equal(eventTwoOccurrences.length, 1, "unchanged activity must not reprint previous events");
    // event three should be emitted once (on the third poll after it was appended)
    const eventThreeOccurrences = output.match(/event three/g) ?? [];
    assert.equal(eventThreeOccurrences.length, 1, "new event should be emitted once");
    assert.match(output, /success - done/);
  });
});

test("status --wait --activity flushes final activity batch on terminal status", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-wait-final", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const deployDir = join(root, "deployments", "d-wait-final");
    mkdirSync(deployDir, { recursive: true });
    const activityFile = join(deployDir, "activity.jsonl");
    writeFileSync(activityFile, [
      JSON.stringify({ deployId: "d-wait-final", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
    ].join("\n") + "\n");

    const captured = capture();
    let sleeps = 0;
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-wait-final", "--wait", "--activity"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
        if (sleeps === 1) {
          // append a late event then mark completed on the second sleep
          writeFileSync(activityFile, [
            JSON.stringify({ deployId: "d-wait-final", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
            JSON.stringify({ deployId: "d-wait-final", timestamp: "2026-04-26T00:00:20.000Z", kind: "text", source: "opencode", body: "event two (final)" }),
          ].join("\n") + "\n");
          return;
        }
        appendRegistryEvent({ deployment_id: "d-wait-final", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:30.000Z", status: "success", summary: "done" });
      },
    });

    assert.equal(code, 0);
    assert.equal(sleeps, 2);
    const output = captured.stdout.join("\n");
    // The late event "event two (final)" must appear in the final flush
    assert.match(output, /event two \(final\)/, "final activity batch must be flushed on terminal status");
    assert.match(output, /success - done/);
  });
});

test("status --wait --activity emits zero ANSI codes in non-TTY mode (AC2, NFR3)", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-noansi", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const deployDir = join(root, "deployments", "d-noansi");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-noansi", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
      JSON.stringify({ deployId: "d-noansi", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
    ].join("\n") + "\n");

    const originalIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;

      const captured = capture();
      let nowMs = 0;
      const code = await runCoreCommand(["status", "d-noansi", "--wait", "--activity"], {
        io: captured.io,
        clock: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
          appendRegistryEvent({ deployment_id: "d-noansi", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "success", summary: "done" });
        },
      });

      assert.equal(code, 0);
      const allOutput = [...writes, ...captured.stdout].join("\n");
      assert.doesNotMatch(allOutput, /\x1b/, "non-TTY output must contain zero ANSI escape codes");
      assert.match(captured.stdout.join("\n"), /event one/);
      assert.match(captured.stdout.join("\n"), /event two/);
    } finally {
      process.stdout.write = originalWrite;
      if (originalIsTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", originalIsTtyDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

test("status --wait --activity uses ANSI cursor control in TTY mode (AC1, FR1)", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-tty-act", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const deployDir = join(root, "deployments", "d-tty-act");
    mkdirSync(deployDir, { recursive: true });
    const activityFile = join(deployDir, "activity.jsonl");
    writeFileSync(activityFile, [
      JSON.stringify({ deployId: "d-tty-act", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
      JSON.stringify({ deployId: "d-tty-act", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
    ].join("\n") + "\n");

    const originalIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;

      const captured = capture();
      let sleeps = 0;
      let nowMs = 0;
      const code = await runCoreCommand(["status", "d-tty-act", "--wait", "--activity"], {
        io: captured.io,
        clock: () => nowMs,
        sleep: async (ms) => {
          sleeps += 1;
          nowMs += ms;
          if (sleeps === 1) {
            writeFileSync(activityFile, [
              JSON.stringify({ deployId: "d-tty-act", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "event one" }),
              JSON.stringify({ deployId: "d-tty-act", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "event two" }),
              JSON.stringify({ deployId: "d-tty-act", timestamp: "2026-04-26T00:00:20.000Z", kind: "text", source: "opencode", body: "event three" }),
            ].join("\n") + "\n");
            return;
          }
          appendRegistryEvent({ deployment_id: "d-tty-act", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:30.000Z", status: "success", summary: "done" });
        },
      });

      assert.equal(code, 0);
      assert.equal(sleeps, 2);
      const ansiOutput = writes.join("");
      assert.match(ansiOutput, /\x1b\[\d+A/, "TTY mode must emit cursor-up ANSI code");
      assert.match(ansiOutput, /\x1b\[K/, "TTY mode must emit line-clear ANSI code");
      assert.match(ansiOutput, /\x1b\[J/, "TTY mode must emit screen-clear-from-cursor ANSI code");
      const ioOutput = captured.stdout.join("\n");
      assert.match(ioOutput, /--- activity tail/);
      assert.match(ioOutput, /event three/, "new events must appear in TTY output");
    } finally {
      process.stdout.write = originalWrite;
      if (originalIsTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", originalIsTtyDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

test("status --activity standalone shows full grouped activity unchanged (AC3, FR10)", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-regression", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-regression");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-regression", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "ses_alpha", body: "alpha event one" }),
      JSON.stringify({ deployId: "d-act-regression", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "ses_alpha", body: "alpha event two" }),
      JSON.stringify({ deployId: "d-act-regression", timestamp: "2026-04-26T00:00:02.000Z", kind: "text", source: "ses_beta", body: "beta event one" }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-regression", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /Activity timeline - d-act-regression \(3\/3 events\)/);
    assert.match(output, /--- ses_alpha \(2\) ---/);
    assert.match(output, /alpha event one/);
    assert.match(output, /alpha event two/);
    assert.match(output, /--- ses_beta \(1\) ---/);
    assert.match(output, /beta event one/);
    assert.doesNotMatch(output, /\[verbose\]/, "standalone --activity must not show verbose label without --verbose");
  });
});

test("status --activity keeps non-empty session.diff events visible", async () => {
  await withCliEnv(async (root) => {
    appendRegistryEvent({ deployment_id: "d-act-diff", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const deployDir = join(root, "deployments", "d-act-diff");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      JSON.stringify({ deployId: "d-act-diff", timestamp: "2026-04-26T00:00:00.000Z", kind: "text", source: "opencode", body: "session.diff: diff=[file.ts]" }),
      JSON.stringify({ deployId: "d-act-diff", timestamp: "2026-04-26T00:00:01.000Z", kind: "text", source: "opencode", body: "session.diff: diff=[]" }),
    ].join("\n") + "\n");

    const activity = capture();
    assert.equal(await runCoreCommand(["status", "d-act-diff", "--activity"], { io: activity.io }), 0);
    const output = activity.stdout.join("\n");
    assert.match(output, /diff=\[file\.ts\]/, "non-empty diff must remain visible");
    assert.doesNotMatch(output, /diff=\[\]\s*\n/, "empty diff must be filtered out");
  });
});

test("status --verbose without --activity is a parse error", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-verbose-err", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z" });
    const captured = capture();
    const code = await runCoreCommand(["status", "d-verbose-err", "--verbose"], { io: captured.io });
    assert.equal(code, 1);
    assert.match(captured.stderr.join("\n"), /--verbose requires --activity/);
  });
});

test("compactActivityTail suppresses message.part.updated events with empty content (FR6, AC4)", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant " },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant actual content" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 1);
  assert.match(compacted[0].body, /agent: actual content/);
});

test("compactActivityTail collapses consecutive same-source same-type text events (FR4, AC5)", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant checking" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant  the" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:02.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant  file" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 1);
  assert.match(compacted[0].body, /agent: checking the file/);
});

test("compactActivityTail collapses consecutive tool_use events (FR5)", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=tool_use role=assistant chunk 1" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=tool_use role=assistant chunk 2" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 1);
  assert.match(compacted[0].body, /agent: tool chunks received/);
});

test("compactActivityTail starts new group on type change text to tool (FR8)", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant some text" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=tool_use role=assistant tool call" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:02.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant more text" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 3);
  assert.match(compacted[0].body, /agent: some text/);
  assert.match(compacted[1].body, /agent: tool chunks received/);
  assert.match(compacted[2].body, /agent: more text/);
});

test("compactActivityTail starts new group on source change", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent-a", body: "message.part.updated: part=text role=assistant text from a" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent-b", body: "message.part.updated: part=text role=assistant text from b" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 2);
  assert.match(compacted[0].body, /agent-a: text from a/);
  assert.match(compacted[1].body, /agent-b: text from b/);
});

test("compactActivityTail passes non-message.part.updated events through unchanged", () => {
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "opencode", body: "normal event one" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:01.000Z", kind: "text" as const, source: "agent", body: "message.part.updated: part=text role=assistant text" },
    { deployId: "d-test", timestamp: "2026-04-26T00:00:02.000Z", kind: "text" as const, source: "opencode", body: "normal event two" },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 3);
  assert.equal(compacted[0].body, "normal event one");
  assert.match(compacted[1].body, /agent: text/);
  assert.equal(compacted[2].body, "normal event two");
});

test("compactActivityTail truncates long text preview at 60 characters (FR7)", () => {
  const longText = "a".repeat(100);
  const events = [
    { deployId: "d-test", timestamp: "2026-04-26T00:00:00.000Z", kind: "text" as const, source: "agent", body: `message.part.updated: part=text role=assistant ${longText}` },
  ];
  const compacted = compactActivityTail(events);
  assert.equal(compacted.length, 1);
  const body = compacted[0].body;
  assert.ok(!body.includes("a".repeat(61)), "body should not contain more than 60 chars");
  assert.ok(body.endsWith("..."), "body should end with ellipsis");
  assert.equal(body.length, "agent: ".length + 60 + 3);
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
    appendRegistryEvent({ deployment_id: "d-reg-extra", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", summary: "done", rating: { source: "agent", overall: 3.5, productivity: 4, quality: 3 } });
    appendRegistryEvent({ deployment_id: "d-reg-eval", team: "builder", event: "started", timestamp: "2026-04-26T00:02:00.000Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-reg-extra",
      evaluator_deployment_id: "d-reg-eval",
      summary: "independent evaluation",
      evidence_refs: ["deployments/d-reg-extra/primer.md"],
      rating: { source: "system", overall: 4, metrics: { human_agency: 5, quality: 4 } },
    });

    const update = capture();
    assert.equal(await runCoreCommand(["registry", "update", "d-reg-extra", "--summary", "updated", "--rating-overall", "4"], { io: update.io }), 0);
    assert.match(update.stdout.join("\n"), /Updated: d-reg-extra/);

    const search = capture();
    assert.equal(await runCoreCommand(["registry", "search", "registry", "--limit", "5"], { io: search.io }), 0);
    assert.match(search.stdout.join("\n"), /d-reg-extra/);

    const analyticsTeams = capture();
    assert.equal(await runCoreCommand(["registry", "analytics", "--view", "teams"], { io: analyticsTeams.io }), 0);
    assert.match(analyticsTeams.stdout.join("\n"), /Team Activity/);

    const analyticsRatings = capture();
    assert.equal(await runCoreCommand(["registry", "analytics", "--view", "ratings"], { io: analyticsRatings.io }), 0);
    assert.match(analyticsRatings.stdout.join("\n"), /SelfSrc/);
    assert.match(analyticsRatings.stdout.join("\n"), /EvalSrc/);
    assert.match(analyticsRatings.stdout.join("\n"), /HumanAgency/);
    assert.match(analyticsRatings.stdout.join("\n"), /d-reg-extra/);
    assert.match(analyticsRatings.stdout.join("\n"), /agent/);
    assert.match(analyticsRatings.stdout.join("\n"), /system/);
    assert.match(analyticsRatings.stdout.join("\n"), /5/);

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
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Ship", "--evaluate-deployment", "d-abc123", "--repo", "pa-platform", "--ticket", "PAP-001", "--timeout", "120"], {
      io: captured.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-hook" }; } },
    }), 0);
    assert.deepEqual(seen, [{ team: "builder", mode: "plan", objective: "Ship", evaluateDeployment: "d-abc123", repo: "pa-platform", ticket: "PAP-001", timeout: 120 }]);
    assert.match(captured.stdout.join("\n"), /d-hook/);
  });
});

test("runCoreCommand routes evaluate to dedicated evaluator deployment", async () => {
  await withCliEnv(async (root) => {
    const help = capture();
    assert.equal(await runCoreCommand(["evaluate", "--help"], { io: help.io }), 0);
    assert.match(help.stdout.join("\n"), /evaluate --evaluate-deployment <deploy-id>/);
    assert.match(help.stdout.join("\n"), /deployment-review/);

    const missing = capture();
    assert.equal(await runCoreCommand(["evaluate"], { io: missing.io }), 0);
    assert.match(missing.stdout.join("\n"), /Usage: evaluate/);

    const invalid = capture();
    assert.equal(await runCoreCommand(["evaluate", "--evaluate-deployment", "bad"], { io: invalid.io }), 1);
    assert.match(invalid.stderr.join("\n"), /Invalid evaluate deployment id/);

    const captured = capture();
    const seen: unknown[] = [];
    assert.equal(await runCoreCommand(["evaluate", "--evaluate-deployment", "d-abc123", "--ticket", "PAP-058", "--background", "--timeout", "120"], {
      io: captured.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-eval01" }; } },
    }), 0);
    assert.deepEqual(seen, [{ team: "evaluator", mode: "deployment-review", evaluateDeployment: "d-abc123", ticket: "PAP-058", background: true, timeout: 120 }]);
    assert.match(captured.stdout.join("\n"), /Evaluation pending: d-eval01/);

    const positional = capture();
    const positionalSeen: unknown[] = [];
    assert.equal(await runCoreCommand(["evaluate", "d-def456", "--dry-run"], {
      io: positional.io,
      hooks: { deploy: (request) => { positionalSeen.push(request); return { status: "pending", deploymentId: "d-eval02" }; } },
    }), 0);
    assert.deepEqual(positionalSeen, [{ team: "evaluator", mode: "deployment-review", evaluateDeployment: "d-def456", dryRun: true, timeout: 1800 }]);

    mkdirSync(join(root, "deployments", "d-target"), { recursive: true });
    writeFileSync(join(root, "deployments", "d-target", "primer.md"), "# Primer");
    writeFileSync(join(root, "deployments", "d-target", "activity.jsonl"), "{}\n");
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", objective: "Ship", primer: "deployments/d-target/primer.md" });
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "completed", timestamp: "2026-04-26T00:01:00.000Z", status: "success", rating: { source: "agent", overall: 4 } });
    appendRegistryEvent({ deployment_id: "d-eval00", team: "evaluator", event: "started", timestamp: "2026-04-26T00:02:00.000Z" });
    const record = capture();
    assert.equal(await runCoreCommand(["evaluate", "--record", "--evaluate-deployment", "d-target", "--evaluator-deployment", "d-eval00", "--report-path", "agent-teams/evaluator/artifacts/report.md", "--overall", "4", "--human-agency", "5"], { io: record.io }), 0);
    assert.match(record.stdout.join("\n"), /Recorded evaluator result: d-eval00 -> d-target/);
    const results = queryEvaluatorResultsByTargetDeployment("d-target");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.report_path, "agent-teams/evaluator/artifacts/report.md");
    assert.equal(results[0]?.rating.overall, 4);
    assert.equal(results[0]?.rating.metrics.human_agency, 5);

    // evaluation.auto_launch_enabled config write removed: EvaluationConfig was
    // removed from PlatformConfig and loadConfig no longer reads this field.
    const disabledConfig = capture();
    const disabledConfigSeen: unknown[] = [];
    assert.equal(await runCoreCommand(["evaluate", "--evaluate-deployment", "d-abc123"], {
      io: disabledConfig.io,
      hooks: { deploy: (request) => { disabledConfigSeen.push(request); return { status: "pending", deploymentId: "d-eval03" }; } },
    }), 0);
    assert.deepEqual(disabledConfigSeen, [{ team: "evaluator", mode: "deployment-review", evaluateDeployment: "d-abc123", timeout: 1800 }]);
    assert.match(disabledConfig.stdout.join("\n"), /Evaluation pending: d-eval03/);
  });
});

test("deploy --validate fails when team config references missing skills paths", async () => {
  await withCliEnv(async () => {
    const teamsDir = process.env["PA_PLATFORM_TEAMS"]!;
    writeFileSync(join(teamsDir, "builder.yaml"), [
      "name: builder",
      "description: Builder",
      "objective: Build",
      "agents:",
      "  - name: implementer",
      "    role: Writes code",
      "    instruction: skills/missing-agent-instruction.md",
      "deploy_modes:",
      "  - id: implement",
      "    label: Implement",
      "    objective: skills/missing-mode-objective.md",
    ].join("\n"));

    const captured = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--validate"], { io: captured.io }), 1);
    const stderr = captured.stderr.join("\n");
    assert.match(stderr, /Team config validation failed/);
    assert.match(stderr, /skills\/missing-agent-instruction\.md \(agent implementer instruction; instruction\)/);
    assert.match(stderr, /skills\/missing-mode-objective\.md \(mode implement objective; objective\)/);
    assert.match(stderr, /attempted:/);
    assert.match(stderr, /team config:/);
  });
});

test("deploy objective-file uses guarded local text-file reader", async () => {
  await withCliEnv(async (root) => {
    const objectiveFile = join(root, "objective.md");
    const markdownObjective = [
      "| Phase | Status |",
      "|---|---|",
      "| 1 | `done` |",
      "",
      "```md",
      "2 < 3 and 5 > 4",
      "```",
    ].join("\n");
    writeFileSync(objectiveFile, markdownObjective);

    const seen: unknown[] = [];
    const allowed = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective-file", objectiveFile, "--dry-run"], {
      io: allowed.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-objective-file" }; } },
    }), 0);
    assert.deepEqual(seen, [{ team: "builder", mode: "plan", objective: markdownObjective, dryRun: true, timeout: 1800 }]);

    writeFileSync(join(process.env["PA_PLATFORM_CONFIG"]!, "sensitive-patterns.yaml"), ["contents:", "  - 'FAKE_PRIVATE_OBJECTIVE_[0-9]+'", ""].join("\n"));
    writeFileSync(objectiveFile, "contains FAKE_PRIVATE_OBJECTIVE_123 only");

    const blocked = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective-file", objectiveFile, "--dry-run"], {
      io: blocked.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-blocked" }; } },
    }), 1);
    assert.match(blocked.stderr.join("\n"), /Blocked sensitive content input/);
    assert.doesNotMatch(blocked.stderr.join("\n"), /FAKE_PRIVATE_OBJECTIVE|123/);
    assert.equal(seen.length, 1);
  });
});

test("deploy objective-file blocks local filename, path, and content matches without leaking inputs", async () => {
  await withCliEnv(async (root) => {
    writeFileSync(join(process.env["PA_PLATFORM_CONFIG"]!, "sensitive-patterns.yaml"), [
      "filenames:",
      "  - '^fake-private-objective\\.md$'",
      "paths:",
      "  - 'fake-private-objectives'",
      "contents:",
      "  - 'FAKE_PRIVATE_OBJECTIVE_[0-9]+'",
      "",
    ].join("\n"));

    const cases = [
      { file: join(root, "fake-private-objective.md"), content: "LOCAL_FILENAME_CONTENT", error: /Blocked sensitive filename input/, hidden: /fake-private-objective|LOCAL_FILENAME_CONTENT/ },
      { file: join(root, "fake-private-objectives", "objective.md"), content: "LOCAL_PATH_CONTENT", error: /Blocked sensitive path input/, hidden: /fake-private-objectives|LOCAL_PATH_CONTENT/ },
      { file: join(root, "objective.md"), content: "contains FAKE_PRIVATE_OBJECTIVE_123 only", error: /Blocked sensitive content input/, hidden: /FAKE_PRIVATE_OBJECTIVE|123/ },
    ];

    for (const scenario of cases) {
      mkdirSync(dirname(scenario.file), { recursive: true });
      writeFileSync(scenario.file, scenario.content);
      const captured = capture();
      let called = false;

      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective-file", scenario.file, "--dry-run"], {
        io: captured.io,
        hooks: { deploy: () => { called = true; return { status: "pending" as const, deploymentId: "d-blocked" }; } },
      }), 1);
      assert.equal(called, false);
      assertSanitizedBlockedError(captured.stderr, scenario.error, scenario.hidden);
      assertDeploymentsDoNotContain(root, scenario.content);
    }
  });
});

test("deploy inline objective blocks sensitive content before deployment execution", async () => {
  await withCliEnv(async () => {
    writeFileSync(join(process.env["PA_PLATFORM_CONFIG"]!, "sensitive-patterns.yaml"), ["contents:", "  - 'FAKE_INLINE_PRIVATE_[0-9]+'", ""].join("\n"));
    const hooks = { deploy: () => { throw new Error("should not deploy sensitive inline objective"); } };

    for (const scenario of [
      { objective: "api_key=abcdefghijklmnop", hidden: /api_key|abcdefghijklmnop/ },
      { objective: "contains FAKE_INLINE_PRIVATE_123 only", hidden: /FAKE_INLINE_PRIVATE|123/ },
    ]) {
      const captured = capture();
      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", scenario.objective, "--dry-run"], { io: captured.io, hooks }), 1);
      assertSanitizedBlockedError(captured.stderr, /Blocked sensitive content input/, scenario.hidden);
    }
  });
});

test("deploy objective-file built-in defaults block common sensitive filenames without local config", async () => {
  await withCliEnv(async (root) => {
    const sensitiveFiles = [
      join(root, ".env"),
      join(root, ".npmrc"),
      join(root, ".pypirc"),
      join(root, ".netrc"),
      join(root, ".ssh", "id_ed25519"),
      join(root, "credentials.json"),
      join(root, "credentials-fake.json"),
      join(root, "secret.json"),
      join(root, "secrets.yaml"),
      join(root, "secrets.yml"),
      join(root, "service-token.json"),
      join(root, "service-api-key.json"),
      join(root, "service-api_key.json"),
    ];

    for (const file of sensitiveFiles) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "SAFE_FAKE_FIXTURE_CONTENT");
      const captured = capture();
      let called = false;

      assert.equal(await runCoreCommand(["deploy", "builder", "--objective-file", file, "--dry-run"], {
        io: captured.io,
        hooks: { deploy: () => { called = true; return { status: "pending" as const, deploymentId: "d-sensitive-default" }; } },
      }), 1, file);
      assert.equal(called, false, file);
      assert.match(captured.stderr.join("\n"), /Blocked sensitive (filename|path) input/, file);
      assert.doesNotMatch(captured.stderr.join("\n"), /SAFE_FAKE_FIXTURE_CONTENT/, file);
    }
  });
});

test("deploy inline objective uses sensitive content guard after objective validation", async () => {
  await withCliEnv(async () => {
    const seen: unknown[] = [];
    const hooks = { deploy: (request: unknown) => { seen.push(request); return { status: "pending" as const, deploymentId: "d-inline-objective" }; } };

    const markdownInlineObjective = "| phase | status | `ok` | 2 < 3 | 5 > 4 |";
    const allowedMarkdown = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", markdownInlineObjective, "--dry-run"], { io: allowedMarkdown.io, hooks }), 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: markdownInlineObjective, dryRun: true, timeout: 1800 });

    const allowed = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Ship a normal inline objective.", "--dry-run"], { io: allowed.io, hooks }), 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Ship a normal inline objective.", dryRun: true, timeout: 1800 });

    const blockedBuiltIn = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "api_key=abcdefghijklmnop", "--dry-run"], { io: blockedBuiltIn.io, hooks }), 1);
    assert.match(blockedBuiltIn.stderr.join("\n"), /Blocked sensitive content input/);
    assert.doesNotMatch(blockedBuiltIn.stderr.join("\n"), /abcdefghijklmnop|api_key/);
    assert.equal(seen.length, 0);

    writeFileSync(join(process.env["PA_PLATFORM_CONFIG"]!, "sensitive-patterns.yaml"), ["contents:", "  - 'FAKE_INLINE_OBJECTIVE_[0-9]+'", ""].join("\n"));

    const blockedLocal = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "contains FAKE_INLINE_OBJECTIVE_123 only", "--dry-run"], { io: blockedLocal.io, hooks }), 1);
    assert.match(blockedLocal.stderr.join("\n"), /Blocked sensitive content input/);
    assert.doesNotMatch(blockedLocal.stderr.join("\n"), /FAKE_INLINE_OBJECTIVE|123/);
    assert.equal(seen.length, 0);

    const sanitized = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Ship it; with $special & chars\\today", "--dry-run"], { io: sanitized.io, hooks }), 0);
    assert.match(sanitized.stderr.join("\n"), /sanitized objective: removed \d+ invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Ship it with special  charstoday", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 4 });

    const tooLong = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--objective", `${"a".repeat(10001)}api_key=abcdefghijklmnop`], { io: tooLong.io, hooks }), 1);
    assert.match(tooLong.stderr.join("\n"), /objective exceeds max length of 10000 characters/);
    assert.doesNotMatch(tooLong.stderr.join("\n"), /Blocked sensitive content input/);
  });
});

test("deploy sanitizes invalid characters from objective and shows stderr warning", async () => {
  await withCliEnv(async () => {
    const seen: unknown[] = [];
    const hooks = { deploy: (request: unknown) => { seen.push(request); return { status: "pending" as const, deploymentId: "d-sanitize" }; } };

    const withSemicolon = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Build feature; deploy now", "--dry-run"], { io: withSemicolon.io, hooks }), 0);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized objective: removed 1 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Build feature deploy now", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 1 });

    const withDollar = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Cost: $100 budget", "--dry-run"], { io: withDollar.io, hooks }), 0);
    assert.match(withDollar.stderr.join("\n"), /sanitized objective: removed 1 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Cost: 100 budget", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 1 });

    const withBackslash = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Path: \\usr\\local", "--dry-run"], { io: withBackslash.io, hooks }), 0);
    assert.match(withBackslash.stderr.join("\n"), /sanitized objective: removed 2 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Path: usrlocal", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 2 });

    const withAmpersand = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Build & test & deploy", "--dry-run"], { io: withAmpersand.io, hooks }), 0);
    assert.match(withAmpersand.stderr.join("\n"), /sanitized objective: removed 2 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Build  test  deploy", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 2 });

    const withControlChar = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Hello\x00World\x1f!", "--dry-run"], { io: withControlChar.io, hooks }), 0);
    assert.match(withControlChar.stderr.join("\n"), /sanitized objective: removed 2 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "HelloWorld!", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 2 });

    const withDel = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Delete\x7fme", "--dry-run"], { io: withDel.io, hooks }), 0);
    assert.match(withDel.stderr.join("\n"), /sanitized objective: removed 1 invalid character\(s\)/);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Deleteme", dryRun: true, timeout: 1800, sanitizedCharsRemoved: 1 });

    const cleanInput = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Clean input no special chars", "--dry-run"], { io: cleanInput.io, hooks }), 0);
    assert.equal(cleanInput.stderr.length, 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Clean input no special chars", dryRun: true, timeout: 1800 });

    const preservesTabNewlineCr = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "Line1\tindented\nLine2\r\nLine3", "--dry-run"], { io: preservesTabNewlineCr.io, hooks }), 0);
    assert.equal(preservesTabNewlineCr.stderr.length, 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", objective: "Line1\tindented\nLine2\r\nLine3", dryRun: true, timeout: 1800 });

    const mixedInvalidAndSensitive = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--objective", "api_key=abcdefghijklmnop;", "--dry-run"], { io: mixedInvalidAndSensitive.io, hooks }), 1);
    assert.match(mixedInvalidAndSensitive.stderr.join("\n"), /sanitized objective: removed 1 invalid character\(s\)/);
    assert.match(mixedInvalidAndSensitive.stderr.join("\n"), /Blocked sensitive content input/);
    assert.doesNotMatch(mixedInvalidAndSensitive.stderr.join("\n"), /abcdefghijklmnop|api_key/);
    assert.equal(seen.length, 0);
  });
});

test("runCoreCommand resolves deploy timeout from flag, PA_MAX_RUNTIME, then default", async () => {
  await withCliEnv(async () => {
    const seen: unknown[] = [];
    const hooks = { deploy: (request: unknown) => { seen.push(request); return { status: "pending" as const, deploymentId: "d-timeout" }; } };

    const defaultTimeout = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan"], { io: defaultTimeout.io, hooks }), 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", timeout: 1800 });

    process.env["PA_MAX_RUNTIME"] = "2400";
    const envTimeout = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan"], { io: envTimeout.io, hooks }), 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", timeout: 2400 });

    const flagTimeout = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan", "--timeout", "120"], { io: flagTimeout.io, hooks }), 0);
    assert.deepEqual(seen.pop(), { team: "builder", mode: "plan", timeout: 120 });
  });
});

test("runCoreCommand rejects invalid PA_MAX_RUNTIME before deployment hook", async () => {
  await withCliEnv(async () => {
    for (const value of ["abc", "59", "7201", "120.5"]) {
      process.env["PA_MAX_RUNTIME"] = value;
      let called = false;
      const captured = capture();
      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "plan"], {
        io: captured.io,
        hooks: { deploy: () => { called = true; return { status: "pending" as const, deploymentId: "d-invalid" }; } },
      }), 1);
      assert.equal(called, false);
      assert.match(captured.stderr.join("\n"), /PA_MAX_RUNTIME must be between 60 and 7200 seconds/);
    }
  });
});

test("runCoreCommand status wait polls until deployment reaches terminal status", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-wait-poll", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const captured = capture();
    let sleeps = 0;
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-wait-poll", "--wait"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
        appendRegistryEvent({ deployment_id: "d-wait-poll", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "partial", summary: "usable with warnings" });
      },
    });

    assert.equal(code, 0);
    assert.equal(sleeps, 1);
    assert.match(captured.stdout.join("\n"), /Waiting for deployment: d-wait-poll/);
    assert.match(captured.stdout.join("\n"), /Wait timeout: 120s/);
    assert.match(captured.stdout.join("\n"), /Poll interval: 10s/);
    assert.match(captured.stdout.join("\n"), /Override env: PA_STATUS_WAIT_TIMEOUT/);
    assert.match(captured.stdout.join("\n"), /partial - usable with warnings/);
  });
});

test("runCoreCommand status wait requires deployment id", async () => {
  await withCliEnv(async () => {
    const captured = capture();

    assert.equal(await runCoreCommand(["status", "--wait"], { io: captured.io }), 1);
    assert.match(captured.stderr.join("\n"), /status --wait requires deploy-id/);
    assert.deepEqual(captured.stdout, []);
  });
});

test("runCoreCommand status wait supports override timeout without mutating stored timeout", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-wait-override", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 1800 });
    process.env["PA_STATUS_WAIT_TIMEOUT"] = "60";
    const captured = capture();
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-wait-override", "--wait"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    assert.equal(code, 1);
    assert.match(captured.stdout.join("\n"), /Wait timeout: 60s/);
    assert.match(captured.stderr.join("\n"), /Timed out waiting for deployment d-wait-override after 60s/);

    const detail = capture();
    assert.equal(await runCoreCommand(["status", "d-wait-override"], { io: detail.io }), 0);
    assert.match(detail.stdout.join("\n"), /Timeout:\s+1800s/);
  });
});

test("runCoreCommand status wait rejects invalid override timeout", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-wait-invalid", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 1800 });
    for (const value of ["abc", "59", "7201", "120.5"]) {
      process.env["PA_STATUS_WAIT_TIMEOUT"] = value;
      const captured = capture();

      assert.equal(await runCoreCommand(["status", "d-wait-invalid", "--wait"], { io: captured.io }), 1);
      assert.match(captured.stderr.join("\n"), /PA_STATUS_WAIT_TIMEOUT must be between 60 and 7200 seconds/);
      assert.deepEqual(captured.stdout, []);
    }
  });
});

test("runCoreCommand status wait returns final-state exit codes", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-wait-success", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    appendRegistryEvent({ deployment_id: "d-wait-success", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "success", summary: "done" });
    appendRegistryEvent({ deployment_id: "d-wait-partial", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    appendRegistryEvent({ deployment_id: "d-wait-partial", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "partial", summary: "usable with warnings" });
    appendRegistryEvent({ deployment_id: "d-wait-failed", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    appendRegistryEvent({ deployment_id: "d-wait-failed", team: "builder", event: "completed", timestamp: "2026-04-26T00:00:10.000Z", status: "failed", summary: "verification failed" });
    appendRegistryEvent({ deployment_id: "d-wait-crashed", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    appendRegistryEvent({ deployment_id: "d-wait-crashed", team: "builder", event: "crashed", timestamp: "2026-04-26T00:00:10.000Z", error: "runtime exited" });

    const success = capture();
    assert.equal(await runCoreCommand(["status", "d-wait-success", "--wait"], { io: success.io }), 0);
    assert.match(success.stdout.join("\n"), /success - done/);

    const partial = capture();
    assert.equal(await runCoreCommand(["status", "d-wait-partial", "--wait"], { io: partial.io }), 0);
    assert.match(partial.stdout.join("\n"), /partial - usable with warnings/);

    const failed = capture();
    assert.equal(await runCoreCommand(["status", "d-wait-failed", "--wait"], { io: failed.io }), 1);
    assert.match(failed.stdout.join("\n"), /failed - verification failed/);

    const crashed = capture();
    assert.equal(await runCoreCommand(["status", "d-wait-crashed", "--wait"], { io: crashed.io }), 1);
    assert.match(crashed.stdout.join("\n"), /crashed - crashed/);
  });
});

test("runCoreCommand status wait reports not found without polling", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    let slept = false;

    assert.equal(await runCoreCommand(["status", "d-missing", "--wait"], {
      io: captured.io,
      sleep: async () => { slept = true; },
    }), 1);
    assert.equal(slept, false);
    assert.match(captured.stderr.join("\n"), /Deployment not found: d-missing/);
    assert.deepEqual(captured.stdout, []);
  });
});

test("status wait unblocks parent when child reaches permission-wait failed terminal status", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-child-perm-wait", team: "requirements", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120 });
    const captured = capture();
    let nowMs = 0;
    const code = await runCoreCommand(["status", "d-child-perm-wait", "--wait"], {
      io: captured.io,
      clock: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        appendRegistryEvent({
          deployment_id: "d-child-perm-wait",
          team: "requirements",
          event: "completed",
          timestamp: "2026-04-26T00:00:10.000Z",
          status: "failed",
          summary: "background permission wait exceeded 120s threshold",
          exit_code: 124,
        });
      },
    });

    assert.equal(code, 1);
    assert.match(captured.stdout.join("\n"), /Waiting for deployment: d-child-perm-wait/);
    assert.match(captured.stdout.join("\n"), /failed - background permission wait exceeded 120s threshold/);
  });
});

test("status wait writes crashed terminal event when deployment pid is stale", async () => {
  await withCliEnv(async () => {
    appendRegistryEvent({ deployment_id: "d-stale-pid", team: "builder", event: "started", timestamp: "2026-04-26T00:00:00.000Z", effective_timeout_seconds: 120, pid: 999999 });
    const captured = capture();

    const code = await runCoreCommand(["status", "d-stale-pid", "--wait"], { io: captured.io });

    assert.equal(code, 1);
    assert.match(captured.stdout.join("\n"), /crashed - crashed/);

    const events = getDeploymentEvents("d-stale-pid");
    const crashed = events.filter((event) => event.event === "crashed");
    assert.equal(crashed.length, 1);
    assert.match(crashed[0]?.error ?? "", /status wait detected stale pid 999999/);
  });
});

test("runCoreCommand owns serve status and stale PID cleanup without adapter hook", async () => {
  await withCliEnv(async () => {
    const stopped = capture();
    assert.equal(await runCoreCommand(["serve", "status"], { io: stopped.io }), 0);
    assert.match(stopped.stdout.join("\n"), /Status: stopped \(no PID file\)/);

    const pidFile = getServePidFilePath();
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, "999999:9848", "utf-8");

    const stale = capture();
    assert.equal(await runCoreCommand(["serve-status"], { io: stale.io }), 0);
    assert.match(stale.stdout.join("\n"), /Status: stopped \(stale PID 999999\)/);
    assert.equal(existsSync(pidFile), false);
  });
});

test("runCoreCommand serve uses old host and port defaults in PID semantics", async () => {
  await withCliEnv(async () => {
    const pidFile = getServePidFilePath();
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, "not-a-pid", "utf-8");

    const stopped = capture();
    assert.equal(await runCoreCommand(["stop"], { io: stopped.io }), 0);
    assert.match(stopped.stdout.join("\n"), /No PID file found/);

    writeFileSync(pidFile, "999999", "utf-8");
    const stale = capture();
    assert.equal(await runCoreCommand(["serve", "status"], { io: stale.io }), 0);
    assert.match(stale.stdout.join("\n"), /stale PID 999999/);
  });
});

test("runCoreCommand serve reports unknown port conflict without PID file", async () => {
  await withCliEnv(async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const port = address.port;
    try {
      const captured = capture();
      assert.equal(await runCoreCommand(["serve", "--port", String(port), "--host", "127.0.0.1"], { io: captured.io }), 1);
      assert.match(captured.stderr.join("\n"), new RegExp(`Port ${port} in use by unknown process`));
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
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

test("runCoreCommand honors NO_COLOR and tty settings for board colors", async () => {
  await withCliEnv(async () => {
    const store = new TicketStore();
    store.create({
      project: "pa-platform",
      title: "Colorized board entry",
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

    const originalNoColor = process.env["NO_COLOR"];
    const originalIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      delete process.env["NO_COLOR"];

      const withColor = capture();
      assert.equal(await runCoreCommand(["board", "--project", "pa-platform"], { io: withColor.io }), 0);
      assert.equal(/\[[0-9;]*m/.test(withColor.stdout.join("\n")), true);

      process.env["NO_COLOR"] = "1";
      const withoutColorFromNoColor = capture();
      assert.equal(await runCoreCommand(["board", "--project", "pa-platform"], { io: withoutColorFromNoColor.io }), 0);
      assert.equal(/\[[0-9;]*m/.test(withoutColorFromNoColor.stdout.join("\n")), false);

      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const withoutColorFromTty = capture();
      assert.equal(await runCoreCommand(["board", "--project", "pa-platform"], { io: withoutColorFromTty.io }), 0);
      assert.equal(/\[[0-9;]*m/.test(withoutColorFromTty.stdout.join("\n")), false);
    } finally {
      if (originalNoColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = originalNoColor;
      if (originalIsTtyDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", originalIsTtyDescriptor);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
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

test("runCoreCommand infers ticket project from CWD", async () => {
  await withCliEnv(async (root) => {
    const repo = join(root, "repo");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });

    const previousCwd = process.cwd();
    try {
      process.chdir(repo);

      const inferred = capture();
      assert.equal(await runCoreCommand(["ticket", "create", "--title", "CWD ticket", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "CWD inferred"], { io: inferred.io }), 0);
      assert.match(inferred.stdout.join("\n"), /Created PAP-001/);
      const inferredTicket = new TicketStore().get("PAP-001");
      assert.equal(inferredTicket?.project, "pa-platform");

      process.chdir(root);
      const explicit = capture();
      assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Explicit ticket", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Explicit override"], { io: explicit.io }), 0);
      assert.match(explicit.stdout.join("\n"), /Created PAP-002/);
      const explicitTicket = new TicketStore().get("PAP-002");
      assert.equal(explicitTicket?.project, "pa-platform");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("runCoreCommand errors on ticket create outside registered repo without project", async () => {
  await withCliEnv(async () => {
    const missingProject = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--title", "No project", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Missing project"], { io: missingProject.io }), 1);
    assert.match(missingProject.stderr.join("\n"), /Not in a registered repo\. Use --project name, or run this inside a registered repo where --project is optional\./);
    assert.match(missingProject.stderr.join("\n"), /Available projects: pa-platform/);
  });
});

test("ticket comment content-file uses guarded local text-file reader", async () => {
  await withCliEnv(async () => {
    const createTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Guarded comment", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: createTicket.io }), 0);

    const commentFile = join(process.env["PA_AI_USAGE_HOME"]!, "comment.md");
    writeFileSync(commentFile, "Normal file comment");
    const allowed = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", commentFile], { io: allowed.io }), 0);

    const blockedFile = join(process.env["PA_AI_USAGE_HOME"]!, ".env");
    const blocked = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", blockedFile], { io: blocked.io }), 1);
    assert.match(blocked.stderr.join("\n"), /Blocked sensitive filename input/);
    assert.doesNotMatch(blocked.stderr.join("\n"), /ENOENT|\.env/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments.length, 1);
    assert.equal(ticket?.comments[0]?.content, "Normal file comment");
  });
});

test("ticket comment content-file blocks local filename, path, and content matches without adding comments", async () => {
  await withCliEnv(async (root) => {
    writeFileSync(join(process.env["PA_PLATFORM_CONFIG"]!, "sensitive-patterns.yaml"), [
      "filenames:",
      "  - '^fake-private-comment\\.md$'",
      "paths:",
      "  - 'fake-private-comments'",
      "contents:",
      "  - 'FAKE_PRIVATE_COMMENT_[0-9]+'",
      "",
    ].join("\n"));
    const createTicket = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Guarded comment matrix", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: createTicket.io }), 0);

    const safeFile = join(root, "comment.md");
    writeFileSync(safeFile, "Allowed comment content");
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", safeFile], { io: capture().io }), 0);

    const cases = [
      { file: join(root, "fake-private-comment.md"), content: "COMMENT_FILENAME_CONTENT", error: /Blocked sensitive filename input/, hidden: /fake-private-comment|COMMENT_FILENAME_CONTENT/ },
      { file: join(root, "fake-private-comments", "comment.md"), content: "COMMENT_PATH_CONTENT", error: /Blocked sensitive path input/, hidden: /fake-private-comments|COMMENT_PATH_CONTENT/ },
      { file: join(root, "comment-sensitive.md"), content: "contains FAKE_PRIVATE_COMMENT_123 only", error: /Blocked sensitive content input/, hidden: /FAKE_PRIVATE_COMMENT|123/ },
    ];

    for (const scenario of cases) {
      mkdirSync(dirname(scenario.file), { recursive: true });
      writeFileSync(scenario.file, scenario.content);
      const captured = capture();

      assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", scenario.file], { io: captured.io }), 1);
      assertSanitizedBlockedError(captured.stderr, scenario.error, scenario.hidden);
    }

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments.length, 1);
    assert.equal(ticket?.comments[0]?.content, "Allowed comment content");
  });
});

test("sensitive guards do not expose bypass flags or override behavior", async () => {
  await withCliEnv(async (root) => {
    const deployHelp = capture();
    assert.equal(await runCoreCommand(["deploy", "--help"], { io: deployHelp.io }), 0);
    assert.doesNotMatch(deployHelp.stdout.join("\n"), /--force|--bypass|--allow|--override|confirm/i);

    const sensitiveFile = join(root, ".env");
    writeFileSync(sensitiveFile, "SAFE_FAKE_FIXTURE_CONTENT");
    const deployForce = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--objective-file", sensitiveFile, "--dry-run", "--force"], { io: deployForce.io }), 1);
    assert.match(deployForce.stderr.join("\n"), /Blocked sensitive filename input/);
    assert.doesNotMatch(deployForce.stderr.join("\n"), /SAFE_FAKE_FIXTURE_CONTENT/);

    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "No bypass", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);
    const commentForce = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", sensitiveFile, "--force"], { io: commentForce.io }), 1);
    assert.match(commentForce.stderr.join("\n"), /Unknown option: --force|Unsupported/);
    assert.equal(new TicketStore().get("PAP-001")?.comments.length, 0);
  });
});

test("ticket create sanitizes invalid characters from title and summary with stderr warning", async () => {
  await withCliEnv(async () => {
    const withSemicolon = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Fix; bug", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary; ok"], { io: withSemicolon.io }), 0);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized summary: removed 1 invalid character\(s\)/);
    assert.match(withSemicolon.stdout.join("\n"), /Created PAP-001/);
    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.title, "Fix bug");
    assert.equal(ticket?.summary, "Summary ok");

    const withDollar = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Cost: $100", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Budget $50"], { io: withDollar.io }), 0);
    assert.match(withDollar.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withDollar.stderr.join("\n"), /sanitized summary: removed 1 invalid character\(s\)/);
    const ticket2 = new TicketStore().get("PAP-002");
    assert.equal(ticket2?.title, "Cost: 100");
    assert.equal(ticket2?.summary, "Budget 50");

    const cleanInput = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Clean title", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Clean summary"], { io: cleanInput.io }), 0);
    assert.equal(cleanInput.stderr.length, 0);
    assert.match(cleanInput.stdout.join("\n"), /Created PAP-003/);
    const ticket3 = new TicketStore().get("PAP-003");
    assert.equal(ticket3?.title, "Clean title");
    assert.equal(ticket3?.summary, "Clean summary");

    const preservesTabNewlineCr = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Line1\tindented\nLine2\r\nLine3", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Tab\tnewline\ncr\r\n"], { io: preservesTabNewlineCr.io }), 0);
    assert.equal(preservesTabNewlineCr.stderr.length, 0);
    const ticket4 = new TicketStore().get("PAP-004");
    assert.equal(ticket4?.title, "Line1\tindented\nLine2\r\nLine3");
    assert.equal(ticket4?.summary, "Tab\tnewline\ncr\r\n");
  });
});

test("ticket create sanitizes invalid characters from description with stderr warning", async () => {
  await withCliEnv(async () => {
    const withSemicolon = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Fix bug", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary", "--description", "Desc; with ; semicolons"], { io: withSemicolon.io }), 0);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized description: removed 2 invalid character\(s\)/);
    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.description, "Desc with  semicolons");

    const withDollar = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Fix bug 2", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary", "--description", "Cost: $100"], { io: withDollar.io }), 0);
    assert.match(withDollar.stderr.join("\n"), /sanitized description: removed 1 invalid character\(s\)/);
    const ticket2 = new TicketStore().get("PAP-002");
    assert.equal(ticket2?.description, "Cost: 100");

    const cleanDesc = capture();
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Fix bug 3", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary", "--description", "Clean desc"], { io: cleanDesc.io }), 0);
    assert.equal(cleanDesc.stderr.length, 0);
    const ticket3 = new TicketStore().get("PAP-003");
    assert.equal(ticket3?.description, "Clean desc");
  });
});

test("ticket comment sanitizes invalid characters from content and content-file with stderr warning", async () => {
  await withCliEnv(async (root) => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Comment sanitize", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const withSemicolon = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content", "Working; done"], { io: withSemicolon.io }), 0);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized comment content: removed 1 invalid character\(s\)/);
    assert.match(withSemicolon.stdout.join("\n"), /Commented PAP-001/);
    let ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments[0]?.content, "Working done");

    const cleanContent = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content", "Clean comment"], { io: cleanContent.io }), 0);
    assert.equal(cleanContent.stderr.length, 0);
    ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments[1]?.content, "Clean comment");

    const commentFile = join(root, "comment-sanitize.md");
    writeFileSync(commentFile, "File; content & special");
    const withFile = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content-file", commentFile], { io: withFile.io }), 0);
    assert.match(withFile.stderr.join("\n"), /sanitized comment content: removed 2 invalid character\(s\)/);
    ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments[2]?.content, "File content  special");

    const preservesTabNewlineCr = capture();
    assert.equal(await runCoreCommand(["ticket", "comment", "PAP-001", "--author", "builder/team-manager", "--content", "Tab\tnewline\ncr\r\n"], { io: preservesTabNewlineCr.io }), 0);
    assert.equal(preservesTabNewlineCr.stderr.length, 0);
    ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.comments[3]?.content, "Tab\tnewline\ncr\r\n");
  });
});

test("ticket subticket create and update sanitize title and summary with stderr warning", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Sub sanitize parent", "--type", "task", "--priority", "high", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const subCreate = capture();
    assert.equal(await runCoreCommand(["ticket", "subticket", "create", "PAP-001", "--title", "Fix; bug", "--summary", "Desc; here"], { io: subCreate.io }), 0);
    assert.match(subCreate.stderr.join("\n"), /sanitized sub-ticket title: removed 1 invalid character\(s\)/);
    assert.match(subCreate.stderr.join("\n"), /sanitized sub-ticket summary: removed 1 invalid character\(s\)/);
    assert.match(subCreate.stdout.join("\n"), /PAP-001-ST-1/);

    const subUpdate = capture();
    assert.equal(await runCoreCommand(["ticket", "subticket", "update", "PAP-001", "PAP-001-ST-1", "--title", "New; title", "--summary", "New; summary"], { io: subUpdate.io }), 0);
    assert.match(subUpdate.stderr.join("\n"), /sanitized sub-ticket title: removed 1 invalid character\(s\)/);
    assert.match(subUpdate.stderr.join("\n"), /sanitized sub-ticket summary: removed 1 invalid character\(s\)/);
    assert.match(subUpdate.stdout.join("\n"), /Updated/);

    const cleanSubCreate = capture();
    assert.equal(await runCoreCommand(["ticket", "subticket", "create", "PAP-001", "--title", "Clean subtask", "--summary", "Clean summary"], { io: cleanSubCreate.io }), 0);
    assert.equal(cleanSubCreate.stderr.length, 0);
    assert.match(cleanSubCreate.stdout.join("\n"), /PAP-001-ST-2/);
  });
});

test("ticket update --title/--summary/--description happy path writes all three fields with exit 0", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Update target", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Original summary", "--description", "Original description"], { io: capture().io }), 0);

    const updateAll = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--title", "New Title", "--summary", "Updated summary", "--description", "Updated description"], { io: updateAll.io }), 0);
    assert.equal(updateAll.stderr.length, 0);
    assert.match(updateAll.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.title, "New Title");
    assert.equal(ticket?.summary, "Updated summary");
    assert.equal(ticket?.description, "Updated description");
  });
});

test("ticket update --title strips invalid characters and writes warning to stderr", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Sanitize target", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const stripped = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--title", "New; bad"], { io: stripped.io }), 0);
    assert.match(stripped.stderr.join("\n"), /sanitized ticket title: removed 1 invalid character\(s\)/);
    assert.match(stripped.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.title, "New bad");
  });
});

test("ticket update --title with clean input produces zero stderr output", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Clean target", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const clean = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--title", "Clean"], { io: clean.io }), 0);
    assert.equal(clean.stderr.length, 0);
    assert.match(clean.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.title, "Clean");
  });
});

test("ticket update --status without new flags continues to work without regression", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "No-regression target", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const statusOnly = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--status", "implementing"], { io: statusOnly.io }), 0);
    assert.equal(statusOnly.stderr.length, 0);
    assert.match(statusOnly.stdout.join("\n"), /Updated PAP-001/);
    assert.match(statusOnly.stdout.join("\n"), /implementing/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.status, "implementing");
  });
});

test("builder implement status updates are rejected before ticket and audit mutation", async () => {
  await withCliEnv(async () => {
    const previousTeam = process.env["PA_TEAM"];
    const previousMode = process.env["PA_MODE"];
    const previousDeploymentId = process.env["PA_DEPLOYMENT_ID"];
    process.env["PA_TEAM"] = "builder";
    process.env["PA_MODE"] = "implement";
    process.env["PA_DEPLOYMENT_ID"] = "d-builder-guard";
    appendRegistryEvent({ deployment_id: "d-builder-guard", team: "builder", mode: "implement", event: "started", timestamp: "2026-04-26T00:00:00Z" });
    try {
      assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Guard target", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Original summary"], { io: capture().io }), 0);
      const before = new TicketStore().get("PAP-001");
      const auditBefore = new TicketStore().readAudit().length;
      const rejected = capture();

      assert.notEqual(await runCoreCommand(["ticket", "update", "PAP-001", "--status", "review-uat", "--summary", "Must not apply"], { io: rejected.io }), 0);
      assert.match(rejected.stderr.join("\n"), /parent.*(flow|owns).*status/i);
      assert.deepEqual(new TicketStore().get("PAP-001"), before);
      assert.equal(new TicketStore().readAudit().length, auditBefore);
    } finally {
      if (previousTeam === undefined) delete process.env["PA_TEAM"];
      else process.env["PA_TEAM"] = previousTeam;
      if (previousMode === undefined) delete process.env["PA_MODE"];
      else process.env["PA_MODE"] = previousMode;
      if (previousDeploymentId === undefined) delete process.env["PA_DEPLOYMENT_ID"];
      else process.env["PA_DEPLOYMENT_ID"] = previousDeploymentId;
    }
  });
});

test("builder implement rejects every status value but allows non-status updates", async () => {
  await withCliEnv(async () => {
    const previousTeam = process.env["PA_TEAM"];
    const previousMode = process.env["PA_MODE"];
    const previousDeploymentId = process.env["PA_DEPLOYMENT_ID"];
    process.env["PA_TEAM"] = "builder";
    process.env["PA_MODE"] = "implement";
    process.env["PA_DEPLOYMENT_ID"] = "d-builder-statuses";
    appendRegistryEvent({ deployment_id: "d-builder-statuses", team: "builder", mode: "implement", event: "started", timestamp: "2026-04-26T00:00:00Z" });
    try {
      assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "All statuses", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Original"], { io: capture().io }), 0);
      for (const status of ["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat", "done", "rejected", "cancelled"]) {
        const rejected = capture();
        assert.notEqual(await runCoreCommand(["ticket", "update", "PAP-001", "--status", status], { io: rejected.io }), 0);
        assert.match(rejected.stderr.join("\n"), /parent flow/);
      }

      const allowed = capture();
      assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--summary", "Updated"], { io: allowed.io }), 0);
      assert.equal(new TicketStore().get("PAP-001")?.summary, "Updated");
    } finally {
      if (previousTeam === undefined) delete process.env["PA_TEAM"];
      else process.env["PA_TEAM"] = previousTeam;
      if (previousMode === undefined) delete process.env["PA_MODE"];
      else process.env["PA_MODE"] = previousMode;
      if (previousDeploymentId === undefined) delete process.env["PA_DEPLOYMENT_ID"];
      else process.env["PA_DEPLOYMENT_ID"] = previousDeploymentId;
    }
  });
});

test("ticket update --title sanitizes to empty keeps existing title and warns on stderr", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Empty guard title", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary"], { io: capture().io }), 0);

    const allStripped = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--title", ";;;"], { io: allStripped.io }), 0);
    assert.match(allStripped.stderr.join("\n"), /title update skipped: sanitization removed all 3 character\(s\); keeping existing title/);
    assert.match(allStripped.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.title, "Empty guard title");
  });
});

test("ticket update --summary sanitizes to empty keeps existing summary and warns on stderr", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Empty guard summary", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Keep me"], { io: capture().io }), 0);

    const allStripped = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--summary", "$$$"], { io: allStripped.io }), 0);
    assert.match(allStripped.stderr.join("\n"), /summary update skipped: sanitization removed all 3 character\(s\); keeping existing summary/);
    assert.match(allStripped.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.summary, "Keep me");
  });
});

test("ticket update --description sanitizes to empty keeps existing description and warns on stderr", async () => {
  await withCliEnv(async () => {
    assert.equal(await runCoreCommand(["ticket", "create", "--project", "pa-platform", "--title", "Empty guard desc", "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "builder/team-manager", "--summary", "Summary", "--description", "Original desc"], { io: capture().io }), 0);

    const allStripped = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "PAP-001", "--description", "&&&"], { io: allStripped.io }), 0);
    assert.match(allStripped.stderr.join("\n"), /description update skipped: sanitization removed all 3 character\(s\); keeping existing description/);
    assert.match(allStripped.stdout.join("\n"), /Updated PAP-001/);

    const ticket = new TicketStore().get("PAP-001");
    assert.equal(ticket?.description, "Original desc");
  });
});

test("ticket update --help shows usage and returns exit 0 without touching store", async () => {
  await withCliEnv(async () => {
    const help = capture();
    assert.equal(await runCoreCommand(["ticket", "update", "--help"], { io: help.io }), 0);
    assert.match(help.stdout.join("\n"), /Usage: ticket update <id> \[options\]/);
    assert.match(help.stdout.join("\n"), /--title <text>/);
    assert.match(help.stdout.join("\n"), /Examples:/);
    assert.equal(help.stderr.length, 0);
  });
});

test("bulletin create sanitizes invalid characters from title and message with stderr warning", async () => {
  await withCliEnv(async () => {
    const withSemicolon = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Stop; deploys", "--block", "all", "--message", "Wait; now"], { io: withSemicolon.io }), 0);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withSemicolon.stderr.join("\n"), /sanitized message: removed 1 invalid character\(s\)/);
    assert.match(withSemicolon.stdout.join("\n"), /Created B-001/);

    const withDollar = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "$Block", "--block", "all", "--message", "$Msg"], { io: withDollar.io }), 0);
    assert.match(withDollar.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withDollar.stderr.join("\n"), /sanitized message: removed 1 invalid character\(s\)/);
    assert.match(withDollar.stdout.join("\n"), /Created B-002/);

    const withBackslash = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Block\\now", "--block", "all", "--message", "Msg\\here"], { io: withBackslash.io }), 0);
    assert.match(withBackslash.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withBackslash.stderr.join("\n"), /sanitized message: removed 1 invalid character\(s\)/);
    assert.match(withBackslash.stdout.join("\n"), /Created B-003/);

    const withAmpersand = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Block&stop", "--block", "all", "--message", "Msg&end"], { io: withAmpersand.io }), 0);
    assert.match(withAmpersand.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withAmpersand.stderr.join("\n"), /sanitized message: removed 1 invalid character\(s\)/);
    assert.match(withAmpersand.stdout.join("\n"), /Created B-004/);

    const withControlChar = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Block\u0001\u0002", "--block", "all", "--message", "Msg\u0001\u0002"], { io: withControlChar.io }), 0);
    assert.match(withControlChar.stderr.join("\n"), /sanitized title: removed 2 invalid character\(s\)/);
    assert.match(withControlChar.stderr.join("\n"), /sanitized message: removed 2 invalid character\(s\)/);
    assert.match(withControlChar.stdout.join("\n"), /Created B-005/);

    const withDel = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Block\u007f", "--block", "all", "--message", "Msg\u007f"], { io: withDel.io }), 0);
    assert.match(withDel.stderr.join("\n"), /sanitized title: removed 1 invalid character\(s\)/);
    assert.match(withDel.stderr.join("\n"), /sanitized message: removed 1 invalid character\(s\)/);
    assert.match(withDel.stdout.join("\n"), /Created B-006/);

    const clean = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Clean title", "--block", "all", "--message", "Clean message"], { io: clean.io }), 0);
    assert.equal(clean.stderr.length, 0);
    assert.match(clean.stdout.join("\n"), /Created B-007/);

    const tabNewlineCr = capture();
    assert.equal(await runCoreCommand(["bulletin", "create", "--title", "Tab\tnewline\ncr\r", "--block", "all", "--message", "Tab\tnewline\ncr\r"], { io: tabNewlineCr.io }), 0);
    assert.equal(tabNewlineCr.stderr.length, 0);
    assert.match(tabNewlineCr.stdout.join("\n"), /Created B-008/);
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

// ---- Phase 3: serve.ts --dev flag parsing (FR1) ----
//
// `--dev` is accepted on start/restart and rejected on stop/status. The
// `PA_DEV_MODE` env var also activates dev mode (FR2). These tests exercise the
// parsing surface that does not bind a port: --help text and stop/status
// rejection. Full start-path propagation is covered by the agent-api layer
// dev mode tests (createAgentApiApp devMode → SessionManager).

test("runCoreCommand serve --help documents --dev flag for start action (FR1)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "--help"], { io: captured.io }), 0);
    assert.match(captured.stdout.join("\n"), /--dev/);
  });
});

test("runCoreCommand serve start --help documents --dev flag (FR1)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "start", "--help"], { io: captured.io }), 0);
    assert.match(captured.stdout.join("\n"), /--dev/);
  });
});

test("runCoreCommand serve restart --help documents --dev flag (FR1)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "restart", "--help"], { io: captured.io }), 0);
    assert.match(captured.stdout.join("\n"), /--dev/);
  });
});

test("runCoreCommand serve stop rejects --dev flag (FR1 — --dev only on start/restart)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "stop", "--dev"], { io: captured.io }), 1);
    assert.match(captured.stderr.join("\n"), /stop only supports --host and --port options/);
  });
});

test("runCoreCommand serve status rejects --dev flag (FR1 — --dev only on start/restart)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "status", "--dev"], { io: captured.io }), 1);
    assert.match(captured.stderr.join("\n"), /status only supports --host and --port options/);
  });
});

test("runCoreCommand serve stop rejects --cors, --force, --background alongside --dev (parser order independent)", async () => {
  await withCliEnv(async () => {
    const captured = capture();
    assert.equal(await runCoreCommand(["serve", "stop", "--cors"], { io: captured.io }), 1);
    assert.match(captured.stderr.join("\n"), /stop only supports --host and --port options/);
  });
});
