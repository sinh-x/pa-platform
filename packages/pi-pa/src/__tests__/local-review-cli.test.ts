import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
  LOCAL_REVIEW_MAX_BODY, LOCAL_REVIEW_MAX_RESPONSE, LOCAL_REVIEW_USAGE,
  LocalReviewTransportError, localReviewDeadline, localReviewFailure,
  readLocalReviewInput, runLocalReviewCommand, serializeLocalReview, writeLocalReviewOutput,
  type LocalReviewHandler,
} from "../local-review-cli.js";

const raw = '{"schemaVersion":"pa-local-review/v1","action":"show","subjectSha256":"' + "a".repeat(64) + '"}';
function fixture(handler: LocalReviewHandler = async () => ({ ok: true, trust: "local-unverified" })) {
  const stdout: string[] = [], stderr: string[] = [], seen: string[] = [];
  return {
    stdout, stderr, seen,
    io: { stdout: (text: string) => { stdout.push(text); }, stderr: (text: string) => { stderr.push(text); } },
    options: { stdin: Readable.from([Buffer.from(raw)]), handler: async (value: string) => { seen.push(value); return handler(value); } },
  };
}
function result(text: string | undefined): Record<string, unknown> {
  assert.ok(text); const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test("help and strict argument failures never read stdin or call core", async () => {
  for (const args of [[], ["--help"], ["serve", "--help"]]) {
    const f = fixture(); assert.equal(await runLocalReviewCommand(args, f.io, f.options), 0);
    assert.deepEqual(f.seen, []); assert.equal(f.options.stdin.readableFlowing, null);
    assert.equal(f.stdout[0], LOCAL_REVIEW_USAGE); assert.deepEqual(f.stderr, []);
  }
  for (const args of [["show"], ["--request-stdin", "--request-stdin"], ["--help", "--request-stdin"], ["serve"], ["serve", "--port", "0"], ["serve", "--port", "65536"], ["serve", "--port", "08080"], ["serve", "--port", "1e3"], ["serve", "--port", "+1234"], ["serve", "--port", "8080", "--host", "0.0.0.0"], ["--request-stdin", "--actor", "human"]]) {
    const f = fixture(); assert.equal(await runLocalReviewCommand(args, f.io, f.options), 1);
    assert.deepEqual(f.seen, []); assert.equal(f.stdout.length, 1); assert.deepEqual(f.stderr, []);
    assert.equal(result(f.stdout[0]).code, "LOCAL_REVIEW_ARGUMENTS");
  }
});

test("stdin forwards exact decoded raw JSON to the shared owner, without re-parsing duplicates", async () => {
  const f = fixture(); const duplicate = raw.replace('"action":"show"', '"action":"show","action":"decide"');
  f.options.stdin = Readable.from([Buffer.from(duplicate)]);
  assert.equal(await runLocalReviewCommand(["--request-stdin"], f.io, f.options), 0);
  assert.deepEqual(f.seen, [duplicate]); assert.equal(f.stdout.length, 1);
  assert.equal(result(f.stdout[0]).trust, "local-unverified"); assert.deepEqual(f.stderr, []);
});

test("returned owner failures preserve JSON and a failing exit; thrown failures never echo exceptions", async () => {
  const f = fixture(async () => ({ ok: false, code: "OWNER_REJECTED", message: "Bounded owner failure" }));
  assert.equal(await runLocalReviewCommand(["--request-stdin"], f.io, f.options), 1);
  assert.deepEqual(result(f.stdout[0]), { ok: false, code: "OWNER_REJECTED", message: "Bounded owner failure" });
  for (const error of [new Error("SYNTHETIC_PRIVATE"), new Proxy({}, { getPrototypeOf() { throw new Error("SYNTHETIC_PRIVATE"); }, get() { throw new Error("SYNTHETIC_PRIVATE"); } }), Object.defineProperty(new LocalReviewTransportError("input"), "message", { get() { throw new Error("SYNTHETIC_PRIVATE"); } })]) {
    const failed = fixture(async () => { throw error; });
    assert.equal(await runLocalReviewCommand(["--request-stdin"], failed.io, failed.options), 1);
    assert.doesNotMatch(failed.stdout.join(""), /SYNTHETIC_PRIVATE/); assert.equal(failed.stdout.length, 1);
    assert.deepEqual(failed.stderr, []);
  }
});

test("stdin enforces byte limit before decoding and rejects malformed UTF-8", async () => {
  const exact = Buffer.alloc(LOCAL_REVIEW_MAX_BODY, 0x61);
  assert.equal((await readLocalReviewInput(Readable.from([exact]))).length, LOCAL_REVIEW_MAX_BODY);
  for (const [body, code] of [[Buffer.alloc(LOCAL_REVIEW_MAX_BODY + 1), "LOCAL_REVIEW_BODY_LIMIT"], [Buffer.from([0xc0, 0xaf]), "LOCAL_REVIEW_UTF8"], [Buffer.from([0xed, 0xa0, 0x80]), "LOCAL_REVIEW_UTF8"], [Buffer.from([0xe2, 0x82]), "LOCAL_REVIEW_UTF8"]] as const) {
    const f = fixture(); f.options.stdin = Readable.from([body]);
    assert.equal(await runLocalReviewCommand(["--request-stdin"], f.io, f.options), 1);
    assert.deepEqual(f.seen, []); assert.equal(result(f.stdout[0]).code, code);
  }
  const encoded = Buffer.from("Tiếng Việt");
  assert.equal(await readLocalReviewInput(Readable.from([...encoded].map(byte => Buffer.from([byte])))), "Tiếng Việt");
  assert.equal(await readLocalReviewInput(Readable.from([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)])), `\uFEFF${raw}`);
  await assert.rejects(readLocalReviewInput(Readable.from(["already decoded"])), error => localReviewFailure(error).code === "LOCAL_REVIEW_INPUT");
});

