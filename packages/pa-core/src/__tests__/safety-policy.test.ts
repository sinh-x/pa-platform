import test from "node:test";
import assert from "node:assert/strict";
import { isDestructiveCommand } from "../index.js";

const group7LoggingPipeline = `bash -lc 'set -euo pipefail; mkdir -p "$PA_DEPLOYMENT_DIR/evidence"; env -u PA_PI_SQLITE_NATIVE_BINDING -u PA_REQUIRE_PI_SQLITE_NATIVE_BINDING PAP167_REAL_PI="$(command -v pi)" PAP183_EXPECTED_PI_NODE_VERSION=v24.19.0 PAP176_INSTALLED_EVIDENCE="$PA_DEPLOYMENT_DIR/evidence/pap-183-installed-teardown.json" bash scripts/nix-store-output-smoke.sh 2>&1 | tee "$PA_DEPLOYMENT_DIR/evidence/pap-183-nix-smoke.log"'`;

test("isDestructiveCommand allows descriptor duplication and closure", () => {
  const commands = [
    "printf ok 2>1",
    "printf ok 1>2",
    "printf ok 2>&1",
    "printf ok 1>&2",
    "exec >-",
    "exec 2>&-",
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), false, command);
  }
});

test("isDestructiveCommand allows the approved group-7 logging pipeline", () => {
  assert.equal(isDestructiveCommand(group7LoggingPipeline), false);
});

test("isDestructiveCommand blocks pathname overwrite and truncation redirects", () => {
  const commands = [
    "printf ok > output.log",
    "printf ok >output.log",
    "printf ok 2> errors.log",
    "printf ok 2>errors.log",
    "printf ok >> output.log",
    "printf ok 2>> errors.log",
    "printf ok >| output.log",
    "printf ok >&output.log",
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), true, command);
  }
});

test("isDestructiveCommand keeps unrelated destructive command classes blocked", () => {
  const commands = [
    "rm output.log",
    "rmdir output",
    "unlink output.log",
    "shred output.log",
    "dd if=input of=output",
    "truncate -s 0 output.log",
    "find . -print0 | xargs -0 rm",
    "git clean -fd",
    "git push origin main --force",
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), true, command);
  }
});
