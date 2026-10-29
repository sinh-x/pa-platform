import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const driver = fileURLToPath(new URL("./verify_template_contracts.mjs", import.meta.url));
for (const args of [[], ["--mode", "SECRET-SENTINEL"], ["--mode", "paired-config", "--output", "/tmp/SECRET-SENTINEL"], ["--mode", "selected-installed", "--binary", "SECRET-SENTINEL"]]) test(`qualification rejects unsupported argument shape ${args.length} without echo`, () => {
  const r = spawnSync(process.execPath, [driver, ...args], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.equal(r.stderr, ""); const result = JSON.parse(r.stdout);
  assert.equal(result.status, "blocked"); assert.equal(result.writes, 0); assert.equal(result.installation, false);
  assert.ok(!r.stdout.includes("SECRET-SENTINEL")); assert.ok(result.diagnostic.length < 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(result.diagnostic.includes(`${label}:`));
});
