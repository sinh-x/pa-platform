import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream } from "node:tty";
import { test } from "node:test";
import { spawn as spawnPty } from "node-pty";
import { closeDb, getDeployPaths, getDeploymentEvents } from "@pa-platform/pa-core";
import { PiAdapter, type PiSupervisionOptions } from "../adapter.js";
import { deployWithPi } from "../deploy.js";
import { readPiProcessIdentity } from "../process-identity.js";

const require = createRequire(import.meta.url);
const source = (file: string) => new URL(`../${file}`, import.meta.url).href;
const childSource = `import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { authenticatePiDocumentCaller } from ${JSON.stringify(source("document-session.ts"))};
import { registerDocumentModule } from ${JSON.stringify(source("pi-extension/document-tool.ts"))};
import { mutatePiDocument } from ${JSON.stringify(source("document-native.ts"))};
try {
  const context = { cwd: process.cwd(), mode: 'tui', sessionManager: { getSessionId: () => 'identity-native-child' } };
  const caller = authenticatePiDocumentCaller(context);
  const events = new EventEmitter(), tools = new Map(); let active;
  registerDocumentModule({ on: events.on.bind(events), registerTool: tool => tools.set(tool.name, tool), setActiveTools: names => { active = names; } });
  events.emit('session_start', {}, context);
  assert.deepEqual(active, ['pa_document']); assert.ok(tools.has('pa_document'));
  const request = JSON.stringify({action:'capabilities'});
  const direct = await mutatePiDocument(request, context);
  const registered = await tools.get('pa_document').execute('identity-adapter', {request}, undefined, undefined, context);
  assert.equal(direct.ok, true); assert.notEqual(registered.isError, true);
  const anchor = JSON.parse(readFileSync(process.env.PA_DEPLOYMENT_DIR + '/pi-process-identity.json', 'utf8'));
  assert.equal(anchor.processFingerprint.pid, process.pid);
  writeFileSync(process.env.IDENTITY_RESULT, JSON.stringify({ok:true, pid:process.pid, team:process.env.PA_TEAM, caller, active, direct, registered}));
} catch (error) {
  writeFileSync(process.env.IDENTITY_RESULT, JSON.stringify({ok:false, message:error.message, stack:error.stack})); process.exitCode=1;
}
`;

