import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { RegistryHandoffReviewJournal, type HandoffReviewRequest } from "../registry/handoff-reviews.js";
import { HandoffReviewService, type NativeHandoffReviewHost } from "../documents/handoff-review.js";
import { HandoffPublicationService } from "../documents/handoff-publication.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, type HandoffBranchIntent, type HandoffReviewSubject } from "../documents/handoff-contract.js";
import { presentFullDocumentReader } from "../documents/reader-publication.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { documentDestination, documentPackageSha, type DocumentPackage } from "../documents/package-contract.js";
import { creationDigest } from "../tickets/create-intent.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

async function fixture(effects = { publish: true, branchRef: true, queue: false }) {
  const f = documentRuntimeFixture();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  f.store.update("EX-1", { title: "Stable complete native fixture" });
  f.db.pragma("synchronous = FULL");
  const physicalIdentitySha256 = withRepositoryRefTicketExclusion("example", f.repo, exclusion => withRepositoryRefAdmission(f.repo, exclusion, id => id));
  const before = f.store.get("EX-1")!;
  const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "native-plan", callerIdentitySha256: "a".repeat(64), expectedTicketVersion: creationDigest(before),
    repository: { key: "example", root: f.repo, physicalIdentitySha256 }, ticket: "EX-1", branch: "feature/EX-1-handoff", action: "create",
    base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-15T06:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" },
    plannedLinkSha256: creationDigest(null), lineage: null };
  const planIdentity = { scope: "e".repeat(64), requestId: "native-plan" };
  f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "plan", intent }, "documents/handoff", planIdentity, { assertCurrent() {}, assertSnapshot() {} });
  f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
  const delivery = await presentFullDocumentReader(f.subject, f.root, hash => f.journal.snapshot(hash));
  const subject: HandoffReviewSubject = { schemaVersion: "pa-handoff-review/v1", documentSubjectSha256: f.sha256, branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: delivery.deliverySha256 as string,
    selectionSha256: "f".repeat(64), callerIdentitySha256: "a".repeat(64), effects };
  let captures = 0, outcome = "approved", available = true;
  const native = (r: HandoffReviewRequest) => Buffer.from(JSON.stringify({ schemaVersion: "pa-handoff-native-evidence/v1", method: "pi-native-handoff-review", request: r,
    outcome, principal: `local-uid:${process.getuid?.()}`, interactionId: `interaction-${r.decisionId}`, boundary: "native-foreground-not-hostile-same-uid-isolation" }));
  const host: NativeHandoffReviewHost = { artifactRoot: f.root, tickets: f.store,
    authenticate: () => ({ identitySha256: "a".repeat(64), selectionSha256: "f".repeat(64), deploymentId: "d-abcdef", sessionId: "synthetic-native-session", repoKey: "example", repoRoot: f.repo, ticket: "EX-1" }),
    assertAvailable() { if (!available) throw Error("synthetic native owner unavailable"); },
    async capture(request, view) { captures++; assert.equal(view.documents.length, f.subject.members.length); assert.equal(view.subject.effects.branchRef, effects.branchRef); return native(request); } };
  const journal = new RegistryHandoffReviewJournal(f.db), review = new HandoffReviewService(journal, host);
  const sha = await review.freeze(subject, intent, planIdentity);
  const publication = new HandoffPublicationService(f.db, review, planIdentity);
  return { ...f, git, base, intent, handoffSubject: subject, sha, journal, review, publication, host, native, planIdentity,
    captures: () => captures, setOutcome: (value: string) => { outcome = value; }, setAvailable: (value: boolean) => { available = value; } };
}

test("distinct native review binds all full documents/intent/effects and original request replay prompts once", async () => {
  const f = await fixture();
  try {
    const decision = await f.review.review(f.sha, 0);
    assert.equal(f.captures(), 1); assert.equal(decision.outcome, "approved"); assert.equal(decision.originalExpectedRevision, 0);
    assert.deepEqual(await f.review.review(f.sha, 0), decision); assert.equal(f.captures(), 1);
    f.review.authorize(f.sha, decision.decisionId, "branchRef");
    assert.throws(() => f.review.authorize(f.sha, decision.decisionId, "queue"), /DOCUMENT_AUTHORITY/);
    assert.equal(f.journal.events(f.sha).length, 2);
    assert.deepEqual(f.journal.documents.events("example", "EX-1").map(e => e.data.kind), ["frozen"], "no legacy confirmation/intent synthesized");
    assert.equal(f.store.get("EX-1")!.linkedBranches[0]!.state, "planned");
  } finally { f.close(); }
});

