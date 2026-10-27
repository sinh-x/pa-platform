import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPiForegroundCompletion, closeDb, appendRegistryEvent, getDb, getDeploymentEvents, repositoryMutationLeasePath, repositoryTicketSlotPath, observeReadonlyRepositoryTicketSlot, preparedRepositoryTicketReservationPath, withPreparedTicketCapacity, PreparedWorkflowService, ProtectedWorkflowStore, withPreparedWorkflowLocks, workflowDigest, type SourceVersion, type RuntimeAdapter, type SpawnOpts } from "@pa-platform/pa-core";
import { deployWithPi, consumePiPreparedBuilderAdmission } from "../deploy.js";
import { seedOrdinaryTaskBaseline, seedOrdinaryCommandFixture } from "./ordinary-task-fixture.js";
import { TreehouseClient } from "../treehouse.js";
import { PiPreparedNativeAuthority, currentPreparedNativeRuntime, type PreparedNativeRuntime } from "../prepared-native.js";
import { PiNativeExecutionAdapter, ORDINARY_NATIVE_EXECUTION_START } from "../execution-native.js";
import { PiNativePhaseReportAdapter } from "../phase-report-native.js";
import { recordPiProcessIdentity, recordPiReadonlyRoleProcessIdentity } from "../process-identity.js";
import { createPiPreparationHost, createPiPreparationTool, createPiWorkflowPolicyModule, createPiExecutionModule, createPiPhaseReportModule, resolveNativePiPreparationBinding, type PiPreparationCaller, type PiPreparationContext } from "../pi-extension/prepared-workflow.js";
import { createPaTools, interceptToolCall, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";
const time = "2026-10-17T00:00:00.000Z"; const sha = "a".repeat(40);
const facts: PreparedNativeRuntime = { sourceSha: sha, packageVersion: "fixture", configSha: "b".repeat(40), storeRoot: "/fixture/immutable-runtime" };
const env = { PA_TEAM: "requirements", PA_MODE: "analyze", PA_PI_EXECUTION_MODE: "foreground" };
const ref = (name: string): SourceVersion => ({ ref: name, version: "fixture/v1", sha256: workflowDigest(name) });
function save(path: string, bytes: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); }
function seedQualification(root: string) {
  const store = new ProtectedWorkflowStore(root); const refs: Record<string, SourceVersion> = {};
  withPreparedWorkflowLocks({ repository: (run) => run(), worktree: (run) => run() }, (scope) => {
    for (const kind of ["review", "ci", "pairing", "humanUat", "delivery"]) {
      const id = workflowDigest(`native-fixture-${kind}`);
      const evidence = { schemaVersion: "prepared-native-evidence/v1", kind, runtime: facts, result: "passed", source: ref(`native-fixture:${kind}`), capturedAt: time };
      store.publish(scope, `${id}.intent.json`, evidence);
      refs[kind] = { ref: `native-prepared-evidence:${id}`, version: "prepared-native-evidence/v1", sha256: workflowDigest(JSON.stringify(evidence)) };
    }
    const id = workflowDigest(JSON.stringify(["prepared-native-qualification/v1", facts]));
    store.publish(scope, `${id}.intent.json`, { schemaVersion: "prepared-native-qualification/v1", runtime: facts, ...refs });
  });
}
function setup(root: string) {
  const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  const ai = join(root, "ai"); const native = join(root, "authority/native"); mkdirSync(native, { recursive: true, mode: 0o700 });
  const config = join(root, "config");
  save(join(config, "config.yaml"), `repos:\n  fixture-repo:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
  process.env.PA_PLATFORM_CONFIG = config;
  let currentFacts = facts;
  const caller: PiPreparationCaller = { deploymentId: "d-123abc", repoKey: "fixture-repo", repoRoot: repo, ticket: "PAP-256", callerIdentity: "c".repeat(64) };
  const authority = new PiPreparedNativeAuthority({ root: join(root, "authority"), aiUsageRoot: ai, runtime: () => currentFacts, now: () => time });
  const requirementsRef = "requirements:agent-teams/requirements/artifacts/promoted.md";
  const uatRef = "uat:agent-teams/requirements/artifacts/promoted-uat.md";
  const checkRef = "agent-teams/requirements/artifacts/final-checks.json";
  const golden = readFileSync(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url), "utf8");
  const matrix = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(golden)![1]!);
  matrix.source = requirementsRef; matrix.repository = { key: caller.repoKey, root: repo, baseSha: sha, branch: "feature/PAP-256-fixture" };
  matrix.environment.PA_TICKET_ID.literal = caller.ticket;
  matrix.prerequisites.find((row: { kind: string }) => row.kind === "operatorGate").ticket = caller.ticket;
  const region = `### Full Validation Matrix\n\n\`\`\`json\n${JSON.stringify(matrix, null, 2)}\n\`\`\`\n\n`;
  const digest = workflowDigest(region);
  const commentId = "c-20261017000000000";
  const requirement = `# Promoted fixture\n\n> Status: Approved — requirements plan only\n> Author: requirements/analyst\n> Route: builder/implement\n> Ticket: ${caller.ticket}\n> Repository Key: ${caller.repoKey}\n> Repository Root: ${repo}\n> Handoff Type: amendment\n> Retained Base SHA: ${sha}\n> Feature Branch: feature/PAP-256-fixture\n> Review Revision: r004\n> Shape-Conformance: 13/13\n> Review Companion UAT: ${uatRef}; exact retained source\n> Review Record: ${checkRef}; retained history\n> Review Approval Evidence: ${caller.ticket} comment ${commentId} by sinh\n> Matrix Approval Evidence: ${caller.ticket} comment ${commentId} by sinh\n> Matrix Source: ${requirementsRef}\n> Matrix Authority SHA-256: ${digest}\n\n${region}## After matrix\n\nRetained conditional handoff.\n`;
  const uat = `# UAT plan\n\n> Status: Approved UAT plan; not product acceptance\n> Ticket: ${caller.ticket}\n> Review Revision: r004\n`;
  const checks = { stage: "final", revision: "r004", shapeConformance: "13/13", passed: 13, total: 13,
    requirementsSha256: workflowDigest(requirement), uatSha256: workflowDigest(uat), matrixAuthoritySha256: digest,
    checks: Array.from({ length: 13 }, (_, index) => ({ number: index + 1, status: "pass" })) };
  const requirementPath = join(ai, requirementsRef.slice("requirements:".length));
  const uatPath = join(ai, uatRef.slice("uat:".length)); const checkPath = join(ai, checkRef);
  save(requirementPath, requirement); save(uatPath, uat); save(checkPath, JSON.stringify(checks));
  const ticketPath = join(ai, "tickets/PAP-256.json");
  const ticket = { id: caller.ticket, project: caller.repoKey, doc_refs: [{ type: "requirements", path: requirementsRef.slice("requirements:".length) }, { type: "uat", path: uatRef.slice("uat:".length) }],
    linkedBranches: [{ repo: caller.repoKey, branch: "feature/PAP-256-fixture", state: "planned" }],
    comments: [{ id: commentId, author: "sinh", content: `Approve ${requirementsRef} feature/PAP-256-fixture ${digest}` }] };
  save(ticketPath, JSON.stringify(ticket));
  const policyTools: PiToolDefinition[] = [];
  createPiWorkflowPolicyModule({ env, nativeAuthority: authority, authenticateCaller: () => caller })({ registerTool: (tool: PiToolDefinition) => policyTools.push(tool) } as PiRuntime);
  const context = (select: NonNullable<PiPreparationContext["ui"]>["select"] = async (_title, choices) => choices[0]): PiPreparationContext => ({ mode: "tui", cwd: repo, ui: { select } });
  const execute = (action: string, ctx = context()) => policyTools[0]!.execute("native-policy-tool", { action }, undefined, undefined, ctx);
  return { root, repo, ai, native, authority, caller, requirementPath, uatPath, checkPath, ticketPath, requirementsRef, context, execute, ticket, checks,
    qualify: () => seedQualification(native), driftRuntime: () => { currentFacts = { ...facts, sourceSha: "d".repeat(40) }; } };
}
async function fixture(run: (f: ReturnType<typeof setup>) => unknown | Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), "pap256-native-")); const previous = process.env.PA_PLATFORM_CONFIG;
  try { await run(setup(root)); } finally {
    if (previous === undefined) delete process.env.PA_PLATFORM_CONFIG; else process.env.PA_PLATFORM_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("native authority and capacity storage are denied at exposed read/write/edit/shell paths, including aliases", () => fixture((f) => {
  const directory = join(f.root, ".local/share/pa-platform/prepared-autonomy/native"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = join(directory, "record.intent.json"); writeFileSync(record, "PRIVATE-NATIVE-RECORD", { mode: 0o600 });
  const alias = join(f.root, "innocent-alias"); symlinkSync(record, alias);
  for (const path of [directory, record, alias, join(f.repo, ".git/pa-ticket-builder-slots/hash.prepared.json")]) {
    for (const name of ["read", "write", "edit"]) assert.equal(interceptToolCall({ name, input: { path } }).allowed, false, `${name}: protected authority`);
    for (const name of ["bash", "shell", "execute", "functions.bash"]) assert.equal(interceptToolCall({ name, input: { command: `cat '${path}'` } }).allowed, false);
  }
  assert.equal(interceptToolCall({ name: "functions.bash", input: { command: "git push --force origin HEAD" } }).allowed, false);
  assert.equal(interceptToolCall({ name: "question", input: { question: `Explain the native namespace ${directory}`, options: [] } }).allowed, true);
}));

test("native default ignores environment authority roots, absent records leave baseline inactive with no writes", () => fixture(async (f) => {
  const absent = new PiPreparedNativeAuthority({ root: join(f.root, "absent"), aiUsageRoot: f.ai, runtime: () => { throw new Error("must not read runtime while absent"); } });
  assert.equal(absent.status(f.caller).active, false); assert.equal(absent.resolve(f.caller), null);
  const tool = createPiPreparationTool({ env, nativeAuthority: absent, authenticateCaller: () => f.caller });
  assert.equal((await tool.execute("status", { action: "status" }, undefined, undefined, f.context())).details.state, "inactive");
  await assert.rejects(tool.execute("request", { action: "request" }, undefined, undefined, f.context()));
  assert.equal(readdirSync(f.root).includes("absent"), false);
  const previous = process.env.PA_PLATFORM_DATA; process.env.PA_PLATFORM_DATA = f.root;
  try { assert.equal(new PiPreparedNativeAuthority().root, join(userInfo().homedir, ".local/share/pa-platform/prepared-autonomy")); }
  finally { if (previous === undefined) delete process.env.PA_PLATFORM_DATA; else process.env.PA_PLATFORM_DATA = previous; }
  assert.throws(() => currentPreparedNativeRuntime()); // source checkout is not an installed qualification target
}));

test("native activation requires all five protected qualified exact-revision receipts BEFORE UI; public prose is no capability", () => fixture(async (f) => {
  let prompted = false;
  await assert.rejects(f.execute("activate", f.context(async () => { prompted = true; return "Activate only these exact qualified revisions"; })));
  assert.equal(prompted, false); assert.equal(f.authority.status(f.caller).active, false);
  f.qualify(); const result = await f.execute("activate"); assert.equal(result.details.active, true);
  assert.equal(f.authority.resolve(f.caller), null); // activation is not a ticket/source grant
  const tool = createPiPreparationTool({ env, nativeAuthority: f.authority, authenticateCaller: () => f.caller });
  await assert.rejects(tool.execute("request", { action: "request" }, undefined, undefined, f.context()));
}));

test("real native binding resolves exact promoted sources, 13 checks and retained amendment without rewriting review parser", () => fixture(async (f) => {
  f.qualify(); await f.execute("activate"); f.authority.preview(f.caller, f.requirementsRef); await f.execute("bind");
  const grant = f.authority.resolve(f.caller); assert.ok(grant);
  assert.equal(grant.contract.approvalBaseSha, sha); assert.equal(grant.contract.requirements.ref, f.requirementsRef);
  const binding = resolveNativePiPreparationBinding(f.caller, f.authority, () => f.caller); assert.ok(binding);
  assert.equal(binding.service.status(binding.contract).state, "not-requested");
  // This is the concrete production authority, not an injected authorize callback.
  binding.service.host.authorize("request", binding.contract, null);
  assert.equal(readdirSync(join(f.root, "authority/operations")).length, 0);
  writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8") + "material drift\n");
  assert.throws(() => binding.service.host.authorize("request", binding.contract, null));
  assert.throws(() => f.authority.resolve(f.caller));
}));

test("native capture cancellation, caller/source drift and forged schema cannot publish a grant", () => fixture(async (f) => {
  f.qualify(); await f.execute("activate");
  const before = readdirSync(f.native);
  const cancelled = await f.execute("bind", f.context(async () => undefined)); assert.equal(cancelled.details.state, "cancelled");
  assert.deepEqual(readdirSync(f.native), before);
  await assert.rejects(f.execute("bind", f.context(async (_title, choices) => {
    if (choices.length === 2) writeFileSync(f.uatPath, readFileSync(f.uatPath, "utf8") + "changed\n");
    return choices[0];
  })));
  assert.deepEqual(readdirSync(f.native), before);
}));

for (const corruption of ["draft-uat", "one-failed-check", "wrong-matrix", "forged-author", "dual-route", "auto-source"] as const) {
  test(`native promotion verifier rejects ${corruption} before policy/grant effects`, () => fixture((f) => {
    if (corruption === "draft-uat") writeFileSync(f.uatPath, readFileSync(f.uatPath, "utf8").replace("Approved", "Draft"));
    if (corruption === "one-failed-check") writeFileSync(f.checkPath, JSON.stringify({ ...f.checks, checks: f.checks.checks.map((check, i) => i === 5 ? { ...check, status: "failed" } : check) }));
    if (corruption === "wrong-matrix") writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8").replace('"commandCount": 1', '"commandCount": 2'));
    if (corruption === "forged-author") writeFileSync(f.ticketPath, JSON.stringify({ ...f.ticket, comments: [{ ...f.ticket.comments[0], author: "requirements/analyst" }] }));
    if (corruption === "dual-route") writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8").replace("> Handoff Type: amendment", `> Approved Base SHA: ${sha}\n> Handoff Type: amendment`));
    if (corruption === "auto-source") writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8").replace("Author: requirements/analyst", "Author: requirements/autonomous-analyst"));
    assert.throws(() => f.authority.preview(f.caller, f.requirementsRef));
    assert.equal(readdirSync(f.native).length, 0);
  }));
}

test("native revocation prevents new requests without deleting reservations or silently reactivating; mismatch fails closed", () => fixture(async (f) => {
  f.qualify(); await f.execute("activate"); await f.execute("bind");
  const binding = resolveNativePiPreparationBinding(f.caller, f.authority, () => f.caller); assert.ok(binding);
  await f.execute("deactivate"); assert.equal(f.authority.resolve(f.caller), null);
  assert.throws(() => binding.service.host.authorize("request", binding.contract, null));
  await assert.rejects(f.execute("activate"));
  assert.ok(readdirSync(f.native).some((name) => name.endsWith(".transaction-1.json")));
  assert.ok(readdirSync(f.native).some((name) => name.endsWith(".intent.json")));
}));

test("insecure private records and qualified-runtime drift are not fallback authority", () => fixture(async (f) => {
  f.qualify(); await f.execute("activate"); await f.execute("bind");
  f.driftRuntime(); assert.equal(f.authority.resolve(f.caller), null);
  const qualified = new PiPreparedNativeAuthority({ root: join(f.root, "authority"), aiUsageRoot: f.ai, runtime: () => facts });
  const grant = qualified.resolve(f.caller); assert.ok(grant);
  chmodSync(join(f.native, `${grant.grantId}.intent.json`), 0o644);
  assert.throws(() => qualified.resolve(f.caller));
}));

async function reportFixture(run: (f: ReturnType<typeof setup> & { runtime: ReturnType<typeof executionRuntime>; context: PiPreparationContext; report: PiToolDefinition; actorId: string; directory: string }) => Promise<void>) {
  const previousEnv = process.env; const previousCwd = process.cwd(); process.env = { ...previousEnv };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  try { await fixture(async (f) => {
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(f.repo, "README.md"), "report fixture\n"); git(["add", "README.md"]); git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
    f.qualify(); await f.execute("activate");
    const actorId = "d-654abc"; const deploymentDir = join(f.ai, "deployments", actorId); mkdirSync(deploymentDir, { recursive: true, mode: 0o700 });
    Object.assign(process.env, { PA_AI_USAGE_HOME: f.ai, PA_REGISTRY_DB: join(f.ai, "registry.db"), PA_DEPLOYMENT_ID: actorId, PA_DEPLOYMENT_DIR: deploymentDir,
      PA_TEAM: "rogue-one", PA_MODE: "rogue-one", PA_REPO: f.repo, PA_WORKTREE_ROOT: f.repo, PA_PI_EXECUTION_MODE: "foreground", TEST_PRIVATE_TOKEN: "report-private-fixture-token" });
    appendRegistryEvent({ deployment_id: actorId, team: "rogue-one", mode: "rogue-one", rogue_one: true, runtime: "pi", binary: "ppa", event: "started", timestamp: time,
      pid: process.pid, repo: f.repo, repo_root: f.repo, worktree_root: f.repo });
    recordPiReadonlyRoleProcessIdentity(process.env, actorId, deploymentDir, process.pid); process.chdir(f.repo);
    const runtime = executionRuntime(); const context: PiPreparationContext = { mode: "tui", cwd: f.repo, ui: { select: async (_title, choices) => choices[0] } };
    createPiPhaseReportModule({ nativeAdapter: new PiNativePhaseReportAdapter({ authority: f.authority }) })(runtime.pi);
    await run({ ...f, runtime, context, report: runtime.tools.get("pa_phase_report")!, actorId, directory: deploymentDir });
  }); } finally { closeDb(); process.chdir(previousCwd); process.env = previousEnv; }
}

test("native report default remains inactive and effect-free without a captured policy/owner intent", () => fixture(async (f) => {
  const runtime = executionRuntime();
  createPiPhaseReportModule({ env: { PA_TEAM: "rogue-one" }, nativeAdapter: new PiNativePhaseReportAdapter({ authority: f.authority }) })(runtime.pi);
  const report = runtime.tools.get("pa_phase_report")!;
  assert.equal((await report.execute("status", { action: "status" }, undefined, undefined, {})).details.artifactAuthorityAvailable, false);
  await assert.rejects(report.execute("capture", { action: "capture", phaseId: "phase-4", summary: "no authority", nextAction: "stop", learning: "not approved" }, undefined, undefined, {}));
  assert.equal(f.authority.reports(), null); assert.equal(existsSync(join(f.ai, "agent-teams/rogue-one/artifacts")), false);
}));

test("native ticketless report capture/publish uses actual actor evidence, preserves ownership and never invents checks", () => reportFixture(async (f) => {
  const capacity = readdirSync(join(f.repo, ".git/pa-ticket-builder-slots"));
  writeFileSync(join(f.repo, ".env"), "UNRELATED-CONTENT-MUST-NOT-BE-READ\n");
  const draft = { action: "capture", phaseId: "phase-4", summary: "Agent note report-private-fixture-token", nextAction: "Verify unproven checks.", learning: "Do not infer acceptance." };
  const capture = await f.report.execute("capture-1", draft, undefined, undefined, f.context);
  assert.deepEqual((await f.report.execute("capture-1", draft, undefined, undefined, f.context)).details.source, capture.details.source);
  await assert.rejects(f.report.execute("capture-1", { ...draft, summary: "conflicting retry" }, undefined, undefined, f.context));
  const published = await f.report.execute("publish-1", { action: "publish", source: capture.details.source }, undefined, undefined, f.context);
  assert.equal(published.details.outcome, "partial"); assert.equal(published.details.canonicalEvidenceAvailable, true);
  assert.deepEqual(published.details.presentationDebt, ["browser", "obsidian"]); assert.equal(published.details.phaseDeliveryReady, false);
  assert.equal(published.details.dependentWorkMayContinue, false); assert.equal(published.details.dependencyState, "missing-check-evidence");
  const root = join(f.ai, "agent-teams/rogue-one/artifacts"); const reportDir = join(root, `2026-10-17-ticketless-phase-4-${f.actorId}`, "attempt-1");
  const markdown = readFileSync(join(reportDir, "report.md"), "utf8");
  assert.match(markdown, /No checks recorded/); assert.match(markdown, /REDACTED/);
  assert.doesNotMatch(markdown, /UNRELATED-CONTENT-MUST-NOT-BE-READ|report-private-fixture-token|\? \.env/);
  assert.equal(readFileSync(join(f.repo, ".env"), "utf8"), "UNRELATED-CONTENT-MUST-NOT-BE-READ\n");
  assert.match(readFileSync(join(reportDir, "report.html"), "utf8"), /diff.patch/);
  const owner = join(root, `2026-10-17-ticketless-${f.actorId}-owner.md`);
  writeFileSync(owner, `${readFileSync(owner, "utf8")}\nHuman follow-up remains outside managed markers.\n`); const before = readFileSync(owner);
  const duplicate = await f.report.execute("publish-2", { action: "publish", source: capture.details.source }, undefined, undefined, f.context);
  assert.deepEqual(duplicate.details.report, published.details.report); assert.deepEqual(readFileSync(owner), before);
  assert.deepEqual(readdirSync(join(f.repo, ".git/pa-ticket-builder-slots")), capacity);
  await assert.rejects(f.report.execute("forged", { ...draft, passed: true }, undefined, undefined, f.context));
  process.env.PA_TICKET_ID = "PAP-999";
  await assert.rejects(f.report.execute("forged-actor", { action: "publish", source: capture.details.source }, undefined, undefined, f.context));
  delete process.env.PA_TICKET_ID;
  writeFileSync(join(f.repo, "README.md"), "new unrelated metadata\n");
  const historical = await f.report.execute("historical", { action: "status", report: published.details.report }, undefined, undefined, f.context);
  assert.equal(historical.details.canonicalEvidenceAvailable, true); assert.equal(historical.details.dependencyState, "historical");
}));

test("native report delivery needs foreground UI observation and source revalidation; durable debt survives reload/revocation", () => reportFixture(async (f) => {
  const captured = await f.report.execute("capture", { action: "capture", phaseId: "phase-4", summary: "Partial native report", nextAction: "Observe reading views.", learning: "Generation is not observation." }, undefined, undefined, f.context);
  const published = await f.report.execute("publish", { action: "publish", source: captured.details.source }, undefined, undefined, f.context);
  const reference = published.details.report;
  const unobserved = { ...f.context, ui: { select: async () => undefined } };
  assert.equal((await f.report.execute("cancel", { action: "observe-delivery", report: reference, application: "browser" }, undefined, undefined, unobserved)).details.observation, "not-observed");
  await assert.rejects(f.report.execute("rpc", { action: "observe-delivery", report: reference, application: "browser" }, undefined, undefined, { ...f.context, mode: "rpc" }));
  const browser = await f.report.execute("browser", { action: "observe-delivery", report: reference, application: "browser" }, undefined, undefined, f.context);
  assert.deepEqual(browser.details.presentationDebt, ["obsidian"]); assert.equal(browser.details.humanProductUatClaimed, false);
  f.authority.deactivate(f.caller);
  const fresh = executionRuntime(); createPiPhaseReportModule({ nativeAdapter: new PiNativePhaseReportAdapter({ authority: f.authority }) })(fresh.pi);
  const tool = fresh.tools.get("pa_phase_report")!;
  assert.deepEqual((await tool.execute("status", { action: "status", report: reference }, undefined, undefined, f.context)).details.presentationDebt, ["obsidian"]);
  const obsidian = await tool.execute("obsidian", { action: "observe-delivery", report: reference, application: "obsidian" }, undefined, undefined, f.context);
  assert.deepEqual(obsidian.details.presentationDebt, []); assert.equal(obsidian.details.phaseDeliveryReady, false); // partial is never product/phase acceptance
  const reportDir = join(f.ai, "agent-teams/rogue-one/artifacts", `2026-10-17-ticketless-phase-4-${f.actorId}`, "attempt-1");
  writeFileSync(join(reportDir, "report.md"), "tampered");
  await assert.rejects(tool.execute("tampered", { action: "status", report: reference }, undefined, undefined, f.context));
}));

test("native report observation cannot survive source-byte replacement during the UI turn", () => reportFixture(async (f) => {
  const capture = await f.report.execute("capture", { action: "capture", phaseId: "phase-4", summary: "Partial native report", nextAction: "Inspect source-bound view.", learning: "Revalidate after UI." }, undefined, undefined, f.context);
  const published = await f.report.execute("publish", { action: "publish", source: capture.details.source }, undefined, undefined, f.context);
  const root = join(f.ai, "agent-teams/rogue-one/artifacts");
  const recordCount = () => f.authority.reports(false, f.actorId)!.records().filter((name) => name.endsWith(".intent.json")).filter((name) => (f.authority.reports(false, f.actorId)!.read(name) as { kind?: string }).kind === "report-delivery").length;
  const before = recordCount();
  const context = { ...f.context, ui: { select: async (_title: string, choices: string[]) => { writeFileSync(join(root, `2026-10-17-ticketless-phase-4-${f.actorId}`, "attempt-1/report.md"), "replaced during UI"); return choices[0]; } } };
  await assert.rejects(f.report.execute("stale-view", { action: "observe-delivery", report: published.details.report, application: "browser" }, undefined, undefined, context));
  assert.equal(recordCount(), before);
}));

async function resourceFixture(run: (f: ReturnType<typeof setup> & { checkout: string; base: string; treehouse: TreehouseClient; service: PreparedWorkflowService; gets: () => number; deploy: (onSpawn?: (options: SpawnOpts) => void | Promise<void>, preflight?: () => Promise<void>) => ReturnType<typeof deployWithPi>; git: (args: string[], cwd?: string) => string }) => unknown | Promise<unknown>) {
  const previous = process.env; process.env = { ...previous };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  try {
    await fixture(async (f) => {
      const git = (args: string[], cwd = f.repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
      git(["symbolic-ref", "HEAD", "refs/heads/develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
      writeFileSync(join(f.repo, "README.md"), "approved fixture\n"); git(["add", "README.md"]); git(["commit", "-m", "approved fixture"]);
      const base = git(["rev-parse", "HEAD"]); git(["clone", "--bare", f.repo, join(f.root, "remote.git")], f.root); git(["remote", "add", "origin", join(f.root, "remote.git")]);
      const checkout = join(f.root, "checkout"); git(["worktree", "add", "--detach", checkout, base]);
      let requirement = readFileSync(f.requirementPath, "utf8").replaceAll(sha, base);
      const region = /^### Full Validation Matrix[\s\S]*?(?=^## After matrix)/m.exec(requirement)![0];
      const digest = workflowDigest(region); const oldDigest = f.checks.matrixAuthoritySha256;
      requirement = requirement.replaceAll(oldDigest, digest); writeFileSync(f.requirementPath, requirement);
      writeFileSync(f.checkPath, JSON.stringify({ ...f.checks, requirementsSha256: workflowDigest(requirement), matrixAuthoritySha256: digest }));
      writeFileSync(f.ticketPath, JSON.stringify({ ...f.ticket, status: "implementing", title: "Native launch fixture", comments: f.ticket.comments.map((comment) => ({ ...comment, content: comment.content.replace(oldDigest, digest) })) }));
      let gets = 0; let leased = false;
      const treehouse = new TreehouseClient({ run(args, cwd) {
        assert.equal(cwd, f.repo);
        const result = (value: unknown) => ({ status: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });
        if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
        const lease = { path: checkout, lease_id: "native-fixture-lease", lease_holder: "pa:fixture-repo:PAP-256", leased_at: "2026-10-17T00:00:00Z" };
        if (args[0] === "status") return result([{ name: "1", path: checkout, status: leased ? "leased" : "available", branch: "", detached: true, flavor: "git", lease_id: leased ? lease.lease_id : "", lease_holder: leased ? lease.lease_holder : "", leased_at: leased ? lease.leased_at : null, processes: [] }]);
        if (args[0] === "get") { gets++; leased = true; return result({ ...lease, base_branch: "develop" }); }
        throw new Error("unlisted Treehouse resource operation");
      } });
      f.qualify(); await f.execute("activate"); await f.execute("bind");
      const grant = f.authority.resolve(f.caller); assert.ok(grant);
      const store = f.authority.operations(); assert.ok(store);
      const host = createPiPreparationHost(grant.contract, { treehouse, ticketStore: f.authority.tickets(), authorize: (op, contract, evidence) => f.authority.authorize(f.caller, grant, op, contract, evidence), assertCurrentBindings: () => f.authority.assertCurrent(f.caller, grant), now: () => time });
      const service = new PreparedWorkflowService(store, host); assert.equal(service.request(grant.contract).state, "ready");
      process.env.PA_AI_USAGE_HOME = f.ai; process.env.PA_REGISTRY_DB = join(f.ai, "registry.db"); process.env.PA_PLATFORM_HOME = f.root;
      save(join(f.root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Implement\nagents: []\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n  - id: implement\n    label: Implement\n    require_ticket: true\n");
      const deploy = (onSpawn?: (opts: SpawnOpts) => void | Promise<void>, preflight = async () => {}) => {
        const adapter: RuntimeAdapter & { preflight: () => Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "native-fixture-session", preflight,
          installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture tools" }), extractActivity: () => [],
          async spawn(opts) { await onSpawn?.(opts); return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
          resume() { throw new Error("unexpected resume"); } };
        return deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-256", repo: "fixture-repo", provider: "openai-codex", model: "gpt-6.1-sol", objective: "Native prepared launch fixture" }, adapter, undefined, { treehouse, preparedAuthority: f.authority });
      };
      await run({ ...f, checkout, base, treehouse, service, gets: () => gets, deploy, git });
    });
  } finally { closeDb(); process.env = previous; }
}

function executionRuntime() {
  const tools = new Map<string, PiToolDefinition>();
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const pi = { registerTool(tool: PiToolDefinition) { tools.set(tool.name, tool); }, on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as PiRuntime;
  return { pi, tools, async dispatch(name: string, event: unknown, context: unknown) { for (const handler of handlers.get(name) ?? []) { const result = await handler(event, context); if (result !== undefined) return result; } } };
}

test("native real launch -> actual SDK write/edit/bash -> private results, bounded recovery and commit settlement", () => resourceFixture(async (f) => {
  const beforeCanonical = f.git(["rev-parse", "HEAD"]); const previousCwd = process.cwd();
  const manager = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).packageManager;
  f.git(["config", "commit.gpgsign", "false"]); f.git(["config", "core.hooksPath", join(f.root, "empty-hooks")]); mkdirSync(join(f.root, "empty-hooks"));
  let bodyFailure: unknown;
  const launched = await f.deploy(async (opts) => {
    const previousEnv = process.env; process.env = { ...previousEnv, ...opts.env, TEST_PRIVATE_TOKEN: "native-test-private-output-value" }; process.chdir(f.checkout);
    try {
      assert.equal(opts.executionPlan?.timeoutSeconds, 7200);
      assert.equal(recordPiProcessIdentity(opts.deployId, join(f.ai, "deployments", opts.deployId), process.pid), true); opts.onPid?.(process.pid);
      const adapter = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } });
      const runtime = executionRuntime(); const context = { cwd: f.checkout };
      createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi);
      await runtime.dispatch("session_start", {}, context);
      assert.deepEqual([...runtime.tools.keys()], ["pa_execution", "pa_feature_update", "pa_ticket", "bash", "write", "edit"]);
      const control = (input: Record<string, unknown>) => runtime.tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
      const observe = async (kind: string) => (await control({ action: "observe", kind })).details.evidence as SourceVersion;
      const select = async () => { const holder = await observe("holder"); await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
      const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
      let sequence = 0;
      const execute = async (name: string, input: Record<string, unknown>, claimedSuccess = false) => {
        const id = `native-${++sequence}`;
        assert.equal(await runtime.dispatch("tool_call", { toolName: name, toolCallId: id, input }, context), undefined);
        let result: unknown; let failed = false;
        try { result = await runtime.tools.get(name)!.execute(id, input, undefined, undefined, context); } catch (error) { failed = true; result = String(error); }
        try { await runtime.dispatch("tool_execution_end", { toolName: name, toolCallId: id, result: claimedSuccess ? { exitCode: 0, text: "PASS, regardless of real exit" } : result, isError: claimedSuccess ? false : failed }, context); }
        catch (error) {
          const proof = session.evidence.read(session.observe("last-result"), "tool-result") as { scopeValid: boolean; settlementError: string | null; process: { groupSettled: boolean } | null };
          assert.fail(`Native end rejected: ${JSON.stringify({ scopeValid: proof.scopeValid, settlementError: proof.settlementError, groupSettled: proof.process?.groupSettled })}; ${String(error)}`);
        }
        return { result, failed };
      };
      assert.equal((await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "unplanned", input: { path: "src/file.ts", content: "no" } }, context) as { block: boolean }).block, true);
      await control({ action: "plan", plan: { phaseId: "phase-3", scope: "isolated native direct fixture", paths: ["src/file.ts", "package.json"], requirements: ["AC8", "AC10"], prerequisites: [], checks: ["typecheck"], size: "bounded", complexity: "bounded", rationale: "Exercise direct native custody; not installed qualification." } });
      await select();
      const session = adapter.resolve(context)!;
      // PAP-263: native liveness and custody checks, not error-text guesses. All
      // record manipulation here is confined to this test's disposable fixture.
      const beforeDiagnostics = session.evidence.store.records();
      appendRegistryEvent({ deployment_id: opts.deployId, team: "builder", event: "pid", timestamp: time, pid: process.pid + 1 });
      try {
        for (const input of [{ action: "status" }, { action: "observe", kind: "holder" }]) {
          await assert.rejects(control(input), /Source: EXECUTION_CALLER_STALE\/caller/);
        }
      } finally { appendRegistryEvent({ deployment_id: opts.deployId, team: "builder", event: "pid", timestamp: time, pid: process.pid }); }
      assert.deepEqual(session.evidence.store.records(), beforeDiagnostics);
      const implementPath = repositoryMutationLeasePath(f.checkout, "implement");
      writeFileSync(implementPath, readFileSync(repositoryMutationLeasePath(f.checkout)), { mode: 0o600 });
      try {
        // Existing status projection is not sole-holder admission. Observation's
        // stronger native custody check must still deny before publication.
        assert.equal((await control({ action: "status" })).details.inFlight, false);
        await assert.rejects(control({ action: "observe", kind: "holder" }), /Source: EXECUTION_HOLDER_CONFLICT\/custody/);
        assert.deepEqual(session.evidence.store.records(), beforeDiagnostics);
      } finally { unlinkSync(implementPath); }
      // An invented completion cannot close a real started operation.
      const write = { path: "src/file.ts", content: "export const value = 1;\n" };
      assert.equal(await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "native-write", input: write }, context), undefined);
      await assert.rejects(runtime.dispatch("tool_execution_end", { toolName: "write", toolCallId: "native-write", result: { text: "success" }, isError: false }, context));
      assert.equal(session.service.status(session.actor).operation?.id, "native-write");
      mkdirSync(join(f.checkout, "src"));
      const canonicalBytes = readFileSync(join(f.repo, "README.md"));
      for (const alias of [symlinkSync, linkSync]) {
        alias(join(f.repo, "README.md"), join(f.checkout, "src/file.ts"));
        await assert.rejects(runtime.tools.get("write")!.execute("native-write", write, undefined, undefined, context));
        assert.deepEqual(readFileSync(join(f.repo, "README.md")), canonicalBytes);
        assert.equal(session.service.status(session.actor).operation?.id, "native-write");
        unlinkSync(join(f.checkout, "src/file.ts"));
      }
      rmdirSync(join(f.checkout, "src"));
      await runtime.tools.get("write")!.execute("native-write", write, undefined, undefined, context);
      await runtime.dispatch("tool_execution_end", { toolName: "write", toolCallId: "native-write", result: { text: "not authoritative" }, isError: false }, context);
      assert.equal(readFileSync(join(f.checkout, "src/file.ts"), "utf8"), write.content);
      await execute("edit", { path: "src/file.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] });
      const packageJson = (exit: number) => JSON.stringify({ name: "native-fixture", packageManager: manager, scripts: { typecheck: `node -e \"console.log(process.env.TEST_PRIVATE_TOKEN);process.exit(${exit})\"` } });
      await execute("write", { path: "package.json", content: packageJson(2) });
      const failed = await execute("bash", { command: "corepack pnpm typecheck", timeout: 30 }, true);
      assert.equal(failed.failed, true);
      const original = session.service.status(session.actor).originalFailure!;
      assert.equal(original.exitCode, 2); assert.equal(original.command, "corepack pnpm typecheck");
      const failedFacts = session.reportFacts();
      assert.equal(failedFacts.scopeProven, true); assert.equal(failedFacts.checks.at(-1)?.exitCode, 2);
      assert.match(failedFacts.diff.toString(), /src\/file\.ts/); assert.match(failedFacts.diff.toString(), /value = 2/);
      const raw = session.evidence.read(original.output, "tool-result") as { process: { stdout: Parameters<typeof session.evidence.blob>[0] } };
      assert.match(session.evidence.blob(raw.process.stdout).toString(), /native-test-private-output-value/);
      await settle(); await control({ action: "attempt", evidence: await observe("recovery") });
      assert.equal(session.service.status(session.actor).bounds.consecutiveNoProgress, 1);
      await assert.rejects(observe("recovery")); // no fresh recheck; no artificial counter-burning/novelty
      await select(); await execute("write", { path: "package.json", content: packageJson(0) });
      const passed = await execute("bash", { command: "corepack pnpm typecheck", timeout: 30 });
      assert.equal(passed.failed, false); assert.doesNotMatch(JSON.stringify(passed.result), /native-test-private-output-value/); assert.match(JSON.stringify(passed.result), /REDACTED/);
      await settle(); await control({ action: "resolve", evidence: await observe("last-result") });
      assert.equal(session.service.status(session.actor).originalFailure, null);
      const immutableStarted = getDeploymentEvents(opts.deployId).find((event) => event.event === "started");
      await select(); await execute("bash", { command: "git add -- package.json src/file.ts" });
      await execute("bash", { command: "git commit -m 'tested native fixture'" });
      const committed = session.service.status(session.actor);
      assert.equal(committed.candidateSha, f.git(["rev-parse", "HEAD"], f.checkout)); assert.notEqual(committed.candidateSha, beforeCanonical);
      assert.equal(committed.binding.initialHeadSha, beforeCanonical); assert.deepEqual(committed.passedChecks, {});
      assert.deepEqual(getDeploymentEvents(opts.deployId).find((event) => event.event === "started"), immutableStarted);
      assert.equal(getDeploymentEvents(opts.deployId).findLast((event) => event.note?.startsWith("direct-owner-authority:"))?.branch_head_sha, committed.candidateSha);
      const reportFacts = session.reportFacts();
      assert.equal(reportFacts.scopeProven, true); assert.equal(reportFacts.snapshot.head, committed.candidateSha);
      assert.ok(reportFacts.checks.some((check) => check.exitCode === 2)); assert.ok(reportFacts.checks.some((check) => check.exitCode === 0));
      assert.match(reportFacts.diff.toString(), /value = 2/); assert.match(reportFacts.diff.toString(), /package.json/);
      await settle(); assert.equal(session.service.status(session.actor).custody.state, "idle");
      assert.equal((await runtime.dispatch("tool_call", { toolName: "bash", toolCallId: "force-denied", input: { command: "git push --force origin HEAD" } }, context) as { block: boolean }).block, true);
      assert.equal(f.git(["rev-parse", "HEAD"]), beforeCanonical); assert.equal(f.gets(), 1);
      const child = await deployWithPi({ team: "builder", mode: "implement", background: true, ticket: "PAP-256", repo: "fixture-repo", provider: "openai-codex", model: "gpt-6.1-sol", objective: "Must stop at native launch owner, not old admission" }, undefined, undefined, { treehouse: f.treehouse, preparedAuthority: f.authority });
      assert.equal(child.status, "failed"); assert.match(child.reason ?? "", /prepared workflow stopped/);
      assert.equal(getDeploymentEvents(child.deploymentId!).some((event) => event.event === "started"), false); assert.equal(f.gets(), 1);
      const correlationPath = join(f.ai, "deployments", opts.deployId, "prepared-consumption.json");
      const correlationBytes = readFileSync(correlationPath); unlinkSync(correlationPath);
      assert.throws(() => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve(context), /EXECUTION_BINDING_UNCERTAIN\/binding-resolution/);
      assert.throws(() => adapter.resolve(context), /EXECUTION_BINDING_UNCERTAIN\/binding-resolution/); // durable start locator prevents a fresh-module legacy fallback
      writeFileSync(correlationPath, correlationBytes, { mode: 0o600 });
      await select(); await execute("bash", { command: "corepack pnpm typecheck", timeout: 30 }); await settle();
      const reporter = new PiNativePhaseReportAdapter({ authority: f.authority, execution: adapter });
      createPiPhaseReportModule({ nativeAdapter: reporter })(runtime.pi);
      const reports = runtime.tools.get("pa_phase_report")!;
      const captured = await reports.execute("report-native-direct", { action: "capture", phaseId: "phase-3", summary: "Native evidence snapshot; not phase acceptance.", nextAction: "Keep independent acceptance pending.", learning: "Preserve original failures." }, undefined, undefined, context);
      const published = await reports.execute("publish-native-direct", { action: "publish", source: captured.details.source }, undefined, undefined, context);
      assert.equal(published.details.canonicalEvidenceAvailable, true); assert.equal(published.details.outcome, "partial");
      assert.equal(published.details.dependencyState, "available"); assert.equal(published.details.phaseDeliveryReady, false);
      const reportDir = join(f.ai, "agent-teams/builder/artifacts", `${committed.bounds.startedAt.slice(0, 10)}-PAP-256-phase-3-${opts.deployId}`, "attempt-1");
      assert.match(readFileSync(join(reportDir, "report.md"), "utf8"), /exit: 2/); assert.match(readFileSync(join(reportDir, "diff.patch"), "utf8"), /value = 2/);
      assert.doesNotMatch(readFileSync(join(reportDir, "report.md"), "utf8"), /native-test-private-output-value/);
      // Revocation retains audit/settlement evidence, never falls back to legacy
      // mutation, and a same-process module reload reads the retained journal.
      f.authority.deactivate(f.caller);
      assert.equal(adapter.resolve(context)!.service.status(session.actor).custody.state, "idle");
      const reloaded = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } }).resolve(context)!;
      assert.equal(reloaded.service.status(reloaded.actor).candidateSha, committed.candidateSha);
      await assert.rejects(select());
    } catch (error) { bodyFailure = error; throw error; }
    finally { process.chdir(previousCwd); process.env = previousEnv; }
  });
  if (bodyFailure) throw bodyFailure;
  assert.equal(launched.status, "success", launched.reason); assert.equal(f.git(["rev-parse", "HEAD"]), beforeCanonical);
}));

