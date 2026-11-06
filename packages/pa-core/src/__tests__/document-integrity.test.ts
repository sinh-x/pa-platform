import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DocumentPackageError, documentDestination, documentPackageSha } from "../documents/package-contract.js";
import { documentPending } from "../registry/documents.js";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

for (const variant of ["bytes", "membership", "effects"] as const) test(`changed approved ${variant} cannot consume the old decision`, async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), next = structuredClone(f.subject); next.revision++;
    if (variant === "bytes") { const raw = Buffer.from("Changed mockup."); const member = next.members[3]!; member.source = member.source.replace("mockup.md", "next.md"); member.bytes = raw.length; member.sha256 = digest(raw); writeFileSync(join(f.root, member.source), raw); }
    else if (variant === "membership") next.members.pop();
    else next.effects.queue = false;
    assert.equal((await f.call({ action: "freeze", package: next, expectedRevision: f.revision() })).ok, true);
    assert.equal((await f.call({ action: "publish", sha256: documentPackageSha(next), decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 0);
  } finally { f.close(); }
});
test("late rejection or revocation cannot revive an older approval of the same immutable subject", async () => {
  const f = documentRuntimeFixture(); try {
    const first = await f.prepare(), native = f.host.capture;
    f.host.capture = async r => ({ ...await native(r), outcome: "rejected" });
    await f.call({ action: "capture", sha256: f.sha256, expectedRevision: f.revision() });
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId: first, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    f.host.capture = native;
    const approved = await f.call({ action: "capture", sha256: f.sha256, expectedRevision: f.revision() }), decisionId = (approved.result as any).decisions.at(-1).decisionId;
    assert.equal((await f.call({ action: "revoke", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId: first, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
  } finally { f.close(); }
});
test("conflicting publication is retained and excludes a second lineage while independent snapshots remain possible", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), path = join(f.root, documentDestination(f.subject, f.subject.members[3]!));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "conflicting retained bytes");
    const inode = statSync(path).ino;
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    assert.equal(readFileSync(path, "utf8"), "conflicting retained bytes"); assert.equal(statSync(path).ino, inode);
    const next = structuredClone(f.subject); next.packageId = "second-lineage";
    const frozen = await f.call({ action: "freeze", package: next, expectedRevision: f.revision() }); assert.equal(frozen.ok, true);
    const sha256 = documentPackageSha(next), approved = await f.call({ action: "capture", sha256, expectedRevision: f.revision() }), nextDecision = (approved.result as any).decisions.at(-1).decisionId;
    assert.equal((await f.call({ action: "publish", sha256, decisionId: nextDecision, expectedRevision: f.revision() })).code, "DOCUMENT_UNCERTAIN");
    assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 1);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 0);
  } finally { f.close(); }
});
test("successor promotion retains exact historical refs and requires every supporting member", async () => {
  const f = documentRuntimeFixture(); try {
    const first = await f.prepare(); await f.call({ action: "publish", sha256: f.sha256, decisionId: first, expectedRevision: f.revision() });
    const before = f.store.get("EX-1")!.doc_refs;
    const next = structuredClone(f.subject); next.revision++; next.predecessor = f.sha256;
    await f.call({ action: "freeze", package: next, expectedRevision: f.revision() });
    const sha256 = documentPackageSha(next), approved = await f.call({ action: "capture", sha256, expectedRevision: f.revision() }), decisionId = (approved.result as any).decisions.at(-1).decisionId;
    assert.equal((await f.call({ action: "publish", sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    const after = f.store.get("EX-1")!.doc_refs; assert.equal(after.length, 10);
    for (const ref of before) assert.deepEqual(after.find(r => r.path === ref.path), { ...ref, primary: false });
    assert.equal(after.filter(r => r.primary).length, 1); assert.equal(after.find(r => r.primary)!.path, documentDestination(next, next.members.find(m => m.role === "requirements")!));
  } finally { f.close(); }
});
for (const status of ["implementing", "review-uat", "done"] as const) test(`queue never downgrades ${status} and preserves the intent`, async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(); await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() });
    f.store.update("EX-1", { status });
    assert.equal((await f.call({ action: "queue", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_CONFLICT");
    assert.equal(f.store.get("EX-1")!.status, status); assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 1);
  } finally { f.close(); }
});
test("completed effect with lost reply settles after revocation without performing a new write", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), append = f.journal.append.bind(f.journal); let interrupted = false;
    f.journal.append = (...args) => { if (!interrupted && args[3].kind === "result" && args[3].outcome === "completed") { interrupted = true; throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); } return append(...args); };
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    const audit = f.store.readAudit().length;
    await f.call({ action: "revoke", sha256: f.sha256, decisionId, expectedRevision: f.revision() });
    const settled = await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() });
    assert.equal(settled.ok, true); assert.equal((settled.result as any).reused, true); assert.equal(f.store.readAudit().length, audit);
    assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 0);
    assert.equal((await f.call({ action: "queue", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
  } finally { f.close(); }
});
test("full immutable Markdown is paged without losing reviewed tail bytes", async () => {
  const f = documentRuntimeFixture(); try {
    const member = f.subject.members[3]!, content = "Long detailed text.\n".repeat(1500) + "Unique reviewed tail.";
    writeFileSync(join(f.root, member.source), content); member.bytes = Buffer.byteLength(content); member.sha256 = digest(content);
    await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 });
    const sha256 = documentPackageSha(f.subject); let offset: number | null = 0, text = "";
    do { const page = await f.call({ action: "read", sha256, path: "mockup", offset }); assert.equal(page.ok, true); text += (page.result as any).content; offset = (page.result as any).nextOffset; } while (offset !== null);
    assert.equal(text, content);
  } finally { f.close(); }
});
