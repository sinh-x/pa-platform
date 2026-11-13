import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.env.PA_TEST_PI_QUALIFICATION;
assert.ok(root, "select the immutable qualification artifact in the test driver only");
const entry = join(root, "bin/qualify-selected-pi");
const marker = "pa-selected-pi-qualification/v1";
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "pap298-pre-node-"));
  const env = { HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_CACHE_HOME: join(directory, "cache"), TMPDIR: directory, NO_COLOR: "1", TERM: "dumb" };
  mkdirSync(join(directory, "project"));
  const execute = (extra = {}, args = [], file = entry) => spawnSync(file, args, {
    env: { ...env, ...extra }, cwd: join(directory, "project"), encoding: "utf8", timeout: 45000,
    maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
  });
  try { return run({ directory, execute }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function denied(result) {
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /SELECTED_HOST_ENTRY/);
  assert.ok(result.stderr.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"])
    assert.equal(result.stderr.split(`${label}:`).length, 2);
}

test("fixed static entry reaches only offline help (or explicitly denies an unmapped root namespace)", () => fixture(({ execute }) => {
  const result = execute();
  if (statSync(join(root, "lib/qualify.mjs")).uid !== 0) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SELECTED_HOST_QUALIFICATION/);
    assert.ok(!result.stdout.includes(marker));
    return;
  }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.split("\n").filter(line => line.includes(marker)).length, 1);
  assert.match(result.stdout, /Usage:/i);
}));

test("actual Node --require/--import preloads never execute through the static entry", () => fixture(({ directory, execute }) => {
  const effect = join(directory, "preload-ran");
  const preload = join(directory, "preload.cjs");
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unexpected');\n`);
  for (const option of [`--require=${preload}`, `--import=${preload}`, `--inspect=0`, `--no-warnings`]) {
    denied(execute({ NODE_OPTIONS: option }));
    assert.equal(existsSync(effect), false, "conflicting code must not run before denial");
  }
}));

test("dynamic-loader and deferred startup namespaces deny before selected Node", () => fixture(({ execute }) => {
  for (const key of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG", "DYLD_INSERT_LIBRARIES",
    "NIX_LD", "NIX_LD_LIBRARY_PATH", "GLIBC_TUNABLES", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PI_PACKAGE_DIR", "PA_PI_START_NODE_OPTIONS"])
    denied(execute({ [key]: "/inert/nonexistent-startup-conflict" }));
}));

test("arguments and a mutable copied entry cannot choose another operation or claim entry custody", () => fixture(({ directory, execute }) => {
  denied(execute({}, ["--version"]));
  const copy = join(directory, "copied-entry");
  copyFileSync(entry, copy);
  denied(execute({}, [], copy));
}));
