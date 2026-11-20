import assert from "node:assert/strict";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { ContentReviewService } from "../documents/content-review.js";
import { ContentPublicationService, type ContentPublicationHost } from "../documents/content-publication.js";
import { contentPublicationGuidance, parseContentPublicationRequest } from "../documents/content-publication-contract.js";
import { documentDestination, documentPackageSha } from "../documents/package-contract.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { presentFullDocumentReader } from "../documents/reader-publication.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

async function fixture() {
  const f = documentRuntimeFixture(); f.db.pragma("synchronous = FULL");
  f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
  const delivery = await presentFullDocumentReader(f.subject, f.root, sha => f.journal.snapshot(sha));
  const journal = new RegistryHandoffReviewJournal(f.db);
  let confirmations = 0;
  const caller = { callerIdentitySha256: "a".repeat(64), selectionSha256: "b".repeat(64), deploymentId: "d-327001", sessionId: "publication-fixture" };
  const host: ContentPublicationHost = { artifactRoot: f.root, tickets: f.store, authenticate: () => caller,
    assertOrigin() {}, assertDocument() {}, assertCaller() {},
    withPublicationBoundary(_document, run) { return run(() => {}); },
    async confirm() { confirmations++; return "confirmed"; },
  };
  const review = new ContentReviewService(journal, host);
  const reference = await review.prepare(f.sha256, String(delivery.deliverySha256), caller);
  await review.request(reference); const decision = await review.decide(reference, "approved");
  const service = new ContentPublicationService(journal, host);
  return { ...f, journal, host, review, reference, decision, service, delivery, confirmations: () => confirmations };
}

test("Publish requires separate native finite authority and reuses the exact content decision", async () => {
  const f = await fixture(); try {
    await assert.rejects(() => f.service.publish(f.reference), /DOCUMENT_AUTHORITY/);
    assert.equal(f.journal.effect(f.reference.slice(7), String(f.decision.decisionId), "publish").started, false);
    const before = f.journal.events(f.reference.slice(7)).slice(0, 2);
    const authority = await f.service.authorize(f.reference);
    assert.equal(authority.contentDecisionId, f.decision.decisionId); assert.equal(f.confirmations(), 1);
    assert.deepEqual(await f.service.authorize(f.reference), authority); assert.equal(f.confirmations(), 1);
    const result = await f.service.publish(f.reference);
    assert.equal(result.publication, "verified"); assert.equal(result.branch, "not-performed"); assert.equal(result.queue, "not-performed");
    assert.deepEqual(f.journal.events(f.reference.slice(7)).slice(0, 2), before);
    assert.throws(() => f.journal.approved(f.reference.slice(7), String(f.decision.decisionId), "publish"));
    const ticket = f.store.get("EX-1")!;
    assert.equal(ticket.status, "requirement-review"); assert.equal(ticket.assignee, "requirements/team-manager");
    assert.equal(ticket.doc_refs.filter(ref => ref.primary).length, 1);
    for (const member of f.subject.members) assert.deepEqual(readFileSync(join(f.root, documentDestination(f.subject, member))), f.journal.documents.snapshot(member.sha256));
    const folder = `agent-teams/requirements/artifacts/presentations/${f.sha256}/${String(f.delivery.deliverySha256)}`;
    for (const path of ["manifest.json", "index.html", ...f.subject.members.flatMap((_m, i) => [`raw/member-${i + 1}.md`, `members/member-${i + 1}.html`])]) {
      const refs = ticket.doc_refs.filter(ref => ref.path === `${folder}/${path}`);
      assert.equal(refs.length, 1); assert.equal(refs[0]!.type, "attachment"); assert.equal(refs[0]!.primary, false);
    }
    const audit = f.store.readAudit();
    assert.deepEqual(await f.service.publish(f.reference), result); assert.deepEqual(f.store.readAudit(), audit);
  } finally { f.close(); }
});