test("AC6 real deploy consumes the same native prepared permit, persists correlation before spawn, and never allocates/materializes again", () => resourceFixture(async (f) => {
  assert.equal(f.gets(), 1); const beforeTicket = readFileSync(f.ticketPath); const beforeCanonical = f.git(["rev-parse", "HEAD"]); let spawns = 0;
  const result = await f.deploy((opts) => {
    spawns++;
    assert.equal(opts.executionPlan?.worktreeRoot, f.checkout); assert.equal(opts.executionPlan?.treehouse?.repositoryPermit, 1);
    assert.equal(readFileSync(f.ticketPath).equals(beforeTicket), true); // no unchanged setup publication
    const correlation = JSON.parse(readFileSync(join(f.ai, "deployments", opts.deployId, "prepared-consumption.json"), "utf8"));
    assert.equal(correlation.receiptId, f.service.status(f.authority.resolve(f.caller)!.contract).receipt?.receiptId);
    assert.equal(correlation.deploymentId, opts.deployId); assert.equal(correlation.repositoryPermit, 1);
    const starts = getDeploymentEvents(opts.deployId).filter((event) => event.event === "started");
    assert.equal(starts.length, 1); assert.equal(starts[0]?.ticket_slot_id, correlation.ticketSlotId); assert.equal(starts[0]?.repository_permit, 1);
    const slot = observeReadonlyRepositoryTicketSlot(f.repo, "PAP-256").slot;
    assert.equal(slot.deploymentId, opts.deployId);
    assert.equal(JSON.stringify(opts.env).includes(slot.slotToken), false); assert.equal(JSON.stringify(correlation).includes(slot.slotToken), false);
    assert.doesNotMatch(JSON.stringify(opts.env), /slotToken|native-prepared-consumer|PRIVATE/);
  });
  assert.equal(result.status, "success", result.reason); assert.equal(spawns, 1); assert.equal(f.gets(), 1);
  assert.equal(f.git(["rev-parse", "HEAD"]), beforeCanonical); assert.equal(f.git(["branch", "--show-current"]), "develop");
  const retained = withPreparedTicketCapacity({ canonicalRepoKey: "fixture-repo", canonicalRepoRoot: f.repo }, (tx) => tx.inventory());
  assert.equal(retained.length, 1); assert.equal("occupancy" in retained[0]! && retained[0].occupancy, "settled-retained");
  const duplicate = await f.deploy(() => { spawns++; }); assert.equal(duplicate.status, "failed"); assert.equal(spawns, 1); assert.equal(f.gets(), 1);
}));

