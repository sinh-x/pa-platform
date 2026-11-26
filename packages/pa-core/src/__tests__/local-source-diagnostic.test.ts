import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { acquireLocalSourceFile, acquireSelectedPiDocument } from "../local-source-file.js";
import { assertLocalFileSource, SourceContentSecurityError } from "../source-content-security.js";
import { loadSensitivePatterns, type SensitivePatternSet } from "../sensitive-patterns.js";
import { MAX_DIAGNOSTIC_FILE_CHARS, renderUnsupportedLocalSource, type LocalSourceUnsupportedCause } from "../local-source-diagnostic.js";

const patterns = (): SensitivePatternSet => loadSensitivePatterns(join(tmpdir(), "absent-local-diagnostic-policy.yaml"));
function rejection(action: () => unknown, cause: LocalSourceUnsupportedCause): SourceContentSecurityError {
  let caught: unknown; try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof SourceContentSecurityError);
  assert.equal(caught.code, "LOCAL_SOURCE_UNSUPPORTED_FILE"); assert.equal(caught.unsupportedObservation?.cause, cause);
  assert.equal(caught.failureClass, undefined, "do not add a native machine failureClass for this code");
  assert.deepEqual(Object.keys(caught).sort(), ["code", "failureClass"]);
  assert.ok(caught.message.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(caught.message.split(`${label}:`).length, 2);
  return caught;
}

