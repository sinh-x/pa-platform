import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NIXOS_APPROVAL_VERSION, NIXOS_BASELINE_VERSION, NIXOS_PROBE_MS, NIXOS_TOTAL_MS, NIXOS_TOOLS,
  NixosPrerequisiteError, NixosPrerequisiteSession, createNixosPrerequisiteDependencies, createNixosProbeRunner,
  discoverNixosInventory, nixosTupleDigest, parseNixosBaseline, parseNixosBaselineReference, parseNixosStrictJson,
  type NixosAuthorityRead, type NixosBaseline, type NixosBaselineReference, type NixosDurableComment,
  type NixosPrerequisiteDependencies, type NixosProbeCommand, type NixosProbeResult, type NixosTool,
} from "../nixos-prerequisites.js";
import { runPiValidationBeforeReviewer } from "../validation-supervisor.js";

const sha = "a".repeat(40);
const matrixAuthority = "### Full Validation Matrix\n\nsynthetic fixture authority bytes\n\n";
const matrixDocument = Buffer.from(`${matrixAuthority}## 13. Implementation Plan\n`);
const matrixDigest = createHash("sha256").update(matrixAuthority).digest("hex");
const source = "agent-teams/requirements/artifacts/synthetic-baseline.json";
const root = "/fixtures/candidate";
const local = "/fixtures/local";
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function json(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)); }
function diagnostic(error: unknown): boolean {
  assert.ok(error instanceof NixosPrerequisiteError);
  for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(error.message.includes(field));
  assert.ok(error.message.length <= 2000);
  assert.ok(!error.message.includes("review-auth:"));
  return true;
}
function seedBaseline(): NixosBaseline {
  const tuple = {
    repoKey: "fixture", canonicalRoot: "/fixtures/canonical", worktreeRoot: root, ticket: "FIX-123", branch: "feature/FIX-123-prerequisites",
    featureSha: sha, matrixSource: "agent-teams/requirements/artifacts/synthetic-matrix.md", matrixDigest,
    matrixApprovalEvidence: "c-matrix", authorizationId: "review-auth:123e4567-e89b-42d3-a456-426614174000", reviewDeploymentId: "d-fixture",
  };
  return {
    schemaVersion: NIXOS_BASELINE_VERSION, tuple,
    environment: {
      CI: "true", HOME: "/fixtures/home", LANG: "C.UTF-8", TZ: "UTC", PATH: "/fixtures/bin",
      PA_REPO: root, PA_WORKTREE_ROOT: root, PA_TICKET_ID: tuple.ticket, PA_EXPECTED_BRANCH: tuple.branch,
      PA_FEATURE_SHA: sha, PA_MATRIX_SOURCE: tuple.matrixSource, PA_MATRIX_AUTHORITY_SHA256: matrixDigest,
      PA_MATRIX_APPROVAL_EVIDENCE: tuple.matrixApprovalEvidence, PA_APPROVED_BASE_SHA: "c".repeat(40),
    },
    localInputs: [{ path: local, topLevel: local, head: sha, status: "" }],
    tools: NIXOS_TOOLS.map((name) => ({ name, executable: `/fixtures/bin/${name}`, version: `${name} fixture-version` })),
    inventory: { localInputs: [local], upstreams: ["https://upstream.invalid/repo.git", "https://upstream.invalid/archive.tar.gz"], caches: ["https://cache.invalid/"], builders: ["ssh-ng://builder.invalid"], daemon: "daemon", storage: [root, local, "/nix/store", "/tmp"] },
    storage: [root, local, "/nix/store", "/tmp"].map((path) => ({ path, minimumFreeBytes: 1000 })),
  };
}
interface Fixture {
  baseline: NixosBaseline;
  bytes: Buffer;
  matrixBytes: Buffer;
  reference: NixosBaselineReference;
  comments: NixosDurableComment[];
  authority: NixosAuthorityRead;
  metadata: Record<string, unknown>;
  config: Record<string, unknown>;
  dependencies: NixosPrerequisiteDependencies;
  commands: NixosProbeCommand[];
  clock: number;
  cost: number;
  expires: Map<symbol, { deadline: number; expire: () => void }>;
  advance: (ms: number) => void;
  approve: () => void;
}
function fixture(): Fixture {
  const baseline = seedBaseline();
  const f = {} as Fixture;
  Object.assign(f, {
    baseline, bytes: json(baseline), matrixBytes: Buffer.from(matrixDocument), reference: { source, digest: digest(json(baseline)), approvalEvidence: "c-baseline" },
    comments: [], authority: { tuple: structuredClone(baseline.tuple), environment: structuredClone(baseline.environment),
      canonicalRepository: { repoKey: baseline.tuple.repoKey, repoRoot: baseline.tuple.canonicalRoot },
      authorizationReceipt: { authorizationId: baseline.tuple.authorizationId, reviewDeploymentId: baseline.tuple.reviewDeploymentId }, prerequisiteStartedMs: 0 },
    metadata: { locks: { root: "root", nodes: { root: { inputs: { local: "local", remote: "remote", archive: "archive" } },
      local: { locked: { type: "path", path: local } }, remote: { locked: { type: "git", url: "https://upstream.invalid/repo.git" } }, archive: { locked: { type: "tarball", url: "https://upstream.invalid/archive.tar.gz" } } } } },
    config: { substituters: { value: baseline.inventory.caches }, builders: { value: "ssh-ng://builder.invalid x86_64-linux - 2 1" }, store: { value: "daemon" }, "build-dir": { value: "" } },
    commands: [], clock: 0, cost: 1, expires: new Map(),
  });
  f.approve = () => {
    f.bytes = json(f.baseline); f.reference.digest = digest(f.bytes);
    f.comments = [
      { id: "c-matrix", author: "sinh", content: `Approved ${baseline.tuple.matrixSource} ${baseline.tuple.matrixDigest}` },
      { id: "c-baseline", author: "sinh", content: JSON.stringify({ schemaVersion: NIXOS_APPROVAL_VERSION, source, digest: f.reference.digest, tupleDigest: nixosTupleDigest(f.baseline.tuple) }) },
    ];
  };
  f.approve();
  f.advance = (ms) => {
    f.clock += ms;
    for (const [id, timer] of f.expires) if (f.clock >= timer.deadline) { f.expires.delete(id); timer.expire(); }
  };
  const tick = (): void => f.advance(f.cost);
  f.dependencies = {
    monotonicMs: () => f.clock, budgetStartedMs: 0,
    schedule: (delay, expire) => { const key = Symbol(); f.expires.set(key, { deadline: f.clock + delay, expire }); return () => { f.expires.delete(key); }; },
    readSource: async (requested) => { tick(); return requested === source ? f.bytes : f.matrixBytes; }, readComments: async () => { tick(); return f.comments; },
    rereadAuthority: async () => { tick(); return f.authority; },
    physicalPath: async (path) => { tick(); return path; }, freeBytes: async () => { tick(); return 1001; },
    httpsHead: async (endpoint) => { tick(); return { endpoint, status: 200 }; },
    run: async (command) => {
      tick(); f.commands.push(command);
      const result: NixosProbeResult = { stdout: "", stderr: "", exitCode: 0, executable: `/fixtures/bin/${command.tool}` };
      const args = command.args;
      if (args[0] === "--version") result.stdout = `${command.tool} fixture-version\n`;
      else if (command.tool === "git" && args[0] === "-C") {
        if (args.includes("--show-toplevel")) result.stdout = `${args[1]}\n`;
        else if (args.includes("--show-current")) result.stdout = `${f.baseline.tuple.branch}\n`;
        else if (args.includes("HEAD")) result.stdout = `${sha}\n`;
        else if (args.includes("status") && args[1] === local) result.stdout = f.baseline.localInputs[0]!.status;
      } else if (command.tool === "git" && args.includes("ls-remote")) result.stdout = `${sha}\trefs/heads/main\n`;
      else if (args[0] === "flake") result.stdout = JSON.stringify(f.metadata);
      else if (args[0] === "config") result.stdout = JSON.stringify(f.config);
      else if (args[0] === "store") result.stdout = JSON.stringify({ url: args[3], version: "fixture" });
      else assert.fail(`unexpected fixed probe ${JSON.stringify(command)}`);
      return result;
    },
  };
  return f;
}

