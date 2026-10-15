import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runCoreCommand } from "../../cli/core-command.js";
import { renderArtifact } from "../render.js";
import { artifactDiagnostic, ArtifactPolicyError } from "../policy.js";
import { appendFeedback } from "../feedback.js";
import { processBirth, sessionDirectory, type ReviewContext } from "../runtime.js";
import {
  consumeFeedback, readReviewRecord, reviewStatus, startReview, stopReview, writeReviewRecord,
  type ReviewLauncher, type ReviewRecord,
} from "../session.js";
import { idleExpired, OUTER_CSP, superviseReview } from "../supervisor.js";
import { isolatedArtifactEnvironment, renderEnvironment } from "./test-environment.js";

const loader = createRequire(import.meta.url).resolve("tsx/esm");
const supervisor = fileURLToPath(new URL("../supervisor.ts", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t: { after(fn: () => void | Promise<void>): void }, adapter: ReviewContext["adapter"] = "pi") {
  const root = mkdtempSync("/tmp/pa-review-test-");
  const children: { child: ChildProcess; birth: string | undefined }[] = [];
  t.after(async () => {
    // Register before rendering: even early fixture failures own their cleanup.
    // Signal only direct synthetic handles, never an inferred PID.
    for (const { child, birth } of children) if (child.exitCode === null && child.signalCode === null) {
      if (birth && child.pid && processBirth(child.pid) === birth) child.kill("SIGTERM");
    }
    await sleep(50);
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source.md");
  writeFileSync(source, "# Synthetic\n\nNo real user content.\n");
  const artifact = renderArtifact(source, join(root, "companion"), renderEnvironment);
  const assets = join(root, "assets"); mkdirSync(assets, { mode: 0o700 });
  // Synthetic loopback fixture, NOT installed/browser/adapted-Lavish proof.
  for (const [name, bytes] of Object.entries({ "outer.html": '<!doctype html><body data-config="__CONFIG__"><iframe sandbox="allow-same-origin" src="content"></iframe></body>',
    "outer.css": "body{color:black}", "review.js": "/* synthetic packaged asset */" })) writeFileSync(join(assets, name), bytes);
  const context: ReviewContext = { adapter, deployment: "d-abcdef", root: join(root, "artifact-review-v1"), ownerPid: process.pid, ownerBirth: processBirth(process.pid)! };
  const launch: ReviewLauncher = path => {
    // Direct source API supplies synthetic assets; production supervisor main
    // independently resolves and revalidates the selected immutable Nix closure.
    const script = `import { superviseReview } from ${JSON.stringify(pathToFileURL(supervisor).href)}; await superviseReview(process.argv[1]);`;
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", script, path], { env: { TZ: "UTC", LC_ALL: "C.UTF-8" }, stdio: "ignore" });
    child.unref(); children.push({ child, birth: child.pid ? processBirth(child.pid) : undefined });
  };
  return { root, source, artifact, assets, context, launch };
}
function getRecord(context: ReviewContext, id: string): ReviewRecord {
  const fd = sessionDirectory(context, id);
  try { return readReviewRecord(fd, context, id); } finally { closeSync(fd); }
}
const codeIs = (code: string) => (error: unknown): boolean => error instanceof ArtifactPolicyError && error.diagnostic === code;
async function post(record: ReviewRecord, route: string, body: unknown): Promise<Response> {
  const origin = `http://127.0.0.1:${record.port}`;
  return fetch(`${origin}/${record.token}/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

for (const adapter of ["pi", "opencode", "claudecode"] as const) {
  test(`${adapter}: owned loopback start/status/idempotence, immutable snapshot, durable export and bounded stop`, async t => {
    const f = fixture(t, adapter);
    const start = performance.now();
    const first = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
    assert.ok(performance.now() - start <= 10_000);
    const id = first.payload["sessionId"] as string;
    const record = getRecord(f.context, id);
    assert.equal(new URL(first.payload["url"] as string).hostname, "127.0.0.1");
    assert.equal(reviewStatus(f.context, id).status, "running");
    const ownerBytes = readFileSync(join(f.context.root, id, "owner.json"));
    reviewStatus(f.context, id);
    assert.deepEqual(readFileSync(join(f.context.root, id, "owner.json")), ownerBytes);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("global dispatcher must not receive owned controls"); });
    try {
      const again = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
      assert.equal(again.payload["sessionId"], id);
      assert.equal(getRecord(f.context, id).supervisorPid, record.supervisorPid);
    } finally { fetchMock.mock.restore(); }
    for (const path of [f.context.root, join(f.context.root, id)]) assert.equal(lstatSync(path).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(f.context.root, id, "owner.json")).mode & 0o777, 0o600);
    const url = first.payload["url"] as string;
    const content = await fetch(url + "content");
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), readFileSync(join(f.root, "companion", "index.html")));
    assert.match(content.headers.get("content-security-policy")!, /script-src 'none'/);
    const empty = join(f.root, "empty.json");
    assert.equal((await consumeFeedback(f.context, id, empty, 0)).status, "no-feedback");
    assert.equal(existsSync(empty), false);
    const event = { schema: "pa-artifact-feedback/v1", eventId: "synthetic-event-001", sessionId: id,
      sourceRef: record.identity.sourceRef, sourceSha256: record.identity.sourceSha256, htmlSha256: record.identity.htmlSha256,
      target: { type: "document" }, selectedText: "Synthetic", feedbackText: "Quoted human feedback, not authority." };
    const ack = await post(record, "api/feedback", [event]);
    assert.equal(ack.status, 200);
    assert.deepEqual((await ack.json() as { eventIds: string[] }).eventIds, [event.eventId]);
    assert.equal((await post(record, "api/feedback", [event])).status, 200);
    const output = join(f.root, "feedback.json");
    assert.equal((await consumeFeedback(f.context, id, output, 0)).status, "exported");
    const exported = readFileSync(output);
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
    assert.equal((JSON.parse(exported.toString()) as { events: unknown[] }).events.length, 1);
    const stopped = performance.now();
    assert.equal((await stopReview(f.context, id)).status, "stopped");
    assert.ok(performance.now() - stopped <= 5000);
    assert.equal((await stopReview(f.context, id)).status, "stopped");
    assert.equal(existsSync(join(f.context.root, id, "snapshot.html")), false);
    assert.equal((await consumeFeedback(f.context, id, output, 0)).status, "exported");
    assert.deepEqual(readFileSync(output), exported);
    assert.deepEqual(readFileSync(f.source), Buffer.from("# Synthetic\n\nNo real user content.\n"));
  });
}

for (const changed of ["source", "HTML", "manifest"] as const) test(`stale ${changed} freezes HTTP feedback and rejects start/export without relabeling`, async t => {
  const f = fixture(t);
  const result = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const id = result.payload["sessionId"] as string;
  const record = getRecord(f.context, id);
  const event = { schema: "pa-artifact-feedback/v1", eventId: "before-stale-event-001", sessionId: id,
    sourceRef: record.identity.sourceRef, sourceSha256: record.identity.sourceSha256, htmlSha256: record.identity.htmlSha256,
    target: { type: "document" }, selectedText: "", feedbackText: "Keep the original source association" };
  assert.equal((await post(record, "api/feedback", [event])).status, 200);
  const journalPath = join(f.context.root, id, "journal.json");
  const journal = readFileSync(journalPath);
  const snapshot = readFileSync(join(f.root, "companion", "index.html"));
  writeFileSync(changed === "source" ? f.source : changed === "HTML" ? join(f.root, "companion", "index.html") : f.artifact.manifest, "# Changed\n");
  assert.equal(reviewStatus(f.context, id).status, "stale");
  assert.deepEqual(Buffer.from(await (await fetch((result.payload["url"] as string) + "content")).arrayBuffer()), snapshot);
  assert.equal((await post(record, "api/feedback", [])).status, 409);
  await assert.rejects(startReview(f.context, f.artifact.manifest, f.assets, f.launch), codeIs("ARTIFACT_STALE"));
  await assert.rejects(consumeFeedback(f.context, id, join(f.root, "stale.json"), 0), codeIs("ARTIFACT_STALE"));
  assert.equal(existsSync(join(f.root, "stale.json")), false);
  assert.deepEqual(readFileSync(journalPath), journal);
  await stopReview(f.context, id);
  assert.deepEqual(readFileSync(journalPath), journal);
});

test("foreign adapter/deployment/private-state/PID-reuse reject without guessed signals", async t => {
  const f = fixture(t);
  const result = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const id = result.payload["sessionId"] as string;
  assert.throws(() => reviewStatus({ ...f.context, adapter: "opencode" }, id), codeIs("ARTIFACT_OWNER_CONFLICT"));
  await assert.rejects(stopReview({ ...f.context, deployment: "d-fedcba" }, id), codeIs("ARTIFACT_OWNER_CONFLICT"));
  const fd = sessionDirectory(f.context, id);
  const original = readReviewRecord(fd, f.context, id);
  writeReviewRecord(fd, { ...original, supervisorPid: process.pid, supervisorBirth: "reused-pid-birth" });
  await assert.rejects(stopReview(f.context, id), codeIs("ARTIFACT_OWNER_CONFLICT"));
  writeReviewRecord(fd, original); closeSync(fd);
  assert.equal(reviewStatus(f.context, id).status, "running");
  await stopReview(f.context, id);
  assert.throws(() => reviewStatus(f.context, "../../etc/passwd"), codeIs("ARTIFACT_USAGE_INVALID"));
});

test("human end is durable before ACK and default cleanup cannot make it restartable", async t => {
  const f = fixture(t);
  let running: Awaited<ReturnType<typeof superviseReview>> | undefined;
  t.after(async () => { await running?.close(); });
  const result = await startReview(f.context, f.artifact.manifest, f.assets, path => {
    void superviseReview(path).then(value => { running = value; });
  });
  const id = result.payload["sessionId"] as string;
  assert.equal((await post(getRecord(f.context, id), "api/end", {})).status, 200);
  // Inspect durable state immediately at ACK, not after waiting for cleanup.
  assert.equal(getRecord(f.context, id).state, "ended");
  await running!.close(); // owner-exit/idle/default close must preserve the tombstone
  assert.equal(reviewStatus(f.context, id).status, "ended");
  assert.equal(existsSync(join(f.context.root, id, "snapshot.html")), false);
  await assert.rejects(startReview(f.context, f.artifact.manifest, f.assets, f.launch), codeIs("ARTIFACT_OWNER_CONFLICT"));
});

test("feedback body already in flight cannot be acknowledged after human end", async t => {
  const f = fixture(t);
  const result = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const id = result.payload["sessionId"] as string;
  const record = getRecord(f.context, id);
  const origin = `http://127.0.0.1:${record.port}`;
  const body = JSON.stringify([{ schema: "pa-artifact-feedback/v1", eventId: "late-feedback-000001", sessionId: id,
    sourceRef: record.identity.sourceRef, sourceSha256: record.identity.sourceSha256, htmlSha256: record.identity.htmlSha256,
    target: { type: "document" }, selectedText: "", feedbackText: "Must not be acknowledged" }]);
  let req: ReturnType<typeof request>;
  const outcome = new Promise<number | string | undefined>((resolve, reject) => {
    req = request(`${origin}/${record.token}/api/feedback`, { method: "POST", headers: { origin, "content-type": "application/json" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? resolve(error.code) : reject(error));
    req.setTimeout(2000, () => req.destroy(new Error("synthetic request timeout")));
    req.write(body.slice(0, -1));
  });
  t.after(() => req.destroy());
  await sleep(30); // owned request has headers/body but is deliberately incomplete
  assert.equal((await post(record, "api/end", {})).status, 200);
  req!.end(body.slice(-1));
  assert.ok([409, "ECONNRESET"].includes((await outcome) as number | string));
  assert.equal(existsSync(join(f.context.root, id, "journal.json")), false);
});

test("unknown HTTP, sibling, share/upload/update/setup/export, host/origin and WS effects are denied", async t => {
  const f = fixture(t);
  const result = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const url = result.payload["url"] as string;
  const record = getRecord(f.context, result.payload["sessionId"] as string);
  for (const route of [".env", "source.md", "manifest.json", "sdk.js", "share", "api/share", "api/upload", "api/attachments", "setup", "update", "export", "whiteboard", "unknown", "%2e%2e/source.md"]) {
    assert.equal((await fetch(url + route)).status, 400, route);
    assert.equal((await post(record, route, {})).status, 400, route);
  }
  // Node fetch rewrites Host from the URL. Use the HTTP client to put the
  // hostile header on the wire, without resolving/contacting any external host.
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: { host: "foreign.invalid" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(hostileHost, 400);
  assert.equal((await fetch(url, { headers: { origin: "https://foreign.invalid" } })).status, 400);
  assert.equal((await fetch(url + "api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: "[]" })).status, 400);
  const { connect } = await import("node:net");
  const upgrade = await new Promise<string>((resolve, reject) => {
    const socket = connect(record.port, "127.0.0.1", () => socket.write(`GET /${record.token}/events HTTP/1.1\r\nHost: 127.0.0.1:${record.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    let data = ""; socket.on("data", chunk => { data += chunk.toString(); }); socket.on("end", () => resolve(data)); socket.on("error", reject);
  });
  assert.match(upgrade, /^HTTP\/1\.1 403/);
  assert.equal(existsSync(join(f.context.root, record.sessionId, "journal.json")), false);
  await stopReview(f.context, record.sessionId);
});

test("denied half-open WebSocket upgrades cannot hold owned cleanup open", async t => {
  const f = fixture(t);
  const result = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const id = result.payload["sessionId"] as string;
  const record = getRecord(f.context, id);
  const { connect } = await import("node:net");
  const socket = connect({ port: record.port, host: "127.0.0.1", allowHalfOpen: true });
  t.after(() => socket.destroy());
  const response = await new Promise<string>((resolve, reject) => {
    let bytes = "";
    socket.on("connect", () => socket.write(`GET /${record.token}/events HTTP/1.1\r\nHost: 127.0.0.1:${record.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on("data", chunk => {
      bytes += chunk.toString();
      if (bytes.includes("\r\n\r\n")) resolve(bytes);
    });
    socket.on("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 403/);
  const started = performance.now();
  assert.equal((await stopReview(f.context, id)).status, "stopped");
  assert.ok(performance.now() - started < 5000);
});

test("concurrent artifacts are isolated; stopped restart retains acknowledged journal", async t => {
  const f = fixture(t);
  const first = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  const a = first.payload["sessionId"] as string;
  const secondSource = join(f.root, "second.md"); writeFileSync(secondSource, "# Different synthetic\n");
  const secondArtifact = renderArtifact(secondSource, join(f.root, "second"), renderEnvironment);
  const second = await startReview(f.context, secondArtifact.manifest, f.assets, f.launch);
  const b = second.payload["sessionId"] as string;
  assert.notEqual(a, b);
  assert.notEqual(first.payload["url"], second.payload["url"]);
  const fd = sessionDirectory(f.context, a);
  const record = readReviewRecord(fd, f.context, a);
  appendFeedback(fd, record, [{ schema: "pa-artifact-feedback/v1", eventId: "restart-event-0001", sessionId: a,
    sourceRef: record.identity.sourceRef, sourceSha256: record.identity.sourceSha256, htmlSha256: record.identity.htmlSha256,
    target: { type: "document" }, selectedText: "", feedbackText: "Retain me" }]);
  closeSync(fd);
  await stopReview(f.context, a);
  assert.equal(reviewStatus(f.context, b).status, "running");
  const restarted = await startReview(f.context, f.artifact.manifest, f.assets, f.launch);
  assert.equal(restarted.payload["sessionId"], a);
  const output = join(f.root, "restarted.json");
  assert.equal((await consumeFeedback(f.context, a, output, 0)).status, "exported");
  assert.equal((JSON.parse(readFileSync(output, "utf8")) as { events: unknown[] }).events.length, 1);
  await stopReview(f.context, a); await stopReview(f.context, b);
});

test("monotonic 900s idle boundary and status/socket presence do not refresh activity", async t => {
  const f = fixture(t);
  let now = 0;
  let running: Awaited<ReturnType<typeof superviseReview>> | undefined;
  const first = await startReview(f.context, f.artifact.manifest, f.assets, path => {
    void superviseReview(path, { now: () => now, tickMs: 10 }).then(value => { running = value; });
  });
  const id = first.payload["sessionId"] as string;
  assert.equal(idleExpired(0, 899_999), false); assert.equal(idleExpired(0, 900_000), true);
  now = 899_999; reviewStatus(f.context, id);
  await fetch(first.payload["url"] as string); // socket/request presence is not human activity
  now = 900_000;
  for (let i = 0; i < 100 && reviewStatus(f.context, id).status !== "stopped"; i++) await sleep(10);
  assert.equal(reviewStatus(f.context, id).status, "stopped");
  await running?.close();
  assert.match(OUTER_CSP, /frame-src 'self'/);
  assert.doesNotMatch(OUTER_CSP, /unsafe-inline|unsafe-eval|https:/);
});

test("owner exit closes only owned loopback runtime and preserves acknowledged journal", async t => {
  const f = fixture(t);
  const owner = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { env: {}, stdio: "ignore" });
  const birth = owner.pid ? processBirth(owner.pid) : undefined;
  assert.ok(owner.pid && birth);
  t.after(() => { if (owner.pid && processBirth(owner.pid) === birth) owner.kill("SIGTERM"); });
  const context = { ...f.context, ownerPid: owner.pid!, ownerBirth: birth! };
  const result = await startReview(context, f.artifact.manifest, f.assets, f.launch);
  const id = result.payload["sessionId"] as string;
  const record = getRecord(context, id);
  const fd = sessionDirectory(context, id);
  appendFeedback(fd, record, [{ schema: "pa-artifact-feedback/v1", eventId: "owner-exit-event-001", sessionId: id,
    sourceRef: record.identity.sourceRef, sourceSha256: record.identity.sourceSha256, htmlSha256: record.identity.htmlSha256,
    target: { type: "document" }, selectedText: "", feedbackText: "Durably retained" }]); closeSync(fd);
  owner.kill("SIGTERM"); // exact direct synthetic child handle, never guessed PID
  for (let i = 0; i < 200 && reviewStatus(context, id).status !== "stopped"; i++) await sleep(10);
  assert.equal(reviewStatus(context, id).status, "stopped");
  assert.equal(existsSync(join(context.root, id, "snapshot.html")), false);
  assert.equal((await consumeFeedback(context, id, join(f.root, "owner-exit.json"), 0)).status, "exported");
});

test("partial startup reaches bounded failure without listener/signals and removes only transient snapshot", async t => {
  const f = fixture(t);
  const started = performance.now();
  await assert.rejects(startReview(f.context, f.artifact.manifest, f.assets, () => {}), codeIs("ARTIFACT_RUNTIME_FAILED"));
  assert.ok(performance.now() - started < 10_000);
  assert.deepEqual(readFileSync(f.source), Buffer.from("# Synthetic\n\nNo real user content.\n"));
});

test("CLI help and invalid input preserve envelopes/exit mappings across three binary names", async () => isolatedArtifactEnvironment(async () => {
  for (const binaryName of ["ppa", "opa", "cpa"]) {
    for (const args of [["review", "start", "--host", "0.0.0.0", "--json"], ["review", "feedback", "--session", "bad/path", "--output", "/tmp/a", "--json"]]) {
      const stdout: string[] = [], stderr: string[] = [];
      const code = await runCoreCommand(["artifact", ...args], { binaryName, io: { stdout: s => stdout.push(s), stderr: s => stderr.push(s) } });
      assert.equal(code, 2); assert.deepEqual(stdout, []); assert.match(stderr.join(""), /ARTIFACT_USAGE_INVALID/);
    }
  }
  assert.equal(artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED").exitCode, 3);
}));

test("private session roots never follow sibling/symlink state", t => {
  const f = fixture(t);
  symlinkSync(f.root, f.context.root);
  assert.throws(() => sessionDirectory(f.context, "a".repeat(48)), codeIs("ARTIFACT_OWNER_CONFLICT"));
});
