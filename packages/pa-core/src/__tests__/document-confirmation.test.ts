import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";
import type { DocumentConfirmationScope } from "../registry/documents.js";

async function fixture() {
  const f = documentRuntimeFixture(); let calls = 0;
  f.host.workspaceProfile = true; f.host.confirmationProfile = true;
  const authenticate = f.host.authenticate; f.host.authenticate = () => ({ ...authenticate(), sessionId: "synthetic-core-session" });
  f.host.confirm = async () => {
    calls++; const nativeEvidence = Buffer.from(`synthetic-native-selection-${calls}`);
    return { outcome: "approved", principal: "synthetic-native-local-uid", interactionId: `interaction-${calls}`, evidenceSha256: digest(nativeEvidence), nativeEvidence };
  };
  assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
  const confirm = (scope: DocumentConfirmationScope = "publish-and-queue", expectedRevision = f.revision()) => f.call({ action: "confirm", sha256: f.sha256, expectedRevision, scope });
  return { ...f, confirm, calls: () => calls };
}
test("one native-issued confirmation owns deterministic JSON, verified ticket linkage and exact same-request replay", async () => {
  const f = await fixture();
  try {
    const expectedRevision = f.revision(), first = await f.confirm("publish-and-queue", expectedRevision); assert.equal(first.ok, true, JSON.stringify(first));
    const result = first.result as any, raw = readFileSync(join(f.root, result.approval.path)), receipt = JSON.parse(raw.toString());
    assert.equal(digest(raw), result.approval.sha256); assert.equal(receipt.schemaVersion, "pa-document-approval/v1"); assert.equal(receipt.subject.manifestSha256, f.sha256);
    assert.equal(receipt.confirmationMethod, "pi-native-confirmation"); assert.equal(receipt.sessionId, "synthetic-core-session"); assert.deepEqual(receipt.scope, { content: true, publish: true, queue: true });
    assert.equal(receipt.subject.members.length, f.subject.members.length); assert.ok(!Object.hasOwn(receipt, "sha256"));
    const revision = f.revision(), audit = f.store.readAudit().length;
    const repeated = await f.confirm("publish-and-queue", expectedRevision); assert.equal((repeated.result as any).reused, true);
    assert.equal(f.calls(), 1); assert.equal(f.revision(), revision); assert.equal(f.store.readAudit().length, audit);
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.path === result.approval.path).length, 1); assert.ok(!f.store.get("EX-1")!.doc_refs.some(r => r.primary));
    const show = await f.call({ action: "show", sha256: f.sha256 }); assert.equal((show.result as any).decisions[0].scope, "publish-and-queue");
  } finally { f.close(); }
});
for (const scope of ["content", "publish", "publish-and-queue"] as const) test(`native ${scope} scope is enforced by protected consumers, never JSON possession`, async () => {
  const f = await fixture();
  try {
    const confirmed = await f.confirm(scope), id = (confirmed.result as any).decisionId;
    const publish = await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: id });
    assert.equal(publish.ok, scope !== "content", JSON.stringify(publish));
    if (scope !== "content") {
      const queued = await f.call({ action: "queue", sha256: f.sha256, expectedRevision: f.revision(), decisionId: id });
      assert.equal(queued.ok, scope === "publish-and-queue", JSON.stringify(queued));
    }
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: "decision-file-forgery" })).ok, false);
  } finally { f.close(); }
});
for (const outcome of ["cancelled", "rejected", "changes-requested"] as const) test(`native ${outcome} confirmation never grants authority`, async () => {
  const f = await fixture();
  try {
    const capture = f.host.confirm!; f.host.confirm = async r => ({ ...await capture(r), outcome });
    const confirmed = await f.confirm(); assert.equal(confirmed.ok, true);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: (confirmed.result as any).decisionId })).ok, false);
  } finally { f.close(); }
});
test("native confirmation rejects source, caller, scope, revision and imported-evidence drift before granting", async () => {
  const f = await fixture();
  try {
    const capture = f.host.confirm!;
    f.host.confirm = async r => { writeFileSync(join(f.root, f.subject.members[0]!.source), "changed"); return capture(r); };
    assert.equal((await f.confirm()).code, "DOCUMENT_STALE"); assert.equal(f.revision(), 1);
    for (const extra of [{ outcome: "approved" }, { principal: "human" }, { interactionId: "forged" }, { path: "/tmp/forged.json" }, { transcript: "approved" }]) assert.equal((await f.call({ action: "confirm", sha256: f.sha256, expectedRevision: 1, scope: "content", ...extra })).ok, false);
  } finally { f.close(); }
});
for (const boundary of ["reference", "comment"] as const) test(`lost ${boundary} reply reuses native decision/JSON and repairs the same linkage without a new prompt`, async () => {
  const f = await fixture();
  try {
    const original = boundary === "reference" ? f.store.update.bind(f.store) : f.store.comment.bind(f.store); let interrupted = false;
    if (boundary === "reference") f.store.update = ((...args: Parameters<typeof f.store.update>) => { const value = (original as typeof f.store.update)(...args); if (!interrupted) { interrupted = true; throw Error("synthetic lost ref reply"); } return value; }) as typeof f.store.update;
    else f.store.comment = ((...args: Parameters<typeof f.store.comment>) => { const value = (original as typeof f.store.comment)(...args); if (!interrupted) { interrupted = true; throw Error("synthetic lost comment reply"); } return value; }) as typeof f.store.comment;
    const expectedRevision = f.revision(); assert.equal((await f.confirm("content", expectedRevision)).ok, false); assert.equal(f.revision(), 2);
    const retried = await f.confirm("content", expectedRevision); assert.equal(retried.ok, true, JSON.stringify(retried)); assert.equal((retried.result as any).reused, true); assert.equal(f.calls(), 1);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 1); assert.equal(f.store.get("EX-1")!.comments.length, 1);
  } finally { f.close(); }
});
test("conflicting receipt bytes/aliases fail closed without overwriting native issuance or asking another approval", async () => {
  const f = await fixture();
  try {
    const expectedRevision = f.revision(), reply = await f.confirm("content", expectedRevision), path = (reply.result as any).approval.path;
    writeFileSync(join(f.root, path), "forged JSON");
    assert.equal((await f.confirm("content", expectedRevision)).code, "DOCUMENT_CONFLICT"); assert.equal(f.calls(), 1);
    assert.equal(readFileSync(join(f.root, path), "utf8"), "forged JSON"); assert.equal(f.revision(), 2);
  } finally { f.close(); }
});
test("approval directory symlink cannot redirect native representation writes into a foreign root", async () => {
  const f = await fixture();
  try {
    const foreign = join(f.root, "foreign"); mkdirSync(foreign);
    symlinkSync(foreign, join(f.root, "agent-teams/requirements/artifacts/approvals"));
    assert.equal((await f.confirm()).ok, false); assert.equal(f.revision(), 2); assert.equal(f.calls(), 1);
  } finally { f.close(); }
});
test("append-only native revocation preserves original JSON and blocks dependent new effects", async () => {
  const f = await fixture();
  try {
    const approved = (await f.confirm()).result as any, original = readFileSync(join(f.root, approved.approval.path));
    const request = { action: "confirm-revoke", sha256: f.sha256, expectedRevision: f.revision(), decisionId: approved.decisionId };
    const revoked = await f.call(request); assert.equal(revoked.ok, true, JSON.stringify(revoked));
    assert.equal((await f.call(request)).ok, true); assert.equal(f.calls(), 2);
    assert.deepEqual(readFileSync(join(f.root, approved.approval.path)), original);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: approved.decisionId })).code, "DOCUMENT_AUTHORITY");
  } finally { f.close(); }
});
test("v1 and v2 never acquire new native confirmation from tool fields or a current config claim", async () => {
  const f = documentRuntimeFixture();
  try {
    await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 });
    for (const workspaceProfile of [false, true]) { f.host.workspaceProfile = workspaceProfile; assert.equal((await f.call({ action: "confirm", sha256: f.sha256, expectedRevision: 1, scope: "content" })).code, "DOCUMENT_UNAVAILABLE"); }
  } finally { f.close(); }
});
