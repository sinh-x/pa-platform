import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.env.PA_TEST_SELECTED_PPA_ROOT;
assert.ok(root, "required boundary check must supply its exact built PPA");

test("a packaged store path never substitutes for actual root authority in a build namespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-host-namespace-"));
  try {
    // Nix user namespaces can map host-owned inputs to overflow UID 65534.
    // They must reject, not relax production checks to make a build test pass.
    const ordinary = ["/", "/nix", root].every(path => {
      const stat = statSync(path); return stat.uid === 0 && (stat.mode & 0o022) === 0;
    });
    const store = statSync("/nix/store");
    const trusted = ordinary && store.uid === 0 && ((store.mode & 0o022) === 0 || (store.mode & 0o1000) !== 0 && (store.mode & 0o002) === 0);
    const result = spawnSync(join(root, "bin", ".ppa-selected-pi"), ["--version"], {
      env: { HOME: directory, TMPDIR: directory, PI_OFFLINE: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, trusted ? 0 : 1, result.stderr);
    if (trusted) assert.equal(result.stdout.trim(), "1.4.0");
    else {
      assert.equal(result.stdout, ""); assert.match(result.stderr, /SELECTED_HOST_ENTRY/);
      assert.ok(result.stderr.length <= 2000);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
