import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { serve } from "@hono/node-server";
import { createAgentApiApp } from "../agent-api/index.js";
import { runServeCommand } from "../cli/commands/serve.js";
import { localReviewBridgeFailure, serializeLocalReviewBridgeResult } from "../agent-api/routes/local-review.js";
import { executeLocalReview } from "../documents/local-review.js";
import { handoffBranchIntentSha, type HandoffBranchIntent, type LocalHandoffReviewSubject } from "../documents/handoff-contract.js";
import { nativeHandoffPlanIdentity } from "../documents/handoff-planning.js";
import { presentFullDocumentReader } from "../documents/reader-publication.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { MODE_CAPABILITY_SESSION } from "../mode-capabilities.js";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { closeDb, getDb } from "../registry/db.js";
import { getRegistryDbPath, getTicketsDir } from "../paths.js";
import { creationDigest } from "../tickets/create-intent.js";
import { digest } from "../workflows/contracts.js";
import { withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

const endpoint = "/api/documents/local-review";
const rawRequest = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "show", subjectSha256: "a".repeat(64), ...extra });

// Enclose EVERY test, including ingress-only/app-only cases, before a TicketStore
// constructor or valid missing-subject request can resolve an ambient path.
// Native fixtures nest inside this environment and restore it on close.
let outerRoot: string, previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  outerRoot = mkdtempSync(join(tmpdir(), "pa-bridge-review-"));
  for (const dir of ["home", "config", "teams", "skills", "data", "cache"]) mkdirSync(join(outerRoot, dir));
  Object.assign(process.env, {
    HOME: join(outerRoot, "home"), XDG_CONFIG_HOME: join(outerRoot, "config"), XDG_DATA_HOME: join(outerRoot, "data"), XDG_CACHE_HOME: join(outerRoot, "cache"),
    PA_PLATFORM_HOME: outerRoot, PA_PLATFORM_CONFIG: join(outerRoot, "config"), PA_PLATFORM_TEAMS: join(outerRoot, "teams"), PA_PLATFORM_SKILLS: join(outerRoot, "skills"),
    PA_AI_USAGE_HOME: outerRoot, PA_REGISTRY_DB: join(outerRoot, "registry.db"), PA_PLATFORM_DATA: join(outerRoot, "data"),
  });
});
afterEach(() => {
  try { closeDb(); }
  finally { process.env = previousEnv; rmSync(outerRoot, { recursive: true, force: true }); }
});

// Use the real persisted native v2 origin/plan, not a transport handler injection.
// The existing local-review test's fixture is private; only its setup is repeated.
async function nativeFixture() {
  const f = documentRuntimeFixture();
  try {
    await f.db.backup(join(f.root, "before-native-review.db"));
    Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db"), PA_PLATFORM_DATA: join(f.root, "data") });
    f.store.update("EX-1", { title: "Requirements bridge fixture" });
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "develop");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    const binding = JSON.stringify({ schemaVersion: "pa-mode-capability-binding/v1", configRevision: "a".repeat(40), resourcePath: "teams/requirements.yaml", resourceSha256: "b".repeat(64), profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: ["document.handoff", "document.local-review", "document.package"] } });
    const caller = { identitySha256: "a".repeat(64), selectionSha256: digest(binding), deploymentId: "d-316001", sessionId: "native-origin", repoKey: "example", repoRoot: f.repo, ticket: "EX-1" };
    const planIdentity = nativeHandoffPlanIdentity(caller, "native-plan"), before = f.store.get("EX-1")!, base = git("rev-parse", "HEAD");
    const physicalIdentitySha256 = withRepositoryRefTicketExclusion("example", f.repo, exclusion => withRepositoryRefAdmission(f.repo, exclusion, id => id));
    const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "native-plan", callerIdentitySha256: caller.identitySha256, expectedTicketVersion: creationDigest(before), repository: { key: "example", root: f.repo, physicalIdentitySha256 }, ticket: "EX-1", branch: "feature/EX-1-bridge", action: "create", base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-17T00:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" }, plannedLinkSha256: creationDigest(null), lineage: null };
    f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "plan", intent }, "requirements/analyze", planIdentity, { assertCurrent() {}, assertSnapshot() {} });
    f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
    const delivery = await presentFullDocumentReader(f.subject, f.root, hash => f.journal.snapshot(hash));
    f.db.pragma("synchronous = FULL");
    f.db.prepare("INSERT INTO registry_events(deployment_id,team,event,timestamp,mode,runtime,binary,note,repo,repo_root,worktree_root,ticket_id,mode_capability_binding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(caller.deploymentId, "requirements", "started", "2026-11-17T00:00:00.000Z", "analyze", "pi", "ppa", MODE_CAPABILITY_SESSION, f.repo, f.repo, f.repo, "EX-1", binding);
    f.db.prepare("INSERT INTO registry_events(deployment_id,team,event,timestamp,status) VALUES(?,?,?,?,?)").run(caller.deploymentId, "requirements", "completed", "2026-11-17T00:01:00.000Z", "completed");
    const subject: LocalHandoffReviewSubject = { schemaVersion: "pa-handoff-review/v2", documentSubjectSha256: f.sha256, branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: String(delivery.deliverySha256), selectionSha256: caller.selectionSha256, callerIdentitySha256: caller.identitySha256, effects: { publish: true, branchRef: true, queue: false }, origin: { deploymentId: caller.deploymentId, sessionId: caller.sessionId, planIdentity } };
    const journal = new RegistryHandoffReviewJournal(f.db), sha = journal.freeze(subject, intent);
    const raw = (extra: Record<string, unknown>) => rawRequest({ subjectSha256: sha, ...extra });
    return { ...f, git, journal, sha, raw };
  } catch (error) { f.close(); throw error; }
}

