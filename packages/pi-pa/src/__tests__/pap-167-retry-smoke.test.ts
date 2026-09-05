import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveStoreOutput } from "../../../../scripts/pap-167-pi-retry-smoke.mjs";

test("PAP-167 retry harness resolves the installed output from only the Pi addon environment", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-167-output-resolution-"));
  const output = join(root, "pa-platform-0.1.100");
  const addon = join(output, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  try {
    mkdirSync(join(output, "bin"), { recursive: true });
    mkdirSync(join(addon, ".."), { recursive: true });
    writeFileSync(join(output, "bin", "ppa"), "fixture");
    writeFileSync(addon, "fixture");

    assert.equal(resolveStoreOutput(undefined, { PA_PI_SQLITE_NATIVE_BINDING: addon }), resolve(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PAP-167 retry harness fails clearly when no addon ancestor contains bin/ppa", () => {
  const root = mkdtempSync(join(tmpdir(), "pap-167-invalid-output-"));
  const addon = join(root, "share", "pa-platform", "native-addons", "pi-node-24", "better_sqlite3.node");
  try {
    mkdirSync(join(addon, ".."), { recursive: true });
    writeFileSync(addon, "fixture");

    assert.throws(
      () => resolveStoreOutput(undefined, { PA_PI_SQLITE_NATIVE_BINDING: addon }),
      /no ancestor .* contains bin\/ppa/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