test("native SDK exit zero with a remaining process group cannot clear the durable tool barrier", () => resourceFixture(async (f) => {
  const previousCwd = process.cwd(); const manager = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).packageManager;
  let bodyFailure: unknown;
  const launched = await f.deploy(async (opts) => {
    const previousEnv = process.env; process.env = { ...previousEnv, ...opts.env }; process.chdir(f.checkout);
    try {
      recordPiProcessIdentity(opts.deployId, join(f.ai, "deployments", opts.deployId), process.pid); opts.onPid?.(process.pid);
      const adapter = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } });
      const runtime = executionRuntime(); const context = { cwd: f.checkout }; createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi);
      await runtime.dispatch("session_start", {}, context);
      const control = (input: Record<string, unknown>) => runtime.tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
      await control({ action: "plan", plan: { phaseId: "phase-3", scope: "native unproven group fixture", paths: ["package.json"], requirements: ["AC8"], prerequisites: [], checks: ["typecheck"], size: "bounded", complexity: "process", rationale: "A real surviving group is not a settled check." } });
      const holder = (await control({ action: "observe", kind: "holder" })).details.evidence;
      await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder });
      const file = { path: "package.json", content: JSON.stringify({ name: "native-group-fixture", packageManager: manager, scripts: { typecheck: "sleep 10 >/dev/null 2>&1 & printf done; exit 0" } }) };
      await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "setup", input: file }, context);
      await runtime.tools.get("write")!.execute("setup", file, undefined, undefined, context);
      await runtime.dispatch("tool_execution_end", { toolName: "write", toolCallId: "setup", result: {}, isError: false }, context);
      const input = { command: "corepack pnpm typecheck", timeout: 15 };
      assert.equal(await runtime.dispatch("tool_call", { toolName: "bash", toolCallId: "unsettled", input }, context), undefined);
      await assert.rejects(runtime.tools.get("bash")!.execute("unsettled", input, undefined, undefined, context));
      await assert.rejects(runtime.dispatch("tool_execution_end", { toolName: "bash", toolCallId: "unsettled", result: { exitCode: 0, text: "PASS" }, isError: false }, context));
      const session = adapter.resolve(context)!;
      const row = session.evidence.read(session.observe("last-result"), "tool-result") as { process: { exitCode: number; groupSettled: boolean } };
      assert.equal(row.process.exitCode, 0); assert.equal(row.process.groupSettled, false);
      const reportFacts = session.reportFacts(); assert.equal(reportFacts.scopeProven, false); assert.equal(reportFacts.diff.length, 0); assert.ok(reportFacts.pendingResult);
      assert.equal(session.service.status(session.actor).operation?.id, "unsettled"); assert.deepEqual(session.service.status(session.actor).passedChecks, {});
      await assert.rejects(control({ action: "settle", evidence: (await control({ action: "observe", kind: "inventory" })).details.evidence }));
    } catch (error) { bodyFailure = error; throw error; }
    finally { process.chdir(previousCwd); process.env = previousEnv; }
  });
  if (bodyFailure) throw bodyFailure;
  assert.equal(launched.status, "failed", "SDK exit zero cannot settle a surviving process group or its direct custody");
  assert.match(launched.reason ?? "", /owner-finalization-invalid-evidence/);
  assert.equal(JSON.parse(readFileSync(repositoryMutationLeasePath(f.checkout), "utf8")).directExecutionCustody, "active");
  const reservation = JSON.parse(readFileSync(preparedRepositoryTicketReservationPath(f.repo, "PAP-256"), "utf8"));
  assert.equal(reservation.occupancy, "active", "unsettled execution retains capacity, not settled-retained");
  assert.equal(f.gets(), 1);
}));

