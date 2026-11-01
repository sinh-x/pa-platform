// Full local/installed entry: portable cases plus all mandatory native cases.
// No environment skip or test-name filter controls this boundary.
import { fixture } from "./pi-workflow-code-cases.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { materializeTicketBranch, parseReviewMatrixPlan, workflowDecisionReference, structuredReviewArtifact, type RuntimeAdapter } from "@pa-platform/pa-core";
import { bytes } from "../../../pa-core/src/__tests__/workflow-fixtures.js";
import { digest } from "../../../pa-core/src/workflows/contracts.js";
import { authorizePiStructuredWork, parseStructuredLaunchNote, resolvePiStructuredBaseline, structuredLaunchNote } from "../workflow-consumers.js";
import { ProjectCommandContract } from "../project-command-contract.js";
import { deployWithPi } from "../deploy.js";
import { PiNativeExecutionAdapter } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { TreehouseClient } from "./treehouse-fixture.js";
import { createPiExecutionModule } from "../pi-extension/prepared-workflow.js";
import { registerWorkflowMatrixCases } from "./pi-workflow-matrix-cases.js";
import type { PiToolDefinition, PiRuntime } from "../pi-extension/index.js";

registerWorkflowMatrixCases(fixture);
test("linked amendment publication/queue admits a new exact baseline without upgrading old launch/scope/review authority", () => fixture(async f => {
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const oldNote = structuredLaunchNote("ordinary-native-execution/v1", f.authority), locator = workflowDecisionReference(f.state, f.authority.decisionId);
  const oldArtifact = readFileSync(join(f.root, f.bundle.requirements.ref.slice("requirements:".length)));
  const next = structuredClone(f.bundle); next.subjectId = "package-amended"; next.revision++;
  next.handoff = { type: "amendment", branch: next.handoff.branch, baseSha: f.base, featureSha: f.base, branchAction: "reuse" };
  next.requirements.ref = "requirements:agent-teams/requirements/artifacts/amended.md"; next.matrix.ref = next.requirements.ref;
  const matrix = parseReviewMatrixPlan(oldArtifact, f.bundle.matrix.ref).matrix; matrix.source = next.matrix.ref;
  const revisedArtifact = Buffer.from(`# Synthetic amendment, no approval paragraphs\n\n### Full Validation Matrix\n\nMatrix Source: ${matrix.source}\n\n\`\`\`json\n${JSON.stringify(matrix)}\n\`\`\`\n\n## After\n`);
  next.requirements.sha256 = digest(revisedArtifact); next.matrix.sha256 = parseReviewMatrixPlan(revisedArtifact, next.matrix.ref).digest;
  f.evidence.set(next.requirements.ref, revisedArtifact);
  next.scope.checks = [{ ...next.scope.checks[0]!, matrixSource: next.matrix.ref, matrixSha256: next.matrix.sha256 }];
  const state = f.service.revise(f.state.runId, f.state.revision, bytes(next));
  assert.equal(state.attempts[0]!.outcomes.queue, "completed"); assert.equal(state.outcomes.queue, undefined);
  assert.deepEqual(parseStructuredLaunchNote(oldNote), f.authority); // immutable pin is not rewritten
  const work = () => authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped", { paths: ["src/a.ts"], checks: ["check"] }, f.authority);
  assert.throws(work, /WORKFLOW_AUTHORITY/);
  assert.throws(() => structuredReviewArtifact("example", "EX-1", f.bundle.matrix.ref, locator), /WORKFLOW_AUTHORITY/);
  const decision = await f.service.decide(state.runId, state.revision, "approve");
  assert.throws(work, /WORKFLOW_AUTHORITY/); // new approval cannot upgrade an old start
  assert.throws(() => resolvePiStructuredBaseline("example", f.repo, "EX-1"), /WORKFLOW_AUTHORITY/); // graph/publication/primary still unproven
  const published = await f.service.requestStep(state.runId, f.service.status(state.runId).revision, "publish", decision.decisionId);
  assert.throws(() => resolvePiStructuredBaseline("example", f.repo, "EX-1"), /WORKFLOW_AUTHORITY/); // current queue outcome is still unproven
  const queued = await f.service.requestStep(state.runId, published.revision, "queue", decision.decisionId);
  assert.deepEqual(readFileSync(join(f.root, f.bundle.requirements.ref.slice("requirements:".length))), oldArtifact);
  assert.equal(queued.pending.length, 0); assert.throws(work, /WORKFLOW_AUTHORITY/);
  const updated = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  assert.equal(updated.handoff.type, "amendment"); assert.equal(updated.requirements.ref, next.requirements.ref); assert.equal(updated.authority.decisionId, decision.decisionId);
  const reused = materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: updated, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  assert.equal(reused.created, false); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), f.base);
  assert.equal(authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped", { paths: ["src/a.ts"], checks: ["check"] }, updated.authority)!.subjectSha256, queued.subjectSha256);
  assert.equal(structuredReviewArtifact("example", "EX-1", next.matrix.ref, workflowDecisionReference(queued, decision.decisionId))!.digest, next.matrix.sha256);
  assert.throws(() => structuredReviewArtifact("example", "EX-1", f.bundle.matrix.ref, locator), /WORKFLOW_AUTHORITY/);
}));
test("structured baseline drives actual materialization without approval text; static profile inspection executes no tools", () => fixture(async f => {
  const before = f.git(["status", "--porcelain=v2"]), head = f.git(["rev-parse", "HEAD"]);
  const path = process.env.PATH; process.env.PATH = "/nonexistent";
  try { assert.equal(ProjectCommandContract.inspect("example", f.repo)!.checks.length, 1); } finally { process.env.PATH = path; }
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!; assert.equal(baseline.authority.runId, f.state.runId);
  const result = materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  assert.equal(result.created, true); assert.equal(result.baseSha, f.base); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), f.base);
  assert.equal(f.git(["status", "--porcelain=v2"]), before); assert.equal(f.git(["rev-parse", "HEAD"]), head);
}));
test("amendment materialization reuses ONLY the exact retained feature and rejects changed HEAD without mutation", () => fixture(async f => {
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!; assert.equal(baseline.handoff.type, "amendment");
  const options = { canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! };
  assert.equal(materializeTicketBranch(options).created, false);
  writeFileSync(join(f.checkout, "check.cjs"), "process.exit(1)\n"); f.git(["commit", "-am", "injected feature drift"], f.checkout);
  const ticket = readFileSync(f.ticketPath), head = f.git(["rev-parse", "HEAD"], f.checkout);
  assert.throws(() => materializeTicketBranch(options), /ORDINARY_BASELINE_CHANGED/);
  assert.deepEqual(readFileSync(f.ticketPath), ticket); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), head);
}, true));
test("default Pi launcher and native execution owner consume the structured grant and reread revocation", () => fixture(async f => {
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const teams = join(f.root, "teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(join(teams, "builder.yaml"), "name: builder\ndescription: Synthetic fixture\nobjective: Synthetic fixture\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
  const treehouse = new TreehouseClient({ run: args => {
    if (args[0] !== "status") throw new Error("unexpected checkout lifecycle effect");
    return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: f.checkout, status: "leased", branch: f.bundle.handoff.branch, detached: false, flavor: "git", lease_id: "synthetic-json-workflow", lease_holder: "pa:example:EX-1", leased_at: "2026-10-29T00:00:00Z", processes: [] }])), stderr: Buffer.alloc(0) };
  } });
  const native = new PiPreparedNativeAuthority({ root: join(f.root, "native-authority"), aiUsageRoot: f.root, runtime: () => ({ sourceSha: "a".repeat(40), packageVersion: "synthetic", configSha: "b".repeat(40), storeRoot: "/fixture/runtime" }) });
  let spawns = 0, bodyFailure: unknown;
  const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "synthetic-json-workflow", async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "synthetic fixture" }), extractActivity: () => [], resume: async () => { throw new Error("not a restart test"); },
    async spawn(opts) {
      spawns++; const env = process.env, cwd = process.cwd(); process.env = { ...env, ...opts.env }; process.chdir(f.checkout);
      try {
        assert.equal(recordPiProcessIdentity(opts.deployId, process.env.PA_DEPLOYMENT_DIR!, process.pid), true); opts.onPid?.(process.pid);
        const session = new PiNativeExecutionAdapter({ authority: native, helperDependencies: { treehouse } }).resolve({ cwd: f.checkout })!;
        assert.ok(session);
        const plan = { phaseId: "scoped-phase", scope: "synthetic source owner proof", paths: ["src/a.ts"], requirements: ["FR-01"], prerequisites: [], checks: ["check"], size: "S", complexity: "bounded", rationale: "Synthetic host, real native owners" };
        session.service.apply(session.actor, { action: "plan", plan });
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, paths: ["outside.ts"] } }), /WORKFLOW_AUTHORITY/);
        await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId);
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan }), /WORKFLOW_AUTHORITY/);
        assert.equal(session.service.status(session.actor).plan!.phaseId, "scoped-phase"); // reporting stays available
      } catch (error) { bodyFailure = error; throw error; }
      finally { process.chdir(cwd); process.env = env; }
      return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
    } };
  const result = await deployWithPi({ team: "builder", mode: "orchestrator", repo: "example", ticket: "EX-1", timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: native });
  if (bodyFailure) throw bodyFailure;
  assert.equal(result.status, "success", result.reason); assert.equal(spawns, 1);
}));
test("foreground default launcher retains failed-check custody across real predecessor exit and resumes two native source phases without allocation", () => fixture(async f => {
  const waiting = await f.service.requestStep(f.state.runId, f.state.revision, "source-phase", f.authority.decisionId);
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const teams = join(f.root, "teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(join(teams, "builder.yaml"), "name: builder\ndescription: Synthetic provider, real restart admission\nobjective: Fixture\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
  const row = { name: "1", path: f.checkout, status: "leased", branch: f.bundle.handoff.branch, detached: false, flavor: "git", lease_id: "synthetic-resume", lease_holder: "pa:example:EX-1", leased_at: "2026-10-30T00:00:00Z", processes: [] };
  const treehouse = new TreehouseClient({ run: args => { if (args[0] !== "status") throw Error("no allocation/return"); return { status: 0, stdout: Buffer.from(JSON.stringify([row])), stderr: Buffer.alloc(0) }; } });
  const script = join(f.root, "original-runtime.mts"), resultPath = join(f.root, "original-result.json");
  const module = (name: string) => new URL(`../${name}.ts`, import.meta.url).href;
  writeFileSync(script, `import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
import {deployWithPi} from ${JSON.stringify(module("deploy"))};import {PiNativeExecutionAdapter} from ${JSON.stringify(module("execution-native"))};
import {PiPreparedNativeAuthority} from ${JSON.stringify(module("prepared-native"))};import {recordPiProcessIdentity} from ${JSON.stringify(module("process-identity"))};
import {createPiExecutionModule} from ${JSON.stringify(new URL("../pi-extension/prepared-workflow.ts", import.meta.url).href)};
import {TreehouseClient} from ${JSON.stringify(new URL("./treehouse-fixture.ts", import.meta.url).href)};
const root=${JSON.stringify(f.root)},checkout=${JSON.stringify(f.checkout)},row=${JSON.stringify(row)};
const treehouse=new TreehouseClient({run:args=>{if(args[0]!=='status')throw Error('no checkout effects');return{status:0,stdout:Buffer.from(JSON.stringify([row])),stderr:Buffer.alloc(0)}}});
const authority=new PiPreparedNativeAuthority({root:root+'/native-authority',aiUsageRoot:root});
const adapter={name:'pi',defaultModel:'',sessionFileName:'session-id-pi.txt',allocateSessionId:()=> 'synthetic-retained-source',async preflight(){},installHooks(){},describeTools:()=>({runtime:'pi',markdown:'fixture'}),extractActivity:()=>[],async resume(){throw Error('original only')},
async spawn(opts){const env=process.env,cwd=process.cwd();process.env={...env,...opts.env};process.chdir(checkout);
try{recordPiProcessIdentity(opts.deployId,process.env.PA_DEPLOYMENT_DIR,process.pid);opts.onPid?.(process.pid);
const native=new PiNativeExecutionAdapter({authority,helperDependencies:{treehouse}}),context={cwd:checkout},session=native.resolve(context),tools=new Map(),handlers=new Map();
createPiExecutionModule({nativeAdapter:native})({registerTool:t=>tools.set(t.name,t),on:(n,h)=>handlers.set(n,[...(handlers.get(n)||[]),h])});
const dispatch=async(n,e)=>{for(const h of handlers.get(n)||[]){const r=await h(e,context);if(r!==undefined)return r}};await dispatch('session_start',{});
const control=input=>tools.get('pa_execution').execute('control',input,undefined,undefined,context);
await control({action:'plan',plan:{phaseId:'source-phase',scope:'restart fixture',paths:['source.txt'],requirements:['FR-01'],prerequisites:[],checks:['check'],size:'S',complexity:'bounded',rationale:'Retain actual original failure across restart'}});
const holder=(await control({action:'observe',kind:'holder'})).details.evidence;await control({action:'select',executor:'orchestrator-direct',holder,handover:holder});
const input={command:"node 'check.cjs'",timeout:10};assert.equal(await dispatch('tool_call',{toolName:'bash',toolCallId:'original-failure',input}),undefined);
let result;try{result=await tools.get('bash').execute('original-failure',input,undefined,undefined,context)}catch(error){result=String(error)}
await dispatch('tool_execution_end',{toolName:'bash',toolCallId:'original-failure',result,isError:true});assert.equal(session.service.status(session.actor).originalFailure.exitCode,2);
}finally{process.chdir(cwd);process.env=env}return{sessionId:opts.sessionId,exitCode:0,metadata:{sessionId:opts.sessionId}}}};
const result=await deployWithPi({team:'builder',mode:'orchestrator',repo:'example',ticket:'EX-1',timeout:1800,provider:'openai-codex',model:'gpt-6.1-sol'},adapter,undefined,{treehouse,preparedAuthority:authority});writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));
`);
  execFileSync(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  const previous = JSON.parse(readFileSync(resultPath, "utf8")); assert.equal(previous.status, "failed"); assert.ok(previous.deploymentId);
  let bodyFailure: unknown, resumes = 0;
  const operations: string[] = [];
  const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "not-new", async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture" }), extractActivity: () => [], spawn: async () => { throw Error("must resume"); },
    async resume(opts) {
      resumes++; const env = process.env, cwd = process.cwd(); process.env = { ...env, ...opts.env }; process.chdir(f.checkout);
      try {
        assert.ok(opts.beforeRuntimeStart); recordPiProcessIdentity(opts.deployId, process.env.PA_DEPLOYMENT_DIR!, process.pid); opts.onPid?.(process.pid); opts.beforeRuntimeStart!(process.pid);
        const native = new PiNativeExecutionAdapter({ authority: f.nativeAuthority, helperDependencies: { treehouse } }), context = { cwd: f.checkout }, session = native.resolve(context)!;
        assert.equal(session.contract.lineageId, previous.deploymentId); assert.equal(session.actor.deploymentId, opts.deployId);
        const before = session.service.status(session.actor); assert.equal(before.originalFailure!.exitCode, 2); assert.equal(before.bounds.replacementsUsed, 1);
        const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
        createPiExecutionModule({ nativeAdapter: native })({ registerTool: t => tools.set(t.name, t as PiToolDefinition), on: (n, h) => handlers.set(n, [...(handlers.get(n) ?? []), h]) } as PiRuntime);
        const dispatch = async (name: string, event: unknown) => { for (const h of handlers.get(name) ?? []) { const result = await h(event, context); if (result !== undefined) return result; } };
        await dispatch("session_start", {});
        const control = (input: Record<string, unknown>) => tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
        const observe = async (kind: string, rationale?: string) => (await control({ action: "observe", kind, ...(rationale ? { rationale } : {}) })).details.evidence;
        const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
        const select = async () => { const holder = await observe("holder"); return control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
        let id = 0;
        const execute = async (name: string, input: Record<string, unknown>) => { const call = `resumed-${++id}`; assert.equal(await dispatch("tool_call", { toolName: name, toolCallId: call, input }), undefined);
          const result = await tools.get(name)!.execute(call, input, undefined, undefined, context); await dispatch("tool_execution_end", { toolName: name, toolCallId: call, result, isError: false }); };
        await settle(); await control({ action: "attempt", evidence: await observe("recovery", "The retained actual check failed because source.txt is not repaired.") }); await select();
        await execute("write", { path: "source.txt", content: "repaired after restart\n" }); await execute("bash", { command: "node 'check.cjs'", timeout: 10 });
        await settle(); const pass = session.service.status(session.actor).passedChecks.check!; await control({ action: "resolve", evidence: pass }); await select();
        await execute("bash", { command: "git add -- source.txt" }); await execute("bash", { command: "git commit -m 'restart phase one'" }); await settle();
        const phase = await observe("phase"); const current = f.service.status(waiting.runId); await f.service.reconcile(waiting.runId, current.revision, waiting.pending[0]!.intentId);
        const done = f.service.status(waiting.runId), next = await f.service.requestStep(waiting.runId, done.revision, "source-next", f.authority.decisionId);
        await control({ action: "advance", plan: { ...session.service.status(session.actor).plan!, phaseId: "source-next" }, evidence: phase }); await select();
        await execute("write", { path: "source.txt", content: "repaired second phase\n" }); await execute("bash", { command: "node 'check.cjs'", timeout: 10 });
        await execute("bash", { command: "git add -- source.txt" }); await execute("bash", { command: "git commit -m 'restart phase two'" }); await settle(); await observe("phase");
        const final = f.service.status(waiting.runId); await f.service.reconcile(waiting.runId, final.revision, next.pending[0]!.intentId);
        const state = session.service.status(session.actor); assert.equal(state.bounds.deadlineAt, before.bounds.deadlineAt); assert.equal(state.bounds.replacementsUsed, 1);
        assert.ok(session.evidence.store.records().some(name => JSON.stringify(session.evidence.store.read(name)).includes("original-failure")));
      } catch (error) { bodyFailure = error; throw error; } finally { process.chdir(cwd); process.env = env; }
      return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
    } };
  const retained = f.nativeAuthority.execution()!, records = retained.records().map(name => [name, JSON.stringify(retained.read(name))]);
  for (const flags of [{ background: true }, { force: true }]) {
    const denied = await deployWithPi({ team: "builder", mode: "orchestrator", repo: "example", ticket: "EX-1", resume: previous.deploymentId, timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol", ...flags }, adapter, undefined, { treehouse, preparedAuthority: f.nativeAuthority });
    assert.equal(denied.status, "failed"); assert.equal(resumes, 0); assert.deepEqual(retained.records().map(name => [name, JSON.stringify(retained.read(name))]), records);
  }
  const result = await deployWithPi({ team: "builder", mode: "orchestrator", repo: "example", ticket: "EX-1", resume: previous.deploymentId, timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: f.nativeAuthority, observeOperation: op => operations.push(op) });
  if (bodyFailure) throw bodyFailure;
  assert.equal(result.status, "success", result.reason); assert.equal(resumes, 1);
  for (const operation of ["slot", "permit", "checkout", "branch", "lineage"]) assert.ok(!operations.includes(operation), operation);
  assert.equal(f.service.status(waiting.runId).outcomes["source-next"], "completed");
}, false, true));

test("roadmap Step 2: exact source intent settles from real native checked/committed phase evidence, never agent flags", () => fixture(async f => {
  assert.throws(() => resolvePiStructuredBaseline("example", f.repo, "EX-1"), /WORKFLOW_AUTHORITY/);
  const waiting = await f.service.requestStep(f.state.runId, f.state.revision, "source-phase", f.authority.decisionId);
  assert.equal(waiting.pending.length, 1); assert.equal(waiting.outcomes["source-phase"], undefined);
  assert.equal(existsSync(f.nativeAuthority.evidenceRoot()), false); // request did not allocate/spawn/initialize execution
  let intent = waiting.pending[0]!;
  assert.equal(f.sourceOwner.verify(intent, { state: "proven", outcome: "completed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: "model-passed", version: "v1", sha256: "a".repeat(64) }] }), false);
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const teams = join(f.root, "teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(join(teams, "builder.yaml"), "name: builder\ndescription: Synthetic provider, real native source\nobjective: Fixture\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
  const treehouse = new TreehouseClient({ run: args => {
    if (args[0] !== "status") throw Error("no checkout allocation/return");
    return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: f.checkout, status: "leased", branch: f.bundle.handoff.branch, detached: false, flavor: "git", lease_id: "synthetic-source-intent", lease_holder: "pa:example:EX-1", leased_at: "2026-10-29T00:00:00Z", processes: [] }])), stderr: Buffer.alloc(0) };
  } });
  let bodyFailure: unknown, spawns = 0;
  const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "synthetic-source-intent", async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture" }), extractActivity: () => [], resume: async () => { throw Error("not holder restart qualification"); },
    async spawn(opts) {
      spawns++; const env = process.env, cwd = process.cwd(); process.env = { ...env, ...opts.env }; process.chdir(f.checkout);
      try {
        assert.equal(recordPiProcessIdentity(opts.deployId, process.env.PA_DEPLOYMENT_DIR!, process.pid), true); opts.onPid?.(process.pid);
        const native = new PiNativeExecutionAdapter({ authority: f.nativeAuthority, helperDependencies: { treehouse } }), context = { cwd: f.checkout };
        const session = native.resolve(context)!, bounds = session.service.status(session.actor).bounds;
        const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
        createPiExecutionModule({ nativeAdapter: native })({ registerTool: t => tools.set(t.name, t as PiToolDefinition), on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) } as PiRuntime);
        const dispatch = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) { const result = await handler(event, context); if (result !== undefined) return result; } };
        await dispatch("session_start", {});
        const control = (input: Record<string, unknown>) => tools.get("pa_execution")!.execute("native-control", input, undefined, undefined, context);
        const observe = async (kind: string, rationale?: string) => (await control({ action: "observe", kind, ...(rationale ? { rationale } : {}) })).details.evidence;
        const select = async () => { const holder = await observe("holder"); await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
        const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
        let count = 0;
        const execute = async (name: string, input: Record<string, unknown>) => {
          const id = `source-${++count}`; assert.equal(await dispatch("tool_call", { toolName: name, toolCallId: id, input }), undefined);
          if (count === 1) {
            const before = session.service.status(session.actor);
            assert.equal((await f.sourceOwner.observe(intent)).state, "unknown");
            const current = f.service.status(waiting.runId);
            await assert.rejects(f.service.reconcile(waiting.runId, current.revision, intent.intentId), /WORKFLOW_UNCERTAIN/);
            assert.deepEqual(session.service.status(session.actor), before); assert.equal(before.operation!.id, id);
          }
          let result: unknown, isError = false;
          try { result = await tools.get(name)!.execute(id, input, undefined, undefined, context); } catch (error) { result = String(error); isError = true; }
          await dispatch("tool_execution_end", { toolName: name, toolCallId: id, result, isError }); return { result, isError };
        };
        const plan = { phaseId: "source-phase", scope: "Exact native workflow phase", paths: ["source.txt"], requirements: ["FR-01"], prerequisites: [], checks: ["check"], size: "S", complexity: "bounded", rationale: "Synthetic capture; real native execution, checks and local commit" };
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, phaseId: "foreign-phase" } }), /WORKFLOW_AUTHORITY/);
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, paths: ["outside.txt"] } }), /WORKFLOW_AUTHORITY/);
        assert.equal(session.service.status(session.actor).plan, null);
        await control({ action: "plan", plan }); await select();
        assert.equal((await dispatch("tool_call", { toolName: "bash", toolCallId: "forged-check-environment", input: { command: "node 'check.cjs'", env: { TEST_MODE: "forged" } } }) as { block: boolean }).block, true);
        assert.equal((await execute("bash", { command: "node 'check.cjs'", timeout: 10 })).isError, true);
        const failure = session.service.status(session.actor).originalFailure!; assert.equal(failure.exitCode, 2); await settle();
        const unfinished = await f.service.reconcile(waiting.runId, f.service.status(waiting.runId).revision, intent.intentId);
        assert.equal(unfinished.outcomes["source-phase"], undefined); assert.equal(unfinished.pending[0]!.intentId, intent.intentId);
        assert.deepEqual(session.service.status(session.actor).originalFailure, failure);
        await control({ action: "attempt", evidence: await observe("recovery", "Native exit 2 and declared source input identify the unrepaired content; repair source only.") });
        await select(); assert.equal((await execute("write", { path: "source.txt", content: "repaired\n" })).isError, false);
        assert.equal((await execute("bash", { command: "node 'check.cjs'", timeout: 10 })).isError, false); await settle();
        await control({ action: "resolve", evidence: session.reportFacts().checks.at(-1)!.output }); await select();
        await execute("bash", { command: "git add -- source.txt" }); assert.equal((await execute("bash", { command: "git commit -m 'feat: native workflow source'" })).isError, false); await settle();
        const firstPhaseRef = await observe("phase");
        const firstPhase = session.evidence.read(firstPhaseRef as Parameters<typeof session.evidence.read>[0], "phase") as { workflow: { intentId: string } };
        assert.equal(firstPhase.workflow.intentId, intent.intentId);
        const firstState = f.service.status(waiting.runId), firstComplete = await f.service.reconcile(waiting.runId, firstState.revision, intent.intentId);
        assert.equal(firstComplete.outcomes["source-phase"], "completed"); assert.equal(firstComplete.outcomes["source-next"], undefined);
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan }), /WORKFLOW_AUTHORITY/); // completion is not a new intent
        const secondPending = await f.service.requestStep(waiting.runId, firstComplete.revision, "source-next", f.authority.decisionId); intent = secondPending.pending[0]!;
        await control({ action: "advance", plan: { ...plan, phaseId: "source-next" }, evidence: firstPhaseRef });
        await select();
        assert.equal((await dispatch("tool_call", { toolName: "bash", toolCallId: "premature-second-commit", input: { command: "git commit -m 'feat: stale phase checks'" } }) as { block: boolean }).block, true);
        await execute("write", { path: "source.txt", content: "repaired phase two\n" });
        assert.equal((await execute("bash", { command: "node 'check.cjs'", timeout: 10 })).isError, false);
        await execute("bash", { command: "git add -- source.txt" }); assert.equal((await execute("bash", { command: "git commit -m 'feat: second native source phase'" })).isError, false); await settle();
        const phaseRef = await observe("phase"), nativeState = session.service.status(session.actor);
        const phase = session.evidence.read(phaseRef as Parameters<typeof session.evidence.read>[0], "phase") as { workflow: { intentId: string }; commit: Parameters<typeof session.evidence.read>[0] };
        assert.equal(phase.workflow.intentId, intent.intentId); assert.equal(f.service.status(waiting.runId).outcomes["source-next"], undefined);
        const actual = await f.sourceOwner.observe(intent); assert.equal(actual.state, "proven"); assert.equal(f.sourceOwner.verify(intent, actual), true);
        if (actual.state === "proven") { const original = structuredClone(actual); actual.evidence[0]!.sha256 = "f".repeat(64); assert.equal(f.sourceOwner.verify(intent, actual), false); actual.evidence = original.evidence; }
        assert.equal(f.sourceOwner.verify(intent, { state: "proven", outcome: "completed", evidence: [] }), false);
        // Changed checked bytes/config/output cannot inherit the retained pass.
        const sourcePath = join(f.checkout, "source.txt"), raw = readFileSync(sourcePath); writeFileSync(sourcePath, "foreign change\n");
        assert.equal((await f.sourceOwner.observe(intent)).state, "unknown"); writeFileSync(sourcePath, raw);
        const candidate = f.git(["rev-parse", "HEAD"], f.checkout); f.git(["commit", "--allow-empty", "-qm", "injected foreign candidate"], f.checkout);
        assert.equal((await f.sourceOwner.observe(intent)).state, "unknown"); f.git(["update-ref", `refs/heads/${f.bundle.handoff.branch}`, candidate], f.checkout);
        const configPath = join(f.root, "config/config.yaml"), config = readFileSync(configPath); writeFileSync(configPath, config.toString().replace(/sha256: [0-9a-f]{64}/, `sha256: ${"0".repeat(64)}`));
        assert.equal((await f.sourceOwner.observe(intent)).state, "unknown"); writeFileSync(configPath, config);
        const commit = session.evidence.read(phase.commit, "tool-result") as { process: { stdout: { name: string } } };
        const outputPath = join(f.nativeAuthority.evidenceRoot(), commit.process.stdout.name), output = readFileSync(outputPath); unlinkSync(outputPath);
        assert.equal((await f.sourceOwner.observe(intent)).state, "unknown"); writeFileSync(outputPath, output, { mode: 0o600 });
        assert.equal((await f.sourceOwner.observe({ ...intent, decisionId: "foreign-decision" })).state, "unknown");
        const current = f.service.status(waiting.runId); await f.service.revoke(waiting.runId, current.revision, f.authority.decisionId);
        assert.throws(() => session.service.apply(session.actor, { action: "plan", plan }), /WORKFLOW_AUTHORITY/); // no new effects after revoke
        const revoked = f.service.status(waiting.runId), settled = await f.service.reconcile(waiting.runId, revoked.revision, intent.intentId);
        assert.equal(settled.outcomes["source-phase"], "completed"); assert.equal(settled.outcomes["source-next"], "completed"); assert.equal(settled.pending.length, 0);
        assert.equal(settled.decisions.length, 1); // two exact native phases, no repeated unchanged package approval
        assert.deepEqual(session.service.status(session.actor), nativeState); assert.equal(nativeState.bounds.deadlineAt, bounds.deadlineAt);
        assert.equal(session.reportFacts().checks[0]!.exitCode, 2); assert.equal(f.journal.runs("example", "EX-1").length, 1);
      } catch (error) { bodyFailure = error; throw error; } finally { process.chdir(cwd); process.env = env; }
      return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
    } };
  const result = await deployWithPi({ team: "builder", mode: "orchestrator", repo: "example", ticket: "EX-1", timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: f.nativeAuthority });
  if (bodyFailure) throw bodyFailure;
  assert.equal(result.status, "success", result.reason); assert.equal(spawns, 1);
}, false, true));

test("pinned native start binds scope/commands; new work rejects foreign, revoked and legacy-start authority", () => fixture(async f => {
  const note = structuredLaunchNote("ordinary-native-execution/v1", f.authority); assert.deepEqual(parseStructuredLaunchNote(note), f.authority);
  const authorize = (paths = ["src/a.ts"], checks = ["check"]) => authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped", { paths, checks }, f.authority);
  assert.equal(authorize()!.runId, f.state.runId);
  assert.throws(() => authorize(["outside.ts"]), /WORKFLOW_AUTHORITY/); assert.throws(() => authorize(undefined, ["unapproved"]), /WORKFLOW_AUTHORITY/);
  assert.throws(() => authorizePiStructuredWork("example", f.repo, "EX-1", f.bundle.handoff.branch, "source.edit-scoped"), /WORKFLOW_AUTHORITY/);
  await f.service.revoke(f.state.runId, f.state.revision, f.authority.decisionId); assert.throws(authorize, /WORKFLOW_AUTHORITY/);
  assert.equal(f.service.status(f.state.runId).decisions.length, 1);
}));