async function rejection(f: Fixture): Promise<NixosPrerequisiteSession> {
  const session = new NixosPrerequisiteSession(f.reference, f.dependencies);
  let commands = 0; let reviewers = 0;
  await assert.rejects(async () => { await session.verify(); await session.executeImmediately(() => { commands++; reviewers++; }); }, diagnostic);
  assert.equal(commands, 0); assert.equal(reviewers, 0);
  assert.ok(session.observations.some((entry) => entry.status === "failed"));
  assert.ok(!JSON.stringify(session.observations).includes(f.baseline.tuple.authorizationId));
  return session;
}

test("strict immutable baseline, raw digest, independent complete probes and one final execution", async () => {
  const f = fixture(); const before = Buffer.from(f.bytes);
  const baseline = parseNixosBaseline(f.bytes);
  assert.ok(Object.isFrozen(baseline)); assert.ok(Object.isFrozen(baseline.tuple)); assert.ok(Object.isFrozen(baseline.storage));
  const session = new NixosPrerequisiteSession(f.reference, f.dependencies);
  await session.verify();
  let executions = 0;
  assert.equal(await session.executeImmediately(() => ++executions), 1);
  assert.equal(executions, 1);
  assert.ok(session.observations.every((entry) => entry.status === "verified"));
  assert.ok(session.observations.some((entry) => entry.phase === "final"));
  assert.deepEqual(f.bytes, before);
  assert.ok(f.commands.some((command) => command.args.includes("--no-write-lock-file")));
  assert.ok(f.commands.filter((command) => command.args.includes("status")).every((command) => command.args.includes("-z") && command.args.includes("--untracked-files=all")));
  await assert.rejects(session.executeImmediately(() => ++executions), diagnostic);
  await assert.rejects(session.verify(), diagnostic);
  assert.equal(executions, 1);
});

