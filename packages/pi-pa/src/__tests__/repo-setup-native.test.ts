import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, closeDb, getDb, resolveExecutionPlan, type DeployRequest } from "@pa-platform/pa-core";
import { mutatePiRepoSetup } from "../repo-setup-native.js";
import { recordPiReadonlyRoleProcessIdentity } from "../process-identity.js";
import { createPaRepoSetupTool, registerRepoSetupModule, repoSetupToolAllowed } from "../pi-extension/repo-setup.js";
import type { PiToolDefinition } from "../pi-extension/index.js";

function fixture(run: (f: { root: string; repo: string; dir: string; file: string; identity: string; candidate: string; request(value: unknown): Record<string, unknown> }) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pap273-setup-native-")), old = process.env, cwd = process.cwd(); closeDb();
  process.env = { ...old };
  return (async () => {
    try {
      for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
      const repo = join(root, "repo"), config = join(root, "config"), ai = join(root, "ai"), dir = join(ai, "deployments", "d-123abc");
      mkdirSync(repo); mkdirSync(config); mkdirSync(dir, { recursive: true });
      Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: ai, PA_REGISTRY_DB: join(ai, "registry.db"), PA_DEPLOYMENT_ID: "d-123abc", PA_DEPLOYMENT_DIR: dir,
        PA_TEAM: "repo-setup", PA_MODE: "setup", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_TICKET_ID: "" });
      writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo } } }));
      execFileSync("git", ["init", "-q", "-b", "develop", repo]); process.chdir(repo);
      appendRegistryEvent({ deployment_id: "d-123abc", team: "repo-setup", mode: "setup", runtime: "pi", binary: "ppa", invocation_channel: "cli", event: "started", timestamp: new Date().toISOString(),
        pid: process.pid, repo, repo_root: repo, worktree_root: repo });
      recordPiReadonlyRoleProcessIdentity(process.env, "d-123abc", dir, process.pid);
      const candidate = JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo }, effects: ["project-read", "isolated-temp-write"], commands: [
        { id: "unit", executable: "/nix/store/nonexistent-fixture/bin/node", argv: ["test.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "test.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 60, maximumOutputBytes: 1024 },
      ] });
      await run({ root, repo, dir, file: join(repo, ".pa", "project-commands.json"), identity: join(dir, "pi-process-identity.json"), candidate,
        request: value => mutatePiRepoSetup({ request: JSON.stringify(value) }, { cwd: repo }) });
    } finally { closeDb(); process.chdir(cwd); process.env = old; rmSync(root, { recursive: true, force: true }); }
  })();
}
const code = (result: Record<string, unknown>) => (result.error as { code: string })?.code;

test("repo setup native tool authenticates actual registry/process and stages only an unapproved fixed-path catalogue", () => fixture(async f => {
  const tools: PiToolDefinition[] = []; registerRepoSetupModule({ registerTool: tool => tools.push(tool as PiToolDefinition) });
  assert.deepEqual(tools.map(tool => tool.name), ["pa_repo_setup"]); assert.ok(existsSync(f.identity));
  const result = await tools[0]!.execute("fixture", { request: JSON.stringify({ action: "stage", expected: null, candidate: f.candidate }) }, undefined, undefined, { cwd: f.repo });
  assert.equal(result.isError, false); const value = JSON.parse(result.content[0]!.text); assert.equal(value.state, "candidate-unapproved"); assert.equal(value.executionReady, false);
  assert.equal(readFileSync(f.file, "utf8"), f.candidate); assert.equal(f.request({ action: "inspect" }).ok, true);
}));

