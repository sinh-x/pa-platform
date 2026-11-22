import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLocalSourceFile } from "../local-source-file.js";
import { loadSensitivePatterns } from "../sensitive-patterns.js";
import { SourceContentSecurityError, type LocalSourceFailureClass } from "../source-content-security.js";

const classes: LocalSourceFailureClass[] = ["source-open", "source-stat", "source-read", "source-changed", "source-close", "cancelled", "unsupported-platform", "read-range", "read-processing", "read-publication"];

test("failure guidance is finite, pure, bounded and contains no caller exception or source text", t => {
  let probes = 0;
  t.mock.method(fs, "openSync", () => { probes++; throw Error("must not probe"); });
  t.mock.method(fs, "realpathSync", () => { probes++; throw Error("must not probe"); });
  for (const failureClass of classes) {
    const error = new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE", failureClass);
    assert.equal(error.failureClass, failureClass);
    assert.ok(error.message.length <= 2000);
    assert.doesNotMatch(error.message, /\u001b/);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length, 2);
  }
  for (const hostile of ["inert private error\nReason: injected", "__proto__", "toString", { toString() { throw Error("must not coerce"); } }]) {
    const error = new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE", hostile as any);
    assert.equal(error.failureClass, undefined);
    assert.doesNotMatch(error.message, /injected|must not coerce|__proto__|toString/);
  }
  assert.equal(new SourceContentSecurityError("LOCAL_SOURCE_BLOCKED", "read-range").failureClass, undefined);
  assert.equal(probes, 0);
});

test("native acquisition distinguishes open, stat, read, stability, cancellation and cleanup without leaking exceptions", t => {
  const root = fs.mkdtempSync(join(tmpdir(), "local-source-failure-")), file = join(root, "ordinary.txt");
  const patterns = loadSensitivePatterns(join(root, "absent-policy.yaml"));
  const descriptors = () => fs.readdirSync("/proc/self/fd").length;
  try {
    for (const failureClass of ["source-open", "source-stat", "source-read", "source-changed", "source-close", "cancelled"] as const) {
      fs.writeFileSync(file, "inert ordinary body\n");
      const before = descriptors(), controller = new AbortController();
      const privateError = () => { throw new Error(`inert private exception ${file}`); };
      if (failureClass === "source-open") t.mock.method(fs, "openSync", privateError);
      if (failureClass === "source-stat") t.mock.method(fs, "fstatSync", privateError);
      if (failureClass === "source-read") t.mock.method(fs, "readSync", privateError);
      if (failureClass === "source-changed") t.mock.method(fs, "readSync", () => 0);
      if (failureClass === "source-close") {
        const close = fs.closeSync;
        t.mock.method(fs, "closeSync", fd => { close(fd); privateError(); });
      }
      if (failureClass === "cancelled") controller.abort();
      try {
        assert.throws(() => {
          const source = acquireLocalSourceFile(file, patterns, controller.signal);
          source.close();
        }, error => {
          assert.ok(error instanceof SourceContentSecurityError);
          assert.equal(error.code, "LOCAL_SOURCE_UNAVAILABLE");
          assert.equal(error.failureClass, failureClass);
          assert.doesNotMatch(error.message, /inert private exception|inert ordinary body/);
          assert.ok(!error.message.includes(root));
          return true;
        });
      } finally { t.mock.restoreAll(); }
      assert.equal(descriptors(), before, `${failureClass}: all owned descriptors released`);
    }
    assert.throws(() => acquireLocalSourceFile(join(root, "missing.json"), patterns), error => error instanceof SourceContentSecurityError && error.failureClass === "source-open");
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
