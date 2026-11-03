import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRegistryEvent, closeDb, getDb, getDeploymentEvents, generatePrimer, queryDeploymentStatus, resolveExecutionPlan, runCoreCommand, type DeployRequest, type SpawnOpts } from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";
import { createPiHooks } from "../deploy.js";
import { mutatePiRepoSetup } from "../repo-setup-native.js";
import { recordPiReadonlyRoleProcessIdentity } from "../process-identity.js";
import { createPaRepoSetupTool, registerRepoSetupModule, repoSetupToolAllowed } from "../pi-extension/repo-setup.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";

function fixture(run: (f: { root: string; repo: string; dir: string; file: string; identity: string; candidate: string; request(value: unknown): Record<string, unknown> }) => void | Promise<void>, launch = true) {
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
      if (launch) {
        appendRegistryEvent({ deployment_id: "d-123abc", team: "repo-setup", mode: "setup", runtime: "pi", binary: "ppa", invocation_channel: "cli", event: "started", timestamp: new Date().toISOString(),
          pid: process.pid, repo, repo_root: repo, worktree_root: repo });
        recordPiReadonlyRoleProcessIdentity(process.env, "d-123abc", dir, process.pid);
      } else {
        for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_REPO", "PA_WORKTREE_ROOT", "PA_TICKET_ID"]) delete process.env[key];
        const teams = join(root, "teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
        writeFileSync(join(teams, "repo-setup.yaml"), JSON.stringify({ name: "repo-setup", description: "Isolated launch regression", objective: "Candidate-only setup", agents: [],
          default_mode: "setup", deploy_modes: [{ id: "setup", label: "Setup", require_ticket: false }] }));
      }
      writeFileSync(join(repo, "test.cjs"), "// prerequisite\n");
      const prerequisiteSha = createHash("sha256").update("// prerequisite\n").digest("hex");
      const candidate = JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo }, effects: ["project-read", "isolated-temp-write"], commands: [
        { id: "unit", executable: "/nix/store/nonexistent-fixture/bin/node", argv: ["test.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "test.cjs", sha256: prerequisiteSha }], timeoutSeconds: 60, maximumOutputBytes: 1024 },
      ] });
      await run({ root, repo, dir, file: join(repo, ".pa", "project-commands.json"), identity: join(dir, "pi-process-identity.json"), candidate,
        request: value => mutatePiRepoSetup({ request: JSON.stringify(value) }, { cwd: repo }) });
    } finally { closeDb(); process.chdir(cwd); process.env = old; rmSync(root, { recursive: true, force: true }); }
  })();
}
const code = (result: Record<string, unknown>) => (result.error as { code: string })?.code;
function denial(result: Record<string, unknown>, cause: string, stage: string) {
  assert.equal(result.ok, false); assert.equal(result.executionReady, false);
  const error = result.error as { cause: string; stage: string; diagnostic: string };
  assert.equal(error.cause, cause); assert.equal(error.stage, stage);
  assert.ok(error.diagnostic.length <= 2000);
  assert.equal(error.diagnostic.split("\n").length, 5);
  for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(error.diagnostic.includes(label));
  assert.doesNotMatch(JSON.stringify(result), /SECRET_SENTINEL|SQLITE_|ENOENT|EACCES/);
}