for (const key of ["schemaVersion", "tuple", "environment", "localInputs", "tools", "inventory", "storage"]) test(`schema rejects omitted ${key}`, () => {
  const value = seedBaseline() as unknown as Record<string, unknown>; delete value[key];
  assert.throws(() => parseNixosBaseline(json(value)), diagnostic);
});
for (const key of Object.keys(seedBaseline().tuple)) test(`tuple requires ${key}`, () => {
  const value = seedBaseline(); delete (value.tuple as unknown as Record<string, unknown>)[key];
  assert.throws(() => parseNixosBaseline(json(value)), diagnostic);
});
for (const key of Object.keys(seedBaseline().environment)) test(`exact environment requires ${key}`, () => {
  const value = seedBaseline(); delete (value.environment as Record<string, string>)[key];
  assert.throws(() => parseNixosBaseline(json(value)), diagnostic);
});
const malformed: Array<[string, (baseline: NixosBaseline) => void]> = [
  ["unknown schema", (b) => { (b as unknown as { schemaVersion: string }).schemaVersion = "future/v2"; }],
  ["unknown field", (b) => { Object.assign(b, { probe: "sudo build" }); }],
  ["short feature", (b) => { b.tuple.featureSha = "abc"; }],
  ["noncanonical authorization", (b) => { b.tuple.authorizationId = "review-auth:fake"; }],
  ["wrong linked branch", (b) => { b.tuple.branch = "feature/OTHER-1-branch"; }],
  ["relative canonical root", (b) => { b.tuple.canonicalRoot = "../canonical"; }],
  ["source traversal", (b) => { b.tuple.matrixSource = "agent-teams/../escape.md"; }],
  ["unknown environment", (b) => { Object.assign(b.environment, { SECRET: "value" }); }],
  ["auth environment leakage", (b) => { (b.environment as Record<string, string>)["HOME"] = b.tuple.authorizationId; }],
  ["wrong exact environment value", (b) => { (b.environment as Record<string, string>)["PA_FEATURE_SHA"] = "d".repeat(40); }],
  ["missing tool", (b) => { b.tools = b.tools.slice(1); }],
  ["arbitrary executable", (b) => { (b.tools[0]! as unknown as { name: string }).name = "sudo"; }],
  ["duplicate tools", (b) => { b.tools = [...b.tools, b.tools[0]!]; }],
  ["duplicate local input", (b) => { b.localInputs = [...b.localInputs, b.localInputs[0]!]; }],
  ["tracked input status", (b) => { b.localInputs[0]!.status = "1 .M dirty\0"; }],
  ["incomplete untracked input status", (b) => { b.localInputs[0]!.status = "? strange\nname"; }],
  ["unbound local inventory", (b) => { b.inventory.localInputs = []; }],
  ["duplicate endpoint", (b) => { b.inventory.caches = [...b.inventory.caches, ...b.inventory.caches]; }],
  ["HTTP endpoint", (b) => { b.inventory.upstreams = ["http://upstream.invalid/"]; }],
  ["arbitrary SSH payload", (b) => { b.inventory.builders = ["ssh-ng://builder.invalid --command=build"]; }],
  ["endpoint credentials", (b) => { b.inventory.caches = ["https://user:secret@cache.invalid/"]; }],
  ["endpoint options", (b) => { b.inventory.caches = ["https://cache.invalid/?option=1"]; }],
  ["no explicit threshold", (b) => { delete (b.storage[0] as unknown as Record<string, unknown>)["minimumFreeBytes"]; }],
  ["zero threshold", (b) => { b.storage[0]!.minimumFreeBytes = 0; }],
  ["unsafe threshold", (b) => { b.storage[0]!.minimumFreeBytes = Number.MAX_SAFE_INTEGER + 1; }],
  ["duplicate storage", (b) => { b.storage = [...b.storage, b.storage[0]!]; }],
  ["empty storage", (b) => { b.storage = []; b.inventory.storage = []; }],
];
for (const [label, mutate] of malformed) test(`strict schema rejects ${label}`, () => {
  const b = seedBaseline(); mutate(b); assert.throws(() => parseNixosBaseline(json(b)), diagnostic);
});
for (const value of ['{"x":1,"x":2}', '{"nested":{"x":1,"\\u0078":2}}', '{"x":1} trailing', '{"x":01}', '\ufeff{}', '['.repeat(40) + ']'.repeat(40)]) test(`strict raw JSON rejects ${JSON.stringify(value).slice(0, 80)}`, () => {
  assert.throws(() => parseNixosStrictJson(Buffer.from(value)), diagnostic);
});
test("strict raw JSON rejects invalid UTF-8 and oversized bytes", () => {
  assert.throws(() => parseNixosStrictJson(Buffer.from([0xff])), diagnostic);
  assert.throws(() => parseNixosStrictJson(Buffer.alloc(1_048_577)), diagnostic);
});
for (const ref of [{ source }, { source, digest: "a".repeat(64) }, { source, digest: "bad", approvalEvidence: "c-baseline" }, { source, digest: "a".repeat(64), approvalEvidence: "c-baseline", shell: "command" }]) test(`all-or-none reference rejects ${JSON.stringify(ref)}`, () => {
  assert.throws(() => parseNixosBaselineReference(ref), diagnostic);
});