for (const point of ["requested", "captured", "issued"] as const) test(`native decision response loss after ${point} never opens another unchanged review`, async () => {
  const f = await fixture();
  try {
    f.host.afterPersist = stage => { if (stage === point) throw Error("synthetic interruption"); };
    await assert.rejects(() => f.review.review(f.sha, 0), /synthetic interruption/);
    delete f.host.afterPersist;
    if (point === "requested") { await assert.rejects(() => f.review.review(f.sha, 0), /DOCUMENT_UNCERTAIN/); assert.equal(f.captures(), 0); }
    else { assert.equal((await f.review.review(f.sha, 0)).outcome, "approved"); assert.equal(f.captures(), 1); }
    await assert.rejects(() => f.review.review(f.sha, 1), /DOCUMENT_CONFLICT/);
  } finally { f.close(); }
});

for (const outcome of ["cancelled", "rejected", "changes-requested"]) test(`${outcome} cannot authorize publication, branch or queue`, async () => {
  const f = await fixture();
  try {
    f.setOutcome(outcome); const decision = await f.review.review(f.sha, 0);
    for (const effect of ["publish", "branchRef", "queue"] as const) assert.throws(() => f.review.authorize(f.sha, decision.decisionId, effect), /DOCUMENT_AUTHORITY/);
    await assert.rejects(() => f.publication.publish(f.sha, decision.decisionId), /DOCUMENT_AUTHORITY/);
    assert.equal(existsSync(join(f.root, documentDestination(f.subject, f.subject.members[0]!))), false);
    assert.equal(f.store.get("EX-1")!.doc_refs.length, 0);
  } finally { f.close(); }
});

test("content-only exact subject grants no effect even though document metadata proposes publication", async () => {
  const f = await fixture({ publish: false, branchRef: false, queue: false });
  try {
    const d = await f.review.review(f.sha, 0);
    for (const effect of ["publish", "branchRef", "queue"] as const) assert.throws(() => f.review.authorize(f.sha, d.decisionId, effect), /DOCUMENT_AUTHORITY/);
    await assert.rejects(() => f.publication.publish(f.sha, d.decisionId), /DOCUMENT_AUTHORITY/);
  } finally { f.close(); }
});

test("hostile/cross-request native evidence and caller drift never issue a grant or reopen a pending interaction", async () => {
  for (const kind of ["legacy", "foreign", "principal", "caller"] as const) {
    const f = await fixture();
    try {
      f.host.capture = async r => {
        if (kind === "caller") { const authenticate = f.host.authenticate; f.host.authenticate = () => ({ ...authenticate(), sessionId: "changed-session" }); return f.native(r); }
        const e = JSON.parse(f.native(r).toString());
        if (kind === "legacy") e.schemaVersion = "pa-document-confirmation/v1";
        if (kind === "foreign") e.request.subjectSha256 = "0".repeat(64);
        if (kind === "principal") e.principal = "local-uid:99999999";
        return Buffer.from(JSON.stringify(e));
      };
      await assert.rejects(() => f.review.review(f.sha, 0), /DOCUMENT_(?:AUTHORITY|INPUT|STALE)/);
      assert.equal(f.journal.events(f.sha).length, 1);
      assert.throws(() => f.review.authorize(f.sha, "decision-forged", "publish"));
    } finally { f.close(); }
  }
});

