import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import { captureSessions, type SessionSnapshot } from "../session-capture.js";
import { DASHBOARD_LIMITS, parseDashboardQuery, startSessionDashboard } from "../session-dashboard-server.js";
import type { InventoryHost } from "../session-inventory.js";
import type { HerdrSource } from "../session-herdr-source.js";
import { DASHBOARD_HTML, DASHBOARD_SCRIPT, DASHBOARD_CSS } from "../session-dashboard-page.js";

const fp = { pid: 42, startTimeTicks: "123", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
function fixture(): InventoryHost {
  return { clock: () => 0, candidates: () => ({ complete: true, candidates: [{ deploymentId: "d-000001", team: "rogue-one", mode: "rogue-one", ticket: "PAP-286", repositoryRoot: "/private/repo", startedAt: null, registryStatus: "success", candidatePid: 42 }] }),
    repositories: () => ({ project: { path: "/private/repo" } }), anchor: () => fp,
    process: pid => ({ kind: "present", fingerprint: { ...fp, pid }, parentPid: 0, state: "S", jobControl: { group: 42, session: 42, tty: 1, foregroundGroup: 42 } }) };
}
const herdr: HerdrSource = { roster: async () => ({ endpoints: [], complete: true, reasons: [] }), snapshot: async () => [], foreground: async () => [] };
function port(server: Server): number { const address = server.address(); assert.ok(address && typeof address !== "string"); assert.equal(address.address, "127.0.0.1"); return address.port; }
function get(server: Server, path = "/v1/sessions", headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: port(server), path, method, headers: { "X-PPA-Sessions": "1", ...headers }, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }); req.on("error", reject); req.end();
  });
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("query filters reuse exact CLI validation with no unknown or duplicate options", () => {
  assert.deepEqual(parseDashboardQuery("ticket=PAP-286&repo=project&deployment=d-000001&all=true"), { all: true, ticket: "PAP-286", repo: "project", deployment: "d-000001" });
  for (const query of ["all=1", "json=true", "repo=/private", "ticket=PAP-286&ticket=PAP-287", "repo=project&repo=project", "ticket=invalid", "deployment=../private", "repo=%0A", "all=false&all=true"]) assert.equal(parseDashboardQuery(query), null, query);
});
test("HTTP and CLI capture are factually identical, fresh, minimized and exact-filtered", async () => {
  const host = fixture(); let reads = 0;
  const capture: typeof captureSessions = async filters => { reads++; return captureSessions(filters, host, herdr); };
  const server = await startSessionDashboard({ port: 0, capture });
  try {
    const result = await get(server, "/v1/sessions?ticket=PAP-286&repo=project");
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), await captureSessions({ ticket: "PAP-286", repo: "project", all: false }, host, herdr));
    assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["x-frame-options"], "DENY"); assert.match(result.headers["content-security-policy"]!, /frame-ancestors 'none'/);
    for (const forbidden of ["/private", fp.bootId, "startTimeTicks", "objective", "environment"]) assert.ok(!result.body.includes(forbidden));
    assert.equal(JSON.parse((await get(server, "/v1/sessions?ticket=PAP-287")).body).rows.length, 0);
    host.candidates = () => ({ complete: true, candidates: [] });
    assert.equal(JSON.parse((await get(server)).body).rows.length, 0); assert.equal(reads, 3);
    const page = await get(server, "/"); assert.equal(page.status, 200); assert.match(page.headers["content-type"]!, /text\/html/); assert.equal(page.body, DASHBOARD_HTML);
    assert.equal((await get(server, "/dashboard.js")).body, DASHBOARD_SCRIPT); assert.equal((await get(server, "/dashboard.css")).body, DASHBOARD_CSS); assert.equal(reads, 3);
  } finally { await close(server); }
});
test("reject hostile methods/hosts/origins/headers/routes and filters before capture", async () => {
  let reads = 0;
  const server = await startSessionDashboard({ port: 0, capture: async () => { reads++; throw new Error("private"); } });
  try {
    const cases: Array<[string, Record<string, string>, string, number]> = [
      ["/v1/sessions", { Host: "evil.example" }, "GET", 400], ["/v1/sessions", { Host: `localhost:${port(server)}` }, "GET", 400],
      ["/v1/sessions", { Origin: "https://evil.example" }, "GET", 403], ["/", { "Sec-Fetch-Site": "cross-site" }, "GET", 403],
      ["/v1/sessions", { "Sec-Fetch-Site": "same-site" }, "GET", 403], ["/v1/sessions", { "X-PPA-Sessions": "0" }, "GET", 403],
      ["/v1/sessions", { Cookie: "session=synthetic" }, "GET", 400], ["/v1/sessions", { Authorization: "synthetic" }, "GET", 400],
      ["/v1/sessions", { "Content-Length": "1" }, "GET", 400], ["/v1/sessions", {}, "POST", 405], ["/v1/sessions", {}, "OPTIONS", 405],
      ["/v1/sessions?all=1", {}, "GET", 400], ["/v1/sessions?repo=x&repo=y", {}, "GET", 400], ["/v1/sessions?json=true", {}, "GET", 400],
      ["/v1/stop", {}, "GET", 404], ["//evil.example/v1/sessions", {}, "GET", 400], ["/../private", {}, "GET", 404], ["/?repo=x", {}, "GET", 404],
    ];
    for (const [path, headers, method, status] of cases) { const reply = await get(server, path, headers, method); assert.equal(reply.status, status, path); assert.equal(reply.headers["access-control-allow-origin"], undefined); }
    assert.equal(reads, 0);
    assert.equal((await get(server, "/v1/sessions", { Origin: `http://127.0.0.1:${port(server)}`, "Sec-Fetch-Site": "same-origin" })).status, 503);
    assert.equal(reads, 1);
  } finally { await close(server); }
});
test("capture failures are bounded; overlapping/disconnected requests never release an unsettled capture", async () => {
  const held = deferred<SessionSnapshot>(), entered = deferred<void>(); let reads = 0;
  const server = await startSessionDashboard({ port: 0, capture: async filters => { reads++; if (reads === 1) { entered.resolve(); return held.promise; } throw new Error("token=synthetic-private /private/path"); } });
  try {
    const first = get(server); await entered.promise;
    assert.deepEqual(JSON.parse((await get(server)).body), { error: "busy" }); assert.equal(reads, 1);
    server.closeAllConnections(); await assert.rejects(first);
    assert.equal((await get(server)).status, 503); assert.equal(reads, 1);
    held.resolve(await captureSessions({}, fixture(), herdr)); await new Promise(resolve => setImmediate(resolve));
    const result = await get(server); assert.equal(result.status, 503); assert.equal(result.body, '{"error":"capture-unavailable"}'); assert.equal(reads, 2);
  } finally { held.resolve(await captureSessions({}, fixture(), herdr)); await close(server); }
});
test("absolute connection deadline discards a late result, retains admission and permits later fresh capture", async () => {
  const held = deferred<SessionSnapshot>(), entered = deferred<void>(); let reads = 0;
  const snapshot = await captureSessions({}, fixture(), herdr);
  const server = await startSessionDashboard({ port: 0, deadlines: { overallMs: 80 }, capture: async () => { reads++; entered.resolve(); return reads === 1 ? held.promise : snapshot; } });
  try {
    const first = get(server); const failed = assert.rejects(first); await entered.promise; await failed;
    assert.equal((await get(server)).body, '{"error":"busy"}');
    held.resolve(snapshot); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse((await get(server)).body), snapshot);
  } finally { held.resolve(snapshot); await close(server); }
});
test("partial headers, oversized headers, duplicate Host, upgrade and CONNECT cannot collect", async () => {
  let reads = 0;
  const server = await startSessionDashboard({ port: 0, deadlines: { headerMs: 50, overallMs: 200 }, capture: async () => { reads++; throw new Error(); } });
  try {
    for (const raw of ["GET / HTTP/1.1\r\n", `GET /v1/sessions HTTP/1.1\r\nHost: 127.0.0.1:${port(server)}\r\nHost: evil\r\n\r\n`, `GET / HTTP/1.1\r\nX-Large: ${"x".repeat(DASHBOARD_LIMITS.headerBytes)}\r\n\r\n`, "CONNECT local:80 HTTP/1.1\r\nHost: local\r\n\r\n", "GET / HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"]) {
      await new Promise<void>((resolve, reject) => { const socket = connect(port(server), "127.0.0.1", () => socket.write(raw)); socket.on("data", () => {}); socket.on("error", reject); socket.on("close", () => resolve()); });
    }
    assert.equal(reads, 0);
  } finally { await close(server); }
});
test("PID reuse and concurrent exit retain diagnostic truth through HTTP; missing HerdR stays explicit", async () => {
  const host = fixture(); let anchors = 0;
  host.anchor = () => (++anchors > 1 ? { ...fp, startTimeTicks: "999" } : fp);
  const server = await startSessionDashboard({ port: 0, capture: filters => captureSessions(filters, host, { ...herdr, roster: async () => { throw new Error("private socket"); } }) });
  try {
    const result: SessionSnapshot = JSON.parse((await get(server, "/v1/sessions?all=true")).body);
    assert.equal(result.rows[0]!.process.state, "unverified"); assert.equal(result.rows[0]!.herdr.state, "unknown"); assert.equal(result.coverage.complete, false);
    host.anchor = () => fp; host.process = () => ({ kind: "exited" });
    assert.equal(JSON.parse((await get(server)).body).rows.length, 0);
  } finally { await close(server); }
});