const authorityNegatives: Array<[string, (f: Fixture) => void]> = [
  ["raw source drift", (f) => { f.bytes = Buffer.concat([f.bytes, Buffer.from(" ")]); }],
  ["raw matrix drift", (f) => { f.matrixBytes = Buffer.from(f.matrixBytes.toString().replace("synthetic fixture", "changed fixture")); }],
  ["matrix approval substituted", (f) => { f.comments[0]!.content = "unrelated"; }],
  ["baseline approval missing", (f) => { f.comments.pop(); }],
  ["baseline approval not Sinh", (f) => { f.comments[1]!.author = "caller"; }],
  ["duplicate durable approval", (f) => { f.comments.push(f.comments[1]!); }],
  ["duplicate matrix approval", (f) => { f.comments.push(f.comments[0]!); }],
  ["caller copied verified assertion", (f) => { f.comments[1]!.content = '{"verified":true}'; }],
  ["approval source conflict", (f) => { const a = JSON.parse(f.comments[1]!.content); a.source = "agent-teams/requirements/artifacts/other.json"; f.comments[1]!.content = JSON.stringify(a); }],
  ["approval digest conflict", (f) => { const a = JSON.parse(f.comments[1]!.content); a.digest = "d".repeat(64); f.comments[1]!.content = JSON.stringify(a); }],
  ["approval tuple conflict", (f) => { const a = JSON.parse(f.comments[1]!.content); a.tupleDigest = "d".repeat(64); f.comments[1]!.content = JSON.stringify(a); }],
  ["approval duplicate field", (f) => { f.comments[1]!.content = f.comments[1]!.content.replace('"source":', '"source":"bad","source":'); }],
  ["matrix approval reused for baseline", (f) => { f.reference.approvalEvidence = "c-matrix"; }],
  ["canonical mapping crossed with runtime", (f) => { f.authority.canonicalRepository.repoRoot = root; }],
  ["runtime tuple drift", (f) => { f.authority.tuple.featureSha = "d".repeat(40); }],
  ["environment drift", (f) => { (f.authority.environment as Record<string, string>)["CI"] = "1"; }],
  ["replayed authorization receipt", (f) => { f.authority.authorizationReceipt.reviewDeploymentId = "d-previous"; }],
  ["unconsumed different authorization", (f) => { f.authority.authorizationReceipt.authorizationId = "review-auth:123e4567-e89b-42d3-a456-426614174001"; }],
  ["reset protected budget anchor", (f) => { f.authority.prerequisiteStartedMs = 1; }],
];
for (const [label, mutate] of authorityNegatives) test(`durable authority rejects ${label} before any subprocess`, async () => {
  const f = fixture(); mutate(f); await rejection(f); assert.equal(f.commands.length, 0);
});

