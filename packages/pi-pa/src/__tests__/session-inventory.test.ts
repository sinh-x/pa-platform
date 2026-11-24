import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessFingerprint, type SessionCandidate } from "@pa-platform/pa-core";
import { captureSessionProcesses, recheckSessionProcesses, type InventoryHost } from "../session-inventory.js";
import { classifySessionProcess, observeSessionProcess, type ProcessObservation } from "../session-process.js";
import { readPiProcessIdentity } from "../process-identity.js";
const fp: ProcessFingerprint = { pid: 42, startTimeTicks: "123", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
const present: ProcessObservation = { kind: "present", fingerprint: fp, state: "S", parentPid: 1 };
const candidate = (n = 0): SessionCandidate => ({ deploymentId: `d-${n.toString(16).padStart(6, "0")}`, candidatePid: 42, team: "rogue-one", mode: "rogue-one", repositoryRoot: "/repo", ticket: "PAP-281", startedAt: "2026-11-24T00:00:00Z", registryStatus: "success" });
const host = (candidates = [candidate()]): InventoryHost => ({ candidates: () => ({ candidates, complete: true }), repositories: () => ({ project: { path: "/repo" } }), anchor: () => fp, process: () => present, clock: () => 0 });
test("fresh capture has 22 rows, includes terminal registry statuses and intersects exact filters before probes", () => {
  const h = host(Array.from({ length: 22 }, (_, i) => candidate(i)));
  let reads = 0; h.anchor = () => { reads++; return fp; };
  assert.equal(captureSessionProcesses({}, h, 100).rows.length, 22);
  assert.equal(reads, 22);
  reads = 0;
  assert.equal(captureSessionProcesses({ deployment: "d-000001", ticket: "PAP-281", repo: "project" }, h, 100).rows.length, 1);
  assert.equal(reads, 1);
  assert.equal(captureSessionProcesses({ ticket: "PAP-28" }, h, 100).rows.length, 0);
  h.candidates = () => ({ candidates: [], complete: true });
  assert.equal(captureSessionProcesses({}, h, 100).rows.length, 0);
});
test("incarnation, zombie, proven absence and inaccessible are distinct", () => {
  assert.equal(classifySessionProcess(fp, 42, present).state, "verified-open");
  for (const patch of [{ startTimeTicks: "456" }, { bootId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" }]) {
    assert.equal(classifySessionProcess(fp, 42, { ...present, fingerprint: { ...fp, ...patch } }).state, "identity-mismatch");
  }
  assert.equal(classifySessionProcess(fp, 43, present).state, "identity-mismatch");
  for (const state of ["Z", "X", "x"]) assert.equal(classifySessionProcess(fp, 42, { ...present, state }).state, "zombie-or-dead");
  assert.equal(classifySessionProcess(fp, 42, { kind: "exited" }).state, "exited");
  assert.equal(classifySessionProcess(fp, 42, { kind: "unverified", reason: "process-inaccessible" }).state, "unverified");
});
test("procfs observes only stat/boot; denied and hidden absence never prove exit", () => {
  const stat = `42 (name with ) paren) S 1 ${Array(17).fill("0").join(" ")} 123`;
  const reads: string[] = [];
  const result = observeSessionProcess(42, path => { reads.push(path); return path.endsWith("/stat") ? stat : fp.bootId; });
  assert.deepEqual(result, present); assert.equal(reads.length, 2);
  for (const code of ["EACCES", "EPERM", "ENOENT", "ESRCH"]) {
    const read = (path: string) => { if (path === "/proc/mounts") return "proc /proc proc rw,hidepid=2 0 0"; throw Object.assign(new Error("private"), { code }); };
    assert.equal(observeSessionProcess(42, read).kind, "unverified");
  }
  assert.equal(observeSessionProcess(42, path => { if (path === "/proc/mounts") return "proc /proc proc rw 0 0"; throw Object.assign(new Error(), { code: "ENOENT" }); }).kind, "exited");
  assert.equal(observeSessionProcess(42, () => "malformed").kind, "unverified");
  assert.equal(observeSessionProcess(42, undefined, "darwin").kind, "unverified");
});
test("guarded existing anchor is unchanged; missing, malformed and unsafe evidence are unverified", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-anchor-")), path = join(dir, "pi-process-identity.json");
  const h = host(); h.anchor = id => readPiProcessIdentity(id, dir);
  try {
    assert.equal(captureSessionProcesses({}, h, 100).rows[0]!.process.state, "unverified");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, deploymentId: "d-000000", processFingerprint: fp }), { mode: 0o600 });
    const before = readFileSync(path);
    const capture = captureSessionProcesses({}, h, 100); recheckSessionProcesses(capture, h);
    assert.equal(capture.rows[0]!.process.state, "verified-open"); assert.deepEqual(readFileSync(path), before);
    chmodSync(path, 0o644); assert.equal(captureSessionProcesses({}, h, 100).rows[0]!.process.state, "unverified");
    chmodSync(path, 0o600); writeFileSync(path, "{}"); assert.equal(captureSessionProcesses({}, h, 100).rows[0]!.process.state, "unverified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("final process or anchor race suppresses verified-open; budgets disclose incomplete selection", () => {
  const h = host(), capture = captureSessionProcesses({}, h, 100);
  h.process = () => ({ ...present, fingerprint: { ...fp, startTimeTicks: "999" } });
  recheckSessionProcesses(capture, h); assert.equal(capture.rows[0]!.process.state, "identity-mismatch"); assert.equal(capture.anchors.size, 0);
  h.process = () => present;
  const second = captureSessionProcesses({}, h, 100); h.anchor = () => ({ ...fp, startTimeTicks: "888" });
  recheckSessionProcesses(second, h); assert.equal(second.rows[0]!.process.state, "unverified");
  assert.deepEqual(captureSessionProcesses({}, h, 0).reasons, ["process-budget-exhausted"]);
  h.candidates = () => ({ candidates: [], complete: false }); assert.equal(captureSessionProcesses({}, h, 100).complete, false);
});