test("native runtime bounds reject before consumption; existing ready reservation/permit are untouched", () => resourceFixture(async (f) => {
  const grant = f.authority.resolve(f.caller)!; const before = f.authority.operations()!.records();
  for (const seconds of [0, 3599, 3601, 14401]) {
    assert.throws(() => consumePiPreparedBuilderAdmission({ repoKey: f.caller.repoKey, repoRoot: f.repo, ticket: f.caller.ticket, deploymentId: "d-ff0001", deploymentDirectory: join(f.ai, "deployments/d-ff0001"), timeoutSeconds: seconds }, { treehouse: f.treehouse, preparedAuthority: f.authority }));
  }
  assert.deepEqual(f.authority.operations()!.records(), before); assert.equal(f.service.status(grant.contract).state, "ready"); assert.equal(f.gets(), 1);
}));

test("AC6 real prepared deploy rejects dirty candidate before transfer/spawn and retains pending native evidence", () => resourceFixture(async (f) => {
  const marker = join(f.checkout, "unrelated.txt"); writeFileSync(marker, "preserve unknown work\n"); let spawns = 0;
  const result = await f.deploy(() => { spawns++; }); assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.equal(f.gets(), 1);
  assert.equal(readFileSync(marker, "utf8"), "preserve unknown work\n");
  const reservation = JSON.parse(readFileSync(preparedRepositoryTicketReservationPath(f.repo, "PAP-256"), "utf8"));
  assert.equal(reservation.occupancy, "idle-ready"); assert.equal(reservation.repositoryPermit, 1);
}));