test("new publication records decision/delivery refs before primary; exact branch-only create stays unqueued", async () => {
  const f = await fixture();
  try {
    const decision = await f.review.review(f.sha, 0), stages: string[] = [], update = f.store.update.bind(f.store);
    f.store.update = (...args) => {
      if (args[1].doc_refs?.some(ref => ref.primary)) {
        const ticket = f.store.get("EX-1")!;
        assert.equal(ticket.doc_refs.filter(r => r.type === "attachment" && /handoff-approvals|presentations/.test(r.path)).length, 3);
        assert.equal(f.subject.members.every(m => ticket.doc_refs.some(r => r.path === documentDestination(f.subject, m))), true);
        stages.push("primary-after-all-refs");
      } return update(...args);
    };
    const status = f.store.get("EX-1")!.status, assignee = f.store.get("EX-1")!.assignee;
    await f.publication.publish(f.sha, decision.decisionId);
    assert.deepEqual(stages, ["primary-after-all-refs"]);
    assert.equal(f.publication.completeBranch(f.sha, decision.decisionId).completion, "verified");
    assert.equal(f.git("rev-parse", f.intent.branch), f.base);
    const ticket = f.store.get("EX-1")!, link = ticket.linkedBranches[0]!;
    assert.deepEqual({ repo: link.repo, branch: link.branch, state: link.state, baseSha: link.baseSha, headSha: link.headSha, sha: link.sha },
      { repo: "example", branch: f.intent.branch, state: "materialized", baseSha: f.base, headSha: f.base, sha: f.base });
    assert.equal(ticket.status, status); assert.equal(ticket.assignee, assignee);
    assert.throws(() => f.publication.queue(f.sha, decision.decisionId), /DOCUMENT_AUTHORITY/);
    assert.equal(f.captures(), 1); assert.equal(f.git("branch", "--show-current"), "develop");
    assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  } finally { f.close(); }
});

for (const point of ["intent", "tracking", "publication", "complete"] as const) test(`publication response loss after ${point} resumes original new-provenance operation`, async () => {
  const f = await fixture();
  try {
    const d = await f.review.review(f.sha, 0);
    const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === point) throw Error("synthetic publication loss"); });
    await assert.rejects(() => interrupted.publish(f.sha, d.decisionId), /synthetic publication loss/);
    const result = await f.publication.publish(f.sha, d.decisionId);
    assert.equal(result.publication, "verified"); assert.equal(f.captures(), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_review_effects").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("revocation after publication blocks remaining branch writes but permits exact publication observation", async () => {
  const f = await fixture();
  try {
    const d = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, d.decisionId);
    await f.review.review(f.sha, 2, "revoke", d.decisionId);
    assert.throws(() => f.publication.completeBranch(f.sha, d.decisionId), /DOCUMENT_AUTHORITY/);
    assert.equal((await f.publication.publish(f.sha, d.decisionId)).publication, "verified");
    assert.equal((await f.review.review(f.sha, 0)).revoked, true);
    assert.equal(f.store.get("EX-1")!.linkedBranches[0]!.state, "planned");
    assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
  } finally { f.close(); }
});

test("queue requires its own finite effect and actual completed correlated branch, then replays without a second review", async () => {
  const f = await fixture({ publish: true, branchRef: true, queue: true });
  try {
    const d = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, d.decisionId);
    assert.throws(() => f.publication.queue(f.sha, d.decisionId), /DOCUMENT_AUTHORITY/);
    f.publication.completeBranch(f.sha, d.decisionId);
    assert.equal(f.publication.queue(f.sha, d.decisionId).queue, "verified");
    assert.equal(f.publication.queue(f.sha, d.decisionId).queue, "verified");
    const ticket = f.store.get("EX-1")!; assert.equal(ticket.status, "pending-implementation"); assert.equal(ticket.assignee, "builder/team-manager");
    assert.equal(f.captures(), 1); assert.equal(f.journal.events(f.sha).length, 2);
  } finally { f.close(); }
});

