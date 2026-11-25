import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runCoreCommand } from "@pa-platform/pa-core";
import { captureSessions } from "../session-capture.js";
import { formatSessions, parseSessionsArgs, runSessionsCommand, sessionsFailure } from "../session-cli.js";
import { sessionDisplayText, type InventoryHost } from "../session-inventory.js";
import { type HerdrSource } from "../session-herdr-source.js";
const fp = { pid: 42, startTimeTicks: "123", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
function fixture(): InventoryHost {
  return { clock: () => 0, candidates: () => ({ complete: true, candidates: [{ deploymentId: "d-000001", team: "rogue-one", mode: "rogue-one", ticket: "PAP-281", repositoryRoot: "/private/path", startedAt: "2026-11-24T00:00:00Z", registryStatus: "success", candidatePid: 42 }] }),
    repositories: () => ({ project: { path: "/private/path" } }), anchor: () => fp,
    process: pid => ({ kind: "present", fingerprint: { ...fp, pid }, parentPid: pid === 42 ? 1 : 0, state: "S", jobControl: { group: 42, session: 42, tty: 1, foregroundGroup: 42 } }) };
}
const herdr: HerdrSource = { roster: async () => ({ endpoints: [], complete: true, reasons: [] }), snapshot: async () => [], foreground: async () => [] };
const output = () => { const stdout: string[] = [], stderr: string[] = []; return { stdout, stderr, io: { stdout: (s: string) => { stdout.push(s); }, stderr: (s: string) => { stderr.push(s); } } }; };
test("parser rejects invalid/duplicate/hostile usage before capture; help never probes", async () => {
  for (const label of ["/home/example/private-client", "Project (/home/example/private-client)", "repo:/home/example/private-client", "C:\\private\\project"]) assert.equal(sessionDisplayText(label), "[withheld]");
  assert.deepEqual(parseSessionsArgs(["--repo", "project.example"]), { all: false, json: false, repo: "project.example" });
  assert.deepEqual(parseSessionsArgs(["--ticket", "PAP-078"]), { all: false, json: false, ticket: "PAP-078" });
  for (const args of [["--unknown"], ["--repo"], ["--ticket", "PAP-281", "--ticket", "PAP-282"], ["--repo", "/private/path"], ["--deployment", "../escape"], ["--json", "--help"], ["--version"]]) {
    const out = output(); let called = false;
    assert.equal(await runSessionsCommand(args, out.io, async () => { called = true; throw new Error(); }), 1);
    assert.equal(called, false); assert.equal(out.stdout.length, 0); assert.equal(out.stderr.length, 1);
  }
  assert.deepEqual(parseSessionsArgs(["--all", "--json", "--deployment", "d-000001", "--ticket", "PAP-281", "--repo", "project"]), { all: true, json: true, deployment: "d-000001", ticket: "PAP-281", repo: "project" });
  const out = output(); assert.equal(await runSessionsCommand(["--help"], out.io, async () => { throw new Error(); }), 0); assert.equal(out.stderr.length, 0);
});
test("default and --all keep registry status, candidate PID and verified PID distinct; table/JSON share minimized rows", async () => {
  const host = fixture(), snapshot = await captureSessions({}, host, herdr), table = formatSessions(snapshot);
  assert.equal(snapshot.rows[0]!.process.state, "verified-open"); assert.equal(snapshot.rows[0]!.registryStatus, "success");
  for (const token of ["d-000001", "PAP-281", "rogue-one", "project", "success", "42", "unmatched", snapshot.capture.startedAt]) assert.ok(table.includes(token));
  assert.ok(!JSON.stringify(snapshot).includes("/private/path")); assert.ok(!table.includes(fp.bootId));
  host.anchor = () => { throw new Error("private token"); };
  const empty = await captureSessions({}, host, herdr), all = await captureSessions({ all: true }, host, herdr);
  assert.equal(empty.rows.length, 0); assert.equal(empty.coverage.diagnosticsOmitted, 1); assert.equal(all.rows[0]!.process.state, "unverified");
  assert.ok(!("pid" in all.rows[0]!.process)); assert.ok(formatSessions(all).includes("candidate:42"));
  const out = output(); assert.equal(await runSessionsCommand(["--json"], out.io, async () => snapshot), 0);
  assert.equal(out.stdout.length, 1); assert.deepEqual(JSON.parse(out.stdout[0]!), snapshot); assert.equal(out.stderr.length, 0);
  assert.equal(await runSessionsCommand([], output().io, async () => empty), 0);
});
test("qualified location and incomplete coverage are explicit in both formats; hostile text stays bounded and screened", async () => {
  const host = fixture(), source: HerdrSource = { ...herdr, roster: async () => ({ endpoints: [{ name: "session", socketPath: "/private/socket", identity: "private" }], complete: false, reasons: ["herdr-coverage-incomplete"] }),
    snapshot: async () => [{ workspaceId: "w1", workspaceLabel: "Safe\u001b[31m\nLabel", tabId: "w1:t1", tabLabel: "token=synthetic-sensitive-value", paneId: "w1:p1", terminalId: "term_1" }], foreground: async () => [42] };
  const snapshot = await captureSessions({}, host, source), table = formatSessions(snapshot), json = JSON.stringify(snapshot);
  assert.equal(snapshot.rows[0]!.herdr.state, "qualified"); assert.ok(table.includes("observed with HerdR coverage incomplete"));
  assert.ok(!table.includes("\u001b")); assert.ok(!json.includes("synthetic-sensitive-value")); assert.ok(!json.includes("/private/socket"));
  assert.ok(!json.includes("startTimeTicks")); assert.ok(!json.includes("bootId"));
  for (const workspaceLabel of ["Project (/home/example/private-client)", "repo:/home/example/private-client"]) {
    const original = source.snapshot;
    source.snapshot = async () => (await original({ name: "session", socketPath: "/private/socket", identity: "private" }, 100)).map(pane => ({ ...pane, workspaceLabel }));
    const screened = await captureSessions({}, host, source);
    assert.ok(!JSON.stringify(screened).includes("private-client")); assert.ok(!formatSessions(screened).includes("private-client"));
    source.snapshot = original;
  }
  const before = JSON.stringify(snapshot); formatSessions(snapshot); formatSessions(snapshot); assert.equal(JSON.stringify(snapshot), before);
});
test("fatal/usage messages obey bounded single five-field envelope; raw exceptions never propagate", async () => {
  for (const kind of ["usage", "registry"] as const) {
    const text = sessionsFailure(kind); assert.ok(text.length <= 2000);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(text.split(label).length - 1, 1);
    assert.match(text, /Impact:/); assert.match(text, /Actor:/); assert.match(text, /New approval:/); assert.match(text, /Prerequisite:/);
  }
  const out = output(); assert.equal(await runSessionsCommand(["--json"], out.io, async () => { throw new Error("SECRET private-path"); }), 1);
  assert.equal(out.stdout.length, 0); assert.ok(!out.stderr[0]!.includes("SECRET"));
});
test("final process race removes both open claim and HerdR location; recheck deadline is explicit", async () => {
  const host = fixture(); let reads = 0;
  host.anchor = () => { reads++; return reads > 1 ? { ...fp, startTimeTicks: "456" } : fp; };
  const snapshot = await captureSessions({ all: true }, host, herdr);
  assert.equal(snapshot.rows[0]!.process.state, "unverified"); assert.equal(snapshot.rows[0]!.herdr.state, "unknown");
  const limited = fixture(); let time = 0; limited.clock = () => time;
  const slow = { ...herdr, roster: async () => { time = 11_000; return { endpoints: [], complete: true, reasons: [] }; } };
  const expired = await captureSessions({ all: true }, limited, slow);
  assert.equal(expired.rows[0]!.process.state, "unverified"); assert.ok(expired.coverage.reasons.includes("process-recheck-budget-exhausted"));
});
test("PPA help advertises sessions but OPA does not; real CLI keeps help/usage streams and does not treat --version as inventory", async () => {
  for (const binaryName of ["ppa", "opa"]) {
    const out = output(); await runCoreCommand(["--help"], { binaryName, io: out.io });
    assert.equal(out.stdout.join("\n").includes("  sessions "), binaryName === "ppa");
  }
  for (const args of [["--help"], ["--json", "--invalid"], ["--version"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "packages/pi-pa/src/cli.ts", "sessions", ...args], { cwd: new URL("../../../..", import.meta.url), encoding: "utf8", env: { ...process.env, NO_COLOR: "1", PA_REGISTRY_DB: "/nonexistent/sessions-test.db" } });
    assert.equal(result.status, args[0] === "--help" ? 0 : 1, result.stderr);
    if (args[0] === "--help") assert.match(result.stdout, /Usage: ppa sessions/);
    else { assert.equal(result.stdout, ""); assert.match(result.stderr, /Session inventory not started/); }
  }
});