async function ordinaryFixture(run: (f: ReturnType<typeof setup> & { checkout: string; base: string; treehouse: TreehouseClient; opts: SpawnOpts; git: (args: string[], cwd?: string) => string }) => Promise<void>, expectedTerminal: "success" | "retained-started-operation" = "success") {
  const previousEnv = process.env; const previousCwd = process.cwd(); process.env = { ...previousEnv };
  for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  let bodyFailure: unknown;
  try { await fixture(async (f) => {
    const git = (args: string[], cwd = f.repo) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["symbolic-ref", "HEAD", "refs/heads/develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]); mkdirSync(join(f.root, "empty-hooks")); git(["config", "core.hooksPath", join(f.root, "empty-hooks")]);
    writeFileSync(join(f.repo, "README.md"), "ordinary fixture\n");
    const registration = seedOrdinaryCommandFixture(f.repo);
    writeFileSync(join(f.root, "config/config.yaml"), readFileSync(join(f.root, "config/config.yaml"), "utf8") + registration);
    git(["add", "README.md", "package.json", "ordinary-check.cjs", "ordinary-checks.json"]); git(["commit", "-m", "ordinary base"]);
    const base = git(["rev-parse", "HEAD"]); const checkout = join(f.root, "checkout");
    git(["worktree", "add", "-b", "feature/PAP-256-fixture", checkout, base]);
    writeFileSync(f.ticketPath, JSON.stringify({ ...f.ticket, status: "implementing", title: "Ordinary fixture", linkedBranches: [{ repo: f.caller.repoKey, branch: "feature/PAP-256-fixture", state: "materialized", baseSha: base, headSha: base, sha: base }] }));
    seedOrdinaryTaskBaseline({ ai: f.ai, repo: f.repo, repoKey: f.caller.repoKey, ticket: "PAP-256", branch: "feature/PAP-256-fixture", base });
    Object.assign(process.env, { PA_AI_USAGE_HOME: f.ai, PA_REGISTRY_DB: join(f.ai, "registry.db"), PA_PLATFORM_HOME: f.root });
    save(join(f.root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Implement\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
    let spawns = 0; let forbidden = 0;
    const treehouse = new TreehouseClient({ run(args, cwd) {
      assert.equal(cwd, f.repo);
      if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
      if (args[0] === "status") return { status: 0, stdout: Buffer.from(JSON.stringify([{ name: "1", path: checkout, status: "leased", branch: "feature/PAP-256-fixture", detached: false, flavor: "git", lease_id: "ordinary-fixture-lease", lease_holder: "pa:fixture-repo:PAP-256", leased_at: time, processes: [] }])), stderr: Buffer.alloc(0) };
      forbidden++; throw new Error("ordinary launch must reuse the existing lease");
    } });
    const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "ordinary-fixture-session", async preflight() {},
      installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture tools" }), extractActivity: () => [], resume() { forbidden++; throw new Error("no resume migration"); },
      async spawn(opts) {
        spawns++; const inherited = process.env; process.env = { ...inherited, ...opts.env, TEST_PRIVATE_TOKEN: "ordinary-private-token" }; process.chdir(checkout);
        try { await run({ ...f, checkout, base, treehouse, opts, git }); }
        catch (error) { bodyFailure = error; throw error; }
        finally { process.chdir(previousCwd); process.env = inherited; }
        return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId } };
      } };
    const result = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-256", repo: f.caller.repoKey, timeout: 1800, provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: f.authority });
    if (bodyFailure) throw bodyFailure;
    if (expectedTerminal === "retained-started-operation") {
      assert.equal(result.status, "failed", "adapter exit zero is not matching direct settlement");
      assert.match(result.reason ?? "", /owner-finalization-invalid-evidence/);
      assert.match(result.reason ?? "", /ticket concurrency finalization/);
      assert.equal(JSON.parse(readFileSync(repositoryMutationLeasePath(checkout), "utf8")).directExecutionCustody, "active");
      assert.equal(existsSync(repositoryTicketSlotPath(f.repo, "PAP-256")), true, "started operation retains its sole permit");
    } else {
      assert.equal(result.status, "success", result.reason);
      assert.equal(existsSync(repositoryMutationLeasePath(checkout)), false);
      assert.equal(existsSync(repositoryTicketSlotPath(f.repo, "PAP-256")), false);
    }
    assert.equal(spawns, 1); assert.equal(forbidden, 0);
    assert.equal(git(["rev-parse", "HEAD"]), base); assert.equal(git(["branch", "--show-current"]), "develop");
    assert.deepEqual(readdirSync(f.native), [], "optional policy, qualification and grants remain absent");
  }); } finally { closeDb(); process.chdir(previousCwd); process.env = previousEnv; }
}