test("incompatible primary, unavailable owner and delivery tamper do not begin publication or rewrite history", async () => {
  for (const kind of ["primary", "owner", "tamper", "legacy"] as const) {
    const f = await fixture();
    try {
      const d = await f.review.review(f.sha, 0);
      if (kind === "primary") f.store.update("EX-1", { add_doc_ref: { type: "attachment", path: "original/handoff.md", primary: true } });
      if (kind === "owner") f.setAvailable(false);
      if (kind === "tamper") writeFileSync(join(f.root, `agent-teams/requirements/artifacts/presentations/${f.sha256}/${f.handoffSubject.deliverySha256}/index.html`), "tampered");
      const before = readFileSync(join(f.root, "tickets/EX-1.json"));
      await assert.rejects(() => f.publication.publish(f.sha, kind === "legacy" ? "decision-historical-document" : d.decisionId));
      assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), before);
      assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_review_effects").get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test("concurrent identical review requests issue once, with no duplicate native interaction", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([f.review.review(f.sha, 0), f.review.review(f.sha, 0)]);
    assert.ok(results.some(r => r.status === "fulfilled"));
    assert.equal(f.captures(), 1); assert.equal(f.journal.events(f.sha).length, 2);
  } finally { f.close(); }
});

test("revoked partial publication cannot write missing tracking or files, but already complete effects remain valid", async () => {
  const f = await fixture();
  try {
    const d = await f.review.review(f.sha, 0);
    const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === "tracking") throw Error("partial publication"); });
    await assert.rejects(() => interrupted.publish(f.sha, d.decisionId), /partial publication/);
    await f.review.review(f.sha, 2, "revoke", d.decisionId);
    const before = readFileSync(join(f.root, "tickets/EX-1.json"));
    await assert.rejects(() => f.publication.publish(f.sha, d.decisionId), /DOCUMENT_AUTHORITY/);
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), before);
    assert.equal(existsSync(join(f.root, documentDestination(f.subject, f.subject.members[0]!))), false);
  } finally { f.close(); }
});

test("queue reply loss settles original queue identity; completed branch remains observable after revocation", async () => {
  const f = await fixture({ publish: true, branchRef: true, queue: true });
  try {
    const d = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, d.decisionId); f.publication.completeBranch(f.sha, d.decisionId);
    const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === "queue") throw Error("queue reply lost"); });
    assert.throws(() => interrupted.queue(f.sha, d.decisionId), /queue reply lost/);
    assert.equal(f.publication.queue(f.sha, d.decisionId).queue, "verified");
    await f.review.review(f.sha, 2, "revoke", d.decisionId);
    assert.equal(f.publication.completeBranch(f.sha, d.decisionId).completion, "verified");
    assert.throws(() => f.publication.queue(f.sha, d.decisionId), /DOCUMENT_AUTHORITY/);
    assert.equal(f.store.get("EX-1")!.status, "pending-implementation");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_review_effects").get() as { n: number }).n, 2);
  } finally { f.close(); }
});

test("a different subject or fresh review coordinate cannot bypass unresolved native ticket history", async () => {
  for (const kind of ["review", "publication"] as const) {
    const f = await fixture();
    try {
      if (kind === "review") {
        f.host.afterPersist = stage => { if (stage === "requested") throw Error("unknown native review"); };
        await assert.rejects(() => f.review.review(f.sha, 0), /unknown native review/); delete f.host.afterPersist;
      } else {
        const d = await f.review.review(f.sha, 0);
        const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === "intent") throw Error("pending publication"); });
        await assert.rejects(() => interrupted.publish(f.sha, d.decisionId), /pending publication/);
        await assert.rejects(() => f.review.review(f.sha, 2), /DOCUMENT_UNCERTAIN/);
      }
      const changed = { ...f.handoffSubject, effects: { publish: true, branchRef: true, queue: true } };
      const changedSha = await f.review.freeze(changed, f.intent, f.planIdentity);
      await assert.rejects(() => f.review.review(changedSha, 0), /DOCUMENT_UNCERTAIN/);
      assert.equal(f.journal.events(changedSha).length, 0);
      assert.equal(f.captures(), kind === "review" ? 0 : 1);
    } finally { f.close(); }
  }
});

async function successor(f: Awaited<ReturnType<typeof fixture>>, change: Partial<DocumentPackage> = {}) {
  const document = { ...structuredClone(f.subject), revision: 2, predecessor: f.sha256, ...change };
  const bytes = document.members.map(member => f.journal.documents.snapshot(member.sha256));
  f.journal.documents.freeze(document, f.journal.documents.events("example", "EX-1").length, bytes);
  const delivery = await presentFullDocumentReader(document, f.root, hash => f.journal.documents.snapshot(hash));
  const subject = { ...f.handoffSubject, documentSubjectSha256: documentPackageSha(document), deliverySha256: delivery.deliverySha256 as string };
  const sha = await f.review.freeze(subject, f.intent, f.planIdentity);
  return { document, sha, decision: await f.review.review(sha, 0) };
}