const observations: Array<[string, (f: Fixture) => void]> = [
  ["missing metadata graph", (f) => { f.metadata = {}; }],
  ["missing Nix config", (f) => { f.config = {}; }],
  ["unknown Nix input type", (f) => { (f.metadata["locks"] as { nodes: { local: { locked: { type: string } } } }).nodes.local.locked.type = "indirect"; }],
  ["omitted actual cache", (f) => { f.config["substituters"] = { value: ["https://extra.invalid/"] }; }],
  ["omitted actual builder", (f) => { f.config["builders"] = { value: "ssh-ng://extra.invalid x86_64-linux" }; }],
  ["unresolved builder file", (f) => { f.config["builders"] = { value: "@/fixtures/machines" }; }],
  ["daemon mismatch", (f) => { f.config["store"] = { value: "local" }; }],
  ["storage inventory mismatch", (f) => { f.config["build-dir"] = { value: "/other/tmp" }; }],
  ["missing physical input", (f) => { f.dependencies.physicalPath = async (path) => { if (path === local) throw new Error("missing"); return path; }; }],
  ["aliased physical input", (f) => { f.dependencies.physicalPath = async () => "/other"; }],
  ["low storage", (f) => { f.dependencies.freeBytes = async () => 999; }],
  ["unavailable storage", (f) => { f.dependencies.freeBytes = async () => { throw new Error("unavailable"); }; }],
  ["unavailable upstream HEAD", (f) => { f.dependencies.httpsHead = async (endpoint) => ({ endpoint, status: 503 }); }],
  ["redirect upstream HEAD", (f) => { f.dependencies.httpsHead = async (endpoint) => ({ endpoint, status: 302 }); }],
  ["mismatched upstream identity", (f) => { f.dependencies.httpsHead = async () => ({ endpoint: "https://other.invalid/", status: 200 }); }],
];
for (const [label, mutate] of observations) test(`independent observations reject ${label}`, async () => { const f = fixture(); mutate(f); await rejection(f); });
for (const label of ["candidate head", "candidate branch", "Git top level", "tracked status", "untracked status", "tool version", "executable identity", "tool unavailable", "store outage", "store identity", "upstream Git outage"]) test(`fixed observations reject ${label}`, async () => {
  const f = fixture(); const run = f.dependencies.run;
  f.dependencies.run = async (command, signal) => {
    const result = await run(command, signal); const args = command.args;
    if (label === "candidate head" && args.includes("HEAD")) result.stdout = `${"d".repeat(40)}\n`;
    if (label === "candidate branch" && args.includes("--show-current")) result.stdout = "develop\n";
    if (label === "Git top level" && args.includes("--show-toplevel")) result.stdout = "/other\n";
    if (label === "tracked status" && args.includes("status")) result.stdout = "1 .M tracked\0";
    if (label === "untracked status" && args.includes("status")) result.stdout = "? filename\nwith newline\0";
    if (label === "tool version" && args.includes("--version")) result.stdout = "wrong version\n";
    if (label === "executable identity" && args.includes("--version")) result.executable = "/other/bin/tool";
    if (label === "tool unavailable" && args.includes("--version")) result.exitCode = 127;
    if (label === "store outage" && args[0] === "store") result.exitCode = 1;
    if (label === "store identity" && args[0] === "store") result.stdout = '{"url":"other"}';
    if (label === "upstream Git outage" && args.includes("ls-remote")) result.exitCode = 128;
    return result;
  };
  await rejection(f);
});
test("explicit empty builders is complete, not unresolved; storage equality at threshold passes", async () => {
  const f = fixture(); f.baseline.inventory.builders = []; f.config["builders"] = { value: "" }; f.approve();
  f.dependencies.freeBytes = async () => 1000;
  const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify(); await session.executeImmediately(() => undefined);
});
test("approved complete local status preserves newline/rename bytes; clean candidate still has zero records", async () => {
  const f = fixture();
  f.baseline.localInputs[0]!.status = `? untracked\\nname\0` + `2 R. N... 100644 100644 100644 ${sha} ${sha} R100 new name\0old\\nname\0`;
  f.approve();
  const parsed = parseNixosBaseline(f.bytes);
  assert.equal(parsed.localInputs[0]!.status, f.baseline.localInputs[0]!.status);
  const session = new NixosPrerequisiteSession(f.reference, f.dependencies);
  await session.verify(); await session.executeImmediately(() => undefined);
});
test("resolved flake follows references deduplicate discovered inventory without dropping nodes", () => {
  const f = fixture(); const locks = f.metadata["locks"] as { nodes: Record<string, Record<string, unknown>> };
  (locks.nodes["root"]!["inputs"] as Record<string, unknown>)["alias"] = ["local"];
  assert.deepEqual(discoverNixosInventory(json(f.metadata), json(f.config), root).localInputs, [local]);
  locks.nodes["orphan"] = { locked: { type: "path", path: "/missing" } };
  assert.throws(() => discoverNixosInventory(json(f.metadata), json(f.config), root), diagnostic);
});