test("PAP-264 ordinary pre-plan startup, denied source work, blocker comment and own completion use authenticated native ports", () => ordinaryFixture(async (f) => {
  const directory = join(f.ai, "deployments", f.opts.deployId); const context = { cwd: f.checkout };
  recordPiProcessIdentity(f.opts.deployId, directory, process.pid); f.opts.onPid?.(process.pid);
  const adapter = new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } });
  const runtime = executionRuntime();
  for (const tool of createPaTools()) runtime.tools.set(tool.name, tool);
  createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi);
  await runtime.dispatch("session_start", {}, context);
  const session = adapter.resolve(context)!;
  const before = session.service.status(session.actor); const sourceBefore = f.git(["status", "--porcelain"], f.checkout);
  let sequence = 0;
  const execute = async (name: string, input: Record<string, unknown>) => {
    const id = `startup-${++sequence}`;
    assert.equal(await runtime.dispatch("tool_call", { toolName: name, toolCallId: id, input }, context), undefined);
    const result = await runtime.tools.get(name)!.execute(id, input, undefined, undefined, context);
    await runtime.dispatch("tool_execution_end", { toolName: name, toolCallId: id, result, isError: false }, context);
    return result;
  };
  const gitPacket = `pwd; git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git remote -v; git status --porcelain=v2 -z --untracked-files=all; printf '\\nRuntime roots\\n'; printf 'PA_REPO=%s\\nPA_WORKTREE_ROOT=%s\\n' "$PA_REPO" "$PA_WORKTREE_ROOT"`;
  const mvm217Packet = `pwd; git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git remote -v; git status --porcelain=v2 -z --untracked-files=all; printf '\\nRuntime paths\\n'; printenv PA_REPO PA_WORKTREE_ROOT PA_DEPLOY_MODE; ppa repos list`;
  for (const command of ["ppa bulletin list", "ppa repos list", "ppa ticket show PAP-256 --json", "date -u", gitPacket, mvm217Packet]) {
    const result = await execute("bash", { command });
    assert.equal(result.details.exitCode, 0, JSON.stringify(result));
    if (command === gitPacket || command === mvm217Packet) assert.match(JSON.stringify(result), new RegExp(f.base));
  }
  assert.deepEqual(session.service.status(session.actor), before, "administration is neither source work nor a phase check");
  const deny = async (name: string, input: Record<string, unknown>) => {
    const response = await runtime.dispatch("tool_call", { toolName: name, toolCallId: `denied-${++sequence}`, input }, context) as { block: boolean };
    assert.equal(response.block, true);
  };
  await deny("write", { path: "src/file.ts", content: "not planned" });
  await deny("bash", { command: "npm run test" }); // no authenticated project phase contract
  await deny("bash", { command: "ppa bulletin list; touch forbidden" });
  await deny("bash", { command: `ppa registry complete ${f.opts.deployId} --status success --summary 'not acceptance'` });
  await deny("pa_ticket", { action: "comment", id: "PAP-999", content: "wrong ticket" });
  await deny("pa_ticket", { action: "comment", id: "PAP-256", author: "sinh", content: "forged approval" });
  const ticketBeforeDenial = readFileSync(f.ticketPath);
  await assert.rejects(runtime.tools.get("pa_ticket")!.execute("unguarded-comment", { action: "comment", id: "PAP-999", author: "builder/team-manager", content: "wrong ticket" }, undefined, undefined, context));
  assert.deepEqual(readFileSync(f.ticketPath), ticketBeforeDenial);
  const priorTicket = process.env.PA_TICKET_ID; process.env.PA_TICKET_ID = "PAP-999";
  try { await deny("bash", { command: "ppa bulletin list" }); }
  finally { process.env.PA_TICKET_ID = priorTicket; }
  await execute("pa_ticket", { action: "comment", id: "PAP-256", author: "builder/team-manager", content: "Startup checked; project command unsupported, preserve state." });
  assert.match(readFileSync(f.ticketPath, "utf8"), /project command unsupported/);
  const logRelative = `sessions/2026/10/agent-team/2026-10-23-${f.opts.deployId}-builder--builder-agent--PAP-256--preflight-blocked.md`;
  const logPath = join(f.ai, logRelative); const logText = "# Native failure log\nProject phase contract unsupported; preserve source and custody.\n";
  await execute("write", { path: logPath, content: logText });
  assert.equal(readFileSync(logPath, "utf8"), logText); assert.equal(statSync(logPath).mode & 0o777, 0o600);
  await execute("write", { path: logPath, content: logText }); // byte-identical retry only
  await assert.rejects(runtime.tools.get("write")!.execute("overwrite-log", { path: logPath, content: "replacement" }, undefined, undefined, context));
  assert.equal(readFileSync(logPath, "utf8"), logText);
  const cancelledPath = logPath.replace("preflight-blocked", "cancelled"); const abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.tools.get("write")!.execute("cancelled-log", { path: cancelledPath, content: logText }, abort.signal, undefined, context));
  assert.equal(existsSync(cancelledPath), false);
  await deny("write", { path: logPath.replace(f.opts.deployId, "d-ffffff"), content: logText });
  await deny("edit", { path: logPath, edits: [{ oldText: "Native", newText: "forged" }] });
  const previous = process.env.PA_PI_EXECUTION_MODE; process.env.PA_PI_EXECUTION_MODE = "foreground";
  try {
    const completionBefore = readPiForegroundCompletion(directory);
    await assert.rejects(runtime.tools.get("bash")!.execute("missing-log-ref", { command: `ppa registry complete ${f.opts.deployId} --status partial --summary 'Stopped' --log-file '${cancelledPath}'` }, undefined, undefined, context));
    assert.deepEqual(readPiForegroundCompletion(directory), completionBefore);
    const result = await execute("bash", { command: `ppa registry complete ${f.opts.deployId} --status partial --summary 'Project command unsupported; preserve state' --log-file '${logPath}' --rating-source agent --rating-overall 2 --rating-productivity 1 --rating-quality 2 --rating-efficiency 3 --rating-insight 3` });
    assert.equal(result.details.exitCode, 0, JSON.stringify(result));
    assert.equal(readPiForegroundCompletion(directory)?.status, "partial");
    assert.equal(readPiForegroundCompletion(directory)?.logFile, logRelative);
    assert.equal(readPiForegroundCompletion(directory)?.rating?.overall, 2);
    assert.equal(getDeploymentEvents(f.opts.deployId).some((event) => event.event === "completed"), false, "staging cannot release live custody");
  } finally { if (previous === undefined) delete process.env.PA_PI_EXECUTION_MODE; else process.env.PA_PI_EXECUTION_MODE = previous; }
  const holder = session.observe("holder");
  session.service.apply(session.actor, { action: "plan", plan: { phaseId: "phase-startup", scope: "barrier fixture", paths: ["src/file.ts"], requirements: ["AC3"], prerequisites: [], checks: ["typecheck", "diff-check"], size: "M", complexity: "high", rationale: "Startup ports cannot clear source barriers." } });
  session.service.apply(session.actor, { action: "select", executor: "orchestrator-direct", holder: session.actor, handover: holder });
  let release!: () => void;
  const administrative = session.executeAdministration("administrative-overlap", { toolName: "bash", input: { command: "ppa bulletin list" } }, context, () => new Promise<void>((resolve) => { release = resolve; }));
  await deny("write", { path: "src/file.ts", content: "must not overlap administration" });
  release(); await administrative;
  assert.equal(await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "in-flight", input: { path: "src/file.ts", content: "not dispatched" } }, context), undefined);
  await deny("bash", { command: "ppa bulletin list" });
  await deny("write", { path: cancelledPath, content: logText });
  assert.equal(existsSync(cancelledPath), false);
  await deny("pa_ticket", { action: "comment", id: "PAP-256", content: "cannot overlap source work" });
  assert.equal(session.service.status(session.actor).operation?.id, "in-flight");
  assert.equal(f.git(["status", "--porcelain"], f.checkout), sourceBefore);
}, "retained-started-operation"));

