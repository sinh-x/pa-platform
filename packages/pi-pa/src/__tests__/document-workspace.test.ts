import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentWorkspace, runWorkspaceHelper, WORKSPACE_LIMITS } from "../document-workspace.js";
import { createWorkspaceTool, workspaceBlocker } from "../pi-extension/workspace-tool.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "document-workspace-")), root = join(base, "workspace"), repo = join(base, "repo");
  mkdirSync(root); mkdirSync(repo);
  const caller = { deploymentId: "d-abcdef", repoKey: "example", repoRoot: repo, ticket: null, identitySha256: "a".repeat(64) };
  return { base, root, repo, caller, service: new DocumentWorkspace(root, repo, () => caller), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
test("workspace writes/CAS, scripts and explicit repository inputs need neither ticket nor catalogue", async () => {
  const f = fixture();
  try {
    const request = (r: unknown) => f.service.execute(JSON.stringify(r));
    const result = await request({ action: "write", path: "scripts/helper.py", content: "print(1)", expectedSha256: null });
    await assert.rejects(request({ action: "write", path: "scripts/helper.py", content: "changed", expectedSha256: null }), /DOCUMENT_CONFLICT/);
    await request({ action: "write", path: "scripts/helper.py", content: "print(2)", expectedSha256: result.sha256 });
    writeFileSync(join(f.repo, "data.json"), '{"count":2}');
    await request({ action: "import", path: "data.json", destination: "inputs/data.json" });
    assert.equal((await request({ action: "read", path: "inputs/data.json" })).content, '{"count":2}');
    await assert.rejects(request({ action: "import", path: "data.json", destination: "inputs/data.json" }), /DOCUMENT_CONFLICT/);
    assert.deepEqual((await request({ action: "capabilities" })).limits, WORKSPACE_LIMITS);
    await assert.rejects(request({ action: "write", path: "x", content: "x", expectedSha256: null, approved: true }));
    assert.equal(readFileSync(join(f.repo, "data.json"), "utf8"), '{"count":2}');
  } finally { f.cleanup(); }
});
test("workspace traversal, aliases, sensitive input and frozen/foreign paths reject", async () => {
  const f = fixture();
  try {
    symlinkSync(f.repo, join(f.root, "alias"));
    for (const path of ["../repo/changed", "/tmp/changed", ".git/config", "alias/changed", "a/../../changed", "a\\b"]) {
      await assert.rejects(f.service.execute(JSON.stringify({ action: "write", path, content: "changed", expectedSha256: null })));
    }
    await assert.rejects(f.service.execute(JSON.stringify({ action: "import", path: ".git/config", destination: "copied" })));
    assert.equal(existsSync(join(f.repo, "changed")), false);
  } finally { f.cleanup(); }
});
test("actual namespace helper preserves outputs while denying repository/foreign/network effects and clearing environment", async () => {
  const f = fixture();
  try {
    // Python avoids V8's platform-dependent virtual-address reservations.
    writeFileSync(join(f.root, "probe.py"), `import os, socket, subprocess, sys\nfrom pathlib import Path\nassert 'PA_DEPLOYMENT_ID' not in os.environ\nassert not Path(${JSON.stringify(f.repo)}).exists()\nassert not Path(${JSON.stringify(f.base)}).exists()\ntry:\n socket.create_connection(('1.1.1.1', 80), timeout=.1)\n raise AssertionError('network escaped')\nexcept OSError: pass\nPath('output.json').write_text('{"count": 2}')\nsubprocess.run([sys.executable, '-c', 'from pathlib import Path; Path("child.txt").write_text("child")'], check=True)\nprint('confined')\n`);
    const result = await f.service.execute(JSON.stringify({ action: "run", program: "python3", path: "probe.py" }));
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(readFileSync(join(f.root, "child.txt"), "utf8"), "child");
    assert.equal(existsSync(join(f.repo, "output.json")), false);
    assert.ok(existsSync(join(f.base, String(result.evidence))));
  } finally { f.cleanup(); }
});
test("actual helper output overflow/cancellation are bounded and results do not claim passing", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "flood.py"), "print('x' * 100000)\n");
    const flood = await runWorkspaceHelper(f.root, "python3", "flood.py");
    assert.equal(flood.outputLimited, true); assert.ok(Buffer.byteLength(flood.stdout + flood.stderr) <= WORKSPACE_LIMITS.outputBytes);
    writeFileSync(join(f.root, "wait.py"), "import time, subprocess, sys\nsubprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\ntime.sleep(60)\n");
    const controller = new AbortController(); setTimeout(() => controller.abort(), 250);
    const cancelled = await runWorkspaceHelper(f.root, "python3", "wait.py", controller.signal);
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.cleanup, "settled");
    writeFileSync(join(f.root, "bad.py"), "raise RuntimeError('fixture failure')\n");
    const failed = await runWorkspaceHelper(f.root, "python3", "bad.py"); assert.notEqual(failed.exitCode, 0);
  } finally { f.cleanup(); }
});
test("workspace blockers are bounded, static and outer tool inputs cannot grant rights", async () => {
  for (const code of ["DOCUMENT_INPUT", "DOCUMENT_AUTHORITY", "DOCUMENT_UNAVAILABLE", "DOCUMENT_CONFLICT", "DOCUMENT_STALE", "\u001bsecret\nCorrection: bad"]) {
    const message = workspaceBlocker(code); assert.ok(message.length <= 2000);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(message.split(label).length, 2);
    assert.ok(!message.includes("\u001b"));
  }
  let calls = 0; const tool = createWorkspaceTool(async () => { calls++; return {}; });
  assert.equal((await tool.execute("x", { request: "{}", approved: true }, undefined, undefined, {})).isError, true); assert.equal(calls, 0);
});
