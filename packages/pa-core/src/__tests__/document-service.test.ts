import assert from "node:assert/strict";
import { existsSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { documentDestination, documentPackageSha } from "../documents/package-contract.js";
import { documentPending } from "../registry/documents.js";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

test("full five-member native-owned publication precedes primary and queue; replay is an observation", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare();
    assert.equal((await f.call({ action: "queue", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    const refs = f.store.get("EX-1")!.doc_refs; assert.equal(refs.length, 5); assert.equal(refs.filter(r => r.primary).length, 1);
    for (const m of f.subject.members) assert.equal(digest(readFileSync(join(f.root, documentDestination(f.subject, m)))), m.sha256);
    const inodes = f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino), before = f.store.readAudit().length;
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    assert.equal(f.store.readAudit().length, before);
    assert.equal((await f.call({ action: "queue", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    assert.equal(f.store.get("EX-1")!.assignee, "builder/team-manager"); assert.equal(f.store.get("EX-1")!.status, "pending-implementation");
    assert.deepEqual(f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino), inodes);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM registry_events").get() as { n: number }).n, 0);
    const decision = f.journal.events("example", "EX-1").find(e => e.data.kind === "decision")!.data;
    assert.equal(decision.kind, "decision"); if (decision.kind === "decision") assert.equal(digest(f.journal.snapshot(decision.evidenceSha256)), decision.evidenceSha256);
    for (const table of ["document_events", "document_subjects", "document_snapshots"]) assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable|append-only/);
  } finally { f.close(); }
});
for (const outcome of ["cancelled", "rejected", "changes-requested"] as const) test(`native ${outcome} produces no affirmative effect`, async () => {
  const f = documentRuntimeFixture(); try {
    const capture = f.host.capture; f.host.capture = async r => ({ ...await capture(r), outcome });
    const decisionId = await f.prepare();
    const result = await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() });
    assert.equal(result.code, "DOCUMENT_AUTHORITY"); assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 0);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 0);
  } finally { f.close(); }
});
test("changed mockup during consent rejects persistence; stale revisions and foreign grants fail locally", async () => {
  const f = documentRuntimeFixture(); try {
    await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 });
    const capture = f.host.capture;
    f.host.capture = async request => { writeFileSync(join(f.root, f.subject.members[3]!.source), "changed mockup"); return capture(request); };
    assert.equal((await f.call({ action: "capture", sha256: f.sha256, expectedRevision: f.revision() })).code, "DOCUMENT_STALE");
    assert.equal(f.revision(), 1); assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId: "invented", expectedRevision: 1 })).code, "DOCUMENT_AUTHORITY");
    const native = f.host.authenticate; f.host.authenticate = () => ({ ...native(), repoKey: "foreign" });
    assert.equal((await f.call({ action: "show", sha256: f.sha256 })).code, "DOCUMENT_AUTHORITY");
  } finally { f.close(); }
});
test("immutable successor snapshots compare meaningful text and never inherit old approval", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), oldBytes = f.journal.snapshot(f.subject.members[3]!.sha256);
    const next = structuredClone(f.subject); next.revision++; next.predecessor = f.sha256;
    next.members[3]!.source = next.members[3]!.source.replace("mockup.md", "mockup-next.md");
    const content = Buffer.from("# mockup\nRevised meaningful design."); writeFileSync(join(f.root, next.members[3]!.source), content); next.members[3]!.bytes = content.length; next.members[3]!.sha256 = digest(content);
    assert.equal((await f.call({ action: "freeze", package: next, expectedRevision: f.revision() })).ok, true);
    const sha256 = documentPackageSha(next), compared = await f.call({ action: "compare", sha256, previousSha256: f.sha256 });
    assert.match(JSON.stringify(compared), /Revised meaningful design/); assert.deepEqual(f.journal.snapshot(f.subject.members[3]!.sha256), oldBytes);
    assert.equal((await f.call({ action: "publish", sha256, decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    assert.equal((await f.call({ action: "freeze", package: { ...next, effects: { ...next.effects, queue: false } }, expectedRevision: f.revision() })).code, "DOCUMENT_CONFLICT");
  } finally { f.close(); }
});
test("failed structural findings remain facts and do not disable independent drafting", async () => {
  const f = documentRuntimeFixture(); try {
    const text = Buffer.from("# FR-1\nMissing AC-99 and TS-77\n"); const member = f.subject.members[1]!;
    writeFileSync(join(f.root, member.source), text); member.bytes = text.length; member.sha256 = digest(text);
    const checked = await f.call({ action: "check", package: f.subject });
    assert.equal(checked.ok, true); assert.equal((checked.result as any).structuralPass, false); assert.equal((checked.result as any).semanticCompleteness, "not-assessed");
    const path = "agent-teams/requirements/artifacts/drafts/d-abcdef/brief.md";
    const draft = await f.call({ action: "draft", path, content: "Safe independent draft", expectedSha256: null }); assert.equal(draft.ok, true);
    assert.equal((await f.call({ action: "draft", path, content: "conflicting replacement", expectedSha256: null })).code, "DOCUMENT_CONFLICT");
    assert.equal((await f.call({ action: "draft", path: "src/unsafe.ts", content: "source write", expectedSha256: null })).ok, false);
    assert.equal((await f.call({ action: "capabilities" })).ok, true);
  } finally { f.close(); }
});
for (const variant of ["symlink", "hardlink", "active-media", "unsafe-markup"] as const) test(`snapshot rejects ${variant} without bytes or authority`, async () => {
  const f = documentRuntimeFixture(); try {
    const member = f.subject.members[3]!;
    if (variant === "symlink" || variant === "hardlink") {
      const original = join(f.root, member.source); member.source = member.source.replace("mockup.md", "alias.md");
      if (variant === "symlink") symlinkSync(original, join(f.root, member.source)); else linkSync(original, join(f.root, member.source));
    } else if (variant === "active-media") (member as any).mediaType = "image/svg+xml";
    else { const bytes = Buffer.from("<script>alert('hostile')</script>"); writeFileSync(join(f.root, member.source), bytes); member.bytes = bytes.length; member.sha256 = digest(bytes); }
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, false);
    assert.equal(f.revision(), 0);
  } finally { f.close(); }
});
test("partial ticket ref interruption resumes the same intent, preserves failure and never promotes early", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), update = f.store.update.bind(f.store); let writes = 0;
    f.store.update = (...args) => { if (++writes === 3) throw Error("synthetic interruption"); return update(...args); };
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.primary).length, 0); assert.equal(f.store.get("EX-1")!.doc_refs.length, 2);
    const pending = documentPending(f.journal.events("example", "EX-1")); assert.equal(pending.length, 1);
    const inodes = f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino);
    f.store.update = update;
    const repaired = await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() }); assert.equal(repaired.ok, true);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "intent").length, 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "result" && e.data.outcome === "unknown").length, 1);
    assert.deepEqual(f.subject.members.map(m => statSync(join(f.root, documentDestination(f.subject, m))).ino), inodes);
  } finally { f.close(); }
});
test("retained effect conflicts block protected calls but not a separate unsigned snapshot", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(); f.host.assertEffectAvailable = () => { throw Error("retained owner"); };
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    const next = structuredClone(f.subject); next.revision++;
    assert.equal((await f.call({ action: "freeze", package: next, expectedRevision: f.revision() })).ok, true);
    assert.equal(existsSync(join(f.root, documentDestination(f.subject, f.subject.members[0]!))), false);
  } finally { f.close(); }
});
test("ticket-first intake is idempotent under the existing owner without workflow approval", async () => {
  const f = documentRuntimeFixture(); try {
    const native = f.host.authenticate; f.host.authenticate = () => ({ ...native(), ticket: null });
    const request = { action: "ticket-create", title: "Ticket first", content: "Discuss and draft this task.", intakeId: "intake-one" };
    const first = await f.call(request), again = await f.call(request);
    assert.equal(first.ok, true); assert.equal((again.result as any).reused, true); assert.equal((first.result as any).ticket.id, (again.result as any).ticket.id);
    assert.equal((await f.call({ ...request, title: "Changed scope" })).code, "DOCUMENT_CONFLICT");
    assert.equal(f.revision(), 0);
  } finally { f.close(); }
});
