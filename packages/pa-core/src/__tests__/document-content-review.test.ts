import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { ContentReviewService, contentReviewGuidance, parseContentReviewRequest, type ContentReviewHost } from "../documents/content-review.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { presentFullDocumentReader } from "../documents/reader-publication.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

async function fixture() {
  const f = documentRuntimeFixture();
  f.db.pragma("synchronous = FULL");
  f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
  const delivery = await presentFullDocumentReader(f.subject, f.root, sha => f.journal.snapshot(sha));
  const journal = new RegistryHandoffReviewJournal(f.db);
  const host: ContentReviewHost = { artifactRoot: f.root, assertOrigin() {}, assertDocument(document) {
    assert.equal(document.ticket, "EX-1"); assert.equal(document.repository.root, f.repo);
  } };
  const service = new ContentReviewService(journal, host);
  const reference = await service.prepare(f.sha256, String(delivery.deliverySha256), {
    callerIdentitySha256: "a".repeat(64), selectionSha256: "b".repeat(64), deploymentId: "d-327001", sessionId: "content-only-fixture",
  });
  return { ...f, journal, host, service, reference, delivery };
}

test("content blockers use fixed bounded owner guidance without reflecting hostile or oversized facts", () => {
  for (const code of ["DOCUMENT_INPUT", "DOCUMENT_SOURCE", "DOCUMENT_STALE", "DOCUMENT_AUTHORITY", "DOCUMENT_CONFLICT", "DOCUMENT_UNCERTAIN", "DOCUMENT_UNAVAILABLE", "PRIVATE_SYNTHETIC".repeat(4000), new Proxy({}, { get() { throw Error("PRIVATE_SYNTHETIC"); } })]) {
    const output = contentReviewGuidance(code);
    assert.ok(output.length <= 2000); assert.doesNotMatch(output, /PRIVATE_SYNTHETIC/);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(output.split(label).length - 1, 1);
    assert.match(output, /read-only/); assert.match(output, /Saved decisions are reused/);
  }
});

test("content reference grammar rejects bare tickets, paths, authority and internal coordinates", () => {
  const reference = `review:${"a".repeat(64)}`;
  assert.deepEqual(parseContentReviewRequest(JSON.stringify({ schemaVersion: "pa-content-review/v1", action: "show", reference })), { action: "show", reference });
  for (const extra of [{ root: "/tmp" }, { expectedRevision: 0 }, { requestKey: "a".repeat(64) }, { principal: "human" }, { effects: {} }]) {
    assert.throws(() => parseContentReviewRequest(JSON.stringify({ schemaVersion: "pa-content-review/v1", action: "show", reference, ...extra })));
  }
  for (const value of ["EX-1", "/tmp/review", "https://example.invalid", `review:${"a".repeat(63)}`]) {
    assert.throws(() => parseContentReviewRequest(JSON.stringify({ schemaVersion: "pa-content-review/v1", action: "show", reference: value })));
  }
  assert.throws(() => parseContentReviewRequest(`{"schemaVersion":"pa-content-review/v1","action":"show","action":"decide","reference":"${reference}"}`));
});

test("ticket discovery, full immutable view and sign-only decision need no branch intent or downstream authority", async () => {
  const f = await fixture();
  try {
    const ticket = readFileSync(join(f.root, "tickets/EX-1.json"));
    const documents = f.journal.documents.events("example", "EX-1");
    assert.equal(f.db.prepare("SELECT count(*) n FROM handoff_review_subjects WHERE intent <> 'null'").get()?.n, 0);
    assert.equal(await f.service.prepare(f.sha256, String(f.delivery.deliverySha256), {
      callerIdentitySha256: "c".repeat(64), selectionSha256: "d".repeat(64), deploymentId: "d-327002", sessionId: "another-client",
    }), f.reference);
    const listed = await f.service.list("example", "EX-1");
    assert.equal(listed.length, 1); assert.equal(listed[0]!.reference, f.reference);
    const view = await f.service.show(f.reference);
    assert.equal(view.trust, "local-unverified"); assert.equal(view.authentication, "not-provided");
    assert.equal(view.documents.length, f.subject.members.length); assert.equal(view.subject.purpose, "sign-content-only");
    assert.equal("effects" in view.subject, false); assert.equal("intent" in view, false);
    const pending = await f.service.request(f.reference);
    assert.equal((await f.service.request(f.reference)).requestKey, pending.requestKey);
    const decision = await f.service.decide(f.reference, "approved");
    assert.equal(decision.outcome, "approved"); assert.equal(decision.publication, "not-published");
    assert.deepEqual(await f.service.decide(f.reference, "approved"), decision);
    assert.deepEqual(await f.service.request(f.reference), decision, "no second unchanged prompt");
    await assert.rejects(() => f.service.decide(f.reference, "rejected"), /DOCUMENT_CONFLICT/);
    const sha = f.reference.slice(7);
    for (const effect of ["publish", "branchRef", "queue"] as const) assert.throws(() => f.journal.approved(sha, String(decision.decisionId), effect));
    assert.throws(() => f.journal.effect(sha, String(decision.decisionId), "publish", true));
    assert.equal(f.db.prepare("SELECT count(*) n FROM handoff_review_effects").get()?.n, 0);
    assert.deepEqual(f.journal.documents.events("example", "EX-1"), documents);
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), ticket);
  } finally { f.close(); }
});

