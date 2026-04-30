import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { closeDb, createAgentApiApp, queryDeploymentStatuses, readActivityEvents, runCoreCommand, type ActivityEvent, type RuntimeAdapter, type SpawnResult } from "@pa-platform/pa-core";
import { createOpencodeActivityWriter, createOpencodeSessionIdParser, OpencodeAdapter, opencodeJsonToActivityEvent, resolveOpencodeModel } from "../adapter.js";
import { createDefaultOpencodeHooks, createOpencodeHooks } from "../deploy.js";
import { PA_SAFETY_ACTIVITY_PLUGIN_SOURCE, resolvePaSafetyActivityPluginPath } from "../plugins/pa-safety-activity.js";

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
  const previous = { config: process.env["PA_PLATFORM_CONFIG"], teams: process.env["PA_PLATFORM_TEAMS"], registry: process.env["PA_REGISTRY_DB"], aiUsage: process.env["PA_AI_USAGE_HOME"], maxRuntime: process.env["PA_MAX_RUNTIME"] };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_MAX_RUNTIME"];
  return fn(root).finally(() => {
    closeDb();
    restore("PA_PLATFORM_CONFIG", previous.config);
    restore("PA_PLATFORM_TEAMS", previous.teams);
    restore("PA_REGISTRY_DB", previous.registry);
    restore("PA_AI_USAGE_HOME", previous.aiUsage);
    restore("PA_MAX_RUNTIME", previous.maxRuntime);
    rmSync(root, { recursive: true, force: true });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeBuilderTeamConfig(root: string): void {
  writeFileSync(join(root, "teams", "builder.yaml"), [
    "name: builder",
    "description: Builder",
    "default_mode: implement",
    "objective: Build",
    "agents:",
    "  - name: builder-agent",
    "    role: Builds things",
    "deploy_modes:",
    "  - id: implement",
    "    label: Implement",
    "    mode_type: work",
    "    provider: openai",
    "    model: gpt-5.3-codex-spark",
    "  - id: routine",
    "    label: Routine",
    "    mode_type: work",
    "    provider: minimax",
    "    model: opus",
  ].join("\n"));
}

function readDryRunBody(root: string, stdout: string[]): string {
  const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
  assert.ok(deployId);
  const activity = readActivityEvents(join(root, "deployments", deployId, "activity.jsonl"));
  return activity.map((event) => event.body).join("\n");
}

test("resolveOpencodeModel supports minimax and openai providers", () => {
  assert.equal(resolveOpencodeModel("minimax", undefined), "minimax-coding-plan/MiniMax-M2.7");
  assert.equal(resolveOpencodeModel("openai", undefined), "openai/gpt-5.5");
  assert.equal(resolveOpencodeModel("openai", "openai/gpt-5.5-fast"), "openai/gpt-5.5-fast");
  assert.equal(resolveOpencodeModel("minimax", "MiniMax-M2.7-highspeed"), "minimax-coding-plan/MiniMax-M2.7-highspeed");
});

test("opa tool guidance keeps pa-core serve as server owner", () => {
  const guidance = new OpencodeAdapter().describeTools().markdown;
  assert.match(guidance, /Use `pa-core serve` for Agent API server lifecycle/);
  assert.match(guidance, /`opa` is the default deployment adapter, not the server owner/);
  assert.match(guidance, /Supported providers for `opa deploy`: `minimax` and `openai`/);
  assert.doesNotMatch(guidance, /opa serve/);
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

test("opa dry-run applies builder implement YAML provider and model", async () => {
  await withOpaEnv(async (root) => {
    writeBuilderTeamConfig(root);
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];

    const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--dry-run"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });

    assert.equal(code, 0);
    assert.match(readDryRunBody(root, stdout), /using openai\/gpt-5\.3-codex-spark/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});

test("opa dry-run defaults builder to implement mode YAML model", async () => {
  await withOpaEnv(async (root) => {
    writeBuilderTeamConfig(root);
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];

    const code = await runCoreCommand(["deploy", "builder", "--dry-run"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });

    assert.equal(code, 0);
    assert.match(readDryRunBody(root, stdout), /using openai\/gpt-5\.3-codex-spark/);
  });
});

test("opa dry-run CLI provider and team model override builder YAML defaults", async () => {
  await withOpaEnv(async (root) => {
    writeBuilderTeamConfig(root);
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];

    const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--provider", "minimax", "--team-model", "MiniMax-M2.7", "--dry-run"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });

    assert.equal(code, 0);
    const dryRunBody = readDryRunBody(root, stdout);
    assert.match(dryRunBody, /using minimax-coding-plan\/MiniMax-M2\.7/);
    assert.doesNotMatch(dryRunBody, /openai\/gpt-5\.3-codex-spark/);
  });
});

test("opa default hooks route agent API deploy requests through opencode adapter", async () => {
  await withOpaEnv(async () => {
    const { app } = createAgentApiApp({ hooks: createOpencodeHooks(createStubAdapter({ exitCode: 0 })) });
    const response = await app.request("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "daily", mode: "plan", background: true, provider: "openai", timeout: 120 }),
    });

    assert.equal(response.status, 202);
    const body = await response.json() as { team: string; mode: string | null; status: string; deploymentId?: string };
    assert.equal(body.team, "daily");
    assert.equal(body.mode, "plan");
    assert.equal(body.status, "pending");
    assert.match(body.deploymentId ?? "", /^d-[a-f0-9]{6}$/);
    assert.equal(queryDeploymentStatuses()[0]?.runtime, "opencode");
  });
});

test("opa exposes an explicit default hook boundary for core-owned serve", () => {
  const hooks = createDefaultOpencodeHooks();
  assert.equal(typeof hooks.deploy, "function");
  assert.equal(hooks.serve, undefined);
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

test("opa deploy preserves absolute repo path in deployment context", async () => {
  await withOpaEnv(async (root) => {
    const repo = join(root, "repo");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--dry-run", "--repo", repo], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    const primer = readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8");
    assert.match(primer, /<deployment-context>/);
    assert.match(primer, new RegExp(`repo_root: ${escapeRegExp(repo)}`));
    assert.doesNotMatch(primer, new RegExp(`${escapeRegExp(process.cwd())}.+${escapeRegExp(repo)}`));
  });
});

test("opa deploy expands tilde repo path in deployment context", async () => {
  await withOpaEnv(async (root) => {
    const repo = "~/opa-tilde-repo";
    const expandedRepo = join(homedir(), "opa-tilde-repo");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--dry-run", "--repo", repo], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    const deployId = stdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    const primer = readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8");
    assert.match(primer, /<deployment-context>/);
    assert.match(primer, new RegExp(`repo_root: ${escapeRegExp(expandedRepo)}`));
    assert.doesNotMatch(primer, new RegExp(`${escapeRegExp(process.cwd())}.+${escapeRegExp(repo)}`));
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

test("opa dry-run objective-file includes allowed content and blocks sensitive local content before primer generation", async () => {
  await withOpaEnv(async (root) => {
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const objectiveFile = join(root, "objective.md");
    writeFileSync(objectiveFile, "Ship allowed objective from dry-run file.");

    const allowedStdout: string[] = [];
    const allowedStderr: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--mode", "plan", "--objective-file", objectiveFile, "--dry-run"], {
      hooks: createOpencodeHooks(adapter),
      io: { stdout: (line) => allowedStdout.push(line), stderr: (line) => allowedStderr.push(line) },
    }), 0);
    assert.deepEqual(allowedStderr, []);
    const deployId = allowedStdout.join("\n").match(/d-[a-f0-9]{6}/)?.[0];
    assert.ok(deployId);
    assert.match(readFileSync(join(root, "deployments", deployId, "primer.md"), "utf-8"), /Ship allowed objective from dry-run file/);

    writeFileSync(join(root, "config", "sensitive-patterns.yaml"), ["contents:", "  - 'FAKE_DRY_RUN_PRIVATE_[0-9]+'", ""].join("\n"));
    writeFileSync(objectiveFile, "contains FAKE_DRY_RUN_PRIVATE_123 only");
    const blockedStdout: string[] = [];
    const blockedStderr: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--mode", "plan", "--objective-file", objectiveFile, "--dry-run"], {
      hooks: createOpencodeHooks(adapter),
      io: { stdout: (line) => blockedStdout.push(line), stderr: (line) => blockedStderr.push(line) },
    }), 1);
    assert.deepEqual(blockedStdout, []);
    assert.match(blockedStderr.join("\n"), /Blocked sensitive content input/);
    assert.doesNotMatch(blockedStderr.join("\n"), /FAKE_DRY_RUN_PRIVATE|123/);

    for (const file of [join(root, "deployments", deployId, "primer.md")]) {
      assert.doesNotMatch(readFileSync(file, "utf-8"), /FAKE_DRY_RUN_PRIVATE|123/);
    }
  });
});

test("opa default deploy opens opencode TUI with prompt", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    const argsPath = join(root, "opencode-args.json");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.OPA_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(process.env.PA_ACTIVITY_LOG, JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", deploy_id: process.env.PA_DEPLOYMENT_ID, agent: "ses_tui", event: "message.updated", data: { message: { role: "assistant" }, text: "default visible text" } }) + "\\n");
fs.appendFileSync(process.env.PA_ACTIVITY_LOG, JSON.stringify({ ts: "2026-04-26T00:00:01.000Z", deploy_id: process.env.PA_DEPLOYMENT_ID, agent: "ses_tui", event: "message.part.updated", data: { part: { type: "thinking", thinking: "default reasoning" } } }) + "\\n");
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
      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.ok(!args.includes("--format"));
      assert.ok(args.includes("--prompt"));
      const deployments = queryDeploymentStatuses();
      assert.equal(deployments.length, 1);
      assert.equal(deployments[0]?.runtime, "opencode");
      assert.equal(deployments[0]?.provider, "minimax");
      const deployId = deployments[0]!.deploy_id;
      assert.equal(existsSync(join(root, "deployments", deployId, "session-id-opencode.txt")), false);
      assert.equal(existsSync(join(root, "deployments", deployId, "opencode-output.jsonl")), false);
      const activity = readActivityEvents(join(root, "deployments", deployId, "activity.jsonl"));
      assert.ok(activity.some((event) => event.kind === "text" && /default visible text/.test(event.body)));
      assert.ok(activity.some((event) => event.kind === "thinking" && /default reasoning/.test(event.body)));
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsPath === undefined) delete process.env["OPA_ARGS_PATH"];
      else process.env["OPA_ARGS_PATH"] = previousArgsPath;
    }
  });
});

