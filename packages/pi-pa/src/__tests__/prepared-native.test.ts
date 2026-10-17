import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDb, getDeploymentEvents, observeReadonlyRepositoryTicketSlot, preparedRepositoryTicketReservationPath, withPreparedTicketCapacity, PreparedWorkflowService, ProtectedWorkflowStore, withPreparedWorkflowLocks, workflowDigest, type SourceVersion, type RuntimeAdapter, type SpawnOpts } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { TreehouseClient } from "../treehouse.js";
import { PiPreparedNativeAuthority, currentPreparedNativeRuntime, type PreparedNativeRuntime } from "../prepared-native.js";
import { createPiPreparationHost, createPiPreparationTool, createPiWorkflowPolicyModule, resolveNativePiPreparationBinding, type PiPreparationCaller, type PiPreparationContext } from "../pi-extension/prepared-workflow.js";
import { interceptToolCall, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";
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

async function resourceFixture(run: (f: ReturnType<typeof setup> & { checkout: string; base: string; treehouse: TreehouseClient; service: PreparedWorkflowService; gets: () => number; deploy: (onSpawn?: (options: SpawnOpts) => void, preflight?: () => Promise<void>) => ReturnType<typeof deployWithPi>; git: (args: string[], cwd?: string) => string }) => unknown | Promise<unknown>) {
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
      save(join(f.root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Implement\nagents: []\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
      const deploy = (onSpawn?: (opts: SpawnOpts) => void, preflight = async () => {}) => {
        const adapter: RuntimeAdapter & { preflight: () => Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "native-fixture-session", preflight,
          installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture tools" }), extractActivity: () => [],
          spawn(opts) { onSpawn?.(opts); return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId } }; },
          resume() { throw new Error("unexpected resume"); } };
        return deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-256", repo: "fixture-repo", provider: "openai-codex", model: "gpt-6.1-sol", objective: "Native prepared launch fixture" }, adapter, undefined, { treehouse, preparedAuthority: f.authority });
      };
      await run({ ...f, checkout, base, treehouse, service, gets: () => gets, deploy, git });
    });
  } finally { closeDb(); process.env = previous; }
}

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

test("AC6 real prepared deploy rejects dirty candidate before transfer/spawn and retains pending native evidence", () => resourceFixture(async (f) => {
  const marker = join(f.checkout, "unrelated.txt"); writeFileSync(marker, "preserve unknown work\n"); let spawns = 0;
  const result = await f.deploy(() => { spawns++; }); assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.equal(f.gets(), 1);
  assert.equal(readFileSync(marker, "utf8"), "preserve unknown work\n");
  const reservation = JSON.parse(readFileSync(preparedRepositoryTicketReservationPath(f.repo, "PAP-256"), "utf8"));
  assert.equal(reservation.occupancy, "idle-ready"); assert.equal(reservation.repositoryPermit, 1);
}));

test("AC6 actual preflight revocation stops prepared spawn while retaining the same checkout/reservation", () => resourceFixture(async (f) => {
  let spawns = 0;
  const result = await f.deploy(() => { spawns++; }, async () => { f.authority.deactivate(f.caller); });
  assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.equal(f.gets(), 1);
  const reservation = JSON.parse(readFileSync(preparedRepositoryTicketReservationPath(f.repo, "PAP-256"), "utf8"));
  assert.equal(reservation.occupancy, "settled-retained"); assert.equal(reservation.repositoryPermit, 1);
}));
