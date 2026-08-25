import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function dependencies(packageName: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(root, packageName, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  return manifest.dependencies ?? {};
}

test("runtime adapters depend on pa-core only; runtime-host owns composition", () => {
  assert.equal(dependencies("opencode-pa")["@pa-platform/pi-pa"], undefined);
  assert.equal(dependencies("pi-pa")["@pa-platform/opencode-pa"], undefined);
  assert.equal(dependencies("runtime-host")["@pa-platform/opencode-pa"], "workspace:*");
  assert.equal(dependencies("runtime-host")["@pa-platform/pi-pa"], "workspace:*");
});