test("opa deploy rejects removed TUI flags", async () => {
  await withOpaEnv(async () => {
    for (const removedFlag of ["--direct", "--interactive"]) {
      const stderr: string[] = [];
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", removedFlag], { hooks: createOpencodeHooks(new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } })), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
      assert.equal(code, 1);
      assert.match(stderr.join("\n"), new RegExp(`${removedFlag} was removed`));
      assert.match(stderr.join("\n"), /Foreground TUI is now the default/);
    }
  });
});

test("opa deploy rejects mutually exclusive background and dry-run flags", async () => {
  await withOpaEnv(async () => {
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--background", "--dry-run"], { hooks: createOpencodeHooks(new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } })), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.equal(code, 1);
    assert.match(stderr.join("\n"), /mutually exclusive/);
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
    assert.equal(deployment.effective_timeout_seconds, 1800);
    assert.equal(readFileSync(join(root, "deployments", deployment.deploy_id, "session-id-opencode.txt"), "utf-8"), "sess-bg");
  });
});

test("opa foreground deploy records flag effective timeout metadata", async () => {
  await withOpaEnv(async () => {
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax", "--timeout", "1200"], { hooks: createOpencodeHooks(createStubAdapter({ exitCode: 0 })), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "success");
    assert.equal(deployment.effective_timeout_seconds, 1200);
    const statusOut: string[] = [];
    assert.equal(await runCoreCommand(["status", deployment.deploy_id], { io: { stdout: (line) => statusOut.push(line), stderr: () => {} } }), 0);
    assert.match(statusOut.join("\n"), /Timeout:\s+1200s/);
  });
});

