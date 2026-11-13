import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AutoWaitlistError, buildAutoWaitlist, getDb, type AutoWaitlistView } from "@pa-platform/pa-core";
import { runAutoCommand, type AutoCliHost } from "../auto-cli.js";

function fixture() {
  const at = new Date().toISOString();
  const snapshot = buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [
    { key: "pa-platform", prefix: "PAP", canonicalRoot: "/synthetic/pa-platform" }, { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: "/synthetic/pa-platform-config" },
  ], tickets: [] });
  const view: AutoWaitlistView = { state: { schemaVersion: "pa-auto-state/v1", snapshot, lastAttempt: { at, outcome: "completed", code: null } }, freshness: "fresh", scan: "idle" };
  let reads = 0, scans = 0, produces = 0;
  const host: AutoCliHost = { read: () => { reads++; return view; }, scan: produce => { scans++; produce(); return view; }, produce: () => { produces++; return snapshot; } };
  const out: string[] = [], err: string[] = [], io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
  return { snapshot, view, host, out, err, io, counts: () => [reads, scans, produces] };
}
test("help and invalid schemas perform no observations, decisions or effects", () => {
  const f = fixture(); assert.equal(runAutoCommand(["--help"], f.io, f.host), 0);
  for (const args of [["approve"], ["select", "PAP-302"], ["scan", "--approved"], ["--actor", "human"], ["--json", "--json"], ["--page", "0"], ["--page", "1;echo"], ["status", "--section", "all"], ["--help", "--json"], ["x".repeat(65_537)]]) {
    assert.equal(runAutoCommand(args, f.io, f.host), 1);
  }
  assert.deepEqual(f.counts(), [0, 0, 0]);
});
test("list and status are pure readers; opening and scan only refresh the unsigned snapshot", () => {
  const f = fixture();
  for (const args of [["list"], ["status"], [], ["scan"]]) assert.equal(runAutoCommand(args, f.io, f.host), 0);
  assert.deepEqual(f.counts(), [2, 2, 2]);
  assert.match(f.out.join("\n"), /selection and execution are not enabled/);
  assert.equal(f.err.length, 0);
});
test("JSON is one envelope on stdout without prose; failures preserve exit and stderr contracts", () => {
  const f = fixture(); assert.equal(runAutoCommand(["list", "--json"], f.io, f.host), 0);
  const result = JSON.parse(f.out[0]!); assert.equal(result.schemaVersion, "pa-auto-result/v1"); assert.equal(result.service.executionAdmitted, false);
  assert.equal(f.err.length, 0); assert.equal(f.out.length, 1);
  const bad = fixture(); assert.equal(runAutoCommand(["approve", "--json"], bad.io, bad.host), 1);
  assert.equal(JSON.parse(bad.out[0]!).code, "AUTO_INPUT"); assert.equal(bad.err.length, 0);
});
test("failed refresh returns stale rows, original version and a typed failure, not a fresh empty list", () => {
  const f = fixture(); f.view.freshness = "stale"; f.view.state!.lastAttempt = { at: new Date().toISOString(), outcome: "failed", code: "AUTO_SOURCE" };
  assert.equal(runAutoCommand(["scan", "--json"], f.io, f.host), 1);
  const result = JSON.parse(f.out[0]!); assert.equal(result.freshness, "stale"); assert.equal(result.snapshotVersion, f.snapshot.version); assert.equal(result.code, "AUTO_SOURCE");
  assert.equal(runAutoCommand(["scan"], f.io, f.host), 1); assert.match(f.err[0]!, /Condition:.*blocked/);
});
test("overlapping or unsettled scan is not reported as completed", () => {
  const f = fixture(); f.view.scan = "busy-or-unsettled";
  assert.equal(runAutoCommand(["scan", "--json"], f.io, f.host), 1);
  assert.equal(JSON.parse(f.out[0]!).code, "AUTO_BUSY");
});
test("returned and thrown failures do not leak private text or invoke hostile getters", () => {
  for (const error of [new Error("SYNTHETIC_PRIVATE exception"), new Proxy({}, { getPrototypeOf() { throw new Error("SYNTHETIC_PRIVATE getter"); } }), Object.defineProperty(new AutoWaitlistError("AUTO_SOURCE"), "code", { get() { throw new Error("SYNTHETIC_PRIVATE getter"); } })]) {
    const f = fixture(); f.host.read = () => { throw error; };
    assert.equal(runAutoCommand(["list"], f.io, f.host), 1);
    assert.doesNotMatch(f.err.join("\n"), /SYNTHETIC_PRIVATE/); assert.equal(f.out.length, 0);
  }
});
test("compiled public CLI routes list/status/help without initialization or OPA changes", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-cli-"));
  try {
    const env = { ...process.env, NO_COLOR: "1", PA_AI_USAGE_HOME: join(root, "absent"), PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "missing.db") };
    const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    for (const args of [["list", "--json"], ["status", "--json"], ["--help"]]) {
      const r = spawnSync(process.execPath, [cli, "auto", ...args], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, "");
      if (args.includes("--json")) assert.equal(JSON.parse(r.stdout).freshness, "missing"); else assert.match(r.stdout, /inspection|Inspect|Read/);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("compiled public scanner publishes both projects without changing source bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-success-cli-"));
  try {
    const usage = join(root, "usage"), config = join(root, "config");
    for (const path of [join(usage, "tickets"), join(usage, "bulletins/active"), config, join(root, "pap"), join(root, "papc")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: {
      "pa-platform": { path: join(root, "pap"), prefix: "PAP" }, "pa-platform-config": { path: join(root, "papc"), prefix: "PAPC" },
    } }));
    for (const [id, project] of [["PAP-1", "pa-platform"], ["PAPC-2", "pa-platform-config"]]) writeFileSync(join(usage, "tickets", `${id}.json`), JSON.stringify({ id, project, title: "Synthetic", status: "idea", priority: "medium", createdAt: "2026-11-13T10:00:00.000Z", tags: [], blockedBy: [], doc_refs: [] }));
    const dbPath = join(usage, "registry.db"); getDb(dbPath).close(); const registryBefore = readFileSync(dbPath);
    const env = { ...process.env, NO_COLOR: "1", PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_PLATFORM_HOME: join(root, "papc"), PA_REGISTRY_DB: dbPath };
    const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    const r = spawnSync(process.execPath, [cli, "auto", "scan", "--json"], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout); assert.equal(r.stderr, ""); const result = JSON.parse(r.stdout);
    assert.deepEqual(result.entries.map((e: { id: string }) => e.id), ["PAP-1", "PAPC-2"]); assert.equal(result.freshness, "fresh");
    assert.ok(readFileSync(dbPath).equals(registryBefore)); assert.deepEqual(readdirSync(join(root, "pap")), []); assert.deepEqual(readdirSync(join(root, "papc")), []);
    assert.equal(existsSync(`${dbPath}-wal`), false); assert.equal(existsSync(join(usage, "auto/.scan.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("compiled public scan worker failure saves a truthful missing snapshot and no registry", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-scan-cli-"));
  try {
    const usage = join(root, "usage"); mkdirSync(usage);
    const env = { ...process.env, NO_COLOR: "1", PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "missing.db") };
    const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    const r = spawnSync(process.execPath, [cli, "auto", "scan", "--json"], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 1); assert.equal(r.stderr, ""); const result = JSON.parse(r.stdout);
    assert.equal(result.code, "AUTO_SOURCE"); assert.equal(result.freshness, "missing"); assert.equal(result.snapshotVersion, null);
    assert.equal(JSON.parse(readFileSync(join(usage, "auto/waitlist.json"), "utf8")).snapshot, null);
    assert.equal(existsSync(join(root, "missing.db")), false); assert.equal(existsSync(join(usage, "auto/.scan.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
