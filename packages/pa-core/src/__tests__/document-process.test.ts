import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { documentDestination } from "../documents/package-contract.js";
import { documentPending } from "../registry/documents.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function worker(root: string, sha256: string, decisionId: string, revision: number, action = "publish", crashAt = "0"): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", fileURLToPath(new URL("./document-process-worker.ts", import.meta.url)), root, sha256, decisionId, String(revision), action, crashAt], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk); child.once("error", reject);
    child.once("close", code => { if (stderr || (code !== 0 && code !== 91)) return reject(Error(`${code}: ${stderr}`)); resolve({ code, result: stdout ? JSON.parse(stdout) : null }); });
  });
}
test("real competing publication processes have one CAS winner and one complete member/ref set", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), revision = f.revision();
    const results = await Promise.all(Array.from({ length: 4 }, () => worker(f.root, f.sha256, decisionId, revision)));
    assert.equal(results.filter(r => r.result.ok === true).length, 1);
    assert.equal(results.filter(r => r.result.code === "DOCUMENT_CONFLICT").length, 3);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 5);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "intent").length, 1);
  } finally { f.close(); }
});
for (const boundary of [1, 3, 6]) test(`process death after publication ticket boundary ${boundary} reconciles without duplicate files or refs`, async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare();
    const crashed = await worker(f.root, f.sha256, decisionId, f.revision(), "publish", String(boundary)); assert.equal(crashed.code, 91);
    const events = f.journal.events("example", "EX-1"); assert.equal(documentPending(events).length, 1);
    const inodes = f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino);
    const result = await worker(f.root, f.sha256, decisionId, f.revision()); assert.equal(result.result.ok, true);
    assert.deepEqual(f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino), inodes);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 5); assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.primary).length, 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "intent").length, 1);
    assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 0);
  } finally { f.close(); }
});
test("lost queue reply is settled by fresh process without a duplicate status/assignment audit", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(); await worker(f.root, f.sha256, decisionId, f.revision());
    assert.equal((await worker(f.root, f.sha256, decisionId, f.revision(), "queue", "1")).code, 91);
    const audit = f.store.readAudit().length;
    const result = await worker(f.root, f.sha256, decisionId, f.revision(), "queue"); assert.equal(result.result.ok, true); assert.equal(result.result.result.reused, true);
    assert.equal(f.store.readAudit().length, audit); assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 0);
  } finally { f.close(); }
});
