#!/usr/bin/env node
// Isolated installed compatibility proof only; never a live review/readiness approval.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`${name} required`); return args[index + 1]; }
const binary = realpathSync(option("--ppa"));
const expected = option("--expected-feature-sha");
assert.match(expected, /^[0-9a-f]{40}$/);
const store = dirname(dirname(binary));
const share = resolve(store, "share/pa-platform");
const provenance = JSON.parse(readFileSync(resolve(share, "review-runtime-provenance.json"), "utf8"));
assert.equal(provenance.schemaVersion, "pa-review-runtime/v1");
assert.equal(provenance.sourceSha, expected, "compare independently packaged Git revision; dirty/echoed input is not provenance");
assert.equal(provenance.objectiveSchema, "pa-review-objective/v1");
assert.equal(provenance.matrixSchema, "pa-review-matrix/v1");
const root = realpathSync(mkdtempSync(resolve(tmpdir(), "pap237-installed-")));
const fixtures = resolve(share, "protected-review-v1-fixtures");
const preload = resolve(root, "observational-guards.mjs");
const guard = `
import fs from 'node:fs'; import cp from 'node:child_process'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
const counts={writes:0,subprocesses:0,network:0};
const trap=(kind)=>()=>{counts[kind]++; throw new Error('forbidden static '+kind);};
for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','chmodSync','truncateSync','writeSync','createWriteStream','linkSync','symlinkSync']) fs[name]=trap('writes');
for(const name of ['writeFile','appendFile','mkdir','rename','unlink','rm','chmod','truncate','open','link','symlink']) fs.promises[name]=trap('writes');
const open=fs.openSync; fs.openSync=(path,flags,...args)=>{if(typeof flags==='string' ? /[wa+]/.test(flags) : flags & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)) return trap('writes')(); return open(path,flags,...args);};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name]=trap('subprocesses');
for(const module of [http,https]) for(const name of ['request','get']) module[name]=trap('network');
net.connect=net.createConnection=trap('network'); globalThis.fetch=trap('network'); syncBuiltinESMExports();
process.on('exit',()=>process.stderr.write('STATIC_GUARDS='+JSON.stringify(counts)+'\\n'));
`;
writeFileSync(preload, guard);
function snapshot(path) {
  const result = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const child = resolve(path, entry.name);
    result.push(entry.isDirectory() ? [child, snapshot(child)] : [child, readFileSync(child).toString("base64")]);
  }
  return result;
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PA_|PI_|GIT_|NODE_OPTIONS)/.test(key)));
Object.assign(environment, { PA_AI_USAGE_HOME: resolve(root, "state"), PA_REGISTRY_DB: resolve(root, "absent-registry/registry.db"), PA_PLATFORM_CONFIG: resolve(root, "config"), PA_PLATFORM_TEAMS: resolve(root, "teams"), NODE_OPTIONS: `--import=${preload}` });
function run(request, json = true) {
  const before = snapshot(root);
  const result = spawnSync(binary, ["review", "preflight", "--ticket", "FIX-237", "--objective-file", request, ...(json ? ["--json"] : [])], { env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 });
  if (result.error || result.signal) throw new Error("isolated installed preflight did not terminate normally");
  assert.deepEqual(snapshot(root), before, "preflight wrote isolated evidence/state");
  assert.match(result.stderr, /STATIC_GUARDS=\{"writes":0,"subprocesses":0,"network":0\}/);
  assert.doesNotMatch(result.stdout + result.stderr, /review-auth:/);
  return result;
}
const results = [];
try {
  mkdirSync(resolve(root, "state/tickets"), { recursive: true });
  mkdirSync(resolve(root, "config"), { recursive: true });
  for (const name of ["producer-node-pnpm", "mvm-179-migrated", "nx-055-migrated"]) {
    const objective = JSON.parse(readFileSync(resolve(fixtures, `${name}.objective.json`), "utf8"));
    objective.prerequisiteEvidence["paired-runtime-ready"] = "c-20000101000000001";
    const artifact = readFileSync(resolve(fixtures, `${name}.md`), "utf8");
    const matrix = JSON.parse(artifact.match(/```json\n([\s\S]*?)\n```/)[1]);
    const artifactPath = resolve(root, "state", objective.matrixSource.slice("requirements:".length));
    mkdirSync(dirname(artifactPath), { recursive: true }); writeFileSync(artifactPath, artifact);
    writeFileSync(resolve(root, "config/repos.yaml"), `repos:\n  ${matrix.repository.key}:\n    path: ${matrix.repository.root}\n`);
    const readiness = JSON.parse(readFileSync(resolve(fixtures, "readiness.json"), "utf8"));
    Object.assign(readiness, { matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256 });
    const ticket = { id: "FIX-237", doc_refs: [{ type: "requirements", path: objective.matrixSource.slice("requirements:".length) }],
      linkedBranches: [{ repo: matrix.repository.key, branch: objective.branch, state: "materialized", baseSha: matrix.repository.baseSha, headSha: objective.featureSha }],
      comments: [{ id: objective.matrixApprovalEvidence, author: "sinh", content: `Approved ${objective.branch} ${objective.matrixSource} ${objective.matrixAuthoritySha256}` },
        { id: objective.prerequisiteEvidence["paired-runtime-ready"], author: "sinh", content: JSON.stringify(readiness) }] };
    writeFileSync(resolve(root, "state/tickets/FIX-237.json"), JSON.stringify(ticket));
    const request = resolve(root, "request.json"); writeFileSync(request, JSON.stringify(objective));
    const result = run(request);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.status, "compatible");
    assert.ok(report.deferredLaunchChecks.length > 0);
    const text = run(request, false); assert.equal(text.status, 0); assert.match(text.stdout, /not launch authorization/);
    writeFileSync(request, JSON.stringify(objective).replace('"ticket"', '"\\u0074icket"').replace("review-auth:", "\\u0072eview-auth:"));
    const escaped = run(request); assert.equal(escaped.status, 0, escaped.stdout + escaped.stderr);
    assert.equal(JSON.parse(escaped.stdout).status, "compatible");
    results.push({ profile: matrix.profile, compatible: true, jsonEscapesCompatible: true });
  }
  const legacy = resolve(root, "legacy.json"); writeFileSync(legacy, "# Ordinary objective\n\nTicket: FIX-237\n");
  const rejected = run(legacy); assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, "REVIEW_LEGACY_MIGRATION");
  console.log(JSON.stringify({ schemaVersion: "pa-review-installed-smoke/v1", binary, provenance, profiles: results, legacyRejected: true,
    staticSideEffects: { writes: 0, subprocesses: 0, network: 0, allocations: 0, claims: 0, attempts: 0, matrixStarts: 0 },
    actualProtectedReview: false, readinessApproval: false, pairedProducerProof: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