test("PAP-264 ordinary optional-inactive launch uses actual SDK effects, exact ordered checks, first failure/reload/replan and commit", () => ordinaryFixture(async (f) => {
  const directory = join(f.ai, "deployments", f.opts.deployId); const context = { cwd: f.checkout };
  const start = getDeploymentEvents(f.opts.deployId).find((event) => event.event === "started")!;
  assert.equal(start.note, ORDINARY_NATIVE_EXECUTION_START); assert.equal(start.effective_timeout_seconds, 1800);
  assert.equal(existsSync(join(directory, "prepared-consumption.json")), false);
  const freshAdapter = () => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } });
  assert.throws(() => freshAdapter().resolve(context), "missing Pi process proof must deny before storage/effects");
  assert.equal(f.authority.execution(), null);
  assert.equal(recordPiProcessIdentity(f.opts.deployId, directory, process.pid), true); f.opts.onPid?.(process.pid);
  let adapter = freshAdapter(); let runtime = executionRuntime(); createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi);
  await runtime.dispatch("session_start", {}, context);
  let session = adapter.resolve(context)!;
  const control = (input: Record<string, unknown>) => runtime.tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
  const observe = async (kind: string) => (await control({ action: "observe", kind })).details.evidence as SourceVersion;
  const select = async () => { const holder = await observe("holder"); await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
  const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
  const reload = async () => {
    const before = session.service.status(session.actor);
    adapter = freshAdapter(); runtime = executionRuntime(); createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi); await runtime.dispatch("session_start", {}, context);
    session = adapter.resolve(context)!; assert.deepEqual(session.service.status(session.actor), before);
  };
  let sequence = 0;
  const execute = async (name: string, input: Record<string, unknown>, claimPass = false) => {
    const id = `ordinary-${++sequence}`;
    assert.equal(await runtime.dispatch("tool_call", { toolName: name, toolCallId: id, input }, context), undefined);
    let failed = false; let result: unknown;
    try { result = await runtime.tools.get(name)!.execute(id, input, undefined, undefined, context); } catch (error) { failed = true; result = String(error); }
    await runtime.dispatch("tool_execution_end", { toolName: name, toolCallId: id, result: claimPass ? { exitCode: 0, text: "PASS" } : result, isError: claimPass ? false : failed }, context);
    return { failed, result };
  };
  const deny = async (name: string, input: Record<string, unknown>) => {
    const before = session.evidence.store.records(); const head = f.git(["rev-parse", "HEAD"], f.checkout);
    const response = await runtime.dispatch("tool_call", { toolName: name, toolCallId: `denied-${++sequence}`, input }, context) as { block: boolean; reason: string };
    assert.equal(response.block, true); assert.ok(response.reason.length <= 2000); assert.match(response.reason, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
    assert.doesNotMatch(response.reason, /ordinary-private-token|bootId|startTimeTicks/);
    assert.deepEqual(session.evidence.store.records(), before); assert.equal(f.git(["rev-parse", "HEAD"], f.checkout), head);
  };
  const plan = { phaseId: "phase-2", scope: "ordinary source/check fixture", paths: ["src/file.ts", "package.json"], requirements: ["FR2", "FR3", "FR4", "FR6", "FR10", "AC1", "AC3", "AC5"], prerequisites: [], checks: ["node 'ordinary-check.cjs' 'typecheck'", "node 'ordinary-check.cjs' 'diff-check'"], size: "L", complexity: "high", rationale: "Actual isolated SDK evidence under a pinned project contract, not packaged/loaded/human acceptance." };
  await control({ action: "plan", plan }); await select();
  assert.equal(session.contract.bounds.runtimeMinutes, 30);
  const coldRuntime = executionRuntime(); createPiExecutionModule({ nativeAdapter: adapter })(coldRuntime.pi);
  const beforeColdDispatch = session.evidence.store.records();
  assert.equal((await coldRuntime.dispatch("tool_call", { toolName: "write", toolCallId: "unguarded-startup", input: { path: "src/file.ts", content: "forbidden" } }, context) as { block: boolean }).block, true);
  assert.deepEqual(session.evidence.store.records(), beforeColdDispatch);
  await deny("bash", { command: "git commit -m 'premature'" });
  await deny("bash", { command: "node 'ordinary-check.cjs' 'diff-check'" }); // wrong named order
  await deny("bash", { command: "node 'ordinary-check.cjs' 'typecheck'; true" });
  await deny("write", { path: join(f.repo, "README.md"), content: "forbidden" });
  await execute("write", { path: "src/file.ts", content: "export const value = 1;\n" });
  await execute("edit", { path: "src/file.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] });
  assert.match(readFileSync(join(f.checkout, "src/file.ts"), "utf8"), /value = 2/);
  const packageJson = (exit: number) => JSON.stringify({ name: "ordinary-fixture", fixtureExit: exit });
  await execute("write", { path: "package.json", content: packageJson(2) });
  assert.equal((await execute("bash", { command: plan.checks[0], timeout: 30 }, true)).failed, true);
  const original = session.service.status(session.actor).originalFailure!;
  assert.equal(original.exitCode, 2); assert.equal(original.command, plan.checks[0]);
  const failedResult = session.evidence.read(original.output, "tool-result") as { process: { stdout: Parameters<typeof session.evidence.blob>[0]; stderr: Parameters<typeof session.evidence.blob>[0] } };
  assert.match(session.evidence.blob(failedResult.process.stdout).toString(), /ordinary-private-token/);
  assert.match(session.evidence.blob(failedResult.process.stderr).toString(), /actual ordinary stderr/);
  const failureState = session.service.status(session.actor);
  const reading = await control({ action: "report" });
  assert.match(String(reading.details.markdown), /actual ordinary stderr/);
  assert.doesNotMatch(String(reading.details.markdown), /ordinary-private-token/);
  assert.deepEqual(session.service.status(session.actor), failureState, "a redacted reading view is not source authority or failure resolution");
  assert.equal((await execute("pa_ticket", { action: "comment", id: "PAP-256", author: "builder/team-manager", content: "Native phase check failed with exit2; original evidence retained." })).failed, false);
  assert.deepEqual(session.service.status(session.actor), failureState, "failure reporting cannot clear the original failure or reset counters");
  await reload(); assert.deepEqual(session.service.status(session.actor).originalFailure, original);
  await settle(); await control({ action: "attempt", evidence: await observe("recovery") });
  await control({ action: "plan", plan }); await reload();
  assert.equal(session.service.status(session.actor).bounds.consecutiveNoProgress, 1);
  assert.equal(session.service.status(session.actor).bounds.replacementsUsed, 0); assert.equal(session.service.status(session.actor).bounds.reviewsUsed, 0);
  await select(); await execute("write", { path: "package.json", content: packageJson(0) });
  await deny("bash", { command: "git commit -m 'failure cannot be erased'" });
  const passed = await execute("bash", { command: plan.checks[0], timeout: 30 }); assert.equal(passed.failed, false);
  assert.doesNotMatch(JSON.stringify(passed.result), /ordinary-private-token/);
  await execute("bash", { command: plan.checks[1], timeout: 30 });
  await settle();
  // Resolution must reference the successful exact original check, not the later diff check.
  const passedEvidence = session.reportFacts().checks.findLast((check) => check.command === plan.checks[0] && check.exitCode === 0)!.output!;
  await control({ action: "resolve", evidence: passedEvidence }); await select();
  await execute("bash", { command: "git add -- package.json src/file.ts" });
  await execute("bash", { command: "git commit -m 'ordinary SDK phase fixture'" });
  const committed = session.service.status(session.actor); assert.notEqual(committed.candidateSha, f.base);
  assert.deepEqual(committed.passedChecks, {}); assert.deepEqual(committed.acceptance, {});
  await reload(); assert.equal(session.service.status(session.actor).candidateSha, committed.candidateSha);
  assert.deepEqual(getDeploymentEvents(f.opts.deployId).find((event) => event.event === "started"), start);
  await deny("bash", { command: "git commit -m 'old passes cannot authorize candidate'" });
  await settle();
  assert.equal(getDeploymentEvents(f.opts.deployId).filter((event) => event.event === "started" && event.mode === "implement").length, 0);
  assert.equal(existsSync(join(directory, "prepared-consumption.json")), false); assert.deepEqual(readdirSync(f.native), []);
}));

