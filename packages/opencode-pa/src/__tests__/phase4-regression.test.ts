import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDb, queryDeploymentStatuses, readActivityEvents, runCoreCommand } from "@pa-platform/pa-core";
import { buildPrimerLoadPrompt, OpencodeAdapter } from "../adapter.js";
import { createOpencodeHooks } from "../deploy.js";

// Phase 4 — Regression guard for opa deploy foreground/background unchanged.
// These tests assert that the session API additions (Phase 1-3) did NOT alter
// the existing opa deploy foreground (TUI) or background arg shapes, exit
// semantics, registry metadata, or session file behavior. They are a guard
// against accidental drift when the session API code path is present.

function withOpaEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opa-phase4-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\n`);
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n`);
  writeFileSync(join(teams, "daily.yaml"), `name: daily\ndescription: Daily\nobjective: Plan\nagents:\n  - name: team-manager\n    role: manage\ndeploy_modes:\n  - id: plan\n    label: Plan\n`);
  const previous = { config: process.env["PA_PLATFORM_CONFIG"], teams: process.env["PA_PLATFORM_TEAMS"], registry: process.env["PA_REGISTRY_DB"], aiUsage: process.env["PA_AI_USAGE_HOME"], maxRuntime: process.env["PA_MAX_RUNTIME"], ticketId: process.env["PA_TICKET_ID"] };
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_TICKET_ID"] = "PAP-TEST";
  delete process.env["PA_MAX_RUNTIME"];
  return fn(root).finally(() => {
    closeDb();
    restore("PA_PLATFORM_CONFIG", previous.config);
    restore("PA_PLATFORM_TEAMS", previous.teams);
    restore("PA_REGISTRY_DB", previous.registry);
    restore("PA_AI_USAGE_HOME", previous.aiUsage);
    restore("PA_MAX_RUNTIME", previous.maxRuntime);
    restore("PA_TICKET_ID", previous.ticketId);
    rmSync(root, { recursive: true, force: true });
  });
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("phase 4 regression: foreground opa deploy still uses TUI args (no run/--format/--dangerously-skip-permissions)", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    const argsPath = join(root, "opencode-args.json");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.OPA_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(process.env.PA_ACTIVITY_LOG, JSON.stringify({ ts: "2026-08-06T00:00:00.000Z", deploy_id: process.env.PA_DEPLOYMENT_ID, agent: "ses_fg", event: "message.updated", data: { message: { role: "assistant" }, text: "fg ok" } }) + "\\n");
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    const previousArgsPath = process.env["OPA_ARGS_PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    process.env["OPA_ARGS_PATH"] = argsPath;
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.equal(code, 0);
      const args = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
      assert.equal(args[0], "-m");
      assert.equal(args[1], "minimax-coding-plan/MiniMax-M2.7");
      assert.ok(!args.includes("run"), "foreground TUI must NOT include 'run'");
      assert.ok(!args.includes("--format"), "foreground TUI must NOT include --format");
      assert.ok(!args.includes("--dangerously-skip-permissions"), "foreground TUI must NOT include --dangerously-skip-permissions");
      assert.ok(args.includes("--prompt"));
      const promptIdx = args.indexOf("--prompt");
      const promptValue = args[promptIdx + 1];
      const deployId = queryDeploymentStatuses()[0]!.deploy_id;
      const primerPath = join(root, "deployments", deployId, "primer.md");
      assert.equal(promptValue, buildPrimerLoadPrompt(primerPath));
      const deployment = queryDeploymentStatuses()[0]!;
      assert.equal(deployment.runtime, "opencode");
      assert.equal(deployment.status, "success");
      assert.equal(existsSync(join(root, "deployments", deployId, "session-id-opencode.txt")), false);
      const activity = readActivityEvents(join(root, "deployments", deployId, "activity.jsonl"));
      assert.ok(activity.some((event) => event.kind === "text" && /fg ok/.test(event.body)));
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsPath === undefined) delete process.env["OPA_ARGS_PATH"];
      else process.env["OPA_ARGS_PATH"] = previousArgsPath;
    }
  });
});

