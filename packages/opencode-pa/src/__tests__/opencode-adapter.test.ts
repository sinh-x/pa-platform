import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, queryDeploymentStatuses, runCoreCommand } from "@pa-platform/pa-core";
import { OpencodeAdapter, resolveOpencodeModel } from "../adapter.js";
import { createOpencodeHooks } from "../deploy.js";

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

test("opa deploy supports pa deploy compatibility flags", async () => {
  await withOpaEnv(async (root) => {
    const objectiveFile = join(root, "objective.md");
    writeFileSync(objectiveFile, "Ship multi-line\nobjective");
    const adapter = new OpencodeAdapter({ runCommand: () => ({ status: 0, stdout: JSON.stringify({ sessionID: "sess-openai", type: "message", content: "ok" }) + "\n", stderr: "" }) });

    const modesOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--list-modes"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => modesOut.push(line), stderr: () => {} } }), 0);
    assert.match(modesOut.join("\n"), /plan/);

    const validateOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--validate"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => validateOut.push(line), stderr: () => {} } }), 0);
    assert.match(validateOut.join("\n"), /Valid team config: daily/);

    const deployOut: string[] = [];
    assert.equal(await runCoreCommand(["deploy", "daily", "--mode", "plan", "--objective-file", objectiveFile, "--provider", "openai", "--team-model", "gpt-5.5-fast", "--agent-model", "gpt-5.5-mini"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => deployOut.push(line), stderr: () => {} } }), 0);
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.provider, "openai");
    assert.equal(deployment.models?.["team"], "openai/gpt-5.5-fast");
    assert.equal(deployment.models?.["agents"], "gpt-5.5-mini");
    assert.match(readFileSync(join(root, "deployments", deployment.deploy_id, "primer.md"), "utf-8"), /Ship multi-line\nobjective/);
  });
});

test("opa foreground deploy records registry, activity, and session file", async () => {
  await withOpaEnv(async (root) => {
    let seenArgs: string[] = [];
    const adapter = new OpencodeAdapter({
      runCommand: (args) => {
        seenArgs = args;
        return { status: 0, stdout: JSON.stringify({ sessionID: "sess-123", type: "message", content: "done" }) + "\n", stderr: "" };
      },
    });
    const stdout: string[] = [];
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax", "--ticket", "PAP-002"], { hooks: createOpencodeHooks(adapter), io: { stdout: (line) => stdout.push(line), stderr: () => {} } });
    assert.equal(code, 0);
    assert.deepEqual(seenArgs.slice(0, 3), ["run", "-m", "minimax-coding-plan/MiniMax-M2.7"]);
    assert.ok(seenArgs.includes("--dangerously-skip-permissions"));
    const deployments = queryDeploymentStatuses();
    assert.equal(deployments.length, 1);
    assert.equal(deployments[0]?.runtime, "opencode");
    assert.equal(deployments[0]?.provider, "minimax");
    const deployId = deployments[0]!.deploy_id;
    assert.equal(readFileSync(join(root, "deployments", deployId, "session-id-opencode.txt"), "utf-8"), "sess-123");
    assert.match(readFileSync(join(root, "deployments", deployId, "activity.jsonl"), "utf-8"), /done/);
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
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "running");
    assert.equal(deployment.pid, 4242);
    assert.equal(readFileSync(join(root, "deployments", deployment.deploy_id, "session-id-opencode.txt"), "utf-8"), "sess-bg");
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