test("PAP-264 ordinary drift, adopted correlation loss/reload and started operations deny without fallback or SDK effects", () => ordinaryFixture(async (f) => {
  const context = { cwd: f.checkout }; const directory = join(f.ai, "deployments", f.opts.deployId);
  recordPiProcessIdentity(f.opts.deployId, directory, process.pid); f.opts.onPid?.(process.pid);
  const fresh = () => new PiNativeExecutionAdapter({ authority: f.authority, helperDependencies: { treehouse: f.treehouse } });
  getDb().prepare("UPDATE registry_events SET note = NULL WHERE deployment_id = ? AND event = 'started'").run(f.opts.deployId);
  try {
    assert.throws(() => fresh().resolve(context), /EXECUTION_CAPABILITY_UNSUPPORTED\/capability/);
    assert.equal(f.authority.execution(), null, "missing direct support creates no execution storage");
  } finally { getDb().prepare("UPDATE registry_events SET note = ? WHERE deployment_id = ? AND event = 'started'").run(ORDINARY_NATIVE_EXECUTION_START, f.opts.deployId); }
  const adapter = fresh(); const runtime = executionRuntime(); createPiExecutionModule({ nativeAdapter: adapter })(runtime.pi); await runtime.dispatch("session_start", {}, context);
  const session = adapter.resolve(context)!; const control = (input: Record<string, unknown>) => runtime.tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
  await control({ action: "plan", plan: { phaseId: "phase-2", scope: "ordinary denial fixture", paths: ["src/file.ts"], requirements: ["AC3", "AC5"], prerequisites: [], checks: ["typecheck", "diff-check"], size: "L", complexity: "high", rationale: "Zero forbidden effects before actual SDK dispatch." } });
  const holder = (await control({ action: "observe", kind: "holder" })).details.evidence;
  await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder });
  const write = { path: "src/file.ts", content: "forbidden drift write" };
  const assertDenied = async () => {
    const records = session.evidence.store.records();
    const result = await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "denied", input: write }, context) as { block: boolean };
    assert.equal(result.block, true);
    await assert.rejects(runtime.tools.get("write")!.execute("denied", write, undefined, undefined, context));
    assert.throws(() => fresh().resolve(context));
    assert.equal(existsSync(join(f.checkout, "src/file.ts")), false); assert.deepEqual(session.evidence.store.records(), records);
  };
  for (const [key, value] of [["PA_TICKET_ID", "PAP-999"], ["PA_REPO", f.repo], ["PA_WORKTREE_ROOT", f.repo], ["PA_DEPLOYMENT_DIR", f.root]] as const) {
    const before = process.env[key]; process.env[key] = value; try { await assertDenied(); } finally { process.env[key] = before; }
  }
  appendRegistryEvent({ deployment_id: f.opts.deployId, team: "builder", event: "pid", timestamp: time, pid: process.pid + 1 });
  try { await assertDenied(); } finally { appendRegistryEvent({ deployment_id: f.opts.deployId, team: "builder", event: "pid", timestamp: time, pid: process.pid }); }
  const slotPath = repositoryTicketSlotPath(f.repo, "PAP-256"); const slotBytes = readFileSync(slotPath);
  writeFileSync(slotPath, JSON.stringify({ ...JSON.parse(slotBytes.toString()), slotToken: "drift" }));
  try { await assertDenied(); } finally { writeFileSync(slotPath, slotBytes); }
  const ticketBytes = readFileSync(f.ticketPath); const ticket = JSON.parse(ticketBytes.toString()); ticket.linkedBranches[0].baseSha = "f".repeat(40); writeFileSync(f.ticketPath, JSON.stringify(ticket));
  try { await assertDenied(); } finally { writeFileSync(f.ticketPath, ticketBytes); }
  // Audit/reporting still requires the authenticated physical checkout. A
  // replaced Git pointer must reject before any Git observation or publication.
  const pointer = join(f.checkout, ".git"), pointerBytes = readFileSync(pointer);
  const reportBefore = session.evidence.store.records();
  writeFileSync(pointer, "gitdir: /missing\n");
  try {
    await assert.rejects(control({ action: "report" }), /EXECUTION_BINDING_UNCERTAIN/);
    assert.deepEqual(session.evidence.store.records(), reportBefore);
  } finally { writeFileSync(pointer, pointerBytes); }
  // Same physical checkout but wrong branch or HEAD, restored only in this disposable fixture.
  const gitDir = f.git(["rev-parse", "--absolute-git-dir"], f.checkout); const headBytes = readFileSync(join(gitDir, "HEAD"));
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/develop\n`);
  try { await assertDenied(); } finally { writeFileSync(join(gitDir, "HEAD"), headBytes); }
  f.git(["commit", "--allow-empty", "-m", "external drift"], f.checkout);
  try { await assertDenied(); } finally { f.git(["update-ref", "refs/heads/feature/PAP-256-fixture", f.base], f.checkout); }
  // Simulate loss of immutable correlation in the disposable registry. Even a
  // config rollback cannot re-enable legacy built-ins once its journal exists.
  const teamPath = join(f.root, "teams/builder.yaml"); const teamBytes = readFileSync(teamPath);
  writeFileSync(teamPath, `${teamBytes.toString()}  - id: implement\n    label: Implement\n`);
  getDb().prepare("UPDATE registry_events SET note = NULL WHERE deployment_id = ? AND event = 'started'").run(f.opts.deployId);
  try { await assertDenied(); } finally {
    getDb().prepare("UPDATE registry_events SET note = ? WHERE deployment_id = ? AND event = 'started'").run(ORDINARY_NATIVE_EXECUTION_START, f.opts.deployId); writeFileSync(teamPath, teamBytes);
  }
  assert.equal(await runtime.dispatch("tool_call", { toolName: "write", toolCallId: "started", input: write }, context), undefined);
  const reloaded = fresh().resolve(context)!; assert.equal(reloaded.service.status(reloaded.actor).operation?.id, "started");
  await assert.rejects(runtime.tools.get("write")!.execute("another-id", write, undefined, undefined, context));
  assert.equal((await runtime.dispatch("tool_call", { toolName: "edit", toolCallId: "overlap", input: { path: "src/file.ts", edits: [] } }, context) as { block: boolean }).block, true);
  const holderAgain = session.observe("holder");
  assert.throws(() => session.service.apply(session.actor, { action: "select", executor: "implement-child", holder: session.actor, handover: holderAgain }));
  assert.equal(existsSync(join(f.checkout, "src/file.ts")), false); assert.equal(reloaded.service.status(reloaded.actor).operation?.id, "started");
}, "retained-started-operation"));

test("PAP-264 packaged driver runs real source-built launch/SDK scenarios in a disposable process", () => {
  // Source/compiled regression only. The zero-argument postcommit smoke owns
  // independent Nix source/store/config provenance; this test cannot grant it.
  const root = mkdtempSync(join(tmpdir(), "pap264-source-driver-"));
  const share = fileURLToPath(new URL("../../../..", import.meta.url));
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, `import { isolatedDriver } from ${JSON.stringify(new URL("../../../../scripts/pap-264-installed-direct-admission-smoke.mjs", import.meta.url).href)};\ntry { console.log(JSON.stringify(await isolatedDriver(${JSON.stringify(root)}, ${JSON.stringify(share)}))); } catch (error) { console.error(error); process.exitCode = 1; }\n`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PA_|PI_|GIT_|NODE_OPTIONS|BASH_ENV|ENV$)/.test(key)));
  try {
    const result = JSON.parse(execFileSync(process.execPath, [driver], { cwd: root, env: { ...environment, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") }, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }));
    assert.equal(result.status, "passed"); assert.equal(result.scenarios.length, 17);
    assert.deepEqual(result.nativeResult.checkLedger.map((row: { exitCode: number }) => row.exitCode), [2, 0]);
    assert.equal(result.counts.runtimeSpawns, 1); assert.equal(result.counts.implementSpawns, 0);
    for (const key of ["outsideWrites", "forbiddenProcesses", "network", "treehouseLifecycle"]) assert.equal(result.counts[key], 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC6 actual preflight revocation stops prepared spawn while retaining the same checkout/reservation", () => resourceFixture(async (f) => {
  let spawns = 0;
  const result = await f.deploy(() => { spawns++; }, async () => { f.authority.deactivate(f.caller); });
  assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.equal(f.gets(), 1);
  const reservation = JSON.parse(readFileSync(preparedRepositoryTicketReservationPath(f.repo, "PAP-256"), "utf8"));
  assert.equal(reservation.occupancy, "settled-retained"); assert.equal(reservation.repositoryPermit, 1);
}));