test("read failures, incomplete streams and stalled input have bounded safe errors", async () => {
  const input = new PassThrough();
  const reading = readLocalReviewInput(input, 20);
  await assert.rejects(reading, error => localReviewFailure(error).code === "LOCAL_REVIEW_DEADLINE");
  input.destroy();
  for (const mode of ["error", "close"]) {
    const stream = new PassThrough(); const promise = readLocalReviewInput(stream);
    if (mode === "error") stream.destroy(new Error("SYNTHETIC_PRIVATE")); else stream.destroy();
    await assert.rejects(promise, error => localReviewFailure(error).code === "LOCAL_REVIEW_INPUT");
  }
});

test("total deadlines settle without trusting or cancelling the pending owner", async () => {
  let resolve!: (value: number) => void;
  const pending = new Promise<number>(done => { resolve = done; });
  await assert.rejects(localReviewDeadline(pending, 20), error => localReviewFailure(error).code === "LOCAL_REVIEW_DEADLINE");
  resolve(7); assert.equal(await pending, 7);
});

test("CLI overall timeout cannot emit a late second result after the owner settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: Record<string, unknown>) => void;
  let started!: () => void;
  const waiting = new Promise<void>(done => { started = done; });
  const f = fixture(() => { started(); return new Promise(done => { resolve = done; }); });
  const execution = runLocalReviewCommand(["--request-stdin"], f.io, f.options);
  await waiting;
  t.mock.timers.tick(30_000);
  assert.equal(await execution, 1); assert.equal(result(f.stdout[0]).code, "LOCAL_REVIEW_DEADLINE");
  resolve({ ok: true });
  await new Promise<void>(done => setImmediate(done));
  assert.equal(f.stdout.length, 1); assert.deepEqual(f.stderr, []);
});

test("document routing exposes review help and delegates stdin only to the injected owner", async () => {
  const { runDocumentCommand } = await import("../document-cli.js");
  const f = fixture();
  assert.equal(await runDocumentCommand(["review", "--help"], f.io, f.options), 0);
  assert.equal(f.stdout[0], LOCAL_REVIEW_USAGE); assert.deepEqual(f.seen, []);
  assert.equal(await runDocumentCommand(["review", "--request-stdin"], f.io, f.options), 0);
  assert.deepEqual(f.seen, [raw]); assert.equal(result(f.stdout[1]).ok, true);
  const help = fixture(); assert.equal(await runDocumentCommand(["--help"], help.io, help.options), 0);
  assert.match(help.stdout[0]!, /ppa document review --help/); assert.deepEqual(help.seen, []);
});