for (const elapsed of [NIXOS_PROBE_MS, NIXOS_PROBE_MS + 1]) test(`per-probe ${elapsed}ms boundary aborts and preserves failure evidence`, async () => {
  const f = fixture(); let aborted = false;
  f.dependencies.run = async (_command, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    queueMicrotask(() => f.advance(elapsed)); return new Promise(() => undefined);
  };
  const session = await rejection(f);
  assert.equal(aborted, true); assert.equal(session.observations.at(-1)?.reason, "deadline");
  assert.ok(session.observations.at(-1)!.finishedMs - session.observations.at(-1)!.startedMs >= NIXOS_PROBE_MS);
});
test("just under 30 seconds per probe passes within one shared budget", async () => {
  const f = fixture(); const run = f.dependencies.run; let first = true;
  f.dependencies.run = async (command, signal) => { if (first) { first = false; f.advance(NIXOS_PROBE_MS - 2); } return run(command, signal); };
  const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify(); await session.executeImmediately(() => undefined);
});
test("aggregate deadline includes final authority reread, no reset on recreated session", async () => {
  const f = fixture(); const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify();
  f.clock = NIXOS_TOTAL_MS - 1;
  let starts = 0; await assert.rejects(session.executeImmediately(() => starts++), diagnostic);
  assert.equal(starts, 0);
  const recreated = new NixosPrerequisiteSession(f.reference, f.dependencies);
  await assert.rejects(recreated.verify(), diagnostic);
  assert.equal(recreated.observations.length, 1); assert.equal(recreated.observations[0]!.status, "failed");
});
test("aggregate deadline clips a hanging final probe to remaining milliseconds", async () => {
  const f = fixture(); const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify();
  f.clock = NIXOS_TOTAL_MS - 50;
  f.dependencies.readSource = async (_source, signal) => {
    queueMicrotask(() => f.advance(50)); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))); return f.bytes;
  };
  let starts = 0; await assert.rejects(session.executeImmediately(() => starts++), diagnostic); assert.equal(starts, 0);
  assert.equal(f.clock, NIXOS_TOTAL_MS); assert.equal(session.observations.at(-1)!.finishedMs, NIXOS_TOTAL_MS);
});
test("repeated initial/final probes consume the same aggregate budget", async () => {
  const f = fixture(); f.cost = 6_000; await rejection(f); assert.ok(f.clock >= NIXOS_TOTAL_MS);
});
test("regressing monotonic clock rejects instead of resetting time", async () => {
  const f = fixture(); const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify(); f.clock = 0;
  await assert.rejects(session.executeImmediately(() => assert.fail("must not start")), diagnostic);
});
for (const [label, mutate] of [...authorityNegatives.filter(([label]) => label !== "matrix approval reused for baseline"), ...observations]) test(`final revalidation catches ${label} with zero execution/reviewer`, async () => {
  const f = fixture(); const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify(); mutate(f);
  let starts = 0; await assert.rejects(session.executeImmediately(() => starts++), diagnostic); assert.equal(starts, 0);
});
test("last fresh tuple reread rejects drift occurring during final service probes", async () => {
  const f = fixture(); const session = new NixosPrerequisiteSession(f.reference, f.dependencies); await session.verify();
  const run = f.dependencies.run;
  f.dependencies.run = async (command, signal) => { const result = await run(command, signal); if (command.args[0] === "store") f.authority.tuple.featureSha = "d".repeat(40); return result; };
  let starts = 0; await assert.rejects(session.executeImmediately(() => starts++), diagnostic); assert.equal(starts, 0);
});