for (const stage of ["authority", "intent", "tracking", "publication", "complete"] as const) test(`lost reply after ${stage} continues only the original operation`, async () => {
  const f = await fixture(); try {
    let fault = true;
    f.host.afterPublicationPersist = at => { if (fault && at === stage) { fault = false; throw Error("fixture reply loss"); } };
    if (stage === "authority") await assert.rejects(() => f.service.authorize(f.reference), /fixture reply loss/);
    else { await f.service.authorize(f.reference); await assert.rejects(() => f.service.publish(f.reference), /fixture reply loss/); }
    const original = f.journal.effect(f.reference.slice(7), String(f.decision.decisionId), "publish").operationId;
    await f.service.authorize(f.reference);
    const result = await f.service.publish(f.reference);
    assert.equal(result.operationId, original); assert.equal(result.publication, "verified"); assert.equal(f.confirmations(), 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM handoff_review_effects").get()?.n, 1);
  } finally { f.close(); }
});

for (const variant of ["source", "raw", "member-html", "entry", "manifest", "lifecycle", "caller", "custody", "wrong-ref", "foreign-primary", "unknown"] as const) test(`fresh ${variant} refusal preserves original intent and prevents primary`, async () => {
  const f = await fixture(); try {
    await f.service.authorize(f.reference);
    f.host.afterPublicationPersist = stage => { if (stage === "intent") throw Error("stop after intent"); };
    await assert.rejects(() => f.service.publish(f.reference)); delete f.host.afterPublicationPersist;
    const operation = f.journal.effect(f.reference.slice(7), String(f.decision.decisionId), "publish");
    const folder = join(f.root, `agent-teams/requirements/artifacts/presentations/${f.sha256}/${String(f.delivery.deliverySha256)}`);
    if (variant === "source") writeFileSync(join(f.root, f.subject.members[0]!.source), "changed");
    if (["raw", "member-html", "entry", "manifest"].includes(variant)) writeFileSync(join(folder, variant === "raw" ? "raw/member-1.md" : variant === "member-html" ? "members/member-1.html" : variant === "entry" ? "index.html" : "manifest.json"), "changed");
    if (variant === "lifecycle") f.store.update("EX-1", { status: "implementing" }, "fixture");
    if (variant === "caller") f.host.assertCaller = () => { throw Error("caller denied"); };
    if (variant === "custody") f.host.withPublicationBoundary = () => { throw Error("custody uncertain"); };
    if (variant === "wrong-ref") f.store.update("EX-1", { add_doc_ref: { type: "uat", path: `agent-teams/requirements/artifacts/presentations/${f.sha256}/${String(f.delivery.deliverySha256)}/index.html`, primary: false } }, "fixture");
    if (variant === "foreign-primary") f.store.update("EX-1", { add_doc_ref: { type: "requirements", path: "foreign.md", primary: true } }, "fixture");
    if (variant === "unknown") { const path = documentDestination(f.subject, f.subject.members[0]!); (await import("node:fs")).mkdirSync(join(f.root, path), { recursive: true }); }
    const before = f.store.readAudit();
    await assert.rejects(() => f.service.publish(f.reference));
    assert.deepEqual(f.store.readAudit(), before);
    assert.deepEqual(f.journal.effect(f.reference.slice(7), String(f.decision.decisionId), "publish"), operation);
    assert.equal(f.store.get("EX-1")!.doc_refs.some(ref => ref.primary && ref.path === documentDestination(f.subject, f.subject.members[1]!)), false);
  } finally { f.close(); }
});

test("partial attachments are retained; revocation fences every unperformed effect without another signature", async () => {
  const f = await fixture(); try {
    await f.service.authorize(f.reference);
    f.host.afterPublicationPersist = stage => { if (stage === "tracking") throw Error("partial attachments"); };
    await assert.rejects(() => f.service.publish(f.reference)); delete f.host.afterPublicationPersist;
    const refs = f.store.get("EX-1")!.doc_refs;
    const files = refs.map(ref => ({ path: ref.path, inode: lstatSync(join(f.root, ref.path)).ino, raw: readFileSync(join(f.root, ref.path)) }));
    await f.service.revoke(f.reference);
    await assert.rejects(() => f.service.publish(f.reference), /DOCUMENT_AUTHORITY/);
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, refs);
    for (const file of files) { assert.equal(lstatSync(join(f.root, file.path)).ino, file.inode); assert.deepEqual(readFileSync(join(f.root, file.path)), file.raw); }
    assert.equal((await f.service.status(f.reference)).eligibility, "revoked");
    assert.equal(f.journal.events(f.reference.slice(7)).filter(e => e.kind === "issued").length, 1);
  } finally { f.close(); }
});