for (const outcome of ["approved", "changes-requested", "rejected", "cancelled"] as const) test(`canonical ${outcome}, races and response loss retain one native decision`, async () => {
  const f = await fixture();
  try {
    f.host.afterPersist = stage => { if (stage === "requested") throw Error("lost request response"); };
    await assert.rejects(() => f.service.request(f.reference), /lost request response/);
    delete f.host.afterPersist;
    const r = await f.service.request(f.reference);
    assert.equal(r.expectedRevision, 0);
    f.host.afterPersist = stage => { if (stage === "issued") throw Error("lost decision response"); };
    await assert.rejects(() => f.service.decide(f.reference, outcome), /lost decision response/);
    delete f.host.afterPersist;
    const results = await Promise.all([f.service.decide(f.reference, outcome), f.service.decide(f.reference, outcome)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(f.journal.events(f.reference.slice(7)).length, 2);
    writeFileSync(join(f.root, `agent-teams/requirements/artifacts/presentations/${f.sha256}/${String(f.delivery.deliverySha256)}/index.html`), "tampered after saved decision");
    assert.deepEqual(await f.service.request(f.reference), results[0]);
    assert.equal((await f.service.show(f.reference)).actionable, false);
  } finally { f.close(); }
});

test("incomplete delivery never becomes actionable or issues an approval", async () => {
  const f = await fixture();
  try {
    await f.service.request(f.reference);
    writeFileSync(join(f.root, `agent-teams/requirements/artifacts/presentations/${f.sha256}/${String(f.delivery.deliverySha256)}/raw/member-2.md`), "tampered");
    assert.equal((await f.service.show(f.reference)).actionable, false);
    assert.deepEqual(await f.service.list("example", "EX-1"), []);
    await assert.rejects(() => f.service.decide(f.reference, "approved"));
    assert.equal(f.journal.events(f.reference.slice(7)).length, 1);
    f.host.assertOrigin = () => { throw Error("denied"); };
    await assert.rejects(() => f.service.show(f.reference), /denied/);
  } finally { f.close(); }
});

test("opposing concurrent outcomes cannot overwrite the first canonical decision", async () => {
  const f = await fixture();
  try {
    await f.service.request(f.reference);
    const results = await Promise.allSettled([f.service.decide(f.reference, "approved"), f.service.decide(f.reference, "rejected")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(f.journal.events(f.reference.slice(7)).length, 2);
  } finally { f.close(); }
});

test("failed durable issuance rolls back evidence and decision together", async () => {
  const f = await fixture();
  try {
    const pending = await f.service.request(f.reference);
    f.db.exec("CREATE TRIGGER fail_content_issue BEFORE INSERT ON handoff_review_events WHEN json_extract(NEW.body,'$.kind')='issued' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await assert.rejects(() => f.service.decide(f.reference, "approved"), /fixture failure/);
    assert.equal(f.journal.capture(String(pending.requestKey)), null);
    assert.equal(f.journal.events(f.reference.slice(7)).length, 1);
    f.db.exec("DROP TRIGGER fail_content_issue");
    assert.equal((await f.service.decide(f.reference, "rejected")).outcome, "rejected");
  } finally { f.close(); }
});

test("foreground detach leaves pending; external decision closes foreground without Cancel or second prompt", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.review(f.reference, async () => "detached")).status, "pending");
    assert.equal(f.journal.events(f.reference.slice(7)).length, 1);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const foreground = f.service.review(f.reference, async (_request, _view, signal) => {
      entered();
      return new Promise<"detached">(resolve => signal.addEventListener("abort", () => resolve("detached"), { once: true }));
    });
    await waiting;
    const result = await f.service.decide(f.reference, "approved");
    assert.deepEqual(await foreground, result);
    assert.deepEqual(await f.service.review(f.reference, async () => { throw Error("duplicate prompt"); }), result);
  } finally { f.close(); }
});