async function start(enabled = true, host = "127.0.0.1", cors = false, configure?: (api: ReturnType<typeof createAgentApiApp>) => void) {
  const api = createAgentApiApp({ enableLocalReview: enabled, enableCors: cors });
  configure?.(api);
  const server = serve({ fetch: api.app.fetch, createServer: api.createServer, hostname: host, port: 0 });
  api.injectWebSocket(server);
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture address unavailable");
  return { api, server, port: address.port, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); api.cleanup(); } };
}

async function post(port: number, body: string | Buffer, headers: Record<string, string> = {}, path = endpoint, localAddress?: string) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; json: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", localAddress, headers: { "Content-Type": "application/json", ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.once("error", reject);
      res.once("end", () => { const text = Buffer.concat(chunks).toString(); let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* Disabled route is plain text. */ } resolve({ status: res.statusCode!, headers: res.headers, text, json }); });
    });
    req.once("error", reject); req.end(body);
  });
}

function assertBlocker(message: unknown) {
  assert.equal(typeof message, "string");
  if (typeof message !== "string") throw Error("missing blocker");
  assert.ok(message.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(message.split(`${label}:`).length, 2);
  assert.match(message, /Impact: none\. Actor: operator\. New approval: not required/);
}

test("real general server opt-in shares native show/request/decision/revoke and never runs effects", async () => {
  const f = await nativeFixture(), s = await start();
  try {
    const ticket = readFileSync(join(f.root, "tickets/EX-1.json")), refs = f.git("show-ref"), schema = f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    const show = await post(s.port, f.raw({ action: "show" }));
    assert.equal(show.status, 200, "opted-in general server must implement the real bridge, not 404");
    assert.deepEqual(show.json, await executeLocalReview(f.raw({ action: "show" })));
    assert.equal(show.json.trust, "local-unverified");
    assert.equal(show.headers["cache-control"], "no-store");
    const request = await post(s.port, f.raw({ action: "request", expectedRevision: 0 }));
    assert.equal(request.status, 200);
    assert.deepEqual(request.json, await executeLocalReview(f.raw({ action: "request", expectedRevision: 0 })));
    const decide = f.raw({ action: "decide", expectedRevision: 0, requestKey: request.json.requestKey, outcome: "approved" });
    const decision = await post(s.port, decide);
    assert.equal(decision.status, 200); assert.equal(decision.json.principal, "local-unverified");
    assert.deepEqual(decision.json, await executeLocalReview(decide));
    assert.deepEqual((await post(s.port, decide)).json, decision.json);
    const conflict = await post(s.port, f.raw({ action: "decide", expectedRevision: 0, requestKey: request.json.requestKey, outcome: "cancelled" }));
    assert.equal(conflict.status, 409); assertBlocker(conflict.json.message);
    const status = await executeLocalReview(f.raw({ action: "show" }));
    assert.equal(status.approval, "approved"); assert.equal(status.launchReady, false);
    assert.equal(status.firstUnprovenEffect, "publication"); assert.equal(status.nextOwner, "publication");
    for (const name of ["publication", "branch", "queue"]) assert.equal(decision.json[name], "not-performed-by-this-operation");
    assert.equal(f.journal.events(f.sha).length, 2);
    assert.deepEqual(f.journal.documents.events("example", "EX-1").map(e => e.data.kind), ["frozen"]);
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), ticket);
    assert.equal(f.git("show-ref"), refs);
    assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), schema);
    const revoke = await post(s.port, f.raw({ action: "revoke", expectedRevision: 2, decisionId: decision.json.decisionId }));
    assert.equal(revoke.status, 200); assert.equal(f.journal.events(f.sha).length, 3);
    const revoked = await post(s.port, f.raw({ action: "decide", expectedRevision: 2, requestKey: revoke.json.requestKey, outcome: "approved" }));
    assert.equal(revoked.status, 200); assert.equal(f.journal.events(f.sha).length, 4);
  } finally { await s.close(); f.close(); }
});