const fixedTools = Object.fromEntries(NIXOS_TOOLS.map((name) => [name, process.execPath])) as Record<NixosTool, string>;
const probeEnv = { PATH: "/usr/bin:/bin", HOME: tmpdir(), LANG: "C.UTF-8", TZ: "UTC" };
for (const command of [
  { tool: "nix", args: ["build", "anything"] }, { tool: "bash", args: ["-c", "exit 0"] }, { tool: "git", args: ["status", "--short"] },
  { tool: "nix", args: ["store", "ping", "--store", "https://cache.invalid/?command=build", "--json"] },
  { tool: "git", args: ["-c", "http.followRedirects=true", "ls-remote", "--", "https://upstream.invalid/"] },
  { tool: "nix", args: ["flake", "metadata", "--json", "--update-lock-file", "--no-write-lock-file", root] },
  { tool: "sudo", args: ["--version"] },
]) test(`fixed runner rejects arbitrary payload ${JSON.stringify(command)}`, async () => {
  const runner = createNixosProbeRunner(fixedTools, probeEnv);
  await assert.rejects(runner({ ...command, cwd: tmpdir() } as NixosProbeCommand, new AbortController().signal), diagnostic);
});
test("probe runner environment excludes ambient secrets and authority", () => {
  assert.throws(() => createNixosProbeRunner(fixedTools, { ...probeEnv, PA_REVIEW_AUTHORIZATION_ID: seedBaseline().tuple.authorizationId }), diagnostic);
  assert.throws(() => createNixosProbeRunner(fixedTools, { ...probeEnv, HOME: seedBaseline().tuple.authorizationId }), diagnostic);
});
test("real fixed subprocess is terminated on abort (disposable executable, no Nix or network)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pap236-probe-"));
  try {
    const executable = join(temp, "nix-fixture"); const pidFile = join(temp, "pid");
    writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const runner = createNixosProbeRunner({ ...fixedTools, nix: executable }, probeEnv);
    const controller = new AbortController();
    const running = runner({ tool: "nix", args: ["--version"], cwd: temp }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 300);
    await assert.rejects(running, /terminated/); clearTimeout(timer);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("production filesystem probes use disposable storage, not live NX-055", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pap236-files-"));
  try {
    const f = fixture();
    const deps = createNixosPrerequisiteDependencies({ tools: fixedTools, probeEnvironment: probeEnv, budgetStartedMs: 0, rereadAuthority: f.dependencies.rereadAuthority });
    assert.equal(await deps.physicalPath(temp, new AbortController().signal), temp);
    assert.ok(await deps.freeBytes(temp, new AbortController().signal) > 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("malformed protected baseline fails closed before executor/reviewer (full launch integration deferred)", async () => {
  let commands = 0; let reviewers = 0;
  const result = await runPiValidationBeforeReviewer({ nixosBaseline: { source } }, {
    evidenceRoot: "/fixtures/evidence", ledgerPath: "/fixtures/evidence/ledger", startReviewer: () => reviewers++,
    execute: async () => { commands++; assert.fail("must not execute"); },
  });
  assert.equal(result.admitted, false); assert.equal(commands, 0); assert.equal(reviewers, 0);
});