test("phase 4 regression: background opa deploy still uses noninteractive run args with --dangerously-skip-permissions", async () => {
  await withOpaEnv(async (root) => {
    let seenArgs: string[] = [];
    const adapter = new OpencodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => {
        seenArgs = args;
        return { pid: 7373, sessionId: "sess-bg-phase4" };
      },
    });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--provider", "deepseek"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(code, 0);
    assert.deepEqual(seenArgs.slice(0, 4), ["run", "-m", "deepseek/deepseek-v4-pro", "--dangerously-skip-permissions"]);
    assert.ok(seenArgs.includes("--format"));
    assert.ok(seenArgs.includes("json"));
    assert.ok(!seenArgs.includes("--prompt"));
    assert.ok(!seenArgs.includes("--print-logs"));
    const deployment = queryDeploymentStatuses()[0]!;
    assert.equal(deployment.status, "running");
    assert.equal(deployment.pid, 7373);
    assert.equal(deployment.runtime, "opencode");
    assert.equal(readFileSync(join(root, "deployments", deployment.deploy_id, "session-id-opencode.txt"), "utf-8"), "sess-bg-phase4");
  });
});

test("phase 4 regression: foreground opa deploy with non-zero exit still records failed status and registry terminal marker", async () => {
  await withOpaEnv(async (root) => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
process.exit(7);
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    try {
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.notEqual(code, 0);
      const deployment = queryDeploymentStatuses()[0]!;
      assert.equal(deployment.status, "failed");
      assert.match(deployment.summary ?? "", /exit 7/);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });
});

test("phase 4 regression: --dangerously-skip-permissions absent in foreground, present in background/streaming (FR9 unchanged)", async () => {
  await withOpaEnv(async (root) => {
    // Background path: drives adapter with runBackgroundCommand override.
    let bgArgs: string[] = [];
    const bgAdapter = new OpencodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => { bgArgs = args; return { pid: 9001 }; },
    });
    const bgCode = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--provider", "openai"], { hooks: createOpencodeHooks(bgAdapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(bgCode, 0);
    assert.ok(bgArgs.includes("--dangerously-skip-permissions"), "background deploy MUST include --dangerously-skip-permissions (FR9)");
    assert.deepEqual(bgArgs.slice(0, 4), ["run", "-m", "openai/gpt-5.5", "--dangerously-skip-permissions"]);

    // Streaming (non-interactive run) path: call adapter.spawn directly with a
    // mode that is NOT "foreground" and NOT "background" so runOpencode dispatches
    // to runCommand (injected) instead of runInheritedCommand/spawnSync.
    let streamArgs: string[] = [];
    const streamAdapter = new OpencodeAdapter({
      runCommand: (args) => { streamArgs = args; return { status: 0, stdout: "", stderr: "" }; },
      runBackgroundCommand: () => { throw new Error("background should not run"); },
    });
    const primerPath = join(root, "deployments", "d-stream-phase4", "primer.md");
    mkdirSync(dirname(primerPath), { recursive: true });
    writeFileSync(primerPath, "# Primer\n\nStreaming regression fixture.\n");
    const streamResult = await streamAdapter.spawn({ primerPath, deployId: "d-stream-phase4", mode: "streaming", model: "openai/gpt-5.5", timeoutMs: 1000, env: {} });
    assert.equal(streamResult.exitCode, 0);
    assert.ok(streamArgs.includes("--dangerously-skip-permissions"), "streaming run deploy MUST include --dangerously-skip-permissions (FR9)");
    assert.ok(streamArgs.includes("run"));
    assert.ok(streamArgs.includes("--format"));
    assert.ok(streamArgs.includes("json"));
    assert.ok(!streamArgs.includes("--prompt"), "streaming path passes prompt positionally, not via --prompt");
  });
});

