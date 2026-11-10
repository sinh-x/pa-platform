import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

function worker(root: string, sha: string, revision: number, boundary: string): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", fileURLToPath(new URL("./document-confirmation-worker.ts", import.meta.url)), root, sha, String(revision), boundary], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.once("error", reject);
    child.once("close", code => { if (stderr || code !== 0 && code !== 91) reject(Error(`${code}: ${stderr}`)); else resolve({ code, result: stdout ? JSON.parse(stdout) : null }); });
  });
}
for (const boundary of ["registry", "file", "reference", "comment"]) test(`real process death after native confirmation ${boundary} boundary reconciles the same decision without another UI`, async () => {
  const f = documentRuntimeFixture();
  try {
    await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 }); const expected = f.revision();
    assert.equal((await worker(f.root, f.sha256, expected, boundary)).code, 91); assert.equal(f.revision(), expected + 1);
    const recovered = await worker(f.root, f.sha256, expected, "none"); assert.equal(recovered.result.ok, true, JSON.stringify(recovered)); assert.equal(recovered.result.result.reused, true);
    assert.equal(readFileSync(join(f.root, "native-ui-calls.txt"), "utf8"), "1");
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "confirmation").length, 1);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 1); assert.equal(f.store.get("EX-1")!.comments.length, 1);
    const audit = f.store.readAudit().length, bytes = readFileSync(join(f.root, recovered.result.result.approval.path));
    assert.equal((await worker(f.root, f.sha256, expected, "none")).result.ok, true);
    assert.equal(f.store.readAudit().length, audit); assert.deepEqual(readFileSync(join(f.root, recovered.result.result.approval.path)), bytes);
  } finally { f.close(); }
});
