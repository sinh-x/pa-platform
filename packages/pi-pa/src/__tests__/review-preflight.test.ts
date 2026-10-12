import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseReviewMatrixArtifact, parseReviewObjective, runCoreCommand, type Ticket } from "@pa-platform/pa-core";
import { createHash } from "node:crypto";
import { inspectReviewPreflight, formatReviewPreflight, runReviewPreflightCommand, reviewPreflightDependencies } from "../review-preflight.js";
import { createPiHooks, deployWithPi } from "../deploy.js";

const fixtures = fileURLToPath(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/", import.meta.url));
const raw = (name: string) => fs.readFileSync(resolve(fixtures, name));
function setup(name = "producer-node-pnpm") {
  const root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), "pap237-preflight-")));
  const objective = parseReviewObjective(raw(`${name}.objective.json`));
  objective.prerequisiteEvidence["paired-runtime-ready"] = "c-20000101000000001";
  const artifact = parseReviewMatrixArtifact(raw(`${name}.md`), objective.matrixSource);
  const path = resolve(root, objective.matrixSource.slice("requirements:".length));
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, raw(`${name}.md`));
  const binding = JSON.parse(raw("readiness.json").toString());
  Object.assign(binding, { matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256 });
  const ticket = { id: objective.ticket, doc_refs: [{ type: "requirements", path: objective.matrixSource.slice("requirements:".length) }],
    linkedBranches: [{ repo: artifact.matrix.repository.key, branch: objective.branch, state: "materialized", baseSha: artifact.matrix.repository.baseSha, headSha: objective.featureSha }],
    comments: [{ id: objective.matrixApprovalEvidence, author: "sinh", content: `Approved ${objective.branch} ${objective.matrixSource} ${objective.matrixAuthoritySha256}` },
      { id: objective.prerequisiteEvidence["paired-runtime-ready"], author: "sinh", content: JSON.stringify(binding) }] } as Ticket;
  const dependencies = { aiUsageRoot: root, readTicket: () => ticket, repositories: () => ({ [artifact.matrix.repository.key]: { path: artifact.matrix.repository.root } }) };
  return { root, objective, ticket, dependencies };
}
function snapshot(root: string): string {
  const entries: string[] = [];
  const walk = (path: string): void => {
    for (const name of fs.readdirSync(path).sort()) {
      const child = resolve(path, name); const stat = fs.lstatSync(child);
      entries.push(`${child}:${stat.mode}:${stat.size}`);
      if (stat.isDirectory()) walk(child); else entries.push(fs.readFileSync(child).toString("base64"));
    }
  };
  walk(root); return JSON.stringify(entries);
}
test("all three producer profiles share compatible text/JSON decisions, deferred live checks and no authority", () => {
  for (const name of ["producer-node-pnpm", "mvm-179-migrated", "nx-055-migrated", "mvm-181-migrated"]) {
    const seed = setup(name);
    try {
      const { report } = inspectReviewPreflight({ ticket: seed.objective.ticket, objective: JSON.stringify(seed.objective) }, seed.dependencies);
      assert.equal(report.status, "compatible", JSON.stringify(report));
      assert.ok(report.checks.every((check) => check.status === "passed"));
      assert.ok(report.deferredLaunchChecks.length >= 5);
      assert.match(formatReviewPreflight(report), /not launch authorization/);
      assert.doesNotMatch(JSON.stringify(report), /review-auth:/);
    } finally { fs.rmSync(seed.root, { recursive: true, force: true }); }
  }
});
test("external-project readiness binds its candidate independently from the installed PPA source", () => {
  const seed = setup("mvm-179-migrated");
  try {
    const binding = JSON.parse(seed.ticket.comments[1]!.content);
    binding.installedRuntime.sourceSha = "a".repeat(40);
    assert.notEqual(binding.installedRuntime.sourceSha, seed.objective.featureSha);
    seed.ticket.comments[1]!.content = JSON.stringify(binding);
    assert.equal(inspectReviewPreflight({ ticket: seed.objective.ticket, objective: JSON.stringify(seed.objective) }, seed.dependencies).report.status, "compatible");
  } finally { fs.rmSync(seed.root, { recursive: true, force: true }); }
});
test("escaped and unescaped sensitive command/environment values reject equivalently without authority rewriting", () => {
  for (const escaped of [false, true]) for (const target of ["command", "environment"]) {
    const seed = setup();
    try {
      const path = resolve(seed.root, seed.objective.matrixSource.slice("requirements:".length));
      const original = fs.readFileSync(path, "utf8");
      const match = /```json\n([\s\S]*?)\n```/.exec(original)!;
      const matrix = JSON.parse(match[1]!);
      const synthetic = "sk-" + "A".repeat(25);
      if (target === "command") matrix.commands[0].command = `printf '%s' '${synthetic}'`;
      else matrix.environment.CI.literal = synthetic;
      let payload = JSON.stringify(matrix, null, 2);
      if (escaped) payload = payload.replace(synthetic, "sk-\\u0041" + "A".repeat(24));
      let artifact = original.replace(match[1]!, payload);
      const section = artifact.slice(artifact.indexOf("### Full Validation Matrix"), artifact.indexOf("## After Matrix"));
      const digest = createHash("sha256").update(section).digest("hex");
      const oldDigest = seed.objective.matrixAuthoritySha256;
      artifact = artifact.replace(oldDigest, digest);
      seed.objective.matrixAuthoritySha256 = digest;
      seed.ticket.comments.forEach((comment) => { comment.content = comment.content.replace(oldDigest, digest); });
      fs.writeFileSync(path, artifact);
      const report = inspectReviewPreflight({ ticket: seed.objective.ticket, objective: JSON.stringify(seed.objective) }, seed.dependencies).report;
      assert.equal(report.status, "incompatible");
      assert.ok(report.diagnostics.some((d) => d.code === "REVIEW_SENSITIVE" && d.source === "artifact.matrix"), JSON.stringify(report));
      assert.doesNotMatch(JSON.stringify(report), new RegExp(synthetic));
      assert.equal(fs.readFileSync(path, "utf8"), artifact, "preflight never rewrites approved bytes to inspect decoded values");
    } finally { fs.rmSync(seed.root, { recursive: true, force: true }); }
  }
});

