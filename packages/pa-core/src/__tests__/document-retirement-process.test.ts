import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { documentPending, documentRetiredSubjects } from "../registry/documents.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function worker(root: string, request: unknown, crash = "none"): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", fileURLToPath(new URL("./document-retirement-worker.ts", import.meta.url)), root, JSON.stringify(request), crash], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.once("error", reject);
    child.once("close", code => { if (stderr || code !== 0 && code !== 91) reject(Error(`${code}: ${stderr}`)); else resolve({ code, result: stdout ? JSON.parse(stdout) : null }); });
  });
}
async function fixture() {
  const f = documentRuntimeFixture(), decisionId = await f.prepare();
  f.host.recoveryProfile = true;
  const auth = f.host.authenticate; f.host.authenticate = () => ({ ...auth(), sessionId: "process-source-test" });
  f.store.update("EX-1", { status: "idea" }, "test");
  await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() });
  const operationId = documentPending(f.journal.events("example", "EX-1"))[0]!.operationId;
  const original = { action: "publication-diagnose", sha256: f.sha256, decisionId, operationId, expectedRevision: f.revision() };
  const diagnosis = (await f.call(original)).result as any;
  return { f, request: { ...original, action: "publication-retire", requestId: "process-retirement", originalRequestSha256: diagnosis.originalRequestSha256, observationSha256: diagnosis.observationSha256 } };
}
for (const crash of ["before-consent", "after-consent", "after-settlement"]) test(`actual process exit ${crash} preserves issuance/settlement boundary and exact replay`, async () => {
  const { f, request } = await fixture(); try {
    const original = f.journal.events("example", "EX-1"), audit = f.store.readAudit();
    assert.equal((await worker(f.root, request, crash)).code, 91);
    assert.equal(documentPending(f.journal.events("example", "EX-1")).length, crash === "after-settlement" ? 0 : 1);
    const recovered = await worker(f.root, request); assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.result.result.outcome, "retired");
    assert.equal(readFileSync(join(f.root, "prompts.txt"), "utf8").trim().split("\n").length, crash === "before-consent" ? 2 : 1);
    assert.deepEqual(f.journal.events("example", "EX-1").slice(0, original.length), original);
    assert.equal(documentRetiredSubjects(f.journal.events("example", "EX-1")).size, 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retired").length, 1);
    assert.deepEqual(f.store.readAudit(), audit); assert.deepEqual(f.store.get("EX-1")!.doc_refs, []);
  } finally { f.close(); }
});
test("competing real retirement processes produce one terminal append, no publication or ticket writes", async () => {
  const { f, request } = await fixture(); try {
    const audit = f.store.readAudit();
    const results = await Promise.all(Array.from({ length: 4 }, () => worker(f.root, request)));
    assert.ok(results.some(r => r.result.ok));
    assert.ok(results.every(r => r.result.ok || r.result.code === "DOCUMENT_CONFLICT"));
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retirement-consent").length, 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retired").length, 1);
    assert.deepEqual(f.store.readAudit(), audit);
  } finally { f.close(); }
});
