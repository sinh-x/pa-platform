import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentWorkspace } from "../document-workspace.js";

// Portable native state boundary: no namespace executable is dispatched here.
test("retained unsettled helper blocks writers but preserves safe reads and capability inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-state-"));
  try {
    const workspace = join(root, "workspace"), repo = join(root, "repo"); mkdirSync(workspace); mkdirSync(repo);
    writeFileSync(join(workspace, "saved.txt"), "retained work"); writeFileSync(join(root, "active-helper.json"), '{"operationId":"helper-retained"}');
    const service = new DocumentWorkspace(workspace, repo, () => ({ deploymentId: "d-abcdef", repoKey: "example", repoRoot: repo, ticket: null, identitySha256: "a".repeat(64) }));
    assert.equal((await service.execute('{"action":"read","path":"saved.txt"}')).content, "retained work");
    assert.ok((await service.execute('{"action":"capabilities"}')).limits);
    for (const request of [{ action: "write", path: "changed", content: "x", expectedSha256: null }, { action: "run", path: "saved.txt", program: "python3" }, { action: "import", path: "README.md", destination: "imported" }]) await assert.rejects(service.execute(JSON.stringify(request)), /DOCUMENT_UNCERTAIN/);
    assert.equal(existsSync(join(workspace, "changed")), false); assert.equal(existsSync(join(root, "active-helper.json")), true);
    await assert.rejects(service.execute('{"action":"capabilities","action":"run"}'));
    await assert.rejects(service.execute(JSON.stringify({ action: "write", path: "large", content: "x".repeat(65536), expectedSha256: null })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
