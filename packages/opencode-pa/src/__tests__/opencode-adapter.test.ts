import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDb, queryDeploymentStatuses, runCoreCommand, type ActivityEvent, type RuntimeAdapter, type SpawnResult } from "@pa-platform/pa-core";
import { createOpencodeActivityWriter, OpencodeAdapter, opencodeJsonToActivityEvent, resolveOpencodeModel } from "../adapter.js";
import { createOpencodeHooks } from "../deploy.js";

interface StubAdapterOpts {
  exitCode: number;
  errorMessage?: string;
  preSeedPluginLines?: number;
}

function createStubAdapter(opts: StubAdapterOpts): RuntimeAdapter {
  let activityLogPath = "";
  let deploymentId = "";
  return {
    name: "opencode",
    defaultModel: "stub/model",
    sessionFileName: "session-id-opencode.txt",
    installHooks(_targetDir, config) {
      activityLogPath = config.activityLogPath;
      deploymentId = config.deploymentId;
      if (opts.preSeedPluginLines && opts.preSeedPluginLines > 0) {
        mkdirSync(dirname(activityLogPath), { recursive: true });
        const lines: string[] = [];
        for (let i = 0; i < opts.preSeedPluginLines; i++) {
          lines.push(JSON.stringify({ ts: 1714000000000 + i, deploy_id: deploymentId, agent: "opencode", event: i === 0 ? "session_started" : "tool_call", data: { idx: i } }));
        }
        writeFileSync(activityLogPath, lines.join("\n") + "\n");
      }
    },
    spawn(spawnOpts): SpawnResult {
      return { sessionId: spawnOpts.deployId, exitCode: opts.exitCode, ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}) };
    },
    resume(spawnOpts): SpawnResult {
      return { sessionId: spawnOpts.sessionId, exitCode: opts.exitCode, ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}) };
    },
    extractActivity(): ActivityEvent[] {
      return [];
    },
    describeTools() {
      return { runtime: "opencode", markdown: "stub" };
    },
  };
}


function withOpaEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opa-adapter-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "daily.yaml"), `name: daily\ndescription: Daily\nobjective: Plan\nagents:\n  - name: team-manager\n    role: manage\ndeploy_modes:\n  - id: plan\n    label: Plan\n`);
  const previous = { config: process.env["PA_PLATFORM_CONFIG"], teams: process.env["PA_PLATFORM_TEAMS"], registry: process.env["PA_REGISTRY_DB"], aiUsage: process.env["PA_AI_USAGE_HOME"] };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    restore("PA_PLATFORM_CONFIG", previous.config);
    restore("PA_PLATFORM_TEAMS", previous.teams);
    restore("PA_REGISTRY_DB", previous.registry);
    restore("PA_AI_USAGE_HOME", previous.aiUsage);
    rmSync(root, { recursive: true, force: true });
  });
}

test("resolveOpencodeModel supports minimax and openai providers", () => {
  assert.equal(resolveOpencodeModel("minimax", undefined), "minimax-coding-plan/MiniMax-M2.7");
  assert.equal(resolveOpencodeModel("openai", undefined), "openai/gpt-5.5");
  assert.equal(resolveOpencodeModel("openai", "openai/gpt-5.5-fast"), "openai/gpt-5.5-fast");
  assert.equal(resolveOpencodeModel("minimax", "MiniMax-M2.7-highspeed"), "minimax-coding-plan/MiniMax-M2.7-highspeed");
});