for (const point of ["none", "intent", "tracking", "publication", "complete"] as const) test(`native successor publication preserves predecessor bytes/refs and recovers original ${point} boundary`, async () => {
  const f = await fixture();
  try {
    const original = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, original.decisionId);
    const oldRefs = structuredClone(f.store.get("EX-1")!.doc_refs), oldBytes = f.subject.members.map(member => readFileSync(join(f.root, documentDestination(f.subject, member))));
    const next = await successor(f);
    if (point !== "none") {
      const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === point) throw Error("successor reply lost"); });
      await assert.rejects(() => interrupted.publish(next.sha, next.decision.decisionId), /successor reply lost/);
    }
    const result = await f.publication.publish(next.sha, next.decision.decisionId);
    assert.equal(result.publication, "verified"); assert.deepEqual(await f.publication.publish(next.sha, next.decision.decisionId), result);
    const ticket = f.store.get("EX-1")!;
    for (const old of oldRefs) assert.deepEqual(ticket.doc_refs.find(ref => ref.path === old.path), { ...old, primary: false });
    assert.deepEqual(f.subject.members.map(member => readFileSync(join(f.root, documentDestination(f.subject, member)))), oldBytes);
    assert.equal(ticket.doc_refs.filter(ref => ref.primary).length, 1);
    assert.equal(ticket.doc_refs.find(ref => ref.primary)!.path, documentDestination(next.document, next.document.members.find(member => member.role === "requirements")!));
    assert.equal(f.publication.completeBranch(next.sha, next.decision.decisionId).completion, "verified");
    assert.equal(f.captures(), 2, "one original and one changed-content successor review, never a bookkeeping replay");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_review_effects").get() as { n: number }).n, 2);
    assert.equal(ticket.status, "requirement-review"); assert.equal(ticket.assignee, "requirements/team-manager");
    assert.equal(f.journal.documents.events("example", "EX-1").filter(event => event.data.kind !== "frozen").length, 0, "no forged legacy events");
  } finally { f.close(); }
});

for (const fault of ["unpublished", "revoked", "missing-provenance", "tampered-bytes", "foreign-package", "foreign-primary"] as const) test(`successor blocks ${fault} without changing old primary/history or transferring grants`, async () => {
  const f = await fixture();
  try {
    const original = await f.review.review(f.sha, 0);
    if (fault !== "unpublished") await f.publication.publish(f.sha, original.decisionId);
    if (fault === "revoked") await f.review.review(f.sha, 2, "revoke", original.decisionId);
    if (fault === "missing-provenance") f.db.exec("DELETE FROM handoff_review_effects");
    const next = await successor(f, fault === "foreign-package" ? { packageId: "foreign" } : {});
    if (fault === "tampered-bytes") writeFileSync(join(f.root, documentDestination(f.subject, f.subject.members[0]!)), "changed old bytes");
    if (fault === "foreign-primary") {
      const path = join(f.root, "tickets/EX-1.json");
      writeFileSync(path, JSON.stringify({ ...f.store.get("EX-1"), doc_refs: [{ type: "attachment", path: "foreign.md", primary: true }] }));
    }
    const before = readFileSync(join(f.root, "tickets/EX-1.json"));
    await assert.rejects(() => f.publication.publish(next.sha, next.decision.decisionId));
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), before);
    assert.equal(f.journal.effect(next.sha, next.decision.decisionId, "publish").started, false);
    assert.equal(existsSync(join(f.root, documentDestination(next.document, next.document.members[0]!))), false);
  } finally { f.close(); }
});