interface Fixture { root: string; config: string; repo: string; result: string; input: ReadStream; }
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const previous = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap316-identity-adapter-"));
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage"), bin = join(root, "bin"), result = join(root, "child-result.json");
  const input = new ReadStream(openSync("/dev/ptmx", "r+"));
  closeDb();
  try {
    for (const path of [join(config, "teams"), join(config, "docs"), join(config, "skills/global/method"), join(config, "skills/global/reference"), repo, usage, bin]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    writeFileSync(join(config, "docs/objective.md"), "Captured native objective.\n");
    writeFileSync(join(config, "skills/global/method/SKILL.md"), "Captured selected method.\n");
    writeFileSync(join(config, "skills/global/reference/SKILL.md"), "Captured reference method, never promoted to an active controller.\n");
    writeFileSync(join(config, "teams/analyst.yaml"), `name: analyst\nobjective: fallback must not load\nagents: []\ndefault_mode: analyze\ndeploy_modes:\n - id: analyze\n   label: Analyze\n   provider: openai\n   model: fixture\n   objective: docs/objective.md\n   document_profile: pa-document-policy/v1\n   capability_policy: {version: pa-mode-capabilities/v1, allow: [document.package]}\n   skills:\n    - {name: method, inject-as: global-skill}\n    - {name: reference, inject-as: reference}\n`);
    for (const path of [config, repo]) {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
      git("init", "-b", "develop"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable identity source");
    }
    const childPath = join(root, "child.mjs"); writeFileSync(childPath, childSource);
    // This inert executable is the only target of the real production PTY/start
    // gate. No installed Pi/provider, model request, or live store is involved.
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nimport(${JSON.stringify(require.resolve("tsx/esm/api"))}).then(({tsImport}) => tsImport(${JSON.stringify(childPath)}, ${JSON.stringify(import.meta.url)})).catch(error => { console.error(error); process.exitCode=1; });\n`, { mode: 0o700 });
    for (const key of Object.keys(process.env)) if (/^(?:PA_|PI_|AXI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"),
      PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"), IDENTITY_RESULT: result, PATH: `${bin}:${previous.PATH ?? ""}` });
    process.chdir(repo);
    await run({ root, config, repo, result, input });
  } finally { input.destroy(); closeDb(); process.chdir(cwd); process.env = previous; rmSync(root, { recursive: true, force: true }); }
}

function adapter(f: Fixture, extra: { preflight?: () => void; spawn?: () => void; command?: (args: string[]) => void } = {}): PiAdapter {
  const spawn: NonNullable<PiSupervisionOptions["spawnPty"]> = (file, args, options) => {
    // Observe actual command bytes, not an alternate RuntimeAdapter's inputs.
    extra.command?.(file === process.execPath ? args.slice(6) : args);
    const pty = spawnPty(file, args, options);
    extra.spawn?.();
    return pty;
  };
  class AwaitBoundaryAdapter extends PiAdapter {
    private preflights = 0;
    override async preflight(): Promise<void> {
      await super.preflight();
      // The launcher already awaits preflight once; the second await is inside
      // the actual adapter, after the launcher's last selection check.
      if (++this.preflights === 2) extra.preflight?.();
    }
  }
  return new AwaitBoundaryAdapter({ cwd: f.repo, env: process.env, versionProbe: () => "0.84.4",
    nativeRegistryProbe: () => undefined, supervision: { input: f.input, spawnPty: spawn } });
}

test("PAP-316 production adapter writes Analyst child anchor and selected tools authenticate/register/invoke without planted evidence", () => fixture(async f => {
  const result = await deployWithPi({ team: "analyst", repo: "example" }, adapter(f));
  assert.equal(result.status, "success", `${result.reason ?? ""}\n${existsSync(f.result) ? readFileSync(f.result, "utf8") : "child not released"}`);
  assert.ok(result.deploymentId);
  const observed = JSON.parse(readFileSync(f.result, "utf8"));
  assert.equal(observed.ok, true); assert.equal(observed.team, "analyst"); assert.deepEqual(observed.active, ["pa_document"]);
  const anchor = readPiProcessIdentity(result.deploymentId, getDeployPaths(result.deploymentId).deployDir);
  assert.equal(anchor.pid, observed.pid);
  assert.equal(getDeploymentEvents(result.deploymentId).find(event => event.event === "pid")?.pid, observed.pid);
}));

test("PAP-316 actual adapter command loads V2 skills only from captured primer, preserving reference-only semantics", () => fixture(async f => {
  let command: string[] | undefined;
  await deployWithPi({ team: "analyst", repo: "example" }, adapter(f, { command: args => { command = args; } }));
  assert.ok(command); assert.ok(command.includes("--no-skills")); assert.ok(!command.includes("--skill"), "mutable selected checkout must not be another skill loader");
  const primer = command.at(-1)!;
  assert.match(primer, /Captured selected method/); assert.match(primer, /Captured reference method/);
  assert.match(primer, /Captured reference-only resource: skills\/global\/reference\/SKILL.md/);
  assert.doesNotMatch(primer, /<global-skill name="reference"/);
}));

for (const boundary of ["preflight await", "PTY admission"] as const) test(`PAP-316 resource drift during ${boundary} prevents actual native child release`, () => fixture(async f => {
  let ptySpawns = 0;
  const mutate = () => writeFileSync(join(f.config, "skills/global/method/SKILL.md"), "UNBOUND drift during adapter start.\n");
  const result = await deployWithPi({ team: "analyst", repo: "example" }, adapter(f, {
    ...(boundary === "preflight await" ? { preflight: mutate } : {}),
    spawn() { ptySpawns++; if (boundary === "PTY admission") mutate(); },
  }));
  assert.equal(result.status, "failed"); assert.match(result.reason ?? "", /CAPABILITY_BINDING/);
  assert.equal(ptySpawns, 1, "exercise the actual inert-child admission, not an earlier launcher check");
  assert.equal(existsSync(f.result), false, "target code must not run before admission");
  assert.ok(result.deploymentId);
  const directory = getDeployPaths(result.deploymentId).deployDir;
  const gates = (await import("node:fs")).readdirSync(directory).filter(name => name.startsWith("pi-start-"));
  assert.equal(gates.length, 1); assert.equal(existsSync(join(directory, gates[0]!, "release")), false);
}));

test("PAP-316 policy launch with runCommand remains fail-closed when the native gate cannot be honored", () => fixture(async f => {
  let commands = 0;
  const sink = new PiAdapter({ cwd: f.repo, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
    runCommand: () => { commands++; return { status: 0, stdout: "", stderr: "" }; } });
  const result = await deployWithPi({ team: "analyst", repo: "example" }, sink);
  assert.equal(result.status, "failed"); assert.match(result.reason ?? "", /native runtime-start gate/); assert.equal(commands, 0);
}));

test("PAP-316 omitted-profile production adapter route denies before allocation or preflight", () => fixture(async f => {
  const path = join(f.config, "teams/analyst.yaml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^   (?:document_profile|capability_policy):.*\n/gm, ""));
  let probes = 0;
  const native = new PiAdapter({ cwd: f.repo, versionProbe: () => { probes++; throw Error("unadmitted preflight"); } });
  const result = await deployWithPi({ team: "analyst", repo: "example" }, native);
  assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined); assert.match(result.reason ?? "", /CAPABILITY_PROFILE/); assert.equal(probes, 0);
  assert.equal(existsSync(join(f.root, "registry.db")), false); assert.equal(existsSync(f.result), false);
}));