test("independent objective and binding defects aggregate deterministically, malformed JSON explicitly blocks dependencies", () => {
  const seed = setup();
  try {
    const input = { ticket: seed.objective.ticket, objective: JSON.stringify({ ...seed.objective, featureSha: "BAD", matrixAuthoritySha256: "BAD", reviewAuthorizationId: "BAD" }) };
    const a = inspectReviewPreflight(input, seed.dependencies).report;
    assert.deepEqual(inspectReviewPreflight(input, seed.dependencies).report, a);
    assert.deepEqual(a.diagnostics.map((d) => d.source), ["objective.featureSha", "objective.matrixAuthoritySha256", "objective.reviewAuthorizationId"]);
    assert.ok(a.checks.some((check) => check.id === "artifact.schema" && check.status === "blocked"));
    seed.ticket.comments[0]!.author = "other";
    const objective = { ...seed.objective, matrixAuthoritySha256: "c".repeat(64), matrixApprovalEvidence: "c-20000101000000003" };
    const b = inspectReviewPreflight({ ticket: objective.ticket, objective: JSON.stringify(objective) }, seed.dependencies).report;
    assert.ok(b.diagnostics.length >= 4);
    assert.ok(b.diagnostics.every((d) => formatReviewPreflight({ ...b, checks: [], diagnostics: [d], deferredLaunchChecks: [] }).length < 2000));
    assert.doesNotMatch(JSON.stringify(b), /review-auth:/);
    const malformed = inspectReviewPreflight({ ticket: objective.ticket, objective: '{"schemaVersion":' }, seed.dependencies).report;
    assert.equal(malformed.diagnostics[0]?.code, "REVIEW_JSON");
    assert.ok(malformed.checks.some((check) => check.status === "blocked"));
  } finally { fs.rmSync(seed.root, { recursive: true, force: true }); }
});
test("static engine traps every write/subprocess/network path and preserves existing or absent state", (t) => {
  const seed = setup();
  const before = snapshot(seed.root);
  const input = JSON.stringify(seed.objective);
  const forbidden = () => { throw new Error("static side effect"); };
  const traps = [
    ...["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "chmodSync", "truncateSync", "writeSync", "createWriteStream"].map((key) => t.mock.method(fs, key as "writeFileSync", forbidden)),
    ...["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((key) => t.mock.method(cp, key as "spawn", forbidden)),
    t.mock.method(net, "connect", forbidden), t.mock.method(net, "createConnection", forbidden),
    t.mock.method(http, "request", forbidden), t.mock.method(https, "request", forbidden), t.mock.method(globalThis, "fetch", forbidden),
  ];
  syncBuiltinESMExports();
  try {
    assert.equal(inspectReviewPreflight({ ticket: seed.objective.ticket, objective: input }, seed.dependencies).report.status, "compatible");
    const missing = inspectReviewPreflight({ ticket: seed.objective.ticket, objective: input }, { ...seed.dependencies, aiUsageRoot: resolve(seed.root, "absent") }).report;
    assert.equal(missing.status, "incompatible");
    assert.equal(missing.diagnostics[0]?.code, "REVIEW_IO");
    assert.ok(traps.every((trap) => trap.mock.callCount() === 0));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(snapshot(seed.root), before);
  fs.rmSync(seed.root, { recursive: true, force: true });
});
test("CLI read-only durable adapters, statuses and redaction, no state directory creation", () => {
  const seed = setup(); const previous = process.env.PA_AI_USAGE_HOME;
  process.env.PA_AI_USAGE_HOME = seed.root;
  try {
    fs.mkdirSync(resolve(seed.root, "tickets"));
    fs.writeFileSync(resolve(seed.root, "tickets/FIX-237.json"), JSON.stringify(seed.ticket));
    assert.equal(reviewPreflightDependencies().readTicket("FIX-237").id, "FIX-237");
    const objectiveFile = resolve(seed.root, "objective.json"); fs.writeFileSync(objectiveFile, "# legacy\n\nTicket: FIX-237\n");
    let output = ""; let error = ""; const io = { stdout: (s: string) => { output += s; return true; }, stderr: (s: string) => { error += s; return true; } };
    const before = snapshot(seed.root);
    assert.equal(runReviewPreflightCommand(["preflight", "--ticket", "FIX-237", "--objective-file", objectiveFile, "--json"], io), 1);
    assert.equal(JSON.parse(output).schemaVersion, "pa-review-preflight/v1");
    assert.equal(JSON.parse(output).diagnostics[0].code, "REVIEW_LEGACY_MIGRATION");
    assert.equal(runReviewPreflightCommand(["preflight", "--ticket", "FIX-237", "--ticket", "FIX-237", "--objective-file", objectiveFile], io), 2);
    assert.equal(runReviewPreflightCommand(["preflight", "--ticket", "FIX-237", "--objective-file", resolve(seed.root, "absent")], io), 2);
    assert.equal(snapshot(seed.root), before);
    assert.doesNotMatch(output + error, /review-auth:/);
  } finally { if (previous === undefined) delete process.env.PA_AI_USAGE_HOME; else process.env.PA_AI_USAGE_HOME = previous; fs.rmSync(seed.root, { recursive: true, force: true }); }
});
test("public PPA CLI rejects incompatible authority before Git, TicketStore initialization or adapter calls", async (t) => {
  const seed = setup();
  const prior = { PA_AI_USAGE_HOME: process.env.PA_AI_USAGE_HOME, PA_PLATFORM_CONFIG: process.env.PA_PLATFORM_CONFIG, PA_PLATFORM_TEAMS: process.env.PA_PLATFORM_TEAMS };
  process.env.PA_AI_USAGE_HOME = seed.root; process.env.PA_PLATFORM_CONFIG = resolve(seed.root, "config"); process.env.PA_PLATFORM_TEAMS = resolve(seed.root, "teams");
  fs.mkdirSync(resolve(seed.root, "teams"));
  fs.writeFileSync(resolve(seed.root, "teams/requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: review-auto\ndeploy_modes:\n  - id: review-auto\n    description: fixture\n    require_ticket: true\n");
  const hooks = createPiHooks(); let deploys = 0; hooks.deploy = () => { deploys++; return { status: "pending" }; };
  const before = snapshot(seed.root);
  const forbidden = () => { throw new Error("CLI static side effect"); };
  const traps = [
    ...["mkdirSync", "writeFileSync", "appendFileSync", "renameSync"].map((key) => t.mock.method(fs, key as "mkdirSync", forbidden)),
    ...["spawnSync", "spawn", "execFileSync", "execSync"].map((key) => t.mock.method(cp, key as "spawn", forbidden)),
    t.mock.method(globalThis, "fetch", forbidden),
  ];
  syncBuiltinESMExports();
  try {
    // Inline requests exercise the whole public CLI without fixture-file writes
    // under the traps. The absent tickets directory must remain absent.
    for (const objective of ["# Legacy objective\n\nTicket: FIX-237", "\ufeff" + JSON.stringify(seed.objective), JSON.stringify(seed.objective).replace('"ticket"', '"ti' + String.fromCharCode(1) + 'cket"')]) {
      let output = "";
      const code = await runCoreCommand(["deploy", "requirements", "--mode", "review-auto", "--ticket", "FIX-237", "--ticket-worktree", "--objective", objective], {
        binaryName: "ppa", hooks, io: { stdout: (s) => { output += s; }, stderr: (s) => { output += s; } },
      });
      assert.equal(code, 1); assert.match(output, /REVIEW_LEGACY_MIGRATION|REVIEW_UTF8|REVIEW_JSON/);
      assert.doesNotMatch(output, /review-auth:|sanitized objective/);
    }
    assert.equal(deploys, 0); assert.ok(traps.every((trap) => trap.mock.callCount() === 0));
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(snapshot(seed.root), before); assert.equal(fs.existsSync(resolve(seed.root, "tickets")), false);
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("production deploy and dry-run reject legacy before ID/state allocation or runtime probes", async () => {
  const seed = setup();
  const env = { PA_AI_USAGE_HOME: process.env.PA_AI_USAGE_HOME, PA_PLATFORM_CONFIG: process.env.PA_PLATFORM_CONFIG, PA_PLATFORM_TEAMS: process.env.PA_PLATFORM_TEAMS };
  process.env.PA_AI_USAGE_HOME = seed.root; process.env.PA_PLATFORM_CONFIG = resolve(seed.root, "config");
  try {
    process.env.PA_PLATFORM_TEAMS = resolve(seed.root, "config/teams");
    fs.mkdirSync(resolve(seed.root, "config/teams"), { recursive: true });
    fs.writeFileSync(resolve(seed.root, "config/teams/requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: review-auto\ndeploy_modes:\n  - id: review-auto\n    description: fixture\n    require_ticket: true\n");
    fs.mkdirSync(resolve(seed.root, "tickets")); fs.writeFileSync(resolve(seed.root, "tickets/FIX-237.json"), JSON.stringify(seed.ticket));
    const before = snapshot(seed.root);
    for (const dryRun of [false, true]) {
      const result = await deployWithPi({ team: "requirements", mode: "review-auto", ticket: "FIX-237", background: true, dryRun, objective: raw("legacy-objective.md").toString() });
      assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined);
      assert.match(result.reason ?? "", /REVIEW_LEGACY_MIGRATION/);
      assert.doesNotMatch(result.reason ?? "", /review-auth:/);
    }
    assert.equal(snapshot(seed.root), before);
    assert.equal(fs.existsSync(resolve(seed.root, "deployments")), false);
  } finally { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(seed.root, { recursive: true, force: true }); }
});
