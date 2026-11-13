import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Test-driver inputs only, not production startup/root overrides. The harness
// independently binds its literal Nix build record and initial native process.
const root = process.env.PA_TEST_PI_QUALIFICATION;
const node = process.env.PA_TEST_PI_NODE;
const wrongNode = process.env.PA_TEST_PI_WRONG_NODE;
assert.ok(root && node && wrongNode, "run through checks.selected-pi-host-qualification with fixed Nix inputs");
const modulePath = join(root, "lib/qualify.mjs");
const marker = "pa-selected-pi-qualification/v1";
function execute(args = [modulePath], extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-qualification-"));
  mkdirSync(join(directory, "project"));
  // No inherited provider credentials, deployment, project config or user HOME.
  const env = { HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_CACHE_HOME: join(directory, "cache"), TMPDIR: directory, NO_COLOR: "1", TERM: "dumb", ...extra };
  try { return spawnSync(node, args, { cwd: join(directory, "project"), env, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function expectDenied(result) {
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.ok(!result.stdout.includes(marker), "denied startup must not reach native factory");
  assert.match(result.stderr, /SELECTED_HOST_QUALIFICATION/);
  assert.ok(result.stderr.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(result.stderr.split(`${label}:`).length, 2);
}

const visibleRootOwner = statSync(modulePath).uid === 0;
test(visibleRootOwner ? "actual pinned Pi main invokes native inline factory under the fixed offline operation" : "unmapped store ownership in the build namespace denies qualification", () => {
  const result = execute();
  if (!visibleRootOwner) { expectDenied(result); return; }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const events = result.stdout.split("\n").filter(line => line.includes(marker)).map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { schema: marker, stage: "native-inline-factory", pi: "1.4.0", node: "24.21.0", closureCustody: true, readExceptionEnabled: false });
  assert.match(result.stdout, /Usage:/i, "the selected host executes help, not a mocked callback");
});
test("runtime args cannot select a document, host, root or agent operation", () => { expectDenied(execute([modulePath, "--version"])); });
test("inherited package-root and Node preload conflicts deny before host import", () => {
  expectDenied(execute([modulePath], { PI_PACKAGE_DIR: "/tmp/forged-pi-root" }));
  expectDenied(execute([modulePath], { NODE_OPTIONS: "--no-warnings" }));
});
test("arbitrary eval/import cannot activate a producer by calling its export", () => {
  const code = `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then(m => m.runQualification()).catch(e => {process.stderr.write(e.message+'\\n');process.exitCode=1;})`;
  expectDenied(execute(["--input-type=module", "--eval", code]));
});
test("copied mutable bootstrap/record cannot assert the fixed installed identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "selected-pi-copy-negative-"));
  try {
    copyFileSync(modulePath, join(directory, "qualify.mjs"));
    copyFileSync(join(root, "lib/selection.mjs"), join(directory, "selection.mjs"));
    expectDenied(execute([join(directory, "qualify.mjs")]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("a different native Node host cannot reuse the literal producer", () => {
  const result = spawnSync(wrongNode, [modulePath], { env: { NO_COLOR: "1" }, encoding: "utf8", timeout: 10000 });
  expectDenied(result);
});
