import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertOwnExecutionSessionLog, MAX_EXECUTION_SESSION_LOG_BYTES, ownExecutionSessionLog, writeOwnExecutionSessionLog } from "../native-execution-session-log.js";

const rel = "sessions/2026/10/agent-team/2026-10-23-d-aaaaaa-builder--builder-agent--TTL-006--preflight-blocked.md";
function fixture(run: (root: string, identity: { deploymentId: string; ticket: string; aiUsageRoot: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap264-session-log-"));
  try { run(root, { deploymentId: "d-aaaaaa", ticket: "TTL-006", aiUsageRoot: root }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("PAP-264 session log namespace binds lexical date/role/ticket/deployment and rejects path aliases", () => fixture((root, identity) => {
  assert.equal(ownExecutionSessionLog(rel, identity), rel);
  assert.equal(ownExecutionSessionLog(join(root, rel), identity), rel);
  for (const path of [rel.replace("d-aaaaaa", "d-bbbbbb"), rel.replace("TTL-006", "TTL-007"), rel.replace("builder--", "requirements--"),
    rel.replace("2026/10", "2026/11"), rel.replace("2026-10-23", "2026-02-31"), `../${rel}`, rel.replace("sessions/", "sessions/../sessions/"),
    join(root, "unknown.md"), rel.replace("preflight-blocked.md", "../other.md"), rel + "\0", rel.replace(".md", ".json")]) assert.equal(ownExecutionSessionLog(path, identity), null, path);
  assert.equal(ownExecutionSessionLog(rel, { ...identity, aiUsageRoot: undefined }), null);
  assert.equal(ownExecutionSessionLog(rel, { ...identity, sourceRoots: [root] }), null, "an AI usage location inside a source checkout cannot grant source writes");
  assert.throws(() => writeOwnExecutionSessionLog({ ...identity, sourceRoots: [root] }, rel, "forbidden source effect"));
  assert.equal(existsSync(join(root, "sessions")), false);
}));

test("PAP-264 logs publish complete private bytes; only identical retry succeeds, never overwrite or repair", () => fixture((root, identity) => {
  assert.throws(() => assertOwnExecutionSessionLog(identity, rel));
  assert.equal(existsSync(join(root, "sessions")), false, "reference validation must be existing-only");
  writeOwnExecutionSessionLog(identity, rel, "# Complete retained log\n");
  const path = join(root, rel); const before = statSync(path);
  assert.equal(before.mode & 0o777, 0o600); assert.equal(before.nlink, 1);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assertOwnExecutionSessionLog(identity, rel);
  writeOwnExecutionSessionLog(identity, rel, "# Complete retained log\n");
  assert.equal(statSync(path).ino, before.ino);
  assert.throws(() => writeOwnExecutionSessionLog(identity, rel, "replacement"));
  assert.equal(readFileSync(path, "utf8"), "# Complete retained log\n");
  assert.deepEqual(readdirSync(dirname(path)), [path.split("/").at(-1)]);
  chmodSync(path, 0o644);
  assert.throws(() => writeOwnExecutionSessionLog(identity, rel, "# Complete retained log\n"));
  assert.equal(statSync(path).mode & 0o777, 0o644);
  assert.throws(() => writeOwnExecutionSessionLog(identity, rel, "x".repeat(MAX_EXECUTION_SESSION_LOG_BYTES + 1)));
}));

for (const kind of ["symlink", "hardlink", "directory"] as const) {
  test(`PAP-264 session log preserves ${kind} target instead of adopting it`, () => fixture((root, identity) => {
    const target = join(root, rel); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const outside = join(root, "outside.md"); writeFileSync(outside, "unknown bytes", { mode: 0o600 });
    if (kind === "symlink") symlinkSync(outside, target);
    else if (kind === "hardlink") linkSync(outside, target);
    else mkdirSync(target);
    assert.throws(() => writeOwnExecutionSessionLog(identity, rel, "unknown bytes"));
    assert.throws(() => assertOwnExecutionSessionLog(identity, rel));
    assert.equal(readFileSync(outside, "utf8"), "unknown bytes");
    assert.equal(existsSync(target), true);
    assert.equal(readdirSync(dirname(target)).some((name) => name.startsWith(".pa-session-log-")), false);
  }));
}

test("PAP-264 session log rejects symlink roots/ancestors and writable parent directories before file effects", () => fixture((root, identity) => {
  const outside = join(root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(root, "sessions"));
  assert.throws(() => writeOwnExecutionSessionLog(identity, rel, "forbidden"));
  assert.deepEqual(readdirSync(outside), []);
  const alias = join(root, "alias"); symlinkSync(root, alias);
  assert.throws(() => writeOwnExecutionSessionLog({ ...identity, aiUsageRoot: alias }, rel, "forbidden"));
  const writable = join(root, "writable"); mkdirSync(writable, { mode: 0o777 }); chmodSync(writable, 0o777);
  assert.throws(() => writeOwnExecutionSessionLog({ ...identity, aiUsageRoot: writable }, rel, "forbidden"));
  assert.deepEqual(readdirSync(writable), []);
}));
