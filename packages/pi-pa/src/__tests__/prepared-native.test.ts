import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProtectedWorkflowStore, withPreparedWorkflowLocks, workflowDigest, type SourceVersion } from "@pa-platform/pa-core";
import { PiPreparedNativeAuthority, currentPreparedNativeRuntime, type PreparedNativeRuntime } from "../prepared-native.js";
import { createPiPreparationTool, createPiWorkflowPolicyModule, resolveNativePiPreparationBinding, type PiPreparationCaller, type PiPreparationContext } from "../pi-extension/prepared-workflow.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";
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
