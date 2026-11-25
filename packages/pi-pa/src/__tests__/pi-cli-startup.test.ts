import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createPiReadonlyHelperCapability as legacyCapability, piReviewCheckoutCorrelation as legacyCorrelation } from "../deploy.js";
import { createPiReadonlyHelperCapability, piReviewCheckoutCorrelation } from "../readonly-helper.js";

function layout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pap337-cli-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "dist"), core = join(root, "node_modules/@pa-platform/pa-core");
  mkdirSync(dist); mkdirSync(core, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-fixture" }));
  copyFileSync(fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), join(dist, "cli.js"));
  // Routing-only stubs: these never stand in for native qualification. The real
  // built CLI/role/negative matrix remains in readonly-helper-contract.test.ts.
  writeFileSync(join(core, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  writeFileSync(join(core, "index.js"), `export async function runCoreCommand(argv, options) {
    const guard = options.hooks?.readOnlyHelperContext;
    console.log(JSON.stringify({argv, binary:options.binaryName, hooks:Object.keys(options.hooks ?? {}), guarded:guard ? guard.authenticate() === 'fixture-only' : false}));
    return 0;
  }
  export function templateFailure() { throw Error('unexpected fixture template failure'); }
  `);
  writeFileSync(join(dist, "readonly-helper.js"), "export function createPiReadonlyHelperCapability(){return {authenticate:()=> 'fixture-only'}}\n");
  writeFileSync(join(dist, "workflow-host.js"), "export function piRetainedTemplateHost(){return undefined}\n");
  for (const name of ["deploy", "adapter", "native-host", "auto-foreground", "document-cli", "session-cli", "setup"]) {
    writeFileSync(join(dist, `${name}.js`), "throw Error('unused-handler-fixture-sentinel');\n");
  }
  return (argv: string[]) => spawnSync(process.execPath, [join(dist, "cli.js"), ...argv], {
    cwd: root, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 15000, maxBuffer: 65536,
  });
}

test("built version dispatch does not load unrelated handlers or require their dependencies", t => {
  const run = layout(t);
  for (const argv of [["--version"], ["-V"], ["branch", "validate", "--version"]]) {
    const result = run(argv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ppa 0.0.0-fixture\n");
    assert.equal(result.stderr, "");
  }
});

test("template resource --version retains precedence over global version dispatch", t => {
  const argv = ["template", "show", "fixture", "--version", "r001", "--format", "json"], result = layout(t)(argv);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv, binary: "ppa", hooks: [], guarded: false });
  assert.equal(result.stderr, "");
});

test("read-only helper routes retain their capability while leaving unrelated handlers unloaded", t => {
  const run = layout(t);
  for (const argv of [["board"], ["branch", "validate"], ["repository", "inspect"]]) {
    const result = run(argv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv, binary: "ppa", hooks: ["readOnlyHelperContext"], guarded: true });
    assert.equal(result.stderr, "");
  }
});

test("mutation routes cannot enter the read-only helper fast path", t => {
  const run = layout(t);
  for (const argv of [["branch", "create", "EX-1", "--topic", "fixture"], ["repository", "quarantine"], ["deploy", "builder"]]) {
    const result = run(argv);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unused-handler-fixture-sentinel/);
  }
});

test("deployment exports retain the identical read-only guard and correlation implementations", () => {
  assert.equal(legacyCapability, createPiReadonlyHelperCapability);
  assert.equal(legacyCorrelation, piReviewCheckoutCorrelation);
});