test("all exact attachments and refs precede primary; predecessor and unrelated history survives a successor", async () => {
  const f = await fixture(); try {
    await f.service.authorize(f.reference); await f.service.publish(f.reference);
    const previousRefs = f.store.get("EX-1")!.doc_refs;
    f.store.update("EX-1", { add_doc_ref: { type: "attachment", path: "unrelated.md", primary: false } }, "fixture");
    const next = { ...f.subject, revision: 2, predecessor: f.sha256 };
    const sha = f.journal.documents.freeze(next, f.journal.documents.events("example", "EX-1").length, readDocumentSources(next, f.root));
    assert.equal(sha, documentPackageSha(next));
    const delivery = await presentFullDocumentReader(next, f.root, hash => f.journal.documents.snapshot(hash));
    const reference = await f.review.prepare(sha, String(delivery.deliverySha256), f.host.authenticate());
    await f.review.request(reference); await f.review.decide(reference, "approved");
    await f.service.supersede(f.reference, reference);
    await f.service.authorize(reference);
    const update = f.store.update.bind(f.store);
    f.store.update = (...args) => {
      if (args[1].doc_refs?.some(ref => ref.primary && ref.path === documentDestination(next, next.members[1]!))) {
        const refs = f.store.get("EX-1")!.doc_refs;
        assert.ok(refs.some(ref => ref.path.endsWith("/manifest.json")));
        for (const member of next.members) assert.equal(refs.filter(ref => ref.path === documentDestination(next, member) && !ref.primary).length, 1);
      }
      return update(...args);
    };
    assert.equal((await f.service.publish(reference)).publication, "verified");
    const refs = f.store.get("EX-1")!.doc_refs;
    for (const old of previousRefs) assert.deepEqual(refs.find(ref => ref.path === old.path), { ...old, primary: false });
    assert.ok(refs.some(ref => ref.path === "unrelated.md" && !ref.primary));
    assert.equal(refs.filter(ref => ref.primary).length, 1);
    await f.service.revoke(reference);
    assert.equal((await f.service.status(f.reference)).eligibility, "superseded", "historical supersession survives successor revocation");
  } finally { f.close(); }
});

test("publication grammar and fixed NO_COLOR guidance reject hostile authority without reflecting it", () => {
  const reference = `review:${"a".repeat(64)}`, input = { schemaVersion: "pa-content-publication/v1", action: "publish", reference };
  assert.deepEqual(parseContentPublicationRequest(JSON.stringify(input)), { action: "publish", reference });
  for (const extra of [{ authorized: true }, { authority: true }, { outcome: "approved" }, { decisionId: "forged" }, { root: "/tmp" }, { effects: { publish: true } }, { successorReference: reference }]) {
    assert.throws(() => parseContentPublicationRequest(JSON.stringify({ ...input, ...extra })), /DOCUMENT_INPUT/);
  }
  for (const code of ["DOCUMENT_INPUT", "DOCUMENT_AUTHORITY", "DOCUMENT_STALE", "DOCUMENT_SOURCE", "DOCUMENT_CONFLICT", "DOCUMENT_UNCERTAIN", "DOCUMENT_UNAVAILABLE", "PRIVATE_SYNTHETIC".repeat(4000), new Proxy({}, { get() { throw Error("PRIVATE_SYNTHETIC"); } })]) {
    const text = contentPublicationGuidance(code);
    assert.ok(text.length <= 2000); assert.doesNotMatch(text, /PRIVATE_SYNTHETIC/);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(text.split(label).length - 1, 1);
    assert.match(text, /read-only/); assert.match(text, /original operation/);
  }
});

