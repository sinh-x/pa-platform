import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const SMOKE_SCRIPT = resolve(REPOSITORY_ROOT, "scripts/nix-store-output-smoke.sh");

function runCaptureFixture(fixture) {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "pap-183-smoke-capture-"));
  const logPath = resolve(temporaryRoot, "evidence", "nix-smoke.log");
  const result = spawnSync(
    "bash",
    [SMOKE_SCRIPT, "--log-file", logPath],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PAP183_SMOKE_CAPTURE_FIXTURE: fixture,
        PAP183_SMOKE_TEST_FIXTURES: "1",
        PA_DEPLOYMENT_DIR: temporaryRoot,
      },
    },
  );
  return { temporaryRoot, logPath, result };
}

test("self-capture combines stdout and stderr in the selected durable log", () => {
  const { temporaryRoot, logPath, result } = runCaptureFixture("success");
  try {
    const expected = "capture-fixture stdout status=success\ncapture-fixture stderr status=success\n";
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(logPath, "utf8"), expected);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("self-capture retains the smoke failure status and its combined log", () => {
  const { temporaryRoot, logPath, result } = runCaptureFixture("failure");
  try {
    const expected = "capture-fixture stdout status=failure\ncapture-fixture stderr status=failure\n";
    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(logPath, "utf8"), expected);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("self-capture rejects log paths outside deployment evidence", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "pap-183-smoke-capture-"));
  const logPath = resolve(temporaryRoot, "outside.log");
  try {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--log-file", logPath], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PAP183_SMOKE_CAPTURE_FIXTURE: "success",
        PAP183_SMOKE_TEST_FIXTURES: "1",
        PA_DEPLOYMENT_DIR: temporaryRoot,
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be inside PA_DEPLOYMENT_DIR\/evidence/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