test("setup admission diagnostics distinguish context launch process root and overlap without leaking inputs or allowing writes", () => fixture(f => {
  const db = getDb(), id = "d-123abc";
  denial(mutatePiRepoSetup({ request: '{"action":"inspect"}' }, { cwd: "SECRET_SENTINEL" }), "context-invalid", "context");
  for (const table of ["deployments", "registry_events"]) {
    const original = db.prepare(`SELECT * FROM ${table} WHERE deployment_id = ?`).get(id) as Record<string, unknown>;
    for (const [field, value, cause, stage] of [
      ["invocation_channel", null, "launch-channel", "launch"], ["invocation_channel", "agent-api", "launch-channel", "launch"],
      ["invocation_channel", "SECRET_SENTINEL", "launch-channel", "launch"], ["team", "SECRET_SENTINEL", "launch-role", "launch"],
      ["mode", "other", "launch-role", "launch"], ["runtime", "opencode", "launch-role", "launch"], ["binary", "opa", "launch-role", "launch"],
      ...["ticket_id", "parent_deployment_id", "builder_authority", "repository_slot", "treehouse_path", "treehouse_lease_id", "treehouse_lease_holder", "branch_state", "branch_base_sha", "branch_head_sha", "ticket_slot_id", "repository_permit", "review_checkout", "ticket_worktree_selection", "resumed_from_deployment_id"].map(field => [field, "SECRET_SENTINEL", "launch-custody", "launch"]),
      ["rogue_one", 1, "launch-custody", "launch"], ["repo_root", f.root, "launch-root", "repository"],
      ...(table === "deployments" ? [["pid", process.pid + 1, "process-pid", "process"], ["status", "success", "launch-inactive", "launch"]] : []),
    ] as [string, string | number | null, string, string][]) {
      db.prepare(`UPDATE ${table} SET ${field} = ? WHERE deployment_id = ?`).run(value, id);
      for (const action of [{ action: "discover", path: "." }, { action: "stage", expected: null, candidate: f.candidate }]) denial(f.request(action), cause, stage);
      assert.equal(existsSync(f.file), false); assert.equal(existsSync(join(f.repo, ".pa")), false);
      db.prepare(`UPDATE ${table} SET ${field} = ? WHERE deployment_id = ?`).run(original[field] ?? null, id);
    }
  }
  const env = process.env.PA_TEAM; process.env.PA_TEAM = "SECRET_SENTINEL";
  denial(f.request({ action: "inspect" }), "context-mismatch", "context"); process.env.PA_TEAM = env;
  const anchor = readFileSync(f.identity); rmSync(f.identity);
  denial(f.request({ action: "stage", expected: null, candidate: f.candidate }), "process-unverified", "process"); writeFileSync(f.identity, anchor, { mode: 0o600 });
  const repo = process.env.PA_REPO; process.env.PA_REPO = f.root;
  denial(f.request({ action: "inspect" }), "repository-mismatch", "repository"); process.env.PA_REPO = repo;
  db.prepare("INSERT INTO registry_events (deployment_id, team, event, timestamp) VALUES (?, 'repo-setup', 'started', ?)").run(id, new Date().toISOString());
  denial(f.request({ action: "inspect" }), "launch-ambiguous", "launch");
  db.prepare("DELETE FROM registry_events WHERE deployment_id = ? AND event = 'started'").run(id);
  denial(f.request({ action: "inspect" }), "launch-missing", "launch"); assert.equal(existsSync(f.file), false);
}));

for (const scenario of ["missing", "unreadable", "unsafe", "over-limit", "unstable"] as const) test(`setup registry ${scenario} retains infrastructure cause and unchanged evidence without actor fallback`, () => fixture(f => {
  const path = process.env.PA_REGISTRY_DB!; closeDb();
  assert.equal(existsSync(`${path}-wal`), false);
  if (scenario === "missing") rmSync(path);
  if (scenario === "unreadable") writeFileSync(path, "SECRET_SENTINEL not sqlite");
  if (scenario === "unsafe") { const other = join(f.root, "SECRET_SENTINEL"); writeFileSync(other, readFileSync(path)); rmSync(path); symlinkSync(other, path); }
  if (scenario === "over-limit") truncateSync(path, 64 * 1024 * 1024 + 1);
  if (scenario === "unstable") writeFileSync(`${path}-journal`, "SECRET_SENTINEL");
  const before = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  for (const action of [{ action: "discover", path: "." }, { action: "stage", expected: null, candidate: f.candidate }]) {
    const result = f.request(action); denial(result, `registry-${scenario}`, "registry"); assert.equal(code(result), "SETUP_REGISTRY");
  }
  assert.equal(existsSync(f.file), false); assert.equal(existsSync(join(f.repo, ".pa")), false);
  assert.equal(existsSync(`${path}-wal`), false); assert.equal(existsSync(`${path}-shm`), false);
  assert.equal(existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null, before);
}));

test("setup registry changing during protected read reports instability without exposing raw filesystem errors", () => fixture(f => {
  const path = process.env.PA_REGISTRY_DB!; closeDb();
  const original = fs.readSync; let changed = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args) as number;
    if (!changed) { changed = true; truncateSync(path, 1); }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    denial(f.request({ action: "stage", expected: null, candidate: f.candidate }), "registry-unstable", "registry");
    assert.equal(changed, true); assert.equal(existsSync(f.file), false);
    assert.equal(existsSync(`${path}-wal`), false); assert.equal(existsSync(`${path}-shm`), false);
  } finally { fs.readSync = original; syncBuiltinESMExports(); }
}));