test("ordinary real hard links report original link count, admitted requested file, no payload read and unchanged descriptors", t => {
  const root = fs.mkdtempSync(join(tmpdir(), "source-diagnostic-")), file = join(root, "source.md"), alias = join(root, "requested-alias.md");
  try {
    fs.writeFileSync(file, "PRIVATE_FIXTURE_BODY"); fs.linkSync(file, join(root, "second.md")); fs.symlinkSync(file, alias);
    const policy = patterns(), before = fs.readdirSync("/proc/self/fd").length; let reads = 0;
    t.mock.method(fs, "readSync", () => { reads++; throw Error("payload must not be read"); });
    for (const requested of [file, alias]) {
      const error = rejection(() => acquireLocalSourceFile(requested, policy), "ordinary-multiple-links");
      assert.ok(error.message.includes(JSON.stringify(requested)));
      assert.match(error.message, /regular file has 2 hard links/); assert.match(error.message, /No selected-Pi document binding was supplied/);
      assert.match(error.message, /immutable exception checks were not evaluated/);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE_BODY/);
      if (requested === alias) assert.ok(!error.message.includes(JSON.stringify(file)), "do not disclose resolved target");
    }
    assert.equal(reads, 0); assert.equal(fs.readdirSync("/proc/self/fd").length, before);
    const directory = rejection(() => acquireLocalSourceFile(root, policy), "not-regular");
    assert.match(directory.message, /not a regular file/); assert.ok(directory.message.includes(JSON.stringify(root)));
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("private, oversized and control-bearing file references are withheld or escaped without weakening admission", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "source-diagnostic-private-"));
  try {
    const policy = patterns(); policy.patterns.push({ inputClass: "content", source: "local-config", regex: /INERT_PRIVATE_PATH/ });
    const filenames = ["INERT_PRIVATE_PATH.md", "name\nReason: fake\u001b[31m\u202e.md"];
    for (const name of filenames) {
      const file = join(root, name); fs.writeFileSync(file, "fixture"); fs.linkSync(file, join(root, `${name}.second`));
      const error = rejection(() => acquireLocalSourceFile(file, policy), "ordinary-multiple-links");
      if (name.startsWith("INERT")) { assert.match(error.message, /File path withheld/); assert.ok(!error.message.includes(root)); assert.doesNotMatch(error.message, /INERT_PRIVATE_PATH/); }
      else { assert.match(error.message, /\\nReason\\u003a/); assert.doesNotMatch(error.message, /[\u001b\u202e]/); }
    }
    const longDir = join(root, ...Array(3).fill("long".repeat(45))); fs.mkdirSync(longDir, { recursive: true });
    const long = join(longDir, "note.md"); fs.writeFileSync(long, "fixture"); fs.linkSync(long, join(longDir, "second.md"));
    const error = rejection(() => acquireLocalSourceFile(long, policy), "ordinary-multiple-links");
    assert.match(error.message, /File path withheld/); assert.ok(!error.message.includes(longDir));
    const blocked = join(root, ".env");
    assert.throws(() => acquireLocalSourceFile(blocked, policy), error => error instanceof SourceContentSecurityError && error.code === "LOCAL_SOURCE_BLOCKED" && !error.message.includes(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const packageRoot = "/nix/store/00000000000000000000000000000000-inert-pi";
const selectedPath = `${packageRoot}/docs/note.md`;
/** Inert virtual descriptor fixture; exercises the actual acquisition/check code
 * without writing to Nix, reading credentials, or granting a real host binding. */
function virtualSource(t: TestContext, overrides: { path?: string; metadata?: Record<string, Partial<fs.BigIntStats>>; body?: Buffer } = {}) {
  const policy = patterns(), body = overrides.body ?? Buffer.from("ordinary fixture\n"), handles = new Map<number, string>();
  let next = 100, reads = 0, opens = 0;
  const requested = overrides.path ?? selectedPath;
  function physical(path: string): string {
    const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(path);
    if (match) { const parent = handles.get(Number(match[1])); assert.ok(parent); return match[2] ? parent.replace(/\/$/, "") + match[2] : parent; }
    return path === requested ? selectedPath : path;
  }
  const metadata = (path: string) => {
    const isFile = path === selectedPath;
    return { dev: 1n, ino: BigInt(path.length), size: BigInt(isFile ? body.length : 0), uid: 0n, gid: 0n, mode: isFile ? 0o100444n : 0o40555n,
      nlink: isFile ? 2n : 1n, mtimeNs: 1n, ctimeNs: 1n, isFile: () => isFile, isDirectory: () => !isFile,
      ...overrides.metadata?.[path] } as fs.BigIntStats;
  };
  t.mock.method(fs, "realpathSync", path => physical(String(path)));
  t.mock.method(fs, "openSync", path => { const fd = next++; opens++; handles.set(fd, physical(String(path))); return fd; });
  t.mock.method(fs, "fstatSync", fd => { const path = handles.get(fd); assert.ok(path); return metadata(path); });
  t.mock.method(fs, "lstatSync", path => metadata(physical(String(path))));
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => { assert.equal(handles.get(fd), selectedPath); reads++; return body.copy(buffer as Buffer, offset as number, position as number, (position as number) + (length as number)); });
  t.mock.method(fs, "closeSync", fd => { assert.ok(handles.delete(fd)); });
  const binding = { packageRoot, assertStable() {} };
  return { policy, requested, handles, binding, reads: () => reads, opens: () => opens, acquire: () => acquireSelectedPiDocument(requested, binding, policy) };
}

test("selected-document native metadata branches retain exact original predicate and cleanup", t => {
  const cases: Array<[LocalSourceUnsupportedCause, Record<string, Partial<fs.BigIntStats>>, string]> = [
    ["immutable-owner", { [selectedPath]: { uid: 1n } }, "source file"],
    ["immutable-owner", { "/nix": { uid: 1n } }, "ancestor directory"],
    ["immutable-unlinked", { "/nix": { nlink: 0n } }, "ancestor directory"],
    ["store-directory-mode", { "/nix/store": { mode: 0o40775n } }, "ancestor directory"],
    ["store-entry-writable", { [selectedPath]: { mode: 0o100644n } }, "source file"],
    ["ancestor-writable", { "/nix": { mode: 0o40775n } }, "ancestor directory"],
  ];
  for (const [cause, metadata, entry] of cases) {
    const f = virtualSource(t, { metadata });
    try {
      const error = rejection(f.acquire, cause); assert.ok(error.message.includes(selectedPath)); assert.ok(error.message.includes(entry));
      assert.equal(f.reads(), 0); assert.equal(f.handles.size, 0);
    } finally { t.mock.restoreAll(); }
  }
});
test("selected aliases and complete-text classifications are not described as missing bindings or OS failures", t => {
  const alias = virtualSource(t, { path: `${packageRoot}/docs/alias.md` });
  try { const error = rejection(alias.acquire, "selected-alias"); assert.ok(error.message.includes(alias.requested)); assert.match(error.message, /differs from its resolved path/); assert.equal(alias.reads(), 0); assert.equal(alias.handles.size, 0); }
  finally { t.mock.restoreAll(); }
  for (const [cause, body] of [["text-image", Buffer.from("GIF89aIMAGE_FIXTURE")], ["text-utf8", Buffer.from([0xff])], ["text-controls", Buffer.from("PRIVATE\0FIXTURE")]] as const) {
    const f = virtualSource(t, { body });
    try { const error = rejection(f.acquire, cause); assert.match(error.message, /File-content reading started/); assert.ok(error.message.includes(selectedPath)); assert.doesNotMatch(error.message, /IMAGE_FIXTURE|PRIVATE/); assert.equal(f.reads(), 2); assert.equal(f.handles.size, 0); }
    finally { t.mock.restoreAll(); }
  }
  const f = virtualSource(t, { metadata: { "/nix/store": { mode: 0o41775n } } });
  try { const source = f.acquire(); assert.equal(source.bytes.toString(), "ordinary fixture\n"); source.assertStable(); source.close(); assert.equal(f.handles.size, 0); }
  finally { t.mock.restoreAll(); }
});

test("selected scope rejection precedes file acquisition and withholds an unadmitted path", t => {
  for (const cause of ["selected-root", "selected-scope"] as const) {
    const f = virtualSource(t, { path: `${packageRoot}/package.json` });
    if (cause === "selected-root") f.binding.packageRoot = "/tmp/unqualified";
    try {
      const error = rejection(f.acquire, cause);
      assert.match(error.message, /File path withheld/); assert.ok(!error.message.includes(packageRoot));
      assert.match(error.message, /before reading file content/); assert.equal(f.opens(), 0); assert.equal(f.reads(), 0);
    } finally { t.mock.restoreAll(); }
  }
});

test("a later selected-scope failure does not claim content reading never started", t => {
  const f = virtualSource(t);
  try {
    const source = f.acquire();
    try {
      f.binding.packageRoot += "-changed";
      const error = rejection(() => source.assertStable(), "selected-scope");
      assert.match(error.message, /File-content reading started/); assert.doesNotMatch(error.message, /before reading file content/);
      assert.match(error.message, /File path withheld/, "failed scope recheck cannot reuse stale disclosure evidence");
      assert.equal(f.reads(), 2, "formatting and a failed scope recheck do not reread payload");
    } finally { source.close(); }
    assert.equal(f.handles.size, 0);
  } finally { t.mock.restoreAll(); }
});

test("formatting only accepts admitted opaque file references and finite observations, with zero IO", t => {
  const policy = patterns(), reference = assertLocalFileSource("/x".repeat((MAX_DIAGNOSTIC_FILE_CHARS - 2) / 2), policy);
  assert.ok(reference);
  let probes = 0;
  for (const method of ["openSync", "realpathSync", "statSync", "readFileSync", "writeFileSync"] as const) t.mock.method(fs, method, () => { probes++; throw Error("formatter must not probe"); });
  try {
    for (const cause of ["not-regular", "ordinary-multiple-links", "selected-alias", "immutable-owner", "immutable-unlinked", "store-directory-mode", "store-entry-writable", "ancestor-writable", "selected-root", "selected-scope", "text-image", "text-utf8", "text-controls"] as const) {
      const text = renderUnsupportedLocalSource({ cause, reference, links: 0xffffffffffffffffn, entry: "ancestor" });
      assert.ok(text.length <= 2000, `${cause}: ${text.length}`); assert.ok(!text.includes("..."));
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
    }
    for (const input of [undefined, "PRIVATE_CONTEXT", { cause: "__proto__", path: "PRIVATE_CONTEXT" }, { cause: "not-regular", reference: { path: "PRIVATE_CONTEXT" } },
      { get cause() { throw Error("getter"); } }, new Proxy({}, { getOwnPropertyDescriptor() { throw Error("proxy"); } })]) {
      const text = renderUnsupportedLocalSource(input as any); assert.match(text, /File path withheld/); assert.doesNotMatch(text, /PRIVATE_CONTEXT|getter|proxy/); assert.ok(text.length <= 2000);
    }
    assert.equal(probes, 0);
  } finally { t.mock.restoreAll(); }
});