test("conflicting concurrent HTTP decisions cannot overwrite the first canonical outcome", async () => {
  const f = await nativeFixture(), s = await start();
  try {
    const requested = await post(s.port, f.raw({ action: "request", expectedRevision: 0 }));
    const raw = (outcome: string) => f.raw({ action: "decide", expectedRevision: 0, requestKey: requested.json.requestKey, outcome });
    const results = await Promise.all([post(s.port, raw("approved")), post(s.port, raw("rejected"))]);
    const accepted = results.filter(r => r.status === 200);
    assert.equal(accepted.length, 1); assert.ok(results.some(r => r.status === 409 || r.status === 503));
    assert.equal(f.journal.events(f.sha).length, 2);
    assert.deepEqual((await post(s.port, raw(String(accepted[0].json.outcome)))).json, accepted[0].json);
  } finally { await s.close(); f.close(); }
});

test("disabled route stays absent; direct app requests cannot fabricate a trusted native peer", async () => {
  const s = await start(false);
  try { assert.equal((await post(s.port, rawRequest())).status, 404); }
  finally { await s.close(); }
  const api = createAgentApiApp({ enableLocalReview: true, enableCors: true });
  try {
    const result = await api.app.request(`http://127.0.0.1${endpoint}`, { method: "POST", body: rawRequest(), headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" } });
    assert.equal(result.status, 403); assert.equal(result.headers.get("access-control-allow-origin"), null);
  } finally { api.cleanup(); }
});

test("ingress rejects every Origin, credentials, forwarding, Host tricks and unsupported content without CORS", async () => {
  const s = await start(true, "127.0.0.1", true);
  try {
    for (const [headers, status] of [
      [{ Origin: "null" }, 403], [{ Origin: "http://127.0.0.1" }, 403], [{ Origin: "" }, 403],
      [{ Host: "localhost" }, 400], [{ Host: `127.0.0.1:${s.port + 1}` }, 400], [{ Host: `user@127.0.0.1:${s.port}` }, 400],
      [{ Forwarded: "for=127.0.0.1" }, 400], [{ "X-Forwarded-For": "127.0.0.1" }, 400], [{ "X-Forwarded-Host": `127.0.0.1:${s.port}` }, 400], [{ "X-Real-IP": "127.0.0.1" }, 400],
      [{ Authorization: "Bearer fixture" }, 400], [{ "Proxy-Authorization": "synthetic" }, 400], [{ Cookie: "synthetic=yes" }, 400], [{ "X-PA-Deployment-ID": "d-316001" }, 400], [{ "X-Av-Pair-Token": "synthetic" }, 400],
      [{ "Content-Encoding": "identity" }, 415], [{ "Content-Type": "text/plain" }, 415], [{ Trailer: "synthetic" }, 400],
    ] satisfies [Record<string, string>, number][]) {
      const result = await post(s.port, rawRequest(), headers);
      assert.equal(result.status, status, JSON.stringify(Object.keys(headers)));
      assert.equal(result.headers["access-control-allow-origin"], undefined); assertBlocker(result.json.message);
      assert.doesNotMatch(result.text, /fixture/);
    }
    for (const path of [`${endpoint}?credential=synthetic`, `${endpoint}/extra`]) assert.equal((await post(s.port, rawRequest(), {}, path)).status, 404);
    const preflight = await fetch(`http://127.0.0.1:${s.port}${endpoint}`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 403); assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  } finally { await s.close(); }
});

test("strict streamed UTF-8 grammar and byte/header limits reject before native owner I/O", async () => {
  assert.equal(getTicketsDir(), join(outerRoot, "tickets"));
  assert.equal(getRegistryDbPath(), join(outerRoot, "registry.db"));
  assert.equal(existsSync(getTicketsDir()), false);
  const s = await start();
  assert.equal(existsSync(getTicketsDir()), true, "API TicketStore must be disposable even in negative tests");
  try {
    for (const body of [rawRequest({ actor: "human" }), rawRequest({ effects: {} }), rawRequest({ action: "publish" }), rawRequest().replace('"action":"show"', '"action":"show","act\\u0069on":"show"'), Buffer.from([0xff]), "{}" + " ".repeat(65535)]) {
      const result = await post(s.port, body);
      assert.equal(result.status, Buffer.byteLength(body) > 65536 ? 413 : 400); assertBlocker(result.json.message);
    }
    assert.equal((await post(s.port, rawRequest(), { "X-Padding": "x".repeat(8192) })).status, 431);
    assert.equal(existsSync(getRegistryDbPath()), false, "invalid ingress must not initialize a registry");
    getDb(); // Initialize only the outer disposable registry for the valid show.
    const missing = await post(s.port, rawRequest());
    assert.equal(missing.status, 503); assert.equal(missing.json.code, "DOCUMENT_UNAVAILABLE"); assertBlocker(missing.json.message);
    assert.doesNotMatch(missing.text, /SQLite|ENOENT|SELECT|registry\.db|stack/);
  } finally { await s.close(); }
});

test("actual bind and socket peer, not a fake loopback Host, control ingress", async () => {
  const broad = await start(true, "0.0.0.0");
  try { assert.equal((await post(broad.port, rawRequest())).status, 403); }
  finally { await broad.close(); }
  const s = await start();
  try { assert.equal((await post(s.port, rawRequest(), { "X-Forwarded-For": "127.0.0.1" }, endpoint, "127.0.0.2")).status, 403); }
  finally { await s.close(); }
});

test("serve grammar discovers opt-in and rejects nonnumeric/nonloopback bind before lifecycle effects", async () => {
  const out: string[] = [], errors: string[] = [], io = { stdout: (s: string) => out.push(s), stderr: (s: string) => errors.push(s) };
  assert.equal(await runServeCommand("serve", ["--help"], io, {}), 0); assert.match(out.join("\n"), /--local-review/);
  for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.1.example.invalid"]) {
    errors.length = 0;
    assert.equal(await runServeCommand("serve", ["--local-review", "--host", host, "--force"], io, {}), 1);
    assertBlocker(errors.join("\n"));
    // Compare complete diagnostics, not substrings: :: is part of the allowed ::1.
    assert.match(errors.join("\n"), /numeric bind 127\.0\.0\.1 or ::1/);
  }
  errors.length = 0;
  assert.equal(await runServeCommand("serve", ["status", "--local-review"], io, {}), 1); assertBlocker(errors.join("\n"));
});

async function exchange(port: number, bytes: string | Buffer, finish = true): Promise<string> {
  const socket = connect(port, "127.0.0.1"), chunks: Buffer[] = [];
  const reply = new Promise<string>((resolve, reject) => {
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject); socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
  });
  socket.once("connect", () => finish ? socket.end(bytes) : socket.write(bytes));
  return reply;
}