test("setup checkpoint at the unchanged 64 MiB boundary supports discovery without WAL allocation or history writes", () => fixture(f => {
  const path = process.env.PA_REGISTRY_DB!; closeDb(); truncateSync(path, 64 * 1024 * 1024);
  const before = createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(f.request({ action: "discover", path: "." }).ok, true);
  assert.equal(f.request({ action: "inspect" }).ok, true);
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), before);
  assert.equal(existsSync(`${path}-wal`), false); assert.equal(existsSync(`${path}-shm`), false); assert.equal(existsSync(f.file), false);
}));

for (const mode of [undefined, "setup"]) test(`normal ${mode ? "explicit" : "default"} setup launch preserves channel through real planner/start/adapter child and native discovery`, () => fixture(async f => {
  const output = join(f.root, "child-result.json");
  let launched: SpawnOpts | undefined, childPid: number | undefined;
  // Only terminal transport and external version/native probes are fixtures.
  // Planning, immutable event emission, PID/anchor recording, process boundary,
  // registered native tool and all setup authentication are production owners.
  const adapter = new class extends PiAdapter {
    override spawn(opts: SpawnOpts) { launched = opts; return super.spawn(opts); }
  }({ versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: {
    input: new Readable({ read() {} }) as NodeJS.ReadStream, output: { write: () => true } as NodeJS.WriteStream,
    spawnPty: (_file, _args, options) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/repo-setup-launch-child.ts", import.meta.url)), output], {
        cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      });
      childPid = child.pid;
      return { pid: child.pid!, process: "fixture", handleFlowControl: false,
        onData: callback => { child.stdout.on("data", chunk => callback(chunk.toString())); child.stderr.on("data", chunk => callback(chunk.toString())); return { dispose() {} }; },
        onExit: callback => { child.once("close", (exitCode, signal) => callback({ exitCode: exitCode ?? 1, signal: signal ? 1 : undefined })); return { dispose() {} }; },
        write: data => { child.stdin.write(data); }, kill: signal => { child.kill(signal as NodeJS.Signals); }, resize() {}, clear() {}, pause() {}, resume() {},
      } as ReturnType<NonNullable<import("../adapter.js").PiSupervisionOptions["spawnPty"]>>;
    },
  } });
  const stderr: string[] = [];
  const exit = await runCoreCommand(["deploy", "repo-setup", "--repo", "example", ...(mode ? ["--mode", mode] : []), "--timeout", "60"], {
    hooks: createPiHooks(adapter), io: { stdout() {}, stderr: line => stderr.push(line) },
  });
  assert.equal(exit, 0, stderr.join("\n"));
  const deploymentId = launched!.env.PA_DEPLOYMENT_ID!, plan = launched!.executionPlan!, events = getDeploymentEvents(deploymentId);
  const start = events.find(event => event.event === "started")!, projection = queryDeploymentStatus(deploymentId)!;
  assert.equal(plan.invocation_channel, "cli"); assert.equal(start.invocation_channel, "cli"); assert.equal(projection.invocation_channel, "cli");
  assert.equal(events.filter(event => event.event === "started").length, 1);
  assert.equal(projection.pid, childPid); assert.notEqual(childPid, process.pid);
  assert.equal(plan.repoRoot, f.repo); assert.equal(start.repo_root, f.repo); assert.equal(projection.repo_root, f.repo);
  assert.equal(plan.treehouse, undefined); assert.equal(plan.ticket, undefined); assert.equal(Boolean(start.rogue_one), false);
  const evidence = JSON.parse(readFileSync(output, "utf8")); assert.equal(evidence.pid, childPid); assert.equal(evidence.cwd, f.repo);
  for (const observation of evidence.results) { assert.equal(observation.ok, true); assert.equal(observation.executionReady, false); }
  const identity = JSON.parse(readFileSync(join(launched!.env.PA_DEPLOYMENT_DIR!, "pi-process-identity.json"), "utf8"));
  assert.equal(identity.processFingerprint.pid, childPid); assert.equal(existsSync(f.file), false);
}, false));