test("phase 4 regression: opa deploy wrapper prompt remains the short pointer, not the full primer body (foreground + background)", async () => {
  await withOpaEnv(async (root) => {
    let bgArgs: string[] = [];
    const bgAdapter = new OpencodeAdapter({
      runCommand: () => { throw new Error("foreground should not run"); },
      runBackgroundCommand: (args) => { bgArgs = args; return { pid: 8484 }; },
    });
    const bgCode = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--background", "--provider", "deepseek"], { hooks: createOpencodeHooks(bgAdapter), io: { stdout: () => {}, stderr: () => {} } });
    assert.equal(bgCode, 0);
    const bgDeployId = queryDeploymentStatuses()[0]!.deploy_id;
    const bgPrimerPath = join(root, "deployments", bgDeployId, "primer.md");
    const bgExpectedWrapper = buildPrimerLoadPrompt(bgPrimerPath);
    const bgLastArg = bgArgs.at(-1);
    assert.equal(bgLastArg, bgExpectedWrapper);
    const bgFullPrimer = readFileSync(bgPrimerPath, "utf-8");
    for (const arg of bgArgs) {
      assert.ok(!arg.includes(bgFullPrimer), "background args must not contain the full primer body");
    }

    const bin = join(root, "bin");
    const fgArgsPath = join(root, "opencode-args-fg.json");
    mkdirSync(bin, { recursive: true });
    const opencode = join(bin, "opencode");
    writeFileSync(opencode, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.OPA_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(process.env.PA_ACTIVITY_LOG, JSON.stringify({ ts: "2026-08-06T00:00:01.000Z", deploy_id: process.env.PA_DEPLOYMENT_ID, agent: "ses_fg2", event: "message.updated", data: { message: { role: "assistant" }, text: "fg ok 2" } }) + "\\n");
`, "utf-8");
    chmodSync(opencode, 0o755);
    const previousPath = process.env["PATH"];
    const previousArgsPath = process.env["OPA_ARGS_PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    process.env["OPA_ARGS_PATH"] = fgArgsPath;
    try {
      const fgCode = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--provider", "minimax"], { hooks: createOpencodeHooks(new OpencodeAdapter()), io: { stdout: () => {}, stderr: () => {} } });
      assert.equal(fgCode, 0);
      const fgArgs = JSON.parse(readFileSync(fgArgsPath, "utf-8")) as string[];
      const fgPromptIdx = fgArgs.indexOf("--prompt");
      assert.ok(fgPromptIdx >= 0);
      const fgPromptValue = fgArgs[fgPromptIdx + 1];
      const fgDeployId = queryDeploymentStatuses().find((d) => d.status === "success")!.deploy_id;
      const fgPrimerPath = join(root, "deployments", fgDeployId, "primer.md");
      assert.equal(fgPromptValue, buildPrimerLoadPrompt(fgPrimerPath));
      const fgFullPrimer = readFileSync(fgPrimerPath, "utf-8");
      for (const arg of fgArgs) {
        assert.ok(!arg.includes(fgFullPrimer), "foreground args must not contain the full primer body");
      }
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousArgsPath === undefined) delete process.env["OPA_ARGS_PATH"];
      else process.env["OPA_ARGS_PATH"] = previousArgsPath;
    }
  });
});

test("phase 4 regression: opa deploy --resume still fails fast when no session id recorded (foreground TUI not resumable)", async () => {
  await withOpaEnv(async () => {
    const stderr: string[] = [];
    const adapter = new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } });
    const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", "--resume", "d-nonexist", "--provider", "minimax"], { hooks: createOpencodeHooks(adapter), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.equal(code, 1);
    assert.match(stderr.join("\n"), /no opencode session id recorded/);
  });
});

test("phase 4 regression: opa deploy rejects removed TUI flags and mutually exclusive --background --dry-run (AC7 unchanged CLI surface)", async () => {
  await withOpaEnv(async () => {
    for (const removedFlag of ["--direct", "--interactive"]) {
      const stderr: string[] = [];
      const code = await runCoreCommand(["deploy", "daily", "--mode", "plan", removedFlag], { hooks: createOpencodeHooks(new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } })), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
      assert.equal(code, 1);
      assert.match(stderr.join("\n"), new RegExp(`${removedFlag} was removed`));
    }
    const stderr2: string[] = [];
    const code2 = await runCoreCommand(["deploy", "daily", "--background", "--dry-run"], { hooks: createOpencodeHooks(new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } })), io: { stdout: () => {}, stderr: (line) => stderr2.push(line) } });
    assert.equal(code2, 1);
    assert.match(stderr2.join("\n"), /mutually exclusive/);
  });
});

test("phase 4 regression: opa deploy still hard-fails when require_ticket mode lacks a ticket id (traceability invariant unchanged)", async () => {
  await withOpaEnv(async (root) => {
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
      "    require_ticket: true",
    ].join("\n"));
    delete process.env["PA_TICKET_ID"];
    const stderr: string[] = [];
    const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--dry-run"], { hooks: createOpencodeHooks(new OpencodeAdapter({ runCommand: () => { throw new Error("should not spawn"); } })), io: { stdout: () => {}, stderr: (line) => stderr.push(line) } });
    assert.equal(code, 1);
    assert.match(stderr.join("\n"), /Hard block: no resolvable ticket id/);
    assert.equal(queryDeploymentStatuses().length, 0);
  });
});