function reviewHttp(port: number, body: string): string {
  return `POST ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

for (const phase of ["rejected", "accepted", "slow"] as const) {
  for (const next of ["request", "continue", "expectation", "upgrade", "review-upgrade", "connect"] as const) {
    test(`review-owned socket fences ${next} handlers after ${phase} review without cancellation`, async () => {
      const f = await nativeFixture();
      let generalEffects = 0, upgradeEffects = 0, connectEffects = 0;
      const s = await start(true, "127.0.0.1", false, api => {
        api.app.post("/pipeline-effect", c => { generalEffects++; return c.json({ recorded: true }); });
      });
      s.server.on("upgrade", () => { upgradeEffects++; });
      s.server.on("connect", () => { connectEffects++; });
      try {
        const requested = await post(s.port, f.raw({ action: "request", expectedRevision: 0 }));
        assert.equal(requested.status, 200);
        const decision = f.raw({ action: "decide", expectedRevision: 0, requestKey: requested.json.requestKey, outcome: "approved" });
        const body = phase === "rejected" ? rawRequest({ actor: "forbidden" }) : decision;
        const host = `Host: 127.0.0.1:${s.port}\r\n`;
        const subsequent = next === "upgrade" || next === "review-upgrade"
          ? `GET ${next === "upgrade" ? "/ws" : endpoint} HTTP/1.1\r\n${host}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
          : next === "connect" ? `CONNECT localhost:443 HTTP/1.1\r\n${host}\r\n`
          : `POST /pipeline-effect HTTP/1.1\r\n${host}${next === "continue" ? "Expect: 100-continue\r\n" : next === "expectation" ? "Expect: unsupported\r\n" : ""}Content-Length: 0\r\n\r\n`;
        let reply: string;
        if (phase === "slow") {
          const socket = connect(s.port, "127.0.0.1"), chunks: Buffer[] = [];
          const received = new Promise<string>((resolve, reject) => {
            socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
            socket.once("error", reject); socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
          });
          await once(socket, "connect");
          socket.write(reviewHttp(s.port, body).slice(0, -1));
          // A separate busy reply proves the first body is admitted but incomplete.
          const busy = await post(s.port, f.raw({ action: "show" }));
          assert.equal(busy.status, 503); assert.equal(busy.json.code, "LOCAL_REVIEW_BUSY");
          socket.write(body.slice(-1) + subsequent);
          reply = await received;
        } else {
          reply = await exchange(s.port, reviewHttp(s.port, body) + subsequent, false);
        }
        // Observe listener invocation, not merely an absent second HTTP response.
        assert.equal(generalEffects, 0, "review-owned socket must not dispatch unrelated Hono work");
        assert.equal(upgradeEffects, 0, "review-owned socket must not dispatch ANY upgrade listener");
        assert.equal(connectEffects, 0, "review-owned socket must not dispatch tunnel listeners");
        assert.doesNotMatch(reply, /100 Continue|101 Switching Protocols/);
        assert.match(reply, phase === "rejected" ? /^HTTP\/1.1 400/ : /^HTTP\/1.1 200/);
        const events = f.journal.events(f.sha);
        assert.equal(events.length, phase === "rejected" ? 1 : 2);
        const issued = events.find(event => event.kind === "issued");
        assert.equal(issued?.kind === "issued" ? issued.decision.outcome : null, phase === "rejected" ? null : "approved");
        // A transport fence must never synthesize Cancel; original replay still works.
        if (phase !== "rejected") assert.equal((await post(s.port, decision)).json.outcome, "approved");
      } finally { await s.close(); f.close(); }
    });
  }
}