test("opa deploy timeout flag takes precedence over PA_MAX_RUNTIME", async () => {
  await withOpaEnv(async () => {
    process.env["PA_MAX_RUNTIME"] = "2400";
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax", "--timeout", "1200"], { hooks: createOpencodeHooks(createStubAdapter({ exitCode: 0 })), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "success");
    assert.equal(deployment.effective_timeout_seconds, 1200);
  });
});

test("opa deploy rejects invalid PA_MAX_RUNTIME before spawning opencode", async () => {
  await withOpaEnv(async () => {
    for (const value of ["abc", "59", "7201", "120.5"]) {
      process.env["PA_MAX_RUNTIME"] = value;
      let spawned = false;
      const stderr: string[] = [];
      const adapter = new OpencodeAdapter({
        runCommand: () => { spawned = true; return { exitCode: 0 }; },
        runBackgroundCommand: () => { spawned = true; return { pid: 4242 }; },
      });

      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
      assert.equal(code, 1);
      assert.equal(spawned, false);
      assert.match(stderr.join("\n"), /PA_MAX_RUNTIME must be between 60 and 7200 seconds/);
      assert.equal(queryDeploymentStatuses().length, 0);
    }
  });
});

test("opa background deploy records PA_MAX_RUNTIME effective timeout metadata", async () => {
  await withOpaEnv(async () => {
    process.env["PA_MAX_RUNTIME"] = "2400";
    const adapter = new OpencodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: () => ({ pid: 4242 }),
    });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--provider", "openai"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "running");
    assert.equal(deployment.provider, "openai");
    assert.equal(deployment.effective_timeout_seconds, 2400);
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
  assert.equal(event.partType, "tool");
  assert.match(event.body, /task completed Gather today's session logs/);
});

test("opencode JSONL masks and truncates stream activity bodies", () => {
  const longSecretText = `Bearer abc123 ${"x".repeat(700)}`;
  const event = opencodeJsonToActivityEvent({
    type: "reasoning",
    timestamp: 1777213840082,
    part: { type: "reasoning", thinking: longSecretText },
  }, "d-live");

  assert.equal(event.kind, "thinking");
  assert.match(event.body, /\[REDACTED\]/);
  assert.equal(event.body.includes("abc123"), false);
  assert.ok(event.body.length <= 500);
});

test("opencode JSONL maps step and tool result stream events", () => {
  const stepStart = opencodeJsonToActivityEvent({ type: "step_start", message: "step 1" }, "d-live");
  const stepFinish = opencodeJsonToActivityEvent({ type: "step_finish", message: "done" }, "d-live");
  const failedTool = opencodeJsonToActivityEvent({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "failed", input: { command: "exit 1" } } } }, "d-live");

  assert.equal(stepStart.kind, "text");
  assert.equal(stepStart.body, "step 1");
  assert.equal(stepFinish.kind, "text");
  assert.equal(stepFinish.body, "done");
  assert.equal(failedTool.kind, "error");
  assert.match(failedTool.body, /bash failed exit 1/);
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
    assert.equal(rows[0]?.["partType"], "text");
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

test("opa foreground captures real opencode stderr on non-zero exit", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/bin/sh
echo "model auth failed: token expired" >&2
echo "context: refresh failed" >&2
exit 7
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    const previousStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "openai"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.notEqual(code, 0);
      const deployment = queryDeploymentStatuses()[0]!;
      assert.equal(deployment.status, "failed");
      assert.match(deployment.summary ?? "", /exit 7/);
      assert.match(deployment.summary ?? "", /model auth failed: token expired/);
      const activity = readFileSync(join(root, "deployments", deployment.deploy_id, "activity.jsonl"), "utf-8").trim().split("\n");
      const errorLine = activity.map((row) => JSON.parse(row) as Record<string, unknown>).find((row) => row["kind"] === "error");
      assert.ok(errorLine, "expected an error-kind activity event");
      assert.match(String(errorLine["body"]), /model auth failed: token expired/);
      assert.equal(existsSync(join(root, "deployments", deployment.deploy_id, "session-id-opencode.txt")), false);
    } finally {
      process.stderr.write = previousStderrWrite;
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });
});