for (const fault of ["during-attachments", "before-primary", "revoked-mid-partial"] as const) test(`fault boundary ${fault} retains exact partials and fresh same-operation recovery`, async () => {
  const f = await fixture(); try {
    await f.service.authorize(f.reference);
    const originalUpdate = f.store.update.bind(f.store); let count = 0, faulted = false;
    f.store.update = (...args) => {
      if (!faulted && fault === "before-primary" && args[1].doc_refs?.some(ref => ref.primary)) { faulted = true; throw Error("fixture before primary"); }
      const result = originalUpdate(...args);
      if (args[1].add_doc_ref && ++count === 2 && fault !== "before-primary") {
        faulted = true;
        if (fault === "revoked-mid-partial") f.journal.fenceContent(f.reference.slice(7), "revoked");
        else throw Error("fixture during attachments");
      }
      return result;
    };
    await assert.rejects(() => f.service.publish(f.reference)); f.store.update = originalUpdate;
    const operation = f.journal.effect(f.reference.slice(7), String(f.decision.decisionId), "publish");
    assert.equal(operation.started, true); assert.equal(operation.completed, false);
    assert.equal(f.store.get("EX-1")!.doc_refs.some(ref => ref.primary), false);
    const retained = f.store.get("EX-1")!.doc_refs.map(ref => ({ path: ref.path, inode: lstatSync(join(f.root, ref.path)).ino }));
    f.store.update("EX-1", { add_doc_ref: { type: "attachment", path: "later-unrelated.md", primary: false } }, "fixture");
    if (fault === "revoked-mid-partial") await assert.rejects(() => f.service.publish(f.reference), /DOCUMENT_AUTHORITY/);
    else {
      const result = await f.service.publish(f.reference); assert.equal(result.operationId, operation.operationId);
      assert.equal(result.publication, "verified");
    }
    for (const file of retained) assert.equal(lstatSync(join(f.root, file.path)).ino, file.inode);
    assert.ok(f.store.get("EX-1")!.doc_refs.some(ref => ref.path === "later-unrelated.md"));
  } finally { f.close(); }
});

test("explicit supersession fences a partial old publication and cannot retarget either reference", async () => {
  const f = await fixture(); try {
    await f.service.authorize(f.reference);
    f.host.afterPublicationPersist = stage => { if (stage === "tracking") throw Error("fixture partial"); };
    await assert.rejects(() => f.service.publish(f.reference)); delete f.host.afterPublicationPersist;
    const next = { ...f.subject, revision: 2 };
    const sha = f.journal.documents.freeze(next, f.journal.documents.events("example", "EX-1").length, readDocumentSources(next, f.root));
    const delivery = await presentFullDocumentReader(next, f.root, hash => f.journal.documents.snapshot(hash));
    const reference = await f.review.prepare(sha, String(delivery.deliverySha256), f.host.authenticate());
    await f.review.request(reference); await f.review.decide(reference, "approved");
    const refs = f.store.get("EX-1")!.doc_refs;
    await f.service.supersede(f.reference, reference);
    await assert.rejects(() => f.service.publish(f.reference), /DOCUMENT_AUTHORITY/);
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, refs);
    await f.service.authorize(reference);
    await assert.rejects(() => f.service.publish(reference), /DOCUMENT_UNCERTAIN/, "successor cannot evade an unresolved original publication");
    assert.equal(f.journal.contentSubject(f.reference.slice(7)).subject.documentSubjectSha256, f.sha256);
    assert.equal((await f.service.status(f.reference)).eligibility, "superseded");
  } finally { f.close(); }
});

test("native journal refuses supersession to an inactive successor without damaging either decision", async () => {
  const f = await fixture(); try {
    const next = { ...f.subject, revision: 2 };
    const sha = f.journal.documents.freeze(next, f.journal.documents.events("example", "EX-1").length, readDocumentSources(next, f.root));
    const delivery = await presentFullDocumentReader(next, f.root, hash => f.journal.documents.snapshot(hash));
    const reference = await f.review.prepare(sha, String(delivery.deliverySha256), f.host.authenticate());
    await f.review.request(reference); await f.review.decide(reference, "approved");
    await f.service.revoke(reference);
    assert.throws(() => f.journal.fenceContent(f.reference.slice(7), "superseded", reference.slice(7)), /DOCUMENT_AUTHORITY/);
    assert.equal((await f.service.status(f.reference)).eligibility, "active");
    assert.equal(f.journal.events(f.reference.slice(7)).length, 2);
  } finally { f.close(); }
});

test("cancelled publication authority does not publish or create an operation", async () => {
  const f = await fixture(); try {
    f.host.confirm = async () => "cancelled";
    assert.equal((await f.service.authorize(f.reference)).authority, "not-issued");
    await assert.rejects(() => f.service.publish(f.reference), /DOCUMENT_AUTHORITY/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM handoff_review_effects").get()?.n, 0);
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, []);
  } finally { f.close(); }
});