test("ordinary nonreview HTTP retains pipelining/keepalive and CORS with review opt-in", async () => {
  let effects = 0;
  const s = await start(true, "127.0.0.1", true, api => {
    api.app.post("/pipeline-effect", c => { effects++; return c.json({ recorded: effects }); });
  });
  try {
    const host = `Host: 127.0.0.1:${s.port}\r\n`;
    const reply = await exchange(s.port, `POST /pipeline-effect HTTP/1.1\r\n${host}Content-Length: 0\r\n\r\nPOST /pipeline-effect HTTP/1.1\r\n${host}Content-Length: 0\r\nConnection: close\r\n\r\n`, false);
    assert.equal(effects, 2); assert.equal(reply.match(/HTTP\/1.1 200/g)?.length, 2);
    const health = await fetch(`http://127.0.0.1:${s.port}/api/health`, { headers: { Origin: "http://example.invalid" } });
    assert.equal(health.status, 200); assert.equal(health.headers.get("access-control-allow-origin"), "*");
  } finally { await s.close(); }
});

test("a first review-targeted upgrade cannot reach general upgrade listeners", async () => {
  let upgrades = 0;
  const s = await start();
  s.server.on("upgrade", () => { upgrades++; });
  try {
    const reply = await exchange(s.port, `GET ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, false);
    assert.equal(upgrades, 0); assert.match(reply, /^HTTP\/1.1 405/);
  } finally { await s.close(); }
});

test("raw HTTP rejects duplicate Host, encoded target, unexpected trailers, Expect and body overflow", async () => {
  const s = await start();
  try {
    const host = `Host: 127.0.0.1:${s.port}\r\n`, content = "Content-Type: application/json\r\n";
    for (const [extra, body, status] of [
      [host + "Content-Length: 2\r\n", "{}", 400],
      ["Expect: 100-continue\r\nContent-Length: 2\r\n", "{}", 405],
      ["Transfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\nX-Extra: forbidden\r\n\r\n", 415],
      ["Transfer-Encoding: chunked\r\n", `10001\r\n${" ".repeat(65537)}\r\n0\r\n\r\n`, 413],
    ] satisfies [string, string, number][]) {
      const reply = await exchange(s.port, `POST ${endpoint} HTTP/1.1\r\n${host}${content}${extra}\r\n${body}`);
      assert.match(reply, new RegExp(`^HTTP/1.1 ${status}`)); assert.doesNotMatch(reply, /Access-Control-Allow-Origin/i);
    }
    for (const body of ["\ufeff" + rawRequest(), rawRequest({ nested: JSON.parse("[".repeat(65) + "0" + "]".repeat(65)) }), rawRequest({ actor: "\\ud800" })]) assert.equal((await post(s.port, body)).status, 400);
    const missingHost = await exchange(s.port, `POST ${endpoint} HTTP/1.1\r\n${content}Content-Length: 2\r\n\r\n{}`);
    assert.match(missingHost, /^HTTP\/1.1 400/);
    const encoded = await post(s.port, rawRequest(), {}, "/api/documents/%6cocal-review");
    assert.equal(encoded.status, 403); assert.equal(encoded.headers["access-control-allow-origin"], undefined);
  } finally { await s.close(); }
});

test("exact 64 KiB request is accepted; reply loss after issuance retains original decision coordinates", async () => {
  const f = await nativeFixture(), s = await start();
  try {
    const show = f.raw({ action: "show" });
    assert.equal((await post(s.port, show + " ".repeat(65536 - Buffer.byteLength(show)))).status, 200);
    const request = await post(s.port, f.raw({ action: "request", expectedRevision: 0 }));
    const body = f.raw({ action: "decide", expectedRevision: 0, requestKey: request.json.requestKey, outcome: "approved" });
    const socket = connect(s.port, "127.0.0.1");
    socket.on("error", () => { /* Lost reply is intentional; journal is the assertion owner. */ });
    await once(socket, "connect"); socket.pause();
    socket.write(`POST ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const until = performance.now() + 5000;
    while (f.journal.events(f.sha).length !== 2 && performance.now() < until) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.journal.events(f.sha).length, 2);
    const closed = once(socket, "close"); socket.destroy(); await closed;
    const replay = await post(s.port, body);
    assert.equal(replay.status, 200); assert.equal(replay.json.outcome, "approved");
    assert.equal(f.journal.events(f.sha).length, 2); assert.deepEqual(replay.json, await executeLocalReview(body));
  } finally { await s.close(); f.close(); }
});