test("source public CLI propagates help and bounded failures without stores or actual review decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "pap314-transport-cli-"));
  try {
    const env = { ...process.env, TZ: "Asia/Saigon", LANG: "en_US.UTF-8", NO_COLOR: "1", PA_AI_USAGE_HOME: join(root, "usage"), PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "absent.db") };
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    for (const args of [["document", "--help"], ["document", "review", "--help"], ["document", "review", "serve", "--help"]]) {
      const execution = spawnSync(process.execPath, ["--import=tsx", cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 0); assert.equal(execution.stderr, ""); assert.match(execution.stdout, /local-unverified/);
    }
    for (const [args, input, code] of [
      [["--request-stdin", "--actor", "human"], Buffer.from(raw), "LOCAL_REVIEW_ARGUMENTS"],
      [["--request-stdin"], Buffer.from([0xc0, 0xaf]), "LOCAL_REVIEW_UTF8"],
      [["--request-stdin"], Buffer.alloc(65537), "LOCAL_REVIEW_BODY_LIMIT"],
    ] as const) {
      const execution = spawnSync(process.execPath, ["--import=tsx", cli, "document", "review", ...args], { env, input, encoding: "utf8", timeout: 10_000 });
      assert.equal(execution.status, 1); assert.equal(execution.stderr, ""); assert.equal(result(execution.stdout).code, code);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source serve command announces numeric loopback, serves store-free health and shuts down cleanly", async t => {
  const root = mkdtempSync(join(tmpdir(), "pap314-transport-serve-"));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, TZ: "Asia/Saigon", LANG: "en_US.UTF-8", NO_COLOR: "1", PA_AI_USAGE_HOME: join(root, "usage"), PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: join(root, "home"), PA_REGISTRY_DB: join(root, "absent.db") };
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import=tsx", cli, "document", "review", "serve", "--port", String(address.port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit").then(args => args, () => null);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await localReviewDeadline(exited, 5_000);
    rmSync(root, { recursive: true, force: true });
  });
  let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const startup = await localReviewDeadline(new Promise<string>((resolve, reject) => {
    let text = "";
    child.once("error", () => reject(new Error("Source CLI could not start")));
    child.once("exit", () => reject(new Error("Source CLI exited before startup")));
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); if (text.includes("\n")) resolve(text); });
  }), 10_000);
  assert.deepEqual(result(startup), { schemaVersion: "pa-local-review/v1", trust: "local-unverified", listening: `http://127.0.0.1:${address.port}` });
  const health = await new Promise<string>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/v1/health`, response => {
      let body = ""; response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.once("error", reject); response.once("end", () => resolve(body));
    });
    request.once("error", reject); request.setTimeout(1000, () => request.destroy(new Error("Source health timed out")));
  });
  assert.deepEqual(result(health), { schemaVersion: "pa-local-review/v1", trust: "local-unverified" });
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(await localReviewDeadline(exited, 5_000), [0, null]);
  assert.equal(stderr, ""); assert.deepEqual(readdirSync(root), []);
});

test("response serialization rejects oversized/cyclic results rather than truncating", async () => {
  const exact = serializeLocalReview({ data: "a".repeat(LOCAL_REVIEW_MAX_RESPONSE - 11) });
  assert.equal(Buffer.byteLength(exact), LOCAL_REVIEW_MAX_RESPONSE);
  assert.throws(() => serializeLocalReview({ data: "a".repeat(LOCAL_REVIEW_MAX_RESPONSE - 10) }), error => localReviewFailure(error).code === "LOCAL_REVIEW_RESPONSE_LIMIT");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const f = fixture(async () => cyclic);
  assert.equal(await runLocalReviewCommand(["--request-stdin"], f.io, f.options), 1);
  assert.equal(result(f.stdout[0]).code, "LOCAL_REVIEW_INTERNAL");
});

test("all typed blocker diagnostics have exactly five labels, safe context and <=2000 characters", () => {
  const codes: ConstructorParameters<typeof LocalReviewTransportError>[0][] = ["arguments", "input", "utf8", "body-limit", "headers", "host", "origin", "route", "method", "content", "busy", "deadline", "response-limit", "unavailable", "internal", "listen", "output"];
  for (const code of codes) {
    const failure = localReviewFailure(new LocalReviewTransportError(code));
    assert.ok(failure.message.length <= 2000); assert.ok(JSON.stringify(failure).length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(failure.message.split(`${label}:`).length - 1, 1);
    assert.match(failure.message, /Impact: none\. Actor: operator\. New approval: not required/);
    assert.doesNotMatch(failure.message, /\u001b/);
  }
  for (const error of [null, undefined, "x".repeat(2001), "x".repeat(2000), "\u001b[31mSYNTHETIC_PRIVATE\nCondition: forged"]) {
    assert.equal(localReviewFailure(error).code, "LOCAL_REVIEW_INTERNAL");
    assert.doesNotMatch(localReviewFailure(error).message, /SYNTHETIC_PRIVATE|forged/);
  }
});

test("CLI output failures do not append another stdout document; production writes await completion", async () => {
  const f = fixture();
  const io = { stdout: () => { throw new Error("SYNTHETIC_PRIVATE"); }, stderr: f.io.stderr };
  assert.equal(await runLocalReviewCommand(["--request-stdin"], io, f.options), 1);
  assert.equal(f.stderr.length, 1); assert.equal(result(f.stderr[0]).code, "LOCAL_REVIEW_OUTPUT");
  const chunks: string[] = [];
  const writable = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  await writeLocalReviewOutput(writable, '{"ok":true}');
  assert.deepEqual(chunks, ['{"ok":true}\n']);
  const failed = new Writable({ write(_chunk, _encoding, done) { done(new Error("SYNTHETIC_PRIVATE")); } });
  await assert.rejects(writeLocalReviewOutput(failed, "result"), error => localReviewFailure(error).code === "LOCAL_REVIEW_OUTPUT");
  const stalled = new Writable({ write() { /* Source fixture deliberately withholds the completion callback. */ } });
  await assert.rejects(writeLocalReviewOutput(stalled, "result", 20), error => localReviewFailure(error).code === "LOCAL_REVIEW_OUTPUT");
  assert.equal(stalled.destroyed, true);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(stalled.listenerCount("error"), 0);
});
