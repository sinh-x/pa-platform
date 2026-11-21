import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream } from "node:tty";
import { test } from "node:test";
import { spawn as spawnPty } from "node-pty";
import { closeDb, getDeployPaths, getDeploymentEvents, READONLY_DOCUMENT_PROFILE, READONLY_DOCUMENT_SESSION, hasModeResources, selectedCapabilityTools, parseModeCapabilityBinding, type RuntimeAdapter } from "@pa-platform/pa-core";
import { PiAdapter } from "../adapter.js";
import { deployWithPi } from "../deploy.js";
import { readPiProcessIdentity } from "../process-identity.js";
import { selectsDocumentSession } from "../document-session.js";

const require = createRequire(import.meta.url), source = (file: string) => new URL(`../${file}`, import.meta.url).href;
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const childSource = `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { authenticatePiDocumentCaller } from ${JSON.stringify(source("document-session.ts"))};
import { authenticatePiHandoffCaller } from ${JSON.stringify(source("handoff-native.ts"))};
import { registerDocumentModule, assertPolicyDocumentTool } from ${JSON.stringify(source("pi-extension/document-tool.ts"))};
try {
  const context = { cwd: process.cwd(), mode: 'tui', sessionManager: { getSessionId: () => 'readonly-profile-child' } };
  const caller = authenticatePiDocumentCaller(context);
  const events = new EventEmitter(), tools = new Map(); let active;
  registerDocumentModule({ on: events.on.bind(events), registerTool: tool => tools.set(tool.name, tool), setActiveTools: names => { active = names; } });
  events.emit('session_start', {}, context);
  const direct = (name, request) => tools.get(name).execute('profile-test', { request: JSON.stringify(request) }, undefined, undefined, context);
  if (!active.includes('pa_handoff')) assert.throws(() => authenticatePiHandoffCaller(context));
  assert.throws(() => assertPolicyDocumentTool(caller.deploymentId, {toolName:'functions.pa_handoff',input:{}}, context));
  if (active.includes('pa_document')) assert.notEqual((await direct('pa_document', {action:'capabilities'})).isError, true);
  let intake;
  if (active.includes('pa_ticket_intake')) {
    const packet = {schemaVersion:'pa-ticket-intake/v1',action:'create',requestId:'same-original',kind:'intake',project:'example',title:'Synthetic profile intake',type:'feature',priority:'medium',estimate:'M',assignee:'sinh'};
    const created = await direct('pa_ticket_intake', packet), replay = await direct('pa_ticket_intake', packet);
    assert.equal(created.isError, false, created.content[0].text); assert.equal(replay.isError, false, replay.content[0].text);
    intake = JSON.parse(created.content[0].text).ticket.id;
    assert.equal(JSON.parse(replay.content[0].text).ticket.id, intake);
    assert.equal(JSON.parse(replay.content[0].text).reusedIntent, true);
    assert.equal(authenticatePiDocumentCaller(context).ticket, caller.ticket);
  }
  const body = process.argv.at(-1), kernelArgs = readFileSync('/proc/self/cmdline').toString().split('\\0');
  writeFileSync(process.env.PROFILE_RESULT, JSON.stringify({ok:true,pid:process.pid,caller,active,registered:[...tools.keys()],intake,
    bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),maxArg:Math.max(...kernelArgs.map(x=>Buffer.byteLength(x)))}));
} catch (error) { writeFileSync(process.env.PROFILE_RESULT, JSON.stringify({ok:false,message:error.message,stack:error.stack})); process.exitCode=1; }
`;
function definition(team: string, modes: string[], edited = false) {
  return { name: team, description: "PAPC-owned report policy", agents: [{ name: edited ? "editor" : "reader", role: "Evidence and reporting", instruction: edited ? "docs/edited.md" : "docs/agent.md" }, { name: "inactive", role: "Not selected", instruction: "docs/absent.md" }],
    default_mode: modes[0], deploy_modes: modes.map((id, i) => ({ id, label: id, provider: "openai", model: "fixture", agents: [edited ? "editor" : "reader"], objective: `docs/${id}.md`,
      document_profile: READONLY_DOCUMENT_PROFILE, capability_policy: { version: "pa-mode-capabilities/v1", allow: edited ? ["human.question"] : team === "analyst" && i === 0 ? ["document.package", "document.handoff", "document.local-review"] : ["context.read", "ticket.intake", ...(id === "research" ? ["web.public-read"] : [])] },
      skills: [{ name: "method", "inject-as": "reference" }], global_docs: ["docs/common.md"], project_guides: { example: ["docs/project.md"], foreign: ["docs/not-selected.md"] } })) };
}
interface Fixture { root: string; config: string; repo: string; result: string; input: ReadStream; commit(): void; author(team: string, modes: string[], edited?: boolean): void }
async function fixture(run: (f: Fixture) => Promise<void>) {
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap318-native-profile-")); closeDb();
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage"), bin = join(root, "bin"), result = join(root, "result.json");
  const input = new ReadStream(openSync("/dev/ptmx", "r+"));
  try {
    for (const path of [join(config, "teams"), join(config, "primers"), join(config, "docs"), join(config, "skills/global/method"), repo, usage, bin]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    for (const [path, body] of Object.entries({ "docs/agent.md": "Selected agent instructions.", "docs/edited.md": "Config-only edited agent.", "docs/common.md": "[Policy](policy.md)", "docs/policy.md": "Selected transitive policy.", "docs/project.md": "Exact selected project guide.", "skills/global/method/SKILL.md": "Reference-only method." })) writeFileSync(join(config, path), body);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: config, stdio: "pipe" });
    git("init", "-b", "fixture");
    const commit = () => { git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Disposable PAPC-only revision"); };
    const author = (team: string, modes: string[], edited = false) => {
      writeFileSync(join(config, `teams/${team}.yaml`), JSON.stringify(definition(team, modes, edited)));
      for (const mode of modes) writeFileSync(join(config, `docs/${mode}.md`), `${mode}: ${mode === "investigate" ? "Evidence-backed diagnosis and repair direction without implementation; feed analyze." : mode === "research" ? "Sourced comparison and recommendation; feed analyze." : "Config-defined document objective."}\n${"x".repeat(635831)}\n`);
    };
    writeFileSync(join(config, "primers/budgets.yaml"), JSON.stringify({ $schema: "contracts/schemas/primer-budgets.schema.json", kind: "pa-primer-budgets", contractVersion: "1.0.0", unit: "lines", defaultMax: 1200, modes: ["analyze", "investigate", "research"].map(mode => ({ team: "analyst", mode, max: 9000 })) }));
    author("analyst", ["analyze", "investigate", "research"]); commit();
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Inert repository"], { cwd: repo, stdio: "pipe" });
    const child = join(root, "child.mjs"); writeFileSync(child, childSource);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nimport(${JSON.stringify(require.resolve("tsx/esm/api"))}).then(({tsImport}) => tsImport(${JSON.stringify(child)}, ${JSON.stringify(import.meta.url)})).catch(error => { console.error(error); process.exitCode=1; });\n`, { mode: 0o700 });
    for (const key of Object.keys(process.env)) if (/^(?:PA_|PI_|AXI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"), PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"), PROFILE_RESULT: result, PATH: `${bin}:${prior.PATH ?? ""}` });
    process.chdir(repo); await run({ root, config, repo, result, input, commit, author });
  } finally { input.destroy(); closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
}

test("PAP-318 same production runtime admits three modes and PAPC-only team/mode add/edit/rename with large exact primers", () => fixture(async f => {
  const adapter = new PiAdapter({ cwd: f.repo, env: process.env, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined,
    supervision: { input: f.input, spawnPty(file, args, options) {
      assert.ok(args.every(value => Buffer.byteLength(value) < 128 * 1024)); assert.ok(Object.values(options.env ?? {}).every(value => Buffer.byteLength(value) < 128 * 1024));
      assert.ok(!args.includes("--skill"), "V3 must not reopen mutable skill paths"); return spawnPty(file, args, options);
    } } });
  mkdirSync(join(f.root, "usage/tickets"), { recursive: true });
  const suppliedRaw = JSON.stringify({ id: "EX-900", project: "example", title: "Supplied inert ticket", status: "idea", assignee: "sinh", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z" });
  writeFileSync(join(f.root, "usage/tickets/EX-900.json"), suppliedRaw);
  const launch = async (team: string, mode: string, supplied = false) => {
    rmSync(f.result, { force: true });
    const result = await deployWithPi({ team, mode, repo: "example", ...(supplied ? { ticket: "EX-900" } : {}) }, adapter);
    assert.equal(result.status, "success", `${result.reason ?? ""}\n${existsSync(f.result) ? readFileSync(f.result, "utf8") : "target not released"}`);
    const observed = JSON.parse(readFileSync(f.result, "utf8")); assert.equal(observed.ok, true);
    const events = getDeploymentEvents(result.deploymentId!), start = events.find(event => event.event === "started")!, binding = parseModeCapabilityBinding(JSON.parse(start.mode_capability_binding!));
    assert.equal(binding.schemaVersion, "pa-mode-capability-binding/v3"); assert.ok(hasModeResources(binding)); assert.equal(start.note, READONLY_DOCUMENT_SESSION);
    const edited = binding.policy.allow.includes("human.question");
    assert.deepEqual(binding.resources.map(file => file.path).sort(), [...(team === "analyst" ? ["primers/budgets.yaml"] : []), `teams/${team}.yaml`, `docs/${mode}.md`, edited ? "docs/edited.md" : "docs/agent.md", "docs/common.md", "docs/policy.md", "docs/project.md", "skills/global/method/SKILL.md"].sort());
    assert.deepEqual(start.agents, [edited ? "editor" : "reader"]);
    assert.equal(start.team, team); assert.equal(start.mode, mode); assert.deepEqual(observed.caller.capabilities, binding);
    assert.equal(observed.caller.ticket, supplied ? "EX-900" : null);
    assert.deepEqual(observed.active, selectedCapabilityTools(binding.policy));
    assert.deepEqual(observed.registered.sort(), observed.active.filter((tool: string) => tool !== "read" && tool !== "question").sort());
    assert.equal(events.filter(event => event.event === "ticket-associated").length, 0, "intake never reassociates the primary");
    const primer = readFileSync(join(getDeployPaths(result.deploymentId!).deployDir, "primer.md"), "utf8");
    assert.ok(observed.bytes > 635831); assert.equal(observed.bytes, Buffer.byteLength(primer)); assert.equal(observed.sha256, sha(primer)); assert.ok(observed.maxArg < 128 * 1024);
    assert.match(primer, new RegExp(`Public identity: ${team}/${mode}`));
    if (team === "analyst") { assert.match(primer, /budget=9000/); assert.match(primer, /selected-resource:docs\/policy.md/); assert.doesNotMatch(primer, /Selected transitive policy/); }
    else assert.match(primer, /Selected transitive policy/);
    assert.doesNotMatch(primer, /docs\/absent|not-selected/);
    assert.equal(readPiProcessIdentity(result.deploymentId!, getDeployPaths(result.deploymentId!).deployDir).pid, observed.pid);
    assert.equal(events.find(event => event.event === "pid")!.pid, observed.pid);
    return binding;
  };
  for (const mode of ["analyze", "investigate", "research"]) { await launch("analyst", mode); await launch("analyst", mode, true); }
  f.author("evidence-lab", ["survey"]); f.commit(); const original = await launch("evidence-lab", "survey");
  f.author("evidence-lab", ["survey"], true); f.commit(); const edited = await launch("evidence-lab", "survey");
  assert.notEqual(original.configRevision, edited.configRevision); assert.deepEqual(edited.policy.allow, ["human.question"]);
  renameSync(join(f.config, "teams/evidence-lab.yaml"), join(f.config, "teams/insight-desk.yaml")); f.author("insight-desk", ["compare"], true); f.commit();
  const renamed = await launch("insight-desk", "compare"); assert.notEqual(renamed.configRevision, edited.configRevision);
  // A public spelling cannot turn the same selected profile into a writer role.
  f.author("builder", ["report"]); f.commit(); await launch("builder", "report");
  // A default is optional only when the operator explicitly selects a mode.
  const withoutDefault = definition("insight-desk", ["compare"], true);
  delete (withoutDefault as { default_mode?: string }).default_mode;
  writeFileSync(join(f.config, "teams/insight-desk.yaml"), JSON.stringify(withoutDefault)); f.commit();
  await launch("insight-desk", "compare");
  assert.equal(readFileSync(join(f.root, "usage/tickets/EX-900.json"), "utf8"), suppliedRaw, "supplied primary lifecycle, ownership and metadata remain unchanged");
}));

test("PAP-318 missing mode cannot drop a profile-only team's binding or restore public-name writer privilege", () => fixture(async f => {
  let probes = 0;
  const inert: RuntimeAdapter = { name: "pi", defaultModel: "", sessionFileName: "fixture", allocateSessionId() { probes++; throw Error("not admitted"); }, installHooks() { probes++; }, describeTools() { probes++; throw Error("not admitted"); }, async spawn() { probes++; throw Error("not admitted"); }, async resume() { probes++; throw Error("not admitted"); }, extractActivity: () => [] };
  for (const team of ["analyst", "evidence-lab", "builder", "requirements"]) {
    const selected = definition(team, ["report"]);
    delete (selected as { default_mode?: string }).default_mode;
    writeFileSync(join(f.config, `teams/${team}.yaml`), JSON.stringify(selected)); f.commit();
    for (const dryRun of [false, true]) {
      const result = await deployWithPi({ team, repo: "example", dryRun }, inert);
      assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined);
      assert.match(result.reason ?? "", /CAPABILITY_PROFILE/); assert.equal(probes, 0);
    }
  }
}));

test("PAP-318 explicit profile selection never upgrades unprofiled names or excluded session classes", () => {
  const input = { team: "any-team", mode: "any-mode", profile: READONLY_DOCUMENT_PROFILE, pinned: false, resume: false, inherited: false, rogue: false, background: false, ticketWorktree: false, supportedConfig: true };
  assert.equal(selectsDocumentSession(input), true);
  assert.equal(selectsDocumentSession({ ...input, profile: undefined }), false);
  for (const key of ["pinned", "resume", "inherited", "rogue", "background", "ticketWorktree"] as const) assert.equal(selectsDocumentSession({ ...input, [key]: true }), false);
});

test("PAP-318 generic profile keeps all fresh-foreground exclusions and rejects current-source drift before native release", () => fixture(async f => {
  f.author("evidence-lab", ["survey"]); f.commit();
  let probes = 0;
  const inert: RuntimeAdapter = { name: "pi", defaultModel: "", sessionFileName: "fixture", allocateSessionId() { probes++; throw Error("not admitted"); }, installHooks() { probes++; }, describeTools() { probes++; throw Error("not admitted"); }, async spawn() { probes++; throw Error("not admitted"); }, async resume() { probes++; throw Error("not admitted"); }, extractActivity: () => [] };
  for (const excluded of [{ background: true }, { resume: "d-318fff" }, { ticketWorktree: true }, { force: true }]) {
    const result = await deployWithPi({ team: "evidence-lab", mode: "survey", repo: "example", ...excluded }, inert);
    assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined);
  }
  process.env.PA_DEPLOYMENT_ID = "d-318999";
  const inherited = await deployWithPi({ team: "evidence-lab", mode: "survey", repo: "example" }, inert);
  assert.equal(inherited.status, "failed"); assert.equal(inherited.deploymentId, undefined); delete process.env.PA_DEPLOYMENT_ID; assert.equal(probes, 0);
  const configPath = join(f.config, "teams/evidence-lab.yaml"), originalConfig = readFileSync(configPath, "utf8");
  for (const [invalid, code] of [
    [originalConfig.replace('"ticket.intake"', '"unsupported.effect"'), "CAPABILITY_UNKNOWN"],
    [originalConfig.replace(READONLY_DOCUMENT_PROFILE, "unsupported-profile/v1"), "CAPABILITY_PROFILE"],
    [originalConfig.replace(/^\{/, '{"actor":"builder/implement",'), "CAPABILITY_POLICY_INVALID"],
  ]) {
    writeFileSync(configPath, invalid);
    const rejected = await deployWithPi({ team: "evidence-lab", mode: "survey", repo: "example" }, inert);
    assert.equal(rejected.status, "failed"); assert.equal(rejected.deploymentId, undefined); assert.match(rejected.reason ?? "", new RegExp(code));
    assert.ok(rejected.reason!.length <= 2000); assert.doesNotMatch(rejected.reason!, /builder\/implement|unsupported\.effect/);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(rejected.reason!.split(`${label}:`).length - 1, 1);
  }
  writeFileSync(configPath, originalConfig); assert.equal(probes, 0);
  let spawns = 0;
  const adapter = new PiAdapter({ cwd: f.repo, env: process.env, versionProbe: () => "0.84.4", nativeRegistryProbe: () => undefined, supervision: { input: f.input, spawnPty(file, args, options) {
    const child = spawnPty(file, args, options); spawns++; writeFileSync(join(f.config, "docs/agent.md"), "Uncommitted source drift at real PTY admission."); return child;
  } } });
  const drift = await deployWithPi({ team: "evidence-lab", mode: "survey", repo: "example" }, adapter);
  assert.equal(drift.status, "failed"); assert.match(drift.reason ?? "", /CAPABILITY_BINDING/); assert.equal(spawns, 1); assert.equal(existsSync(f.result), false);
}));