test("production serve command reaches the bridge in an isolated child and cleans up its listener", async () => {
  const f = await nativeFixture(), reservation = await start(false), port = reservation.port;
  await reservation.close();
  const commandUrl = new URL("../cli/core-command.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "-e", `import { runCoreCommand } from ${JSON.stringify(commandUrl)}; const code = await runCoreCommand(["serve", "--port", "${port}", "--host", "127.0.0.1", "--local-review", "--cors"], { io: { stdout: s => console.log(s), stderr: s => console.error(s) }, hooks: {} }); if (code) process.exit(code);`], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(Error("disposable production server did not become ready")), 10000);
      child.stdout.on("data", chunk => { text += String(chunk); if (text.includes("Listening on")) { clearTimeout(timer); resolve(); } });
      child.stderr.resume();
      child.once("error", () => { clearTimeout(timer); reject(Error("disposable production process failed")); });
      child.once("exit", () => { clearTimeout(timer); reject(Error("disposable production process exited before readiness")); });
    });
    const show = await post(port, f.raw({ action: "show" }));
    assert.equal(show.status, 200); assert.equal(show.json.trust, "local-unverified");
    assert.equal((await post(port, f.raw({ action: "show" }), { Origin: "null" })).status, 403);
  } finally { child.kill("SIGTERM"); await exited; f.close(); }
});