test("repo setup native host rejects environment-only role, changed registry bindings, child/custody/rogue identity and stale process", () => fixture(f => {
  const original = getDb().prepare("SELECT * FROM deployments WHERE deployment_id = ?").get("d-123abc") as Record<string, unknown>;
  for (const [field, value] of [["team", "rogue-one"], ["mode", "other"], ["runtime", "opencode"], ["binary", "opa"], ["invocation_channel", "agent-api"], ["pid", process.pid + 1], ["ticket_id", "EX-1"], ["parent_deployment_id", "d-456abc"], ["builder_authority", "orchestrator"], ["rogue_one", 1], ["status", "success"], ["repo_root", f.root]] as const) {
    getDb().prepare(`UPDATE deployments SET ${field} = ? WHERE deployment_id = ?`).run(value, "d-123abc");
    assert.equal(f.request({ action: "stage", expected: null, candidate: f.candidate }).ok, false, field);
    assert.equal(existsSync(f.file), false);
    getDb().prepare(`UPDATE deployments SET ${field} = ? WHERE deployment_id = ?`).run(original[field] ?? null, "d-123abc");
  }
  for (const [key, value] of [["PA_TEAM", "rogue-one"], ["PA_MODE", "other"], ["PA_TICKET_ID", "EX-1"], ["PA_DEPLOYMENT_DIR", f.root], ["PA_REPO", f.root], ["PA_ROGUE_ONE", "1"]] as const) {
    const before = process.env[key]; process.env[key] = value;
    assert.equal(f.request({ action: "inspect" }).ok, false, key); if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
  assert.equal(code(mutatePiRepoSetup({ request: '{"action":"inspect"}' }, { cwd: f.root })), "SETUP_ACTOR");
  chmodSync(f.identity, 0o644); assert.equal(code(f.request({ action: "inspect" })), "SETUP_ACTOR");
  chmodSync(f.identity, 0o600); const body = JSON.parse(readFileSync(f.identity, "utf8")); body.processFingerprint.startTimeTicks = "0";
  writeFileSync(f.identity, JSON.stringify(body)); assert.equal(code(f.request({ action: "inspect" })), "SETUP_ACTOR");
  rmSync(f.identity); assert.equal(code(f.request({ action: "inspect" })), "SETUP_ACTOR"); assert.equal(existsSync(f.file), false);
}));

test("repo setup native host refuses overlapping live/uncertain foreground deployment rather than forcing terminal state", () => fixture(f => {
  appendRegistryEvent({ deployment_id: "d-456abc", team: "rogue-one", mode: "rogue-one", runtime: "pi", binary: "ppa", event: "started", timestamp: new Date().toISOString(), pid: process.pid, repo: f.repo, repo_root: f.repo, worktree_root: f.repo });
  assert.equal(code(f.request({ action: "stage", expected: null, candidate: f.candidate })), "SETUP_BUSY");
  assert.equal(existsSync(f.file), false);
}));

test("repo setup route is ticketless Pi CLI primary-only and cannot become builder/OpenCode/API/background/override launch", () => fixture(f => {
  const teamConfig = { name: "repo-setup", description: "Fixture", objective: "Bounded setup", agents: [], default_mode: "setup", deploy_modes: [{ id: "setup", label: "Setup", require_ticket: false }] };
  const options = { request: { team: "repo-setup" } as DeployRequest, teamConfig, runtime: "pi" as const, deploymentId: "d-123abc", deploymentDir: f.dir, activityLogPath: join(f.dir, "activity.jsonl"), environment: {}, timeoutSeconds: 60, cwd: f.repo };
  const plan = resolveExecutionPlan(options); assert.equal(plan.ticketRequired, false); assert.equal(plan.repositoryAdmission.access, "non-locking");
  assert.equal(plan.treehouse, undefined); assert.equal(plan.ticket, undefined);
  for (const request of [{ ticket: "EX-1" }, { background: true }, { force: true }, { resume: "d-123abc" }, { objective: "Do arbitrary source work" }, { invocationChannel: "agent-api" as const }, { ticketWorktree: true }]) {
    assert.throws(() => resolveExecutionPlan({ ...options, request: { ...options.request, ...request } }), /repo-setup/);
  }
  assert.throws(() => resolveExecutionPlan({ ...options, runtime: "opencode" }), /repo-setup/);
}));

test("repo setup managed-agent guard denies shell/editor/approval/workflow/child/wrapper tools, including malformed framing", async () => {
  for (const name of ["bash", "write", "edit", "pa_workflow", "pa_decision", "pa_phase_report", "pa_prepare", "spawn", "multi_tool_use.parallel", "repo_setup_approve", "unknown"]) assert.equal(repoSetupToolAllowed({ name, input: {} }), false, name);
  for (const name of ["read", "grep", "glob", "find", "ls", "pa_repo_setup", "pa_template", "todo", "question"]) assert.equal(repoSetupToolAllowed({ toolName: name, input: {} }), true, name);
  assert.equal(repoSetupToolAllowed({ name: "pa_ticket", input: { action: "comment" } }), false); assert.equal(repoSetupToolAllowed({ name: "pa_ticket", input: { action: "read" } }), true);
  const result = await createPaRepoSetupTool().execute("fixture", { request: '{"action":"inspect"}', approved: true }, undefined, undefined, {});
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0]!.text).error.code, "SETUP_REQUEST");
  const controller = new AbortController(); controller.abort();
  const cancelled = await createPaRepoSetupTool().execute("fixture", { request: '{"action":"inspect"}' }, controller.signal, undefined, {}); assert.equal(cancelled.isError, true);
});
