import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { documentDestination, documentPackageSha, DocumentPackageError } from "../documents/package-contract.js";
import { documentPending, documentRetiredSubjects } from "../registry/documents.js";
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
async function retirementFixture() {
  const { f, request } = await pendingFixture();
  const diagnosis = (await f.call(request)).result as any;
  const retire = { ...request, action: "publication-retire", requestId: "recover-original", originalRequestSha256: diagnosis.originalRequestSha256, observationSha256: diagnosis.observationSha256 };
  let prompts = 0;
  f.host.retire = async () => {
    prompts++;
    const nativeEvidence = Buffer.from("native-source-test-retirement");
    return { outcome: "approved", principal: "synthetic-source-test", interactionId: `interaction-${prompts}`, evidenceSha256: (await import("../workflows/contracts.js")).digest(nativeEvidence), nativeEvidence };
  };
  return { f, request, retire, prompts: () => prompts };
}

test("terminal retirement preserves unknown history, releases only intent and fences every old-subject route", async () => {
  const { f, retire, prompts } = await retirementFixture(); try {
    const before = f.journal.events("example", "EX-1"), audit = f.store.readAudit();
    const result = await f.call(retire);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal((result.result as any).outcome, "retired");
    const events = f.journal.events("example", "EX-1");
    assert.deepEqual(events.slice(0, before.length), before);
    assert.deepEqual(f.store.readAudit(), audit); assert.equal(prompts(), 1);
    assert.deepEqual(events.slice(-2).map(e => e.data.kind), ["retirement-consent", "retired"]);
    assert.equal(documentPending(events).length, 0); assert.ok(documentRetiredSubjects(events).has(f.sha256));
    for (const action of ["publish", "queue"]) for (const decisionId of [retire.decisionId, "new-decision"]) {
      assert.equal((await f.call({ action, sha256: f.sha256, decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    }
    assert.throws(() => f.journal.append("example", "EX-1", f.revision(), { kind: "intent", subjectSha256: f.sha256, operationId: "alternate-operation", decisionId: "new-decision", operation: "publish" }), /DOCUMENT_AUTHORITY/);
    // Replay uses original request coordinates, even after later journal activity.
    const next = structuredClone(f.subject); next.revision++;
    assert.equal((await f.call({ action: "freeze", package: next, expectedRevision: f.revision() })).ok, true);
    const replay = await f.call(retire);
    assert.equal(replay.ok, true); assert.equal((replay.result as any).reused, true); assert.equal(prompts(), 1);
    assert.equal((await f.call({ ...retire, observationSha256: "b".repeat(64) })).code, "DOCUMENT_AUTHORITY");
    assert.equal((await f.call({ ...retire, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retired").length, 1);
  } finally { f.close(); }
});

for (const outcome of ["cancelled", "rejected", "changes-requested"] as const) test(`native ${outcome} is durable but does not retire`, async () => {
  const { f, retire, prompts } = await retirementFixture(); try {
    const capture = f.host.retire!; f.host.retire = async r => ({ ...await capture(r), outcome });
    assert.equal((await f.call(retire)).ok, true);
    assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 1);
    assert.equal(documentRetiredSubjects(f.journal.events("example", "EX-1")).size, 0);
    assert.equal((await f.call(retire)).ok, true); assert.equal(prompts(), 1);
  } finally { f.close(); }
});

test("no UI, forged evidence, changed caller and post-consent physical drift grant no settlement", async () => {
  for (const variant of ["no-ui", "forged", "caller", "file", "refs", "owner", "stale", "extra"] as const) {
    const { f, retire } = await retirementFixture(); try {
      const capture = f.host.retire!;
      if (variant === "no-ui") f.host.retire = undefined;
      else f.host.retire = async r => {
        const result = await capture(r);
        if (variant === "forged") return { ...result, evidenceSha256: "b".repeat(64) };
        if (variant === "caller") { const auth = f.host.authenticate; f.host.authenticate = () => ({ ...auth(), identitySha256: "b".repeat(64) }); }
        if (variant === "file") { const path = join(f.root, documentDestination(f.subject, f.subject.members[0]!)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "drift"); }
        if (variant === "refs") f.store.update("EX-1", { add_doc_ref: { type: "attachment", path: "unrelated.md", primary: false } }, "test");
        if (variant === "owner") f.host.assertEffectAvailable = () => { throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); };
        return result;
      };
      const result = await f.call(variant === "stale" ? { ...retire, expectedRevision: retire.expectedRevision - 1 } : variant === "extra" ? { ...retire, outcome: "approved" } : retire);
      assert.equal(result.ok, false, variant); assert.equal(documentPending(f.journal.events("example", "EX-1")).length, 1);
      assert.equal(documentRetiredSubjects(f.journal.events("example", "EX-1")).size, 0);
    } finally { f.close(); }
  }
});

for (const boundary of ["before-consent", "after-consent", "after-settlement"] as const) test(`lost reply at ${boundary} reconciles original request`, async () => {
  const { f, retire, prompts } = await retirementFixture(); try {
    const append = f.journal.append.bind(f.journal); let interrupted = false;
    f.journal.append = (...args) => {
      const kind = args[3].kind;
      if (!interrupted && boundary === "before-consent" && kind === "retirement-consent") { interrupted = true; throw Error("pre-issuance interruption"); }
      const result = append(...args);
      if (!interrupted && (boundary === "after-consent" && kind === "retirement-consent" || boundary === "after-settlement" && kind === "retired")) { interrupted = true; throw Error("lost reply"); }
      return result;
    };
    assert.equal((await f.call(retire)).ok, false);
    assert.equal((await f.call(retire)).ok, true);
    assert.equal(prompts(), boundary === "before-consent" ? 2 : 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retired").length, 1);
    assert.equal(f.journal.events("example", "EX-1").filter(e => e.data.kind === "retirement-consent").length, 1);
  } finally { f.close(); }
});

test("safe partial files/refs retain their exact bytes and inodes through retirement", async () => {
  const { f, request } = await pendingFixture(); try {
    const member = f.subject.members[0]!, path = documentDestination(f.subject, member), absolute = join(f.root, path);
    mkdirSync(dirname(absolute), { recursive: true }); const bytes = readFileSync(join(f.root, member.source)); writeFileSync(absolute, bytes);
    f.store.update("EX-1", { add_doc_ref: { type: "attachment", path, primary: false } }, "test");
    const refs = f.store.get("EX-1")!.doc_refs, stat = (await import("node:fs")).statSync(absolute);
    const diagnosis = (await f.call(request)).result as any;
    f.host.retire = async () => { const nativeEvidence = Buffer.from("exact-partial-retirement"); return { outcome: "approved", principal: "source-test", interactionId: "interaction-partial", nativeEvidence, evidenceSha256: (await import("../workflows/contracts.js")).digest(nativeEvidence) }; };
    const result = await f.call({ ...request, action: "publication-retire", requestId: "partial-request", originalRequestSha256: diagnosis.originalRequestSha256, observationSha256: diagnosis.observationSha256 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, refs); assert.deepEqual(readFileSync(absolute), bytes); assert.equal((await import("node:fs")).statSync(absolute).ino, stat.ino);
  } finally { f.close(); }
});

test("retirement resumes corrected SAME-package review with fresh native approval; old partials stay historical", async () => {
  const { f, retire } = await retirementFixture(); try {
    assert.equal((await f.call(retire)).ok, true);
    const retiredEvents = f.journal.events("example", "EX-1");
    const next = structuredClone(f.subject); next.revision++;
    const member = next.members[1]!; member.source = member.source.replace("requirements.md", "requirements-corrected.md");
    const bytes = Buffer.from("# FR-1 — corrected scope\n# AC-1 — corrected delivery\nCoverage: TS-1\n");
    writeFileSync(join(f.root, member.source), bytes); member.bytes = bytes.length; member.sha256 = (await import("../workflows/contracts.js")).digest(bytes);
    assert.equal((await f.call({ action: "freeze", package: { ...next, packageId: "alternate-lineage" }, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    f.store.update("EX-1", { status: "requirement-review" }, "test");
    assert.equal((await f.call({ action: "check", package: next })).ok, true);
    assert.equal((await f.call({ action: "freeze", package: next, expectedRevision: f.revision() })).ok, true);
    const sha256 = documentPackageSha(next);
    assert.equal((await f.call({ action: "publish", sha256, decisionId: retire.decisionId, expectedRevision: f.revision() })).code, "DOCUMENT_AUTHORITY");
    for (const m of next.members) assert.equal((await f.call({ action: "read", sha256, path: m.id, offset: 0 })).ok, true);
    f.host.confirmationProfile = true; f.host.workspaceProfile = true;
    f.host.confirm = async () => { const nativeEvidence = Buffer.from("fresh-corrected-package-native-source-test"); return { outcome: "approved", principal: "source-test", interactionId: "interaction-corrected", nativeEvidence, evidenceSha256: (await import("../workflows/contracts.js")).digest(nativeEvidence) }; };
    assert.equal((await f.call({ action: "present", sha256 })).ok, true);
    const confirmed = await f.call({ action: "confirm", sha256, expectedRevision: f.revision(), scope: "publish-and-queue" });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    const decisionId = (confirmed.result as any).decisionId;
    assert.notEqual(decisionId, retire.decisionId);
    assert.equal((await f.call({ action: "publish", sha256, expectedRevision: f.revision(), decisionId })).ok, true);
    assert.equal((await f.call({ action: "queue", sha256, expectedRevision: f.revision(), decisionId })).ok, true);
    assert.equal(f.store.get("EX-1")!.doc_refs.filter(r => r.primary)[0]!.path, documentDestination(next, next.members[1]!));
    assert.equal(next.predecessor, null);
    assert.deepEqual(f.journal.events("example", "EX-1").slice(0, retiredEvents.length), retiredEvents);
    assert.equal((await f.call(retire)).ok, true);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: retire.decisionId })).code, "DOCUMENT_AUTHORITY");
  } finally { f.close(); }
});

test("completed truth cannot be retired; lost publication reply settles observation-only", async () => {
  const f = documentRuntimeFixture(); try {
    const decisionId = await f.prepare(), append = f.journal.append.bind(f.journal);
    f.journal.append = (...args) => { if (args[3].kind === "result") throw Error("lost result"); return append(...args); };
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, false);
    f.journal.append = append; f.host.recoveryProfile = true;
    const auth = f.host.authenticate; f.host.authenticate = () => ({ ...auth(), sessionId: "source-test" });
    let prompts = 0; f.host.retire = async () => { prompts++; throw Error("must not prompt"); };
    const operationId = documentPending(f.journal.events("example", "EX-1"))[0]!.operationId;
    const request = { action: "publication-diagnose", sha256: f.sha256, decisionId, operationId, expectedRevision: f.revision() };
    const diagnosis = (await f.call(request)).result as any;
    assert.equal(diagnosis.observation.publication, "complete"); assert.equal(diagnosis.eligible, false);
    const audit = f.store.readAudit();
    assert.equal((await f.call({ ...request, action: "publication-retire", requestId: "do-not-retire", originalRequestSha256: diagnosis.originalRequestSha256, observationSha256: diagnosis.observationSha256 })).code, "DOCUMENT_CONFLICT");
    assert.equal(prompts, 0);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, decisionId, expectedRevision: f.revision() })).ok, true);
    assert.deepEqual(f.store.readAudit(), audit); assert.equal(documentRetiredSubjects(f.journal.events("example", "EX-1")).size, 0);
  } finally { f.close(); }
});

test("status/show recover exact retirement request coordinates, not caller authority", async () => {
  const { f, retire } = await retirementFixture(); try {
    assert.equal((await f.call(retire)).ok, true);
    for (const request of [{ action: "status", ticket: "EX-1" }, { action: "show", sha256: f.sha256 }]) {
      const result = (await f.call(request)).result as any;
      assert.deepEqual(result.retiredSubjects, [f.sha256]);
      const issued = result.retirementRequests[0];
      for (const key of ["expectedRevision", "requestId", "originalRequestSha256", "observationSha256", "operationId", "decisionId"]) assert.equal(issued[key], (retire as any)[key]);
      assert.equal(issued.settled, true);
    }
  } finally { f.close(); }
});