test("opt-in connection cap rejects socket seventeen and unrelated health/WebSocket still work", async () => {
  const s = await start(), sockets: import("node:net").Socket[] = [];
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/health`)).status, 200);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(Error("fixture websocket failed")), { once: true }); });
      // A general WebSocket must not inherit a pending review header deadline.
      await new Promise(resolve => setTimeout(resolve, 5100)); assert.equal(ws.readyState, WebSocket.OPEN);
    } finally { ws.close(); }
    // Use a separate server so health keep-alive/WS do not consume cap slots.
  } finally { await s.close(); }
  const capped = await start();
  try {
    for (let i = 0; i < 16; i++) { const socket = connect(capped.port, "127.0.0.1"); socket.on("error", () => {}); sockets.push(socket); await once(socket, "connect"); }
    const denied = connect(capped.port, "127.0.0.1"); denied.on("error", () => {});
    await new Promise<void>(resolve => denied.once("close", () => resolve()));
    assert.ok(denied.destroyed); assert.ok(sockets.every(socket => !socket.destroyed));
  } finally { for (const socket of sockets) socket.destroy(); await capped.close(); }
});

test("response serialization rejects excess rather than truncating and static failure guidance is bounded", () => {
  const limit = 32 * 1024 * 1024, overhead = Buffer.byteLength(JSON.stringify({ value: "" }));
  assert.equal(Buffer.byteLength(serializeLocalReviewBridgeResult({ value: "x".repeat(limit - overhead) })), limit);
  assert.throws(() => serializeLocalReviewBridgeResult({ value: "x".repeat(limit - overhead + 1) }), /RESPONSE_LIMIT/);
  for (const cause of ["BIND", "OPTIONS", "PEER", "HOST", "ORIGIN", "HEADERS", "CONTENT", "METHOD", "ROUTE", "INPUT", "UTF8", "BODY_LIMIT", "BUSY", "DEADLINE", "RESPONSE_LIMIT", "INTERNAL", "DOCUMENT_INPUT", "DOCUMENT_SOURCE", "DOCUMENT_STALE", "DOCUMENT_AUTHORITY", "DOCUMENT_CONFLICT", "DOCUMENT_UNCERTAIN", "DOCUMENT_UNAVAILABLE"] as const) assertBlocker(localReviewBridgeFailure(cause).message);
});

test("body and header deadlines reject slow streams without a shared cancellation", async () => {
  const s = await start();
  try {
    const bodyTimeout = exchange(s.port, `POST ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n`, false);
    // Keep an actual socket open for header timeout; do not end the input.
    const socket = connect(s.port, "127.0.0.1"), chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(Buffer.from(chunk))); socket.on("error", () => {});
    const closed = once(socket, "close");
    assert.match(await bodyTimeout, /^HTTP\/1.1 408/);
    await closed; assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 408/);
  } finally { await s.close(); }
});

test("one active operation has no queue; abandoned body cannot decide or cancel a shared request", async () => {
  const f = await nativeFixture(), s = await start();
  try {
    const pending = await post(s.port, f.raw({ action: "request", expectedRevision: 0 })); assert.equal(pending.status, 200);
    const socket = connect(s.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`POST ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`);
    // The busy reply is a deterministic acknowledgement that the slow request owns admission.
    let busy = await post(s.port, f.raw({ action: "show" }));
    assert.equal(busy.status, 503); assert.equal(busy.json.code, "LOCAL_REVIEW_BUSY");
    socket.destroy();
    await new Promise<void>(resolve => socket.once("close", resolve));
    assert.equal(f.journal.events(f.sha).length, 1); assert.equal(f.journal.capture(String(pending.json.requestKey)), null);
    // Reconcile ORIGINAL coordinates; closing the client is not shared Cancel.
    const decision = await post(s.port, f.raw({ action: "decide", expectedRevision: 0, requestKey: pending.json.requestKey, outcome: "approved" }));
    assert.equal(decision.status, 200); assert.equal(decision.json.outcome, "approved");
  } finally { await s.close(); f.close(); }
});