test("retained native document publication proves predecessor only; successor still requires its own new finite decision", async () => {
  const f = await fixture();
  try {
    const oldDecision = await f.prepare();
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: f.revision(), decisionId: oldDecision })).ok, true);
    const next = await successor(f);
    await assert.rejects(() => f.publication.publish(next.sha, oldDecision), /DOCUMENT_AUTHORITY/);
    assert.equal((await f.publication.publish(next.sha, next.decision.decisionId)).publication, "verified");
    assert.equal(f.publication.completeBranch(next.sha, next.decision.decisionId).completion, "verified");
    assert.equal(f.captures(), 1, "retained decision is not translated into a handoff grant or repeated");
  } finally { f.close(); }
});

test("successor queue consumes only its own finite grant after exact successor ref/link readback", async () => {
  const f = await fixture({ publish: true, branchRef: true, queue: true });
  try {
    const original = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, original.decisionId);
    const next = await successor(f); await f.publication.publish(next.sha, next.decision.decisionId);
    assert.throws(() => f.publication.queue(next.sha, next.decision.decisionId), /DOCUMENT_AUTHORITY/);
    assert.throws(() => f.publication.completeBranch(next.sha, original.decisionId), /DOCUMENT_AUTHORITY/);
    f.publication.completeBranch(next.sha, next.decision.decisionId);
    assert.equal(f.publication.queue(next.sha, next.decision.decisionId).queue, "verified");
    assert.equal(f.store.get("EX-1")!.status, "pending-implementation"); assert.equal(f.captures(), 2);
    assert.equal(f.journal.effect(f.sha, original.decisionId, "queue").started, false);
  } finally { f.close(); }
});

test("successor interruption during member-ref publication resumes without early primary promotion", async () => {
  const f = await fixture();
  try {
    const original = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, original.decisionId);
    const next = await successor(f), update = f.store.update.bind(f.store);
    let interrupted = false;
    f.store.update = (...args) => {
      const result = update(...args);
      if (!interrupted && args[1].add_doc_ref?.path === documentDestination(next.document, next.document.members[1]!)) {
        interrupted = true; throw Error("member ref reply lost");
      }
      return result;
    };
    await assert.rejects(() => f.publication.publish(next.sha, next.decision.decisionId), /member ref reply lost/);
    assert.equal(f.store.get("EX-1")!.doc_refs.find(ref => ref.primary)!.path, documentDestination(f.subject, f.subject.members.find(member => member.role === "requirements")!));
    assert.equal((await f.publication.publish(next.sha, next.decision.decisionId)).publication, "verified");
    assert.equal(f.captures(), 2);
  } finally { f.close(); }
});

test("revoked partial successor retains its predecessor primary and cannot resume missing writes", async () => {
  const f = await fixture();
  try {
    const original = await f.review.review(f.sha, 0); await f.publication.publish(f.sha, original.decisionId);
    const next = await successor(f);
    const interrupted = new HandoffPublicationService(f.db, f.review, f.planIdentity, stage => { if (stage === "tracking") throw Error("partial successor"); });
    await assert.rejects(() => interrupted.publish(next.sha, next.decision.decisionId), /partial successor/);
    await f.review.review(next.sha, 2, "revoke", next.decision.decisionId);
    const before = readFileSync(join(f.root, "tickets/EX-1.json"));
    await assert.rejects(() => f.publication.publish(next.sha, next.decision.decisionId), /DOCUMENT_AUTHORITY/);
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), before);
    assert.equal(f.store.get("EX-1")!.doc_refs.find(ref => ref.primary)!.path, documentDestination(f.subject, f.subject.members.find(member => member.role === "requirements")!));
  } finally { f.close(); }
});

test("handoff subject/intent and native evidence tampering are detected by the actual registry consumer", async () => {
  const f = await fixture();
  try {
    const d = await f.review.review(f.sha, 0);
    const row = f.db.prepare("SELECT body FROM handoff_review_subjects WHERE sha256=?").get(f.sha) as { body: string };
    const changed = JSON.parse(row.body); changed.effects.queue = true;
    assert.notEqual(handoffReviewSubjectSha(changed), f.sha);
    f.db.prepare("UPDATE handoff_review_subjects SET body=? WHERE sha256=?").run(JSON.stringify(changed), f.sha);
    assert.throws(() => f.review.authorize(f.sha, d.decisionId, "publish"), /DOCUMENT_UNCERTAIN/);
  } finally { f.close(); }
});
