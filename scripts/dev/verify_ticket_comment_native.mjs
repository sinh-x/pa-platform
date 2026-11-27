#!/usr/bin/env node
// Explicit built/installed module qualification. No source fallback, production
// ticket writes, installation, native approval or human-UAT claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 3) throw Error("Usage: node scripts/dev/verify_ticket_comment_native.mjs <exact-runtime-root>");
const runtimeRoot = realpathSync(process.argv[2]);
const load = path => import(pathToFileURL(join(runtimeRoot, "packages", path)).href);
const core = await load("pa-core/dist/index.js");
const identity = await load("pi-pa/dist/process-identity.js");
const { createPaTicketTool } = await load("pi-pa/dist/pi-extension/ticket-tool.js");
const environment = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap345-built-native-"));
const cases = [];
try {
  core.closeDb();
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
  const repo = join(root, "repo"), config = join(root, "config"), teams = join(root, "teams");
  for (const directory of [repo, config, teams]) mkdirSync(directory);
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(config, "config.yaml"), `repos:\n fixture:\n  path: ${repo}\n  prefix: FIX\n`);
  writeFileSync(join(teams, "coordinator.yaml"), "name: coordinator\nagents:\n - name: native-agent\n   role: Fixture\n");
  Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: teams, PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
  process.chdir(repo);
  const deploymentId = "d-345100", directory = core.ensureDeployDir(deploymentId);
  core.emitStartedEvent({ deploymentId, team: "coordinator", mode: "coordinate", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo });
  core.emitPidEvent({ deploymentId, team: "coordinator", pid: process.pid });
  Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "coordinator", PA_MODE: "coordinate", PA_REPO: repo, PA_REPO_ROOT: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
  identity.recordPiReadonlyRoleProcessIdentity(process.env, deploymentId, directory, process.pid);
  const context = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => "pap345-built-session", getCwd: () => repo } };
  const tool = createPaTicketTool();
  const store = new core.TicketStore(undefined, core.resolveTrustedTicketMutationContext({ deploymentId }, false));
  const invoke = request => tool.execute("built-native", request, undefined, undefined, context);
  const success = async request => {
    const reply = await invoke(request); assert.notEqual(reply.isError, true, reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  const snapshot = () => readdirSync(core.getTicketsDir()).filter(name => name.endsWith(".json") || name.endsWith(".jsonl"))
    .sort().map(name => [name, readFileSync(join(core.getTicketsDir(), name), "utf8")]);
  const refused = async (request, code) => {
    const before = snapshot(), reply = await invoke(request);
    assert.equal(reply.isError, true); assert.equal(reply.details.code, code); assert.deepEqual(snapshot(), before);
    return reply;
  };
  const created = await success({ action: "create", project: "fixture", requestId: "live-target", fields: { title: "Built native comment target" } });
  const id = created.id, other = "d-345101";
  core.emitStartedEvent({ deploymentId: other, team: "builder", mode: "implement", ticketId: id, runtime: "pi" });
  core.emitPidEvent({ deploymentId: other, team: "builder", pid: process.pid });
  for (const state of ["live", "unproven"]) {
    if (state === "unproven") core.getDb().prepare("UPDATE deployments SET status='partial', pid=NULL WHERE deployment_id=?").run(other);
    for (const legacy of [false, true]) {
      const before = store.get(id), audit = store.readAudit(), custody = core.queryDeploymentStatus(other);
      const comment = { action: "comment", id, ...(legacy ? { author: "coordinator/native-agent" } : { project: "fixture" }), content: "Coordination only" };
      const added = await success(comment), after = store.get(id);
      assert.deepEqual({ ...after, comments: before.comments, updatedAt: before.updatedAt }, before);
      assert.equal(after.comments.length, before.comments.length + 1); assert.equal(after.comments.at(-1).author, "coordinator/coordinate");
      assert.equal(store.readAudit().length, audit.length + 1); assert.deepEqual(core.queryDeploymentStatus(other), custody);
      await refused({ action: "set-status", project: "fixture", id, requestId: `${state}-${legacy}`, expectedVersion: added.version, status: "implementing" }, "TICKET_STATUS_OWNER");
      cases.push(`${state}-${legacy ? "legacy" : "modern"}-append-and-status-guard`);
    }
  }
  await refused({ action: "comment", project: "fixture", id, content: " " }, "TICKET_ADMIN_INPUT");
  await refused({ action: "comment", id, author: "builder/implement", content: "Spoof" }, "TICKET_ADMIN_INPUT");
  process.env.PA_MODE = "invented";
  await refused({ action: "comment", project: "fixture", id, content: "Drift" }, "TICKET_ADMIN_SESSION");
  process.env.PA_MODE = "coordinate";
  cases.push("content-attribution-and-current-auth-denials");
  for (const stop of ["intent", "ticket"]) {
    const target = await success({ action: "create", project: "fixture", requestId: `recovery-${stop}`, fields: { title: "Original status recovery" } });
    const coordinates = { scope: "a".repeat(64), requestId: `original-${stop}` };
    assert.throws(() => store.setStatusWithIntent(target.id, target.version, "requirement-review", "coordinator/coordinate", coordinates,
      { assertCurrent() {}, afterPersist(stage) { if (stage === stop) throw Error("Synthetic interruption"); } }), /Synthetic interruption/);
    const request = { action: "comment", project: "fixture", id: target.id, content: "Independent append" };
    const reply = await refused(request, "TICKET_COMMENT_PENDING");
    assert.ok(reply.content[0].text.length <= 2000); assert.doesNotMatch(reply.content[0].text, /administrative status request/);
    assert.equal(store.setStatusWithIntent(target.id, target.version, "requirement-review", "coordinator/coordinate", coordinates, { assertCurrent() {} }).reused, true);
    await success(request); assert.equal(store.get(target.id).comments.length, 1);
    cases.push(`${stop}-interruption-preservation-and-original-recovery`);
  }
  // Deliberately discard one successful response. Inspect instead of replaying.
  await invoke({ action: "comment", project: "fixture", id, content: "Acknowledgement discarded" });
  const inspected = await success({ action: "inspect", project: "fixture", id });
  assert.equal(inspected.ticket.comments.length, 5);
  assert.equal(store.readAudit().filter(row => row.ticket_id === id && row.action === "commented").length, 5);
  cases.push("lost-acknowledgement-inspection-without-replay");
  console.log(JSON.stringify({ schemaVersion: "pa-ticket-comment-qualification/v1", runtimeRoot, node: process.version,
    evidenceClass: "disposable-built-native-tool-with-real-process-authentication", cases, passed: cases.length,
    humanUat: false, independentReview: false, interactivePiSession: false, sourceFallback: false }, null, 2));
} finally {
  core.closeDb(); process.chdir(cwd); process.env = environment; rmSync(root, { recursive: true, force: true });
}
