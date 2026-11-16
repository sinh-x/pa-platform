import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadToolDefinition } from "../../packages/pi-pa/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { bindLocalReadTool } from "../../packages/pi-pa/src/pi-extension/bound-local-read.ts";
import { createSecureLocalReadTool } from "../../packages/pi-pa/src/pi-extension/local-source-tools.ts";
import { acquireSelectedPiDocument } from "../../packages/pa-core/dist/local-source-file.js";

// Unit/integration mechanics only: this fixture root and callback are NOT proof
// of an actual selected Pi producer. No production tool/config/env accepts them.
const root = process.env.PA_TEST_IMMUTABLE_DOCUMENT_FIXTURE;
assert.ok(root, "build the inert Nix mechanics fixture first");
const env = process.env, directory = mkdtempSync(join(tmpdir(), "pap298-mechanics-"));
mkdirSync(join(directory, "config"));
process.env = { ...env, PA_PLATFORM_CONFIG: join(directory, "config"), PA_AI_USAGE_HOME: directory };
delete process.env.PA_DEPLOYMENT_ID;
process.on("exit", () => { process.env = env; rmSync(directory, { recursive: true, force: true }); });
let active = true;
const binding = { packageRoot: root, assertStable() { if (!active) throw new Error("inert revoked fixture binding"); } };
const tool = bindLocalReadTool(createReadToolDefinition, (path, patterns, signal) => acquireSelectedPiDocument(path, binding, patterns, signal));
const call = (path: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => tool.execute("inert-mechanics", { path, ...extra }, signal, undefined, { cwd: directory });
const text = (result: any) => result.content.map((block: any) => block.text ?? "").join("\n");

test("actual immutable hard-link metadata and shared guarded formatter deliver checked inert text", async () => {
  assert.equal(statSync(root!).uid, 0, "run positive mechanics checks in the ordinary root-mapped host namespace");
  assert.ok(statSync(`${root}/README.md`).nlink > 1);
  const result = await call(`${root}/README.md`);
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /inert immutable readme/);
  const example = await call(`${root}/examples/example.ts`);
  assert.notEqual(example.isError, true, text(example));
  assert.match(text(example), /inert immutable example/);
});

test("complete immutable hard-link text is scanned before pagination", async () => {
  const result = await call(`${root}/docs/note.txt`, { offset: 3, limit: 1, source: "public-web-response" });
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /INERT_MECHANICS_CANARY/);
});

test("image/binary, symlink routes, oversized files and outside-scope names remain withheld", async () => {
  for (const [name, expected] of [["docs/image.gif", "LOCAL_SOURCE_UNSUPPORTED_FILE"], ["docs/invalid.txt", "LOCAL_SOURCE_UNSUPPORTED_FILE"], ["docs/symlink.md", "LOCAL_SOURCE_UNSUPPORTED_FILE"], ["docs/oversized.txt", "LOCAL_CONTENT_LIMIT"], ["outside.txt", "LOCAL_SOURCE_UNSUPPORTED_FILE"]]) {
    const result = await call(`${root}/${name}`);
    assert.equal(result.isError, true, name);
    assert.equal(result.details.code, expected, text(result));
    assert.equal(result.details.outputWithheld, true);
    assert.doesNotMatch(text(result), /GIF89a|inert immutable readme/);
  }
});

test("caller cancellation, revoked producer and mutable multi-link fixture never deliver bytes", async () => {
  const caller = new AbortController(); caller.abort();
  assert.equal((await call(`${root}/README.md`, {}, caller.signal)).details.code, "LOCAL_SOURCE_UNAVAILABLE");
  active = false;
  assert.equal((await call(`${root}/README.md`)).details.code, "LOCAL_SOURCE_UNAVAILABLE");
  active = true;
  const path = join(directory, "mutable.txt"); writeFileSync(path, "inert mutable fixture"); linkSync(path, join(directory, "alias.txt"));
  const denied = await call(path);
  assert.equal(denied.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE");
  assert.doesNotMatch(text(denied), /inert mutable fixture/);
});

test("ordinary read denies exact root-owned immutable store hard links before payload access", async t => {
  // Last on purpose: no selected-reader retry follows the ordinary denial.
  // Only the pre-existing, freshly authored inert mechanics fixture is used;
  // this is not access to installed Pi/Herdr documentation or source.
  const path = `${root}/README.md`, before = statSync(path, { bigint: true });
  assert.equal(before.uid, 0n);
  assert.equal(before.mode & 0o222n, 0n);
  assert.ok(before.nlink > 1n);
  const originalRead = fs.readSync;
  let payloadReads = 0;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
    const observed = fs.fstatSync(args[0], { bigint: true });
    if (observed.ino === before.ino && observed.dev === before.dev) {
      payloadReads++;
      throw new Error("inert ordinary store payload probe must not run");
    }
    return originalRead(...args);
  }) as typeof fs.readSync);
  const result = await createSecureLocalReadTool().execute("ordinary-store-negative", { path }, undefined, undefined, { cwd: directory });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE");
  assert.equal(payloadReads, 0);
  assert.doesNotMatch(text(result), /inert immutable readme/);
  const after = statSync(path, { bigint: true });
  for (const key of ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], before[key]);
});