test("opa deploy --resume fails fast when no session id was recorded", async () => {
  await withOpaEnv(async (root) => {
    // Pretend a previous foreground deploy ran but never produced a session file.
    const priorId = "d-foregr";
    const priorDir = join(root, "deployments", priorId);
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "primer.md"), "stub primer");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--resume", priorId], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.notEqual(code, 0);
    assert.match(stderr.join("\n"), /no opencode session id recorded/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});

test("opa deploy --resume fails clearly on claude session files without registering", async () => {
  await withOpaEnv(async (root) => {
    const priorId = "d-claude";
    const priorDir = join(root, "deployments", priorId);
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "session-id-claude.txt"), "claude-session-token");
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--resume", priorId], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.notEqual(code, 0);
    assert.match(stderr.join("\n"), /was launched by claude/);
    assert.match(stderr.join("\n"), /cpa deploy --resume d-claude/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});

test("opencode installHooks installs repo-managed activity plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "opa-plugin-"));
  try {
    const env = { HOME: root } as NodeJS.ProcessEnv;
    const adapter = new OpencodeAdapter({ env, runCommand: () => { throw new Error("should not spawn"); } });
    const activityLogPath = join(root, "deployments", "d-plugin", "activity.jsonl");

    adapter.installHooks(join(root, "deployments", "d-plugin"), { deploymentId: "d-plugin", deploymentDir: join(root, "deployments", "d-plugin"), activityLogPath, env: { PA_DEPLOYMENT_ID: "d-plugin", PA_ACTIVITY_LOG: activityLogPath } });

    const pluginPath = resolvePaSafetyActivityPluginPath(env);
    assert.equal(readFileSync(pluginPath, "utf-8"), PA_SAFETY_ACTIVITY_PLUGIN_SOURCE);
    assert.match(readFileSync(pluginPath, "utf-8"), /PA_DEPLOYMENT_ID/);
    assert.match(readFileSync(pluginPath, "utf-8"), /PA_ACTIVITY_LOG/);
    assert.match(readFileSync(pluginPath, "utf-8"), /message\.part\.updated/);
    for (const eventName of [
      "message.part.updated",
      "message.updated",
      "message.part.removed",
      "message.removed",
      "tool.execute.before",
      "tool.execute.after",
      "session.created",
      "session.updated",
      "session.status",
      "session.idle",
      "session.compacted",
      "session.diff",
      "session.deleted",
      "session.error",
      "permission.asked",
      "permission.replied",
      "todo.updated",
      "command.executed",
      "file.edited",
      "file.watcher.updated",
      "lsp.client.diagnostics",
      "lsp.updated",
      "installation.updated",
      "server.connected",
      "tui.prompt.append",
      "tui.command.execute",
      "tui.toast.show",
    ]) {
      assert.match(readFileSync(pluginPath, "utf-8"), new RegExp(eventName.replaceAll(".", "\\.")), eventName);
    }
    assert.match(readFileSync(pluginPath, "utf-8"), /dedupeKey/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode installHooks refreshes stale activity plugin content", () => {
  const root = mkdtempSync(join(tmpdir(), "opa-plugin-stale-"));
  try {
    const env = { XDG_CONFIG_HOME: join(root, "xdg") } as NodeJS.ProcessEnv;
    const pluginPath = resolvePaSafetyActivityPluginPath(env);
    mkdirSync(dirname(pluginPath), { recursive: true });
    writeFileSync(pluginPath, "// stale plugin\n", "utf-8");

    const adapter = new OpencodeAdapter({ env, runCommand: () => { throw new Error("should not spawn"); } });
    const activityLogPath = join(root, "deployments", "d-refresh", "activity.jsonl");
    adapter.installHooks(join(root, "deployments", "d-refresh"), { deploymentId: "d-refresh", deploymentDir: join(root, "deployments", "d-refresh"), activityLogPath, env: { PA_DEPLOYMENT_ID: "d-refresh", PA_ACTIVITY_LOG: activityLogPath } });

    assert.equal(readFileSync(pluginPath, "utf-8"), PA_SAFETY_ACTIVITY_PLUGIN_SOURCE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pa safety activity plugin does not enforce guards outside PA deployments", async () => {
  const root = mkdtempSync(join(tmpdir(), "opa-plugin-non-pa-"));
  const originalActivityLog = process.env.PA_ACTIVITY_LOG;
  const originalDeploymentDir = process.env.PA_DEPLOYMENT_DIR;
  try {
    delete process.env.PA_ACTIVITY_LOG;
    delete process.env.PA_DEPLOYMENT_DIR;
    const pluginPath = join(root, "pa-safety-activity.mjs");
    writeFileSync(pluginPath, PA_SAFETY_ACTIVITY_PLUGIN_SOURCE, "utf-8");
    const module = await import(pathToFileURL(pluginPath).href);
    const plugin = await module.PaSafetyActivityPlugin();

    await plugin["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm .env" } });
    await plugin["tool.execute.before"]({ tool: "read" }, { args: { filePath: ".env" } });
  } finally {
    restore("PA_ACTIVITY_LOG", originalActivityLog);
    restore("PA_DEPLOYMENT_DIR", originalDeploymentDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("pa safety activity plugin masks bash activity without mutating execution args", async () => {
  const root = mkdtempSync(join(tmpdir(), "opa-plugin-mask-"));
  const originalActivityLog = process.env.PA_ACTIVITY_LOG;
  const originalDeploymentDir = process.env.PA_DEPLOYMENT_DIR;
  const originalDeploymentId = process.env.PA_DEPLOYMENT_ID;
  const originalHome = process.env.HOME;
  try {
    const hooksDir = join(root, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "sensitive-patterns.conf"), "API_KEY|sk-[A-Za-z0-9]+\n", "utf-8");
    process.env.HOME = root;
    process.env.PA_DEPLOYMENT_ID = "d-mask";
    process.env.PA_DEPLOYMENT_DIR = join(root, "deployments", "d-mask");
    process.env.PA_ACTIVITY_LOG = join(process.env.PA_DEPLOYMENT_DIR, "activity.jsonl");

    const pluginPath = join(root, "pa-safety-activity.mjs");
    writeFileSync(pluginPath, PA_SAFETY_ACTIVITY_PLUGIN_SOURCE, "utf-8");
    const module = await import(pathToFileURL(pluginPath).href);
    const plugin = await module.PaSafetyActivityPlugin();
    const args = { command: "printf sk-secret123" };

    await plugin["tool.execute.before"]({ tool: "bash", sessionID: "ses-mask" }, { args });

    assert.equal(args.command, "printf sk-secret123");
    const activity = readFileSync(process.env.PA_ACTIVITY_LOG, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { event?: string; data?: { args?: { command?: string }; summary?: string } });
    const before = activity.find((row) => row.event === "tool.execute.before");
    assert.equal(before?.data?.args?.command, "printf ***API_KEY_MASKED***");
    assert.equal(before?.data?.summary, "printf ***API_KEY_MASKED***");
  } finally {
    restore("PA_ACTIVITY_LOG", originalActivityLog);
    restore("PA_DEPLOYMENT_DIR", originalDeploymentDir);
    restore("PA_DEPLOYMENT_ID", originalDeploymentId);
    restore("HOME", originalHome);
    rmSync(root, { recursive: true, force: true });
  }
});

test("createOpencodeSessionIdParser handles chunks split mid-line", () => {
  const line = JSON.stringify({ type: "session", sessionID: "ses_chunkstraddle_real_token" });
  const parser = createOpencodeSessionIdParser();
  parser.write(line.slice(0, 18));
  parser.write(line.slice(18) + "\n");
  assert.equal(parser.flush(), "ses_chunkstraddle_real_token");
});

test("createOpencodeSessionIdParser ignores partial sessionID matches across chunks", () => {
  // Old per-chunk regex would match the partial 'sessionID":"ses_par' and capture
  // 'ses_par' as the session id. The line-buffered parser waits for newline before
  // inspecting, so the full token wins.
  const parser = createOpencodeSessionIdParser();
  parser.write('{"sessionID":"ses_par');
  parser.write('tial_complete"}\n');
  assert.equal(parser.flush(), "ses_partial_complete");
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