test("opa dry-run generates primer and does not spawn opencode", async () => {
  await withOpaEnv(async (root) => {
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--dry-run", "--provider", "openai"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    assert.ok(existsSync(join(root, "deployments", deployId, "primer.md")));
    assert.match(readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8"), /Runtime: opencode/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});

test("opa planner daily modes resolve dynamic template variables", async () => {
  await withOpaEnv(async (root) => {
    writeFileSync(join(root, "teams", "planner.yaml"), `name: planner\ndescription: Planner\nobjective: Plan\nagents:\n  - name: team-manager\n    role: manage\ndeploy_modes:\n  - id: end\n    label: End\n    objective: teams/daily/modes/end.md\n`);
    mkdirSync(join(root, "teams", "daily", "modes"), { recursive: true });
    writeFileSync(join(root, "teams", "daily", "modes", "end.md"), "Write {{GATHER_REPORT}} and {{READY_MARKER}} under {{OUTPUT_DIR}}");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "planner", "--mode", "end", "--dry-run"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    const primer = readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8");
    assert.doesNotMatch(primer, /{{[A-Z_]+}}/);
    assert.match(primer, /agent-teams\/planner\/inbox\/\d{4}-\d{2}-\d{2}-end-gather\.md/);
  });
});

test("opa deploy includes repo memory docs in generated primer", async () => {
  await withOpaEnv(async (root) => {
    writeFileSync(join(root, "repo", "CLAUDE.md"), "# Repo Memory\nAlways follow repo-specific memory.\n");
    mkdirSync(join(root, "repo", ".claude"), { recursive: true });
    writeFileSync(join(root, "repo", ".claude", "CLAUDE.md"), "# Nested Memory\nUse nested Claude memory too.\n");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--dry-run", "--repo", "pa-platform"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    const primer = readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8");
    assert.match(primer, /## Memory Docs/);
    assert.match(primer, /Always follow repo-specific memory/);
    assert.match(primer, /Use nested Claude memory too/);
    assert.match(primer, /<memory-doc path=.*CLAUDE\.md">/);
  });
});

test("opa deploy supports pa deploy compatibility flags", async () => {
  await withOpaEnv(async (root) => {
    const objectiveFile = join(root, "objective.md");
    writeFileSync(objectiveFile, "Ship multi-line\nobjective");
    const adapter = new OpencodeAdapter({ runBackgroundCommand: () => ({ pid: 4242, sessionId: "sess-openai" }) });

    const modesOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--list-modes"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => modesOut.push(line), stderr: () => {} } }), 0);
    assert.match(modesOut.join("\n"), /plan/);

    const validateOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--validate"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => validateOut.push(line), stderr: () => {} } }), 0);
    assert.match(validateOut.join("\n"), /Valid team config: daily/);

    const deployOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--mode", "plan", "--objective-file", objectiveFile, "--provider", "openai", "--team-model", "gpt-5.5-fast", "--agent-model", "gpt-5.5-mini", "--background"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => deployOut.push(line), stderr: () => {} } }), 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.provider, "openai");
    assert.equal(deployment.models?.["team"], "openai/gpt-5.5-fast");
    assert.equal(deployment.models?.["agents"], "gpt-5.5-mini");
    assert.match(readFileSync(join(root, "deployments", deployment.deploy_id, "primer.md"), "utf-8"), /Ship multi-line\nobjective/);
  });
});

test("opa default deploy opens opencode TUI and records registry", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    const argsPath = join(root, "opencode-args.json");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.OPA_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    const previousArgsPath = process.env["OPA_ARGS_PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    process.env["OPA_ARGS_PATH"] = argsPath;
    const stdout: string[] = [];
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax", "--ticket", "PAP-002"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
      assert.equal(code, 0);
      assert.match(stdout.join("\n"), /Deployment completed: d-[a-f0-9]{6}/);
      const args = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
      assert.equal(args[0], "-m");
      assert.ok(!args.includes("run"));
      assert.ok(!args.includes("--format"));
      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.ok(args.includes("--prompt"));
      const deployments = queryDeploymentStatuses();
      assert.equal(deployments.length, 1);
      assert.equal(deployments[0]?.runtime, "opencode");
      assert.equal(deployments[0]?.provider, "minimax");
      const deployId = deployments[0]!.deploy_id;
      assert.equal(readFileSync(join(root, "deployments", deployId, "session-id-opencode.txt"), "utf-8"), deployId);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsPath === undefined) delete process.env["OPA_ARGS_PATH"];
      else process.env["OPA_ARGS_PATH"] = previousArgsPath;
    }
  });
});

test("opa direct mode opens opencode TUI with prompt", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    const argsPath = join(root, "opencode-args.json");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.OPA_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    const previousArgsPath = process.env["OPA_ARGS_PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    process.env["OPA_ARGS_PATH"] = argsPath;
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--direct"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.equal(code, 0);
      const args = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
      assert.equal(args[0], "-m");
      assert.ok(!args.includes("run"));
      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.ok(!args.includes("--format"));
      assert.ok(args.includes("--prompt"));
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsPath === undefined) delete process.env["OPA_ARGS_PATH"];
      else process.env["OPA_ARGS_PATH"] = previousArgsPath;
    }
  });
});

