import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeDb, ensureDeployDir, getDeploymentEvents, selectedCapabilityTools, type DeployRequest, type RuntimeAdapter } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { authenticatePiDocumentCaller } from "../document-session.js";
import { createPiPaModules, createPiSessionLifecycle, registerPiSessionModules, type PiToolDefinition } from "../pi-extension/index.js";
import { createPublicWebTool } from "../pi-extension/web-read-tool.js";
import { FakeComposedHost } from "./fixtures/pi-composed-host.js";

const baseline = ["document.package", "document.workspace", "ticket.read-comment", "ticket.intake", "capability.discover", "bulletin.read", "registry.read", "status.read", "template.draft", "human.question", "session.todo", "context.read"];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();

// These tests use the real launcher, committed-resource owner and native extension,
// but a synthetic provider/host. No public DNS, HTTPS, installation or human UAT.
async function withFixture(run: (fixture: {
  repo: string;
  resource: string;
  select(allow?: string[], profile?: string): { revision: string; sha256: string };
  launch(check: (host: FakeComposedHost, context: any, id: string, active: string[]) => Promise<void>, options?: Partial<DeployRequest>, duringPreflight?: () => void): ReturnType<typeof deployWithPi>;
  observations(): { spawns: number; preflights: number };
}) => Promise<void>): Promise<void> {
  const env = process.env, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "web-launch-source-"));
  closeDb();
  try {
    process.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PA_|PI_|GIT_)/.test(key)));
    const repo = join(root, "repo"), config = join(root, "config"), teams = join(root, "teams"), usage = join(root, "usage");
    for (const directory of [repo, config, teams, usage]) mkdirSync(directory);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: teams, PA_PLATFORM_DATA: join(root, "data"), PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    git(repo, "init", "-b", "develop");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "source fixture");
    git(root, "init", "-b", "fixture-config");
    process.chdir(repo);
    writeFileSync(join(config, "config.yaml"), `config_dir: ${root}\nrepos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    const resource = join(teams, "requirements.yaml");
    let spawns = 0, preflights = 0;
    await run({ repo, resource,
      select(allow, profile = "pa-document-policy/v1") {
        writeFileSync(resource, `name: requirements\nobjective: Disposable source reader fixture\nagents: []\ndeploy_modes:\n - id: analyze\n   document_profile: ${profile}\n${allow ? `   capability_policy: {version: pa-mode-capabilities/v1, allow: [${allow.join(", ")}]}\n` : ""}`);
        git(root, "add", "teams/requirements.yaml");
        git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "select source fixture policy");
        return { revision: git(root, "rev-parse", "HEAD"), sha256: createHash("sha256").update(readFileSync(resource)).digest("hex") };
      },
      observations: () => ({ spawns, preflights }),
      async launch(check, options = {}, duringPreflight) {
        let bodyError: unknown;
        const adapter: RuntimeAdapter & { preflight(): Promise<void> } = {
          name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => `source-web-session-${spawns}`,
          async preflight() { preflights++; duringPreflight?.(); }, installHooks() {},
          describeTools: () => ({ runtime: "pi", markdown: "Synthetic provider; real native registration." }), extractActivity: () => [],
          resume: async () => { throw Error("fixture must not resume"); },
          async spawn(opts) {
            spawns++;
            const inherited = process.env;
            process.env = { ...inherited, ...opts.env };
            const lifecycle = createPiSessionLifecycle();
            try {
              assert.equal(opts.env.PA_PROVIDER, "openai-codex"); assert.equal(opts.env.PA_MODEL, "gpt-6.1-sol");
              assert.equal(recordPiProcessIdentity(opts.deployId, ensureDeployDir(opts.deployId), process.pid), true);
              opts.onPid?.(process.pid);
              const context: any = { cwd: repo, mode: "tui", sessionManager: { getSessionId: () => opts.sessionId!, getBranch: () => [] }, ui: { setStatus() {}, setWidget() {}, notify() {} } };
              const host = new FakeComposedHost(); let active: string[] = [];
              host.runtime.setActiveTools = names => { active = names; };
              registerPiSessionModules(host.runtime, lifecycle, createPiPaModules([]));
              await host.dispatch("session_start", {}, context);
              await check(host, context, opts.deployId, active);
            } catch (error) { bodyError = error; throw error; }
            finally { await lifecycle.shutdown(); process.env = inherited; }
            return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
          },
        };
        const result = await deployWithPi({ team: "requirements", mode: "analyze", repo: "example", timeout: 60, provider: "openai-codex", model: "gpt-6.1-sol", ...options }, adapter);
        if (bodyError) throw bodyError;
        return result;
      },
    });
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
}

function assertBlocker(message: string): void {
  assert.ok(message.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(message.split(`${label}:`).length - 1, 1);
}

test("same source launcher admits config-only reader on/off/on with complete baseline and immutable native binding; no network", async () => {
  await withFixture(async fixture => {
    const ids: string[] = [];
    for (const on of [true, false, true]) {
      const allow = [...baseline, ...(on ? ["web.public-read"] : [])].sort();
      const selected = fixture.select(allow);
      const result = await fixture.launch(async (host, context, id, active) => {
        ids.push(id);
        const starts = getDeploymentEvents(id).filter(event => event.event === "started");
        assert.equal(starts.length, 1); assert.equal(starts[0]!.note, "requirements-document-policy/v1");
        const caller = authenticatePiDocumentCaller(context), binding = caller.capabilities!;
        assert.equal(binding.configRevision, selected.revision); assert.equal(binding.resourceSha256, selected.sha256);
        assert.deepEqual(binding.policy.allow, allow);
        assert.deepEqual(JSON.parse(starts[0]!.mode_capability_binding!), binding);
        assert.deepEqual([...active].sort(), [...selectedCapabilityTools(binding.policy)].sort());
        for (const tool of ["pa_document", "pa_workspace", "pa_ticket_intake", "pa_capabilities"]) assert.ok(host.tools.has(tool), tool);
        for (const tool of ["bash", "write", "edit", "pa_operation"]) assert.equal(active.includes(tool), false);
        assert.equal(host.tools.has("pa_web_read"), on);
        const tool: PiToolDefinition = host.tools.get("pa_web_read") ?? createPublicWebTool(id, context.sessionManager.getSessionId());
        // Literal loopback rejects before DNS; this exercises the production tool
        // without substituting a connector or making any external request.
        const reply = await tool.execute("source-unsafe-target", { url: "https://127.0.0.1/" }, undefined, undefined, context);
        const denied = JSON.parse(reply.content[0]!.text);
        assert.equal(reply.isError, true); assert.equal(denied.code, on ? "WEB_TARGET" : "CAPABILITY_OMITTED");
        if (on) { assert.equal(denied.stage, "not-started"); assert.equal(denied.cleanup, "settled"); }
        assertBlocker(denied.message);
        // Real OpenAI Responses IDs are composite, not only call_<id>.
        const composite = await tool.execute("call_fixture|fc_fixture", { url: "https://127.0.0.1/" }, undefined, undefined, context);
        assert.equal(JSON.parse(composite.content[0]!.text).code, on ? "WEB_TARGET" : "CAPABILITY_OMITTED", "provider ID must reach the existing URL guard, never bypass omission");
        const gates = await host.dispatch("tool_call", { toolName: "pa_web_read", input: { url: "https://127.0.0.1/" } }, context);
        assert.equal(gates.some((entry: any) => entry?.block), !on);
        const before = JSON.stringify(binding);
        const changed = [...baseline, ...(!on ? ["web.public-read"] : [])].sort();
        writeFileSync(fixture.resource, readFileSync(fixture.resource, "utf8").replace(`allow: [${allow.join(", ")}]`, `allow: [${changed.join(", ")}]`));
        assert.equal(JSON.stringify(authenticatePiDocumentCaller(context).capabilities), before, "working config edits cannot widen or replace a running native selection");
        const afterEdit = JSON.parse((await tool.execute("source-after-config-edit", { url: "https://127.0.0.1/" }, undefined, undefined, context)).content[0]!.text);
        assert.equal(afterEdit.code, on ? "WEB_TARGET" : "CAPABILITY_OMITTED", "config edit cannot change actual execution admission");
      });
      assert.equal(result.status, "success", result.reason);
    }
    assert.equal(new Set(ids).size, 3); assert.deepEqual(fixture.observations(), { spawns: 3, preflights: 3 });
  });
});

test("reader policy still rejects background/resume/worktree routes before allocation or spawn", async () => {
  await withFixture(async fixture => {
    fixture.select([...baseline, "web.public-read"]);
    for (const options of [{ background: true }, { resume: "d-abcdef" }, { ticketWorktree: true }]) {
      const result = await fixture.launch(async () => assert.fail("ineligible launch"), options);
      assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined);
      assert.match(result.reason!, /CAPABILITY_PROFILE/); assertBlocker(result.reason!);
    }
    assert.deepEqual(fixture.observations(), { spawns: 0, preflights: 0 });
  });
});

test("reader selection rejects uncommitted policy and preflight config drift; no runtime spawn", async () => {
  await withFixture(async fixture => {
    fixture.select(baseline);
    const original = readFileSync(fixture.resource, "utf8");
    writeFileSync(fixture.resource, original.replace("allow: [", "allow: [web.public-read, "));
    const dirty = await fixture.launch(async () => assert.fail("dirty selection"));
    assert.equal(dirty.status, "failed"); assert.equal(dirty.deploymentId, undefined); assert.match(dirty.reason!, /CAPABILITY_BINDING/); assertBlocker(dirty.reason!);
    fixture.select([...baseline, "web.public-read"]);
    const drift = await fixture.launch(async () => assert.fail("drifted selection"), {}, () => {
      writeFileSync(fixture.resource, readFileSync(fixture.resource, "utf8") + "# preflight drift\n");
    });
    assert.equal(drift.status, "failed"); assert.match(drift.reason!, /CAPABILITY_BINDING/); assertBlocker(drift.reason!);
    assert.ok(drift.deploymentId);
    const events = getDeploymentEvents(drift.deploymentId!);
    assert.equal(events.filter(event => event.event === "started").length, 1, "native preparation already started before preflight");
    assert.equal(events.some(event => event.event === "pid"), false);
    assert.equal(events.find(event => event.event === "completed")!.status, "failed", "existing terminal owner records the failed preparation");
    assert.deepEqual(fixture.observations(), { spawns: 0, preflights: 1 });
  });
});

test("retained absent-policy v1-v4 launches do not gain a public reader", async () => {
  await withFixture(async fixture => {
    for (const profile of ["pa-document-package/v1", "pa-document-workspace/v2", "pa-document-confirmation/v3", "pa-document-interactions/v4"]) {
      fixture.select(undefined, profile);
      const result = await fixture.launch(async (host, context, id, active) => {
        assert.equal(getDeploymentEvents(id).find(event => event.event === "started")!.mode_capability_binding, undefined);
        assert.equal(authenticatePiDocumentCaller(context).capabilities, undefined);
        assert.equal(host.tools.has("pa_web_read"), false); assert.equal(active.includes("pa_web_read"), false);
      });
      assert.equal(result.status, "success", result.reason);
    }
    assert.equal(fixture.observations().spawns, 4);
  });
});