test("repo setup native tool authenticates actual registry/process and stages only an unapproved fixed-path catalogue", () => fixture(async f => {
  const tools: PiToolDefinition[] = []; registerRepoSetupModule({ registerTool: tool => tools.push(tool as PiToolDefinition) });
  assert.deepEqual(tools.map(tool => tool.name), ["pa_repo_setup"]); assert.ok(existsSync(f.identity));
  for (const request of [{ action: "discover", path: "." }, { action: "read", path: "test.cjs" }, { action: "search", path: "test.cjs", query: "prerequisite" }, { action: "observe", paths: ["test.cjs"] }]) {
    const observation = await tools[0]!.execute("fresh-discovery", { request: JSON.stringify(request) }, undefined, undefined, { cwd: f.repo });
    assert.equal(observation.isError, false, request.action); assert.equal(existsSync(f.file), false);
  }
  const result = await tools[0]!.execute("fixture", { request: JSON.stringify({ action: "stage", expected: null, candidate: f.candidate }) }, undefined, undefined, { cwd: f.repo });
  assert.equal(result.isError, false); const value = JSON.parse(result.content[0]!.text); assert.equal(value.state, "candidate-unapproved"); assert.equal(value.executionReady, false);
  assert.equal(readFileSync(f.file, "utf8"), f.candidate); assert.equal(f.request({ action: "inspect" }).ok, true);
}));

test("fresh Pi SDK setup session exposes native discovery without assuming builtin read/search registration", () => fixture(async f => {
  // Installed qualification explicitly resolves this dependency from the
  // verified adapter closure; the harness never borrows the source SDK.
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = join(f.root, "sdk-agent"); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: f.repo, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => registerRepoSetupModule(pi as unknown as PiRuntime)] });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: f.repo, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(f.repo), tools: ["pa_repo_setup"] });
  try {
    assert.deepEqual(extensionsResult.errors, []); assert.deepEqual(session.getActiveToolNames(), ["pa_repo_setup"]);
    const tool = session.agent.state.tools.find(tool => tool.name === "pa_repo_setup")!; assert.ok(tool);
    for (const request of [{ action: "inspect" }, { action: "discover", path: "." }, { action: "read", path: "test.cjs" }, { action: "search", path: "test.cjs", query: "prerequisite" }, { action: "observe", paths: ["test.cjs"] }]) {
      const result = await tool.execute("fresh-sdk", { request: JSON.stringify(request) });
      const value = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join(""));
      assert.equal(value.ok, true, request.action); assert.equal(value.executionReady, false);
      if (request.action === "inspect") { assert.equal(value.runtime.nodeVersion, process.versions.node); assert.equal(value.runtime.projectCompatibility, "unproven"); }
    }
    assert.equal(existsSync(f.file), false);
    const primer = generatePrimer({ runtime: "pi", teamConfig: { name: "repo-setup", description: "Fixture", objective: "Candidate-only setup", agents: [], deploy_modes: [{ id: "setup", label: "Setup", require_ticket: false }] }, mode: "setup" });
    assert.match(primer, /"action":"observe"/); assert.match(primer, /runtime itself/);
    assert.doesNotMatch(primer, /ppa registry complete|ppa registry update|Save session logs|ppa bulletin list/);
  } finally { session.dispose(); }
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
  for (const status of ["running", "dead", "unknown"]) {
    getDb().prepare("UPDATE deployments SET status = ? WHERE deployment_id = ?").run(status, "d-456abc");
    const result = f.request({ action: "stage", expected: null, candidate: f.candidate });
    assert.equal(code(result), "SETUP_BUSY"); denial(result, "overlap-active-or-uncertain", "overlap");
    assert.equal(existsSync(f.file), false);
  }
}));

test("repo setup route is ticketless Pi CLI primary-only and cannot become builder/OpenCode/API/background/override launch", () => fixture(f => {
  const teamConfig = { name: "repo-setup", description: "Fixture", objective: "Bounded setup", agents: [], default_mode: "setup", deploy_modes: [{ id: "setup", label: "Setup", require_ticket: false }] };
  const options = { request: { team: "repo-setup" } as DeployRequest, teamConfig, runtime: "pi" as const, deploymentId: "d-123abc", deploymentDir: f.dir, activityLogPath: join(f.dir, "activity.jsonl"), environment: {}, timeoutSeconds: 60, cwd: f.repo };
  const plan = resolveExecutionPlan(options); assert.equal(plan.ticketRequired, false); assert.equal(plan.repositoryAdmission.access, "non-locking");
  assert.equal(plan.treehouse, undefined); assert.equal(plan.ticket, undefined); assert.equal(plan.invocation_channel, "cli");
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
