import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DASHBOARD_USAGE, dashboardFailure, parseDashboardArgs, runSessionDashboardCommand } from "../session-dashboard-cli.js";
import { startSessionDashboard } from "../session-dashboard-server.js";
const output = () => { const stdout: string[] = [], stderr: string[] = []; return { stdout, stderr, io: { stdout: (s: string) => { stdout.push(s); }, stderr: (s: string) => { stderr.push(s); } } }; };
const root = new URL("../../../..", import.meta.url);
test("dashboard args require one explicit bounded port; help/usage cannot listen or collect", async () => {
  for (const args of [[], ["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "01"], ["--port", "1e3"], ["--host", "0.0.0.0"], ["--port", "9000", "--json"], ["--help", "--port", "9000"], ["--port", "9000", "--port", "9001"]]) {
    assert.equal(parseDashboardArgs(args), null);
    const out = output(); assert.equal(await runSessionDashboardCommand(args, out.io, async () => { throw new Error("must not start"); }), 1); assert.equal(out.stdout.length, 0); assert.equal(out.stderr[0], dashboardFailure("usage"));
  }
  for (const port of [1, 9000, 65535]) assert.equal(parseDashboardArgs(["--port", String(port)]), port);
  const out = output(); assert.equal(await runSessionDashboardCommand(["--help"], out.io, async () => { throw new Error("must not start"); }), 0); assert.deepEqual(out.stdout, [DASHBOARD_USAGE]); assert.equal(out.stderr.length, 0);
});
test("human messages are plain, bounded, safe and single-envelope; startup cause never prints exceptions", async () => {
  for (const kind of ["usage", "listen"] as const) {
    const text = dashboardFailure(kind); assert.ok(text.length <= 2000);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(text.split(label).length - 1, 1);
    for (const label of ["Impact:", "Actor:", "New approval:", "Prerequisite:"]) assert.ok(text.includes(label));
    assert.ok(!text.includes("\u001b"));
  }
  const out = output(); assert.equal(await runSessionDashboardCommand(["--port", "9000"], out.io, async () => { throw new Error("token=synthetic-private /private/path"); }), 1);
  assert.equal(out.stdout.length, 0); assert.deepEqual(out.stderr, [dashboardFailure("listen")]);
});
test("successful command reports only its own listener; signal handlers are removed on close", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const server = await startSessionDashboard({ port: 0 }); const out = output();
  try {
    assert.equal(await runSessionDashboardCommand(["--port", "9000"], out.io, async () => server), 0);
    assert.match(out.stdout[0]!, /listening at http:\/\/127\.0\.0\.1:\d+\//); assert.match(out.stdout[0]!, /no separate user authentication/); assert.equal(out.stderr.length, 0);
    assert.equal(process.listenerCount("SIGINT"), before[0]! + 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});
test("generated completions keep dashboard flags scoped and absent from OPA", () => {
  const ppa = readFileSync(new URL("completions/ppa.fish", root), "utf8"), opa = readFileSync(new URL("completions/opa.fish", root), "utf8");
  assert.ok(!opa.includes("dashboard"));
  assert.match(ppa, /sessions; and __fish_seen_subcommand_from dashboard' -l port/);
  for (const flag of ["json", "all", "deployment", "ticket", "repo"]) assert.ok(ppa.includes(`sessions; and not __fish_seen_subcommand_from dashboard' -l ${flag}`));
});
test("real CLI dispatch keeps help/usage separate from list JSON", () => {
  for (const args of [["--help"], ["-h"], [], ["--json"], ["--port", "0"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "packages/pi-pa/src/cli.ts", "sessions", "dashboard", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", PA_REGISTRY_DB: "/nonexistent/dashboard-test.db" } });
    assert.equal(result.status, args[0] === "--help" || args[0] === "-h" ? 0 : 1);
    if (result.status === 0) { assert.equal(result.stderr, ""); assert.match(result.stdout, /Usage: ppa sessions dashboard/); }
    else { assert.equal(result.stdout, ""); assert.match(result.stderr, /Session dashboard not started/); }
  }
});
test("real foreground CLI serves bundled assets without evidence, fails capture safely, and SIGTERM closes only listener", { timeout: 15_000 }, async () => {
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "packages/pi-pa/src/cli.ts", "sessions", "dashboard", "--port", String(port)], { cwd: root, env: { ...process.env, NO_COLOR: "1", PA_REGISTRY_DB: "/nonexistent/dashboard-test.db" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dashboard startup timeout")), 8000);
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("listening at")) { clearTimeout(timer); resolve(); } });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("dashboard exited before listening")); });
    });
    const page = await fetch(`http://127.0.0.1:${port}/`); assert.equal(page.status, 200); assert.match(await page.text(), /Session <span>dashboard/);
    const capture = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers: { "X-PPA-Sessions": "1" } }); assert.equal(capture.status, 503); assert.deepEqual(await capture.json(), { error: "capture-unavailable" });
    assert.equal(stderr, ""); child.kill("SIGTERM"); assert.equal(await exited, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await exited; } }
});
