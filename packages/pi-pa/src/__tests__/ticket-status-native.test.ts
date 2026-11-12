import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy, TicketStore, emitCompletedEvent } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { authenticatePiDocumentCaller } from "../document-session.js";
import { createTicketStatusTool } from "../pi-extension/ticket-status-tool.js";
import { runTicketStatusCommand } from "../ticket-status.js";

test("native-first and actual CLI subprocess-first share status owner, CAS, replay and genuine process identity", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "status-native-")); closeDb();
  const cli = resolve("packages/pi-pa/src/cli.ts");
  try {
    const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config");
    for (const path of [repo, usage, config]) mkdirSync(path);
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    process.chdir(repo);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "source-status-not-human" } };
    const id = "d-292101", directory = ensureDeployDir(id);
    const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("source fixture"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["ticket.status", "ordinary.bash"] }));
    emitStartedEvent({ deploymentId: id, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
    emitPidEvent({ deploymentId: id, team: "requirements", pid: process.pid }); assert.ok(recordPiProcessIdentity(id, directory, process.pid));
    Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    const store = new TicketStore(), create = () => store.create({ project: "example", title: "Status fixture", summary: "", description: "", type: "feature", priority: "medium", estimate: "M", status: "idea", assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] });
    const native = createTicketStatusTool(authenticatePiDocumentCaller(context).identitySha256);
    const call = async (request: unknown) => {
      const result = await native.execute("source", { request: JSON.stringify(request) }, undefined, undefined, context);
      return result;
    };
    const cliCall = (request: unknown) => spawnSync(process.execPath, [`--import=${import.meta.resolve("tsx")}`, cli, "ticket-status", "--request", JSON.stringify(request)], { cwd: repo, env: process.env, encoding: "utf8" });
    for (const first of ["native", "cli"] as const) {
      const ticket = create(), inspect = { schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: ticket.id };
      const read = await call(inspect); assert.notEqual(read.isError, true, read.content[0].text);
      const inspected = JSON.parse(read.content[0].text);
      for (const args of [["ticket", "update", ticket.id, "--status", "done"], ["ticket", "delete", ticket.id]]) {
        const legacy = spawnSync(process.execPath, [`--import=${import.meta.resolve("tsx")}`, cli, ...args], { cwd: repo, env: process.env, encoding: "utf8" });
        assert.equal(legacy.status, 1); assert.match(legacy.stderr, /TICKET_STATUS_ROUTE/);
        assert.ok(legacy.stderr.length <= 2000); assert.equal(store.get(ticket.id)!.status, "idea");
      }
      const request = { ...inspect, action: "set", requestId: `${first}-first`, expectedVersion: inspected.version, status: "requirement-review" };
      const result = first === "native" ? await call(request) : cliCall(request);
      if (first === "native") assert.notEqual((result as any).isError, true, JSON.stringify(result));
      else assert.equal((result as any).status, 0, (result as any).stderr);
      assert.equal(store.get(ticket.id)!.status, "requirement-review");
      const audit = store.readAudit(), replay = cliCall(request); assert.equal(replay.status, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).reusedIntent, true); assert.deepEqual(store.readAudit(), audit);
      const stale = await call({ ...request, requestId: `${first}-stale` }); assert.equal(stale.details.code, "TICKET_STATUS_STALE");
      const changed = await call({ ...request, status: "done" }); assert.equal(changed.details.code, "TICKET_STATUS_CONFLICT");
      const foreign = await call({ ...inspect, project: "other" }); assert.equal(foreign.details.code, "TICKET_STATUS_INPUT");
      const fake = await call({ ...request, actor: "sinh" }); assert.equal(fake.details.code, "TICKET_STATUS_INPUT");
      // Terminal registry label with a still-live PID is NOT owner release.
      const otherId = first === "native" ? "d-292102" : "d-292103";
      emitStartedEvent({ deploymentId: otherId, team: "builder", mode: "implement", ticketId: ticket.id, runtime: "pi", repo, repoRoot: repo, worktreeRoot: repo });
      emitPidEvent({ deploymentId: otherId, team: "builder", pid: process.pid });
      emitCompletedEvent({ deploymentId: otherId, team: "builder", status: "success" });
      assert.equal((await call({ ...request, requestId: `${first}-owner-conflict`, expectedVersion: JSON.parse((await call(inspect)).content[0].text).version })).details.code, "TICKET_STATUS_OWNER");
      // Keep each iteration's foreign owner on its own target.
    }
    const raceTicket = create();
    const inspectedRace = JSON.parse((await call({ schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: raceTicket.id })).content[0].text);
    const race = (status: string) => new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
      const child = spawn(process.execPath, [`--import=${import.meta.resolve("tsx")}`, cli, "ticket-status", "--request", JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "set", project: "example", ticket: raceTicket.id, requestId: `race-${status}`, expectedVersion: inspectedRace.version, status })], { cwd: repo, env: process.env });
      let out = "", err = ""; child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; });
      child.on("error", reject); child.on("close", code => done({ code, out, err }));
    });
    const contenders = await Promise.all([race("requirement-review"), race("cancelled")]);
    assert.equal(contenders.filter(r => r.code === 0).length, 1, JSON.stringify(contenders));
    assert.match(contenders.find(r => r.code !== 0)!.err, /TICKET_STATUS_STALE/);
    process.env.PA_TEAM = "rogue-one";
    const output: string[] = [];
    assert.equal(runTicketStatusCommand(["--request", JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: "EX-001" })], { stdout: s => output.push(s), stderr: s => output.push(s) }), 1);
    assert.match(output.join(""), /TICKET_STATUS_SESSION/);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
