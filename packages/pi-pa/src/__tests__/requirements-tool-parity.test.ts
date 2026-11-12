import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createReadTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { interceptToolCall, registerPiSessionModules, createPiSessionLifecycle, type PiToolDefinition, type PiRuntime } from "../pi-extension/index.js";

// Real ordinary Pi implementations and real native identity, synthetic host only.
// This is source mechanics, not an installed foreground/human parity trial.
test("ordinary tools execute with specialists, whole-workspace reads and immutable include/omit/include", async () => {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "requirements-parity-"));
  closeDb();
  try {
    const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config");
    for (const path of [repo, usage, config]) mkdirSync(path);
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    const outside = join(usage, "future-other-team"); mkdirSync(outside);
    const long = Array.from({ length: 3001 }, (_, i) => `${i}: ordinary UTF-8 λ`).join("\n");
    const source = join(outside, "history.txt"), artifact = join(outside, "draft.md"); writeFileSync(source, long);
    process.chdir(repo);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "synthetic-parity-session", getSessionFile: () => undefined } };
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    const base = ["document.package", "document.workspace", "ticket.intake", "capability.discover"];
    for (const [n, expanded] of [true, false, true].entries()) {
      const id = `d-29200${n}`, directory = ensureDeployDir(id);
      const allow = [...base, ...(expanded ? ["ordinary.bash", "ordinary.read", "ordinary.edit", "ordinary.write"] : ["context.read"])];
      const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("synthetic resource"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow }));
      emitStartedEvent({ deploymentId: id, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
      emitPidEvent({ deploymentId: id, team: "requirements", pid: process.pid }); assert.ok(recordPiProcessIdentity(id, directory, process.pid));
      Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
      const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>(); let active: string[] = [];
      const runtime: PiRuntime = { registerTool: tool => tools.set(tool.name, tool), setActiveTools: names => { active = names; }, on: ((name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler])) as any };
      const lifecycle = createPiSessionLifecycle(() => {});
      registerPiSessionModules(runtime, lifecycle, [pi => {
        for (const tool of [createBashTool(repo), createReadTool(repo), createEditTool(repo), createWriteTool(repo)]) pi.registerTool!(tool as any);
      }, registerDocumentModule]);
      const emit = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).map(h => h(event, context)); emit("session_start");
      for (const specialist of ["pa_document", "pa_workspace", "pa_ticket_intake", "pa_capabilities"]) assert.ok(active.includes(specialist));
      const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.execute("fixture", input, undefined, undefined, context);
      if (expanded) {
        assert.ok(active.includes("bash"));
        assert.match(JSON.stringify(await call("bash", { command: "printf '%s' ordinary-analysis" })), /ordinary-analysis/);
        await call("write", { path: artifact, content: "draft first" });
        await call("edit", { path: artifact, edits: [{ oldText: "draft first", newText: "draft revised" }] });
        assert.equal(readFileSync(artifact, "utf8"), "draft revised");
        assert.match(JSON.stringify(await call("read", { path: source, offset: 3001, limit: 1 })), /3000: ordinary UTF-8/);
        assert.equal(emit("tool_call", { toolName: "read", input: { path: source } })[0], undefined);
        assert.ok(interceptToolCall({ toolName: "bash", input: { command: "rm fixture.txt" } }).allowed === false);
      } else {
        assert.equal(active.includes("bash"), false);
        assert.equal(emit("tool_call", { toolName: "read", input: { path: source } })[0]?.block, true);
        await assert.rejects(() => call("read", { path: source }));
        await assert.rejects(() => call("bash", { command: "printf omitted" }));
      }
      writeFileSync(join(config, "requirements.yaml"), "ordinary tools changed in live config"); emit("before_agent_start");
      assert.equal(active.includes("bash"), expanded);
      assert.equal(emit("tool_call", { toolName: "functions.bash", input: { command: "printf alias" } })[0]?.block, true);
      await lifecycle.shutdown();
    }
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), before);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
