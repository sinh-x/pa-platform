import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLocalSourceFile } from "../local-source-file.js";
import { MAX_LOCAL_SECURITY_BYTES, SourceContentSecurityError } from "../source-content-security.js";
import { loadSensitivePatterns } from "../sensitive-patterns.js";

const patterns = () => loadSensitivePatterns(join(tmpdir(), "absent-local-source-file-policy.yaml"));
function fixture(run: (root: string, path: string) => void) {
  const root = fs.mkdtempSync(join(tmpdir(), "local-source-file-")), path = join(root, "ordinary.txt");
  try { fs.writeFileSync(path, "ordinary inert λ text\n"); run(root, path); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const code = (expected: string) => (error: unknown) => error instanceof SourceContentSecurityError && error.code === expected;

test("source acquisition preserves ordinary aliases, exact UTF-8 bytes and bounded edge sizes", () => fixture((root, path) => {
  const alias = join(root, "alias.txt"); fs.symlinkSync(path, alias);
  for (const input of [path, alias]) {
    const file = acquireLocalSourceFile(input, patterns());
    try { assert.equal(file.bytes.toString(), "ordinary inert λ text\n"); file.assertStable(); }
    finally { file.close(); }
    file.close();
    assert.throws(() => file.assertStable(), code("LOCAL_SOURCE_UNAVAILABLE"));
  }
  for (const size of [0, MAX_LOCAL_SECURITY_BYTES]) {
    fs.writeFileSync(path, Buffer.alloc(size, 120));
    const file = acquireLocalSourceFile(path, patterns());
    try { assert.equal(file.bytes.length, size); file.assertStable(); } finally { file.close(); }
  }
  fs.truncateSync(path, MAX_LOCAL_SECURITY_BYTES + 1);
  assert.throws(() => acquireLocalSourceFile(path, patterns()), code("LOCAL_CONTENT_LIMIT"));
}));

test("unsupported links/nonregular files are typed and rejected before any data read", t => fixture((root, path) => {
  fs.linkSync(path, join(root, "second.txt"));
  let reads = 0;
  const original = fs.readSync;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => { reads++; return original(...args); }) as typeof fs.readSync);
  for (const input of [path, root]) assert.throws(() => acquireLocalSourceFile(input, patterns()), code("LOCAL_SOURCE_UNSUPPORTED_FILE"));
  assert.equal(reads, 0);
  assert.throws(() => acquireLocalSourceFile(join(root, "missing.txt"), patterns()), code("LOCAL_SOURCE_UNAVAILABLE"));
  assert.throws(() => acquireLocalSourceFile(join(root, ".env"), patterns()), code("LOCAL_SOURCE_BLOCKED"));
}));

test("source snapshots reject replacements, changed links/mode, logical aliases and ancestor changes", () => {
  for (const change of ["replace", "link", "mode", "alias", "ancestor"] as const) fixture((root, path) => {
    const directory = join(root, "docs"); fs.mkdirSync(directory);
    const nested = join(directory, "note.txt"); fs.writeFileSync(nested, "ordinary nested text");
    const alias = join(root, "alias.txt"); fs.symlinkSync(nested, alias);
    const file = acquireLocalSourceFile(change === "alias" ? alias : nested, patterns());
    try {
      if (change === "replace") { fs.renameSync(nested, join(directory, "old.txt")); fs.writeFileSync(nested, "replacement"); }
      if (change === "link") fs.linkSync(nested, join(root, "second.txt"));
      if (change === "mode") fs.chmodSync(nested, 0o600);
      if (change === "alias") { fs.unlinkSync(alias); fs.symlinkSync(path, alias); }
      if (change === "ancestor") { fs.renameSync(directory, join(root, "old-docs")); fs.symlinkSync(join(root, "old-docs"), directory); }
      assert.throws(() => file.assertStable(), code("LOCAL_SOURCE_UNAVAILABLE"));
    } finally { file.close(); }
  });
});

test("growth and mutation during ingress never return partial success; all owned descriptors close", t => fixture((root, path) => {
  const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRead = fs.readSync;
  const owned = new Set<number>();
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => { const fd = originalOpen(...args); owned.add(fd); return fd; }) as typeof fs.openSync);
  t.mock.method(fs, "closeSync", (fd: number) => { owned.delete(fd); return originalClose(fd); });
  let mutated = false;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
    const length = originalRead(...args);
    if (!mutated) { mutated = true; fs.appendFileSync(path, "growth"); }
    return length;
  }) as typeof fs.readSync);
  assert.throws(() => acquireLocalSourceFile(path, patterns()), code("LOCAL_SOURCE_UNAVAILABLE"));
  assert.equal(owned.size, 0, "directory and file descriptors close on changed ingress");
}));

test("abort before ingress or during a synchronous test seam withholds bytes and closes descriptors", t => fixture((_root, path) => {
  const early = new AbortController(); early.abort();
  assert.throws(() => acquireLocalSourceFile(path, patterns(), early.signal), code("LOCAL_SOURCE_UNAVAILABLE"));
  const controller = new AbortController(), originalRead = fs.readSync;
  t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => { controller.abort(); return originalRead(...args); }) as typeof fs.readSync);
  const count = () => fs.readdirSync("/proc/self/fd").length;
  const before = count();
  assert.throws(() => acquireLocalSourceFile(path, patterns(), controller.signal), code("LOCAL_SOURCE_UNAVAILABLE"));
  assert.equal(count(), before);
}));

test("descriptor identity/owner/link/time changes fail before content reads", t => {
  for (const field of ["dev", "ino", "size", "uid", "gid", "mode", "nlink", "mtimeNs", "ctimeNs"] as const) fixture((_root, path) => {
    const target = fs.statSync(path, { bigint: true }), originalStat = fs.fstatSync;
    let observations = 0, reads = 0;
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = originalStat(...args) as fs.BigIntStats;
      if (stat.ino === target.ino && stat.dev === target.dev && ++observations > 1) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: stat[field] + 1n });
      }
      return stat;
    }) as typeof fs.fstatSync);
    t.mock.method(fs, "readSync", () => { reads++; throw new Error("content must not be read"); });
    try {
      assert.throws(() => acquireLocalSourceFile(path, patterns()), code("LOCAL_SOURCE_UNAVAILABLE"));
      assert.equal(reads, 0, field);
    } finally { t.mock.restoreAll(); }
  });
});

test("failed directory metadata observation closes even the just-opened descriptor", t => fixture((_root, path) => {
  const before = fs.readdirSync("/proc/self/fd").length;
  t.mock.method(fs, "fstatSync", () => { throw new Error("inert private observation failure"); });
  assert.throws(() => acquireLocalSourceFile(path, patterns()), error => code("LOCAL_SOURCE_UNAVAILABLE")(error) && !(error as Error).message.includes("private observation"));
  assert.equal(fs.readdirSync("/proc/self/fd").length, before);
}));
