import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { documentDestination, DocumentPackageError } from "../documents/package-contract.js";
import { documentPending } from "../registry/documents.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

async function pendingFixture() {
  const f = documentRuntimeFixture();
  const decisionId = await f.prepare();
  f.host.recoveryProfile = true;
  const authenticate = f.host.authenticate;
  f.host.authenticate = () => ({ ...authenticate(), sessionId: "source-test-session" });
  // A real owner rejection occurs after durable intent, before any file write.
  f.store.update("EX-1", { status: "idea" }, "test");
  assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
  const operationId = documentPending(f.journal.events("example", "EX-1"))[0]!.operationId;
  const request = { action: "publication-diagnose", sha256: f.sha256, decisionId, operationId, expectedRevision: f.revision() };
  return { f, request };
}

test("diagnosis is read-only, exact, draft-independent and honest about historical cause", async () => {
  const { f, request } = await pendingFixture(); try {
    for (const m of f.subject.members) rmSync(join(f.root, m.source));
    const events = f.journal.events("example", "EX-1"), audit = f.store.readAudit();
    const result = await f.call(request);
    assert.equal(result.ok, true);
    const d = result.result as any;
    assert.equal(d.eligible, true); assert.equal(d.settled, false); assert.match(d.cause, /unproven/);
    assert.equal(d.observation.members.length, 5); assert.ok(d.observation.members.every((m: any) => m.state === "absent"));
    assert.equal(d.historicalResults[0].outcome, "unknown"); assert.equal(d.historicalResults[0].code, "DOCUMENT_CONFLICT");
    assert.deepEqual(f.journal.events("example", "EX-1"), events); assert.deepEqual(f.store.readAudit(), audit);
    assert.equal((await f.call({ ...request, expectedRevision: request.expectedRevision - 1 })).code, "DOCUMENT_CONFLICT");
    assert.equal((await f.call({ ...request, operationId: "effect-foreign" })).code, "DOCUMENT_AUTHORITY");
    f.host.recoveryProfile = false;
    assert.equal((await f.call(request)).code, "DOCUMENT_UNAVAILABLE");
  } finally { f.close(); }
});
for (const variant of ["exact", "ref-without-file", "wrong-ref", "primary", "foreign-primary", "duplicate", "conflict", "hardlink", "symlink", "directory", "owner-unknown"] as const) test(`diagnosis eligibility: ${variant}`, async () => {
  const { f, request } = await pendingFixture(); try {
    const member = f.subject.members[0]!, path = documentDestination(f.subject, member), absolute = join(f.root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    if (variant !== "ref-without-file") writeFileSync(absolute, variant === "conflict" ? "wrong bytes" : readFileSync(join(f.root, member.source)));
    if (variant === "hardlink" || variant === "symlink" || variant === "directory") {
      rmSync(absolute);
      if (variant === "hardlink") linkSync(join(f.root, member.source), absolute);
      else if (variant === "symlink") symlinkSync(join(f.root, member.source), absolute);
      else mkdirSync(absolute);
    }
    const ref = { type: "attachment" as const, path, primary: false, addedAt: "2026-11-12T00:00:00.000Z", addedBy: "test" };
    if (["exact", "ref-without-file", "wrong-ref", "primary", "foreign-primary", "duplicate"].includes(variant))
      f.store.update("EX-1", { doc_refs: [variant === "wrong-ref" ? { ...ref, type: "uat" } : variant === "foreign-primary" ? { ...ref, path: "elsewhere.md", primary: true } : { ...ref, primary: variant === "primary" }, ...(variant === "duplicate" ? [ref] : [])] }, "test");
    if (variant === "owner-unknown") f.host.assertEffectAvailable = () => { throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); };
    const before = f.revision(), audit = f.store.readAudit();
    const result = await f.call(request);
    assert.equal(result.ok, true); assert.equal((result.result as any).eligible, variant === "exact");
    assert.equal(f.revision(), before); assert.deepEqual(f.store.readAudit(), audit);
  } finally { f.close(); }
});
export { pendingFixture };
