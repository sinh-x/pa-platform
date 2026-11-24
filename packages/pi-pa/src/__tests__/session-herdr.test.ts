import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, lstatSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessFingerprint } from "@pa-platform/pa-core";
import { captureHerdrLocations } from "../session-herdr.js";
import { parseHerdrForeground, parseHerdrSnapshot, readHerdrSocket, type HerdrEndpoint, type HerdrPane, type HerdrSource } from "../session-herdr-source.js";
import type { ProcessReader } from "../session-process.js";
const fp = (pid: number): ProcessFingerprint => ({ pid, startTimeTicks: String(pid), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
const read: ProcessReader = pid => ({ kind: "present", fingerprint: fp(pid), parentPid: pid === 42 ? 20 : pid === 20 ? 1 : 0, state: "S" });
const pane: HerdrPane = { workspaceId: "w1", workspaceLabel: "Project", tabId: "w1:t1", tabLabel: "Task", paneId: "w1:p1", terminalId: "term_1" };
const endpoint = (name = "one"): HerdrEndpoint => ({ name, socketPath: `/inert/${name}.sock`, identity: name });
function fixture(endpoints = [endpoint()]): HerdrSource {
  return { roster: async () => ({ endpoints, complete: true, reasons: [] }), snapshot: async () => [pane], foreground: async () => [20] };
}
const capture = (source: HerdrSource, process = read, clock = () => 0) => captureHerdrLocations(new Map([["d-000001", fp(42)]]), source, process, 100, clock);
test("indirect foreground ancestry maps scoped pane, with labels; duplicate pane IDs across sessions stay ambiguous", async () => {
  const result = await capture(fixture());
  assert.equal(result.complete, true); assert.deepEqual(result.mappings.get("d-000001"), { state: "mapped", location: { session: "one", ...pane } });
  assert.equal((await capture(fixture([endpoint(), endpoint("two")]))).mappings.get("d-000001")!.state, "ambiguous");
});
test("partial lone stable hit is qualified, complete no hit unmatched, incomplete no hit unknown; recovery is fresh", async () => {
  const source = fixture([endpoint(), endpoint("offline")]);
  source.snapshot = async e => { if (e.name === "offline") throw new Error("private payload"); return [pane]; };
  const partial = await capture(source); assert.equal(partial.complete, false); assert.equal(partial.mappings.get("d-000001")!.state, "qualified");
  source.foreground = async () => [999]; assert.equal((await capture(source)).mappings.get("d-000001")!.state, "unknown");
  source.snapshot = async () => [pane]; assert.equal((await capture(source)).mappings.get("d-000001")!.state, "unmatched");
  assert.equal((await capture(fixture())).mappings.get("d-000001")!.state, "mapped");
  assert.equal((await capture(fixture([]))).mappings.get("d-000001")!.state, "unmatched");
});
test("moves, renames, terminal replacement, foreground exits and reparenting withhold stale location", async () => {
  for (const patch of [{ tabId: "w1:t2" }, { tabLabel: "Renamed" }, { terminalId: "term_2" }, null]) {
    const source = fixture(); let calls = 0;
    source.snapshot = async () => ++calls === 1 ? [pane] : patch ? [{ ...pane, ...patch }] : [];
    assert.equal((await capture(source)).mappings.get("d-000001")!.state, "unknown");
  }
  const source = fixture(); let calls = 0;
  source.foreground = async () => ++calls === 1 ? [20] : [];
  assert.equal((await capture(source)).mappings.get("d-000001")!.state, "unknown");
  const changing = fixture(); changing.foreground = async () => { calls++; return [20]; }; calls = 0;
  assert.equal((await capture(changing, pid => calls > 1 && pid === 42 ? { kind: "exited" } : read(pid))).mappings.get("d-000001")!.state, "unknown");
});
test("roster churn and missing process evidence cannot establish a unique location; budget is explicit", async () => {
  const source = fixture(); let calls = 0;
  source.roster = async () => ({ endpoints: ++calls === 1 ? [endpoint()] : [endpoint(), endpoint("new")], complete: true, reasons: [] });
  assert.equal((await capture(source)).mappings.get("d-000001")!.state, "qualified");
  assert.equal((await capture(fixture(), () => ({ kind: "unverified", reason: "process-inaccessible" }))).mappings.get("d-000001")!.state, "unknown");
  const limited = await capture(fixture(), read, () => 100); assert.equal(limited.complete, false); assert.ok(limited.reasons.includes("herdr-budget-exhausted"));
});
test("protocol-22 projection discards argv, cwd, titles and agent activity; foreground shell never attributes background jobs", () => {
  const result = parseHerdrSnapshot({ snapshot: { protocol: 22, workspaces: [{ workspace_id: "w1", label: "Project" }], tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "Task" }], panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term_1", terminal_title: "private" }], agents: [{ state: "working" }] } });
  assert.deepEqual(result, [pane]); assert.ok(!JSON.stringify(result).includes("private"));
  assert.deepEqual(parseHerdrForeground({ process_info: { pane_id: "w1:p1", shell_pid: 20, foreground_processes: [{ pid: 20, argv: ["private"] }] } }, "w1:p1"), []);
  assert.throws(() => parseHerdrSnapshot({ snapshot: { protocol: 23 } }));
  assert.throws(() => parseHerdrForeground({ process_info: { pane_id: "other" } }, "w1:p1"));
});
test("socket adapter sends only allowlisted reads, validates response IDs and bounds timeout/malformed/oversize", async () => {
  const root = mkdtempSync(join(tmpdir(), "sessions-herdr-")), path = join(root, "read.sock");
  const requests: string[] = []; let mode = "valid";
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", chunk => {
      const request = JSON.parse(chunk.toString()); requests.push(request.method);
      if (mode === "timeout") return;
      if (mode === "oversize") { socket.end("x".repeat(140 * 1024)); return; }
      socket.end(mode === "malformed" ? "not json\n" : JSON.stringify({ id: mode === "wrong-id" ? "wrong" : request.id, result: { process_info: {} } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const stat = lstatSync(path), e = { name: "test", socketPath: path, identity: `${stat.dev}:${stat.ino}:${stat.ctimeMs}` };
  try {
    assert.deepEqual(await readHerdrSocket(e, "pane.process_info", { pane_id: "w1:p1" }, Date.now() + 1000), { process_info: {} });
    for (mode of ["wrong-id", "malformed", "oversize", "timeout"]) await assert.rejects(readHerdrSocket(e, "pane.process_info", { pane_id: "w1:p1" }, Date.now() + 30));
    assert.deepEqual(new Set(requests), new Set(["pane.process_info"]));
    await assert.rejects(readHerdrSocket({ ...e, identity: "replaced" }, "session.snapshot", {}, Date.now() + 1000));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