test("opa background deploy records running registry state and pid", async () => {
  await withOpaEnv(async (root) => {
    let seenArgs: string[] = [];
    const adapter = new OpencodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => {
        seenArgs = args;
        return { pid: 4242, sessionId: "sess-bg" };
      },
    });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    assert.ok(seenArgs.includes("--format"));
    assert.ok(seenArgs.includes("json"));
    assert.ok(!seenArgs.includes("--print-logs"));
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "running");
    assert.equal(deployment.pid, 4242);
    assert.equal(readFileSync(join(root, "deployments", deployment.deploy_id, "session-id-opencode.txt"), "utf-8"), "sess-bg");
  });
});

test("opencode JSONL maps to useful live activity events", () => {
  const event = opencodeJsonToActivityEvent({
    type: "tool_use",
    timestamp: 1777213840082,
    sessionID: "ses_235d0458fffehW7IAqiVTw5ZJn",
    part: { type: "tool", tool: "task", state: { status: "completed", input: { description: "Gather today's session logs" }, output: "done" } },
  }, "d-live");

  assert.equal(event.deployId, "d-live");
  assert.equal(event.timestamp, "2026-04-26T14:30:40.082Z");
  assert.equal(event.source, "ses_235d");
  assert.equal(event.kind, "tool_result");
  assert.match(event.body, /task completed Gather today's session logs/);
});

test("opencode activity writer appends split JSONL chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "opa-activity-"));
  try {
    const activityPath = join(root, "activity.jsonl");
    const writer = createOpencodeActivityWriter("d-live", activityPath);
    const line = JSON.stringify({ type: "text", timestamp: 1777213628268, sessionID: "ses_235d0458fffehW7IAqiVTw5ZJn", part: { type: "text", text: "hello" } });
    writer.write(line.slice(0, 20));
    writer.write(line.slice(20) + "\n");
    writer.flush();

    const rows = readFileSync(activityPath, "utf-8").trim().split("\n").map((row) => JSON.parse(row) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["kind"], "text");
    assert.equal(rows[0]?.["source"], "ses_235d");
    assert.equal(rows[0]?.["body"], "hello");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opa deploy preserves pre-existing live activity events", async () => {
  await withOpaEnv(async (root) => {
    const adapter = createStubAdapter({ exitCode: 0, preSeedPluginLines: 5 });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployId = queryDeploymentStatuses()[0]?.deploy_id;
    assert.ok(deployId);
    const activityPath = join(root, "deployments", deployId, "activity.jsonl");
    const raw = readFileSync(activityPath, "utf-8");
    const lines = raw.trim().split("\n");
    assert.ok(lines.length >= 6, `expected ≥ 6 lines, got ${lines.length}`);
    for (let i = 0; i < 5; i++) {
      assert.equal(lines[i], JSON.stringify({ ts: 1714000000000 + i, deploy_id: deployId, agent: "opencode", event: i === 0 ? "session_started" : "tool_call", data: { idx: i } }));
    }
    const terminal = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    assert.equal(terminal["kind"], "text");
    assert.match(String(terminal["body"]), /opencode exited with code 0/);
  });
});

test("opa deploy emits error event on non-zero exit", async () => {
  await withOpaEnv(async (root) => {
    const adapter = createStubAdapter({ exitCode: 1, errorMessage: "boom: model auth failed" });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.notEqual(code, 0);
    const deployId = queryDeploymentStatuses()[0]?.deploy_id;
    assert.ok(deployId);
    const activityPath = join(root, "deployments", deployId, "activity.jsonl");
    const lines = readFileSync(activityPath, "utf-8").trim().split("\n");
    const terminal = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    assert.equal(terminal["kind"], "error");
    assert.match(String(terminal["body"]), /opencode exited with code 1/);
    assert.match(String(terminal["body"]), /boom: model auth failed/);
  });
});

test("opa deploy registry summary includes exit code on failure", async () => {
  await withOpaEnv(async () => {
    const adapter = createStubAdapter({ exitCode: 1, errorMessage: "boom: model auth failed" });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.notEqual(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "failed");
    assert.match(deployment.summary ?? "", /exit 1/);
    assert.match(deployment.summary ?? "", /boom: model auth failed/);
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
