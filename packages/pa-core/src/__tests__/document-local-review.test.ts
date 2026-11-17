import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { LocalHandoffReviewService, HandoffReviewService, type LocalHandoffReviewHost } from "../documents/handoff-review.js";
import { executeLocalReview, localHandoffReviewHooks, verifyLocalReviewOrigin } from "../documents/local-review.js";
import { handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffReviewSubject, parseLocalReviewRequest, type HandoffBranchIntent, type LocalHandoffReviewSubject } from "../documents/handoff-contract.js";
import { nativeHandoffPlanIdentity } from "../documents/handoff-planning.js";
import { presentFullDocumentReader } from "../documents/reader-publication.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { creationDigest } from "../tickets/create-intent.js";
import { digest } from "../workflows/contracts.js";
import { MODE_CAPABILITY_SESSION } from "../mode-capabilities.js";
import { readProcessFingerprint, withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { preparedRepositoryTicketReservationPath, withPreparedTicketCapacity, withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { assertLocalHandoffRepository, withLocalHandoffRepository } from "../documents/handoff-preflight.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

async function fixture(verify = false, allow = ["document.handoff", "document.local-review", "document.package"]) {
  const f = documentRuntimeFixture();
  try {
  f.store.update("EX-1", { title: "Stable v2 local-review fixture" });
  Object.assign(process.env, { PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "registry.db") });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const binding = JSON.stringify({ schemaVersion: "pa-mode-capability-binding/v1", configRevision: "a".repeat(40), resourcePath: "teams/requirements.yaml", resourceSha256: "b".repeat(64), profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: [...allow].sort() } });
  const caller = { identitySha256: "a".repeat(64), selectionSha256: digest(binding), deploymentId: "d-314001", sessionId: "original-native-session", repoKey: "example", repoRoot: f.repo, ticket: "EX-1" };
  const planIdentity = nativeHandoffPlanIdentity(caller, "native-plan"), before = f.store.get("EX-1")!, base = git("rev-parse", "HEAD");
  const physicalIdentitySha256 = withRepositoryRefTicketExclusion("example", f.repo, exclusion => withRepositoryRefAdmission(f.repo, exclusion, id => id));
  const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "native-plan", callerIdentitySha256: caller.identitySha256, expectedTicketVersion: creationDigest(before),
    repository: { key: "example", root: f.repo, physicalIdentitySha256 }, ticket: "EX-1", branch: "feature/EX-1-local", action: "create",
    base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-17T00:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" }, plannedLinkSha256: creationDigest(null), lineage: null };
  f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "plan", intent }, "requirements/analyze", planIdentity, { assertCurrent() {}, assertSnapshot() {} });
  f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
  const delivery = await presentFullDocumentReader(f.subject, f.root, hash => f.journal.snapshot(hash));
  f.db.pragma("synchronous = FULL");
  f.db.prepare(`INSERT INTO registry_events(deployment_id,team,event,timestamp,mode,runtime,binary,note,repo,repo_root,worktree_root,ticket_id,mode_capability_binding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(caller.deploymentId, "requirements", "started", "2026-11-17T00:00:00.000Z", "analyze", "pi", "ppa", MODE_CAPABILITY_SESSION, f.repo, f.repo, f.repo, "EX-1", binding);
  // Origin is no longer running. Local review must not pretend to authenticate it.
  f.db.prepare("INSERT INTO registry_events(deployment_id,team,event,timestamp,status) VALUES(?,?,?,?,?)").run(caller.deploymentId, "requirements", "completed", "2026-11-17T00:01:00.000Z", "completed");
  const subject: LocalHandoffReviewSubject = { schemaVersion: "pa-handoff-review/v2", documentSubjectSha256: f.sha256, branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: String(delivery.deliverySha256),
    selectionSha256: caller.selectionSha256, callerIdentitySha256: caller.identitySha256, effects: { publish: true, branchRef: true, queue: false }, origin: { deploymentId: caller.deploymentId, sessionId: caller.sessionId, planIdentity } };
  const journal = new RegistryHandoffReviewJournal(f.db), sha = journal.freeze(subject, intent);
  let checks = 0;
  const host: LocalHandoffReviewHost = { artifactRoot: f.root, tickets: f.store, ...localHandoffReviewHooks(f.db, f.store, journal, f.root), assertOrigin(value, plan) { checks++; if (verify) verifyLocalReviewOrigin(f.db, f.store, value, plan); } };
  const local = new LocalHandoffReviewService(journal, host);
  const call = (input: Record<string, unknown>) => executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", subjectSha256: sha, ...input }));
  return { ...f, git, intent, localSubject: subject, caller, planIdentity, journal, sha, host, local, call, checks: () => checks };
  } catch (error) { f.close(); throw error; }
}

for (const sameTicket of [false, true]) test(`local handoff inventory admits only proven unrelated idle custody; same ticket: ${sameTicket}`, async () => {
  const f = await fixture();
  try {
    const ticket = sameTicket ? f.intent.ticket : "EX-999";
    const options = { canonicalRepoKey: "example", canonicalRepoRoot: f.repo };
    const reservation = withPreparedTicketCapacity(options, tx => {
      const result = tx.reserve({ ticket, operationId: "1".repeat(64), reservationId: "2".repeat(64), retainedAt: new Date().toISOString() });
      if (result.status !== "reserved") throw Error("fixture has no capacity");
      return result.reservation;
    });
    const path = preparedRepositoryTicketReservationPath(f.repo, ticket);
    const observe = (allowed: boolean) => {
      const before = readFileSync(path);
      if (allowed) withLocalHandoffRepository(f.intent, admission => assertLocalHandoffRepository(f.intent, admission));
      else assert.throws(() => withLocalHandoffRepository(f.intent, () => {}));
      assert.deepEqual(readFileSync(path), before, "custody observation must not reconcile retained evidence");
    };
    observe(false); // preparing, even though its custody.state is idle
    const ready = withPreparedTicketCapacity(options, tx => tx.update(reservation, { ...reservation, occupancy: "idle-ready", receiptId: "3".repeat(64) }));
    observe(!sameTicket);
    const processIdentity = readProcessFingerprint(process.pid); if (!processIdentity) throw Error("fixture process missing");
    const active = withPreparedTicketCapacity(options, tx => tx.update(ready, { ...ready, occupancy: "active", lineageId: "fixture-lineage",
      custody: { state: "orchestrator-direct", holder: { deploymentId: "d-314001", process: processIdentity }, inFlightOperation: null } }));
    observe(false);
    withPreparedTicketCapacity(options, tx => tx.update(active, { ...active, occupancy: "uncertain-retained", custody: { state: "uncertain-blocked", holder: null, inFlightOperation: null } }));
    observe(false);
    assert.throws(() => assertLocalHandoffRepository(f.intent, { identitySha256: f.intent.repository.physicalIdentitySha256 }), /absent/);
  } finally { f.close(); }
});

const request = (action: string, extra = {}) => JSON.stringify({ schemaVersion: "pa-local-review/v1", action, subjectSha256: "a".repeat(64), ...extra });
test("strict local request grammar accepts no actor, provenance, coordinates, duplicate keys or effects", () => {
  for (const raw of [request("request", { expectedRevision: 0, actor: "human" }), request("show", { root: "/tmp" }), request("decide", { expectedRevision: 0, requestKey: "b".repeat(64), outcome: "approve" }), request("revoke", { expectedRevision: 0 }), request("show").replace('"action":"show"', '"action":"show","act\\u0069on":"show"'), request("show") + " ".repeat(65536)]) assert.throws(() => parseLocalReviewRequest(raw), /DOCUMENT_INPUT/);
  assert.equal(parseLocalReviewRequest(request("request", { expectedRevision: 0 })).action, "request");
  assert.throws(() => parseLocalReviewRequest(request("decide", { expectedRevision: 1, requestKey: "b".repeat(64), outcome: "approved", principal: "local-unverified" })), /DOCUMENT_INPUT/);
});

test("v2 origin coordinates are immutable bindings, not optional v1 additions", async () => {
  const f = await fixture();
  try {
    const changed = structuredClone(f.localSubject); changed.origin.sessionId = "different-session";
    assert.notEqual(handoffReviewSubjectSha(changed), f.sha);
    assert.throws(() => parseHandoffReviewSubject({ ...f.localSubject, schemaVersion: "pa-handoff-review/v1" }), /DOCUMENT_INPUT/);
    const { origin: _origin, ...bindings } = f.localSubject;
    assert.throws(() => parseHandoffReviewSubject(bindings), /DOCUMENT_INPUT/);
  } finally { f.close(); }
});

test("request-only persistence, full show and atomic exact decision replay use the existing journal", async () => {
  const f = await fixture();
  try {
    const ticket = readFileSync(join(f.root, "tickets/EX-1.json"));
    const r = await f.local.request(f.sha, 0);
    assert.deepEqual(await f.local.request(f.sha, 0), r);
    assert.equal(f.journal.events(f.sha).length, 1); assert.equal(f.journal.capture(r.requestKey), null);
    const show = await f.local.show(f.sha);
    assert.equal(show.trust, "local-unverified"); assert.equal(show.pendingReview, true);
    assert.deepEqual(show.subject, f.localSubject); assert.deepEqual(show.inventory, f.subject.members);
    assert.ok(Array.isArray(show.documents)); assert.equal(show.documents.length, f.subject.members.length);
    const result = await f.local.decide(f.sha, 0, r.requestKey, "approved");
    assert.equal(result.principal, "local-unverified"); assert.equal(result.method, "unauthenticated-local-confirmation");
    assert.deepEqual(await f.local.decide(f.sha, 0, r.requestKey, "approved"), result);
    await assert.rejects(() => f.local.decide(f.sha, 0, r.requestKey, "rejected"), /DOCUMENT_CONFLICT/);
    await assert.rejects(() => f.local.decide(f.sha, 1, r.requestKey, "approved"), /DOCUMENT_CONFLICT/);
    assert.equal(f.journal.events(f.sha).length, 2);
    assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), ticket);
    assert.deepEqual(f.journal.documents.events("example", "EX-1").map(e => e.data.kind), ["frozen"]);
    assert.ok(f.checks() > 0);
  } finally { f.close(); }
});

for (const point of ["requested", "issued"] as const) test(`v2 reply loss after ${point} retains the same bytes and pending requests remain decidable`, async () => {
  const f = await fixture();
  try {
    if (point === "requested") {
      f.host.afterPersist = stage => { if (stage === point) throw Error("reply loss"); };
      await assert.rejects(() => f.local.request(f.sha, 0), /reply loss/);
      delete f.host.afterPersist;
    }
    const r = await f.local.request(f.sha, 0);
    f.host.afterPersist = stage => { if (stage === "issued") throw Error("reply loss"); };
    await assert.rejects(() => f.local.decide(f.sha, 0, r.requestKey, "approved"), /reply loss/);
    const bytes = f.journal.capture(r.requestKey);
    delete f.host.afterPersist;
    const first = await f.local.decide(f.sha, 0, r.requestKey, "approved");
    // Later develop movement and damaged presentation cannot retarget an issued result.
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "later");
    writeFileSync(join(f.root, `agent-teams/requirements/artifacts/presentations/${f.sha256}/${f.localSubject.deliverySha256}/index.html`), "later damaged delivery");
    assert.deepEqual(await f.local.decide(f.sha, 0, r.requestKey, "approved"), first);
    assert.deepEqual(f.journal.capture(r.requestKey), bytes);
    await assert.rejects(() => f.local.decide(f.sha, 0, r.requestKey, "cancelled"), /DOCUMENT_CONFLICT/);
  } finally { f.close(); }
});

test("capture and issuance roll back together if the durable issued write fails", async () => {
  const f = await fixture();
  try {
    const r = await f.local.request(f.sha, 0);
    f.db.exec("CREATE TRIGGER fail_local_issue BEFORE INSERT ON handoff_review_events WHEN json_extract(NEW.body,'$.kind')='issued' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await assert.rejects(() => f.local.decide(f.sha, 0, r.requestKey, "approved"), /fixture failure/);
    assert.equal(f.journal.capture(r.requestKey), null); assert.equal(f.journal.events(f.sha).length, 1);
    f.db.exec("DROP TRIGGER fail_local_issue");
    assert.equal((await f.local.decide(f.sha, 0, r.requestKey, "rejected")).outcome, "rejected");
  } finally { f.close(); }
});

for (const outcome of ["approved", "changes-requested", "rejected", "cancelled"] as const) test(`revocation is request-only; ${outcome} finalizes only its exact persisted target`, async () => {
  const f = await fixture();
  try {
    const r = await f.local.request(f.sha, 0), d = await f.local.decide(f.sha, 0, r.requestKey, "approved");
    assert.equal(typeof d.decisionId, "string"); if (typeof d.decisionId !== "string") throw Error("invalid fixture");
    const revoke = await f.local.revoke(f.sha, 2, d.decisionId);
    assert.notEqual(revoke.requestKey, r.requestKey); assert.equal(f.journal.events(f.sha).length, 3);
    assert.throws(() => f.journal.approved(f.sha, d.decisionId, "publish"), /DOCUMENT_AUTHORITY/);
    assert.deepEqual(await f.local.revoke(f.sha, 2, d.decisionId), revoke);
    await f.local.decide(f.sha, 2, revoke.requestKey, outcome);
    if (outcome === "approved") assert.throws(() => f.journal.approved(f.sha, d.decisionId, "publish"), /DOCUMENT_AUTHORITY/);
    else assert.equal(f.journal.approved(f.sha, d.decisionId, "publish").decisionId, d.decisionId);
    assert.deepEqual(await f.local.decide(f.sha, 0, r.requestKey, "approved"), d, "replay remains exactly the original outcome result");
  } finally { f.close(); }
});

test("cross-subject keys, conflicting concurrent decisions and imported local captures cannot widen provenance", async () => {
  const f = await fixture();
  try {
    const r = await f.local.request(f.sha, 0);
    await assert.rejects(() => f.local.decide(f.sha, 0, "0".repeat(64), "approved"), /DOCUMENT_CONFLICT/);
    assert.throws(() => f.journal.saveCapture(f.sha, r.requestKey, Buffer.from("forged evidence")), /DOCUMENT_AUTHORITY/);
    const results = await Promise.allSettled([f.local.decide(f.sha, 0, r.requestKey, "approved"), f.local.decide(f.sha, 0, r.requestKey, "rejected")]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(f.journal.events(f.sha).length, 2);
    const saved = f.journal.events(f.sha)[0]; assert.equal(saved.kind, "requested");
    if (saved.kind !== "requested") throw Error("invalid fixture");
    assert.throws(() => f.journal.issue(f.sha, saved.request, new Date().toISOString()), /DOCUMENT_AUTHORITY/);
    const native = new HandoffReviewService(f.journal, { artifactRoot: f.root, tickets: f.store, authenticate: () => f.caller, assertAvailable() {}, async capture() { throw Error("v1 capture must not run"); } });
    await assert.rejects(() => native.review(f.sha, 0), /DOCUMENT_AUTHORITY/);
    assert.throws(() => native.authorize(f.sha, saved.request.decisionId, "publish"), /DOCUMENT_UNAVAILABLE/);
  } finally { f.close(); }
});

test("v2 effect approval fails closed without the serialized eligibility owner, while nonapproval can settle the request", async () => {
  const f = await fixture();
  try {
    const boundary = f.host.withApprovalBoundary;
    delete f.host.withApprovalBoundary;
    await assert.rejects(() => f.local.request(f.sha, 0), /DOCUMENT_UNAVAILABLE/); assert.equal(f.journal.events(f.sha).length, 0);
    f.host.withApprovalBoundary = boundary;
    const request = await f.local.request(f.sha, 0);
    delete f.host.withApprovalBoundary;
    await assert.rejects(() => f.local.decide(f.sha, 0, request.requestKey, "approved"), /DOCUMENT_UNAVAILABLE/);
    assert.equal(f.journal.capture(request.requestKey), null);
    assert.equal((await f.local.decide(f.sha, 0, request.requestKey, "rejected")).outcome, "rejected");
  } finally { f.close(); }
});

test("native v2 foreground shares the local owner, never manufactures native-human evidence, and replays without UI", async () => {
  const f = await fixture();
  try {
    let prompts = 0;
    const native = new HandoffReviewService(f.journal, { artifactRoot: f.root, tickets: f.store, authenticate: () => f.caller, assertAvailable() {},
      async capture() { throw Error("v1 evidence owner must not run"); }, localReview: {
        ...localHandoffReviewHooks(f.db, f.store, f.journal, f.root), assertOrigin: f.host.assertOrigin,
        async capture(request, view) { prompts++; assert.equal(request.schemaVersion, "pa-handoff-local-request/v2"); assert.equal(view.documents.length, f.subject.members.length); return "approved"; },
      } });
    assert.equal(await native.freeze(f.localSubject, f.intent, f.planIdentity), f.sha);
    await assert.rejects(() => native.freeze({ ...f.localSubject, origin: { ...f.localSubject.origin, sessionId: "foreign-session" } }, f.intent, f.planIdentity), /DOCUMENT_AUTHORITY/);
    const d = await native.review(f.sha, 0);
    assert.equal(d.principal, "local-unverified"); assert.equal(d.authentication, "not-provided");
    assert.deepEqual(await native.review(f.sha, 0), d); assert.equal(prompts, 1);
    const first = f.journal.events(f.sha)[0]; if (first.kind !== "requested") throw Error("invalid fixture");
    assert.equal(JSON.parse(f.journal.capture(first.request.requestKey)!.toString()).method, "unauthenticated-local-confirmation");
  } finally { f.close(); }
});

for (const loading of ["delayed", "rejected"] as const) for (const outcome of ["approved", "rejected", "changes-requested", "cancelled"] as const) test(`PAP-316 ${outcome} during ${loading} view loading returns canonical result without capture`, async () => {
  const f = await fixture(), originalView = LocalHandoffReviewService.prototype.view;
  let pending: Promise<Record<string, unknown>> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  try {
    const request = await f.local.request(f.sha, 0);
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const reading = new Promise<void>(resolve => { release = resolve; });
    LocalHandoffReviewService.prototype.view = async function (...args) {
      if (this !== f.local) {
        entered(); await reading;
        if (loading === "rejected") throw Error("DOCUMENT_SOURCE");
      }
      return originalView.apply(this, args);
    };
    let prompts = 0;
    const native = new HandoffReviewService(f.journal, { artifactRoot: f.root, tickets: f.store, authenticate: () => f.caller, assertAvailable() {},
      async capture() { throw Error("v1 forbidden"); }, localReview: { ...f.host, async capture() { prompts++; return "cancelled"; } } });
    pending = native.review(f.sha, 0);
    await ready;
    const canonical = await f.local.decide(f.sha, 0, request.requestKey, outcome);
    if (loading === "rejected") release();
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("Canonical decision did not settle while view loading was pending")), 1000);
    })]);
    assert.deepEqual(result, canonical); assert.equal(prompts, 0);
    assert.deepEqual(f.journal.events(f.sha).map(event => event.kind), ["requested", "issued"]);
  } finally {
    if (timer) clearTimeout(timer);
    release?.(); await pending?.catch(() => {});
    LocalHandoffReviewService.prototype.view = originalView; f.close();
  }
});

for (const disposition of ["stale", "revocation"] as const) test(`PAP-316 ${disposition} settles during delayed view without a second capture`, async () => {
  const f = await fixture(), originalView = LocalHandoffReviewService.prototype.view;
  let pending: Promise<Record<string, unknown>> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  try {
    const first = await f.local.request(f.sha, 0);
    let target: string | null = null, expectedRevision = 0;
    if (disposition === "revocation") {
      const approved = await f.local.decide(f.sha, 0, first.requestKey, "approved");
      target = String(approved.decisionId); expectedRevision = 2;
    }
    const request = target ? await f.local.revoke(f.sha, expectedRevision, target) : first;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const reading = new Promise<void>(resolve => { release = resolve; });
    LocalHandoffReviewService.prototype.view = async function (...args) {
      if (this !== f.local) { entered(); await reading; }
      return originalView.apply(this, args);
    };
    let prompts = 0;
    const native = new HandoffReviewService(f.journal, { artifactRoot: f.root, tickets: f.store, authenticate: () => f.caller, assertAvailable() {},
      async capture() { throw Error("v1 forbidden"); }, localReview: { ...f.host, async capture() { prompts++; return "cancelled"; } } });
    pending = native.review(f.sha, expectedRevision, target ? "revoke" : "capture", target);
    await ready;
    const canonical = target ? await f.local.decide(f.sha, expectedRevision, request.requestKey, "approved")
      : f.local.staleResult(f.sha, f.journal.markStale(f.sha, "f".repeat(40)));
    assert.deepEqual(await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("Canonical disposition did not settle during view loading")), 1000);
    })]), canonical);
    assert.equal(prompts, 0); assert.equal(f.journal.events(f.sha).length, target ? 4 : 2);
  } finally {
    if (timer) clearTimeout(timer);
    release?.(); await pending?.catch(() => {});
    LocalHandoffReviewService.prototype.view = originalView; f.close();
  }
});

test("all four production local operations deny a valid persisted v1 subject", async () => {
  const f = await fixture();
  try {
    const { origin: _origin, ...rest } = f.localSubject;
    const v1 = f.journal.freeze({ ...rest, schemaVersion: "pa-handoff-review/v1" }, f.intent);
    for (const operation of [{ action: "show" }, { action: "request", expectedRevision: 0 }, { action: "decide", expectedRevision: 0, requestKey: "b".repeat(64), outcome: "approved" }, { action: "revoke", expectedRevision: 0, decisionId: "decision-example" }]) await assert.rejects(() => f.call({ ...operation, subjectSha256: v1 }), /DOCUMENT_AUTHORITY/);
    assert.equal(f.journal.events(v1).length, 0);
  } finally { f.close(); }
});

test("production dispatch verifies saved native selection and original plan after origin ends, without a current actor", async () => {
  const f = await fixture(true);
  try {
    verifyLocalReviewOrigin(f.db, f.store, f.localSubject, f.intent);
    const schemas = f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    const show = await f.call({ action: "show" }); assert.equal(show.trust, "local-unverified");
    assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), schemas, "show allocates no tables");
    const r = await f.call({ action: "request", expectedRevision: 0 });
    assert.equal(typeof r.requestKey, "string");
    const d = await f.call({ action: "decide", expectedRevision: 0, requestKey: r.requestKey, outcome: "approved" });
    assert.equal(d.principal, "local-unverified");
    assert.deepEqual(await f.call({ action: "decide", expectedRevision: 0, requestKey: r.requestKey, outcome: "approved" }), d);
    const rev = await f.call({ action: "revoke", expectedRevision: 2, decisionId: d.decisionId });
    assert.equal(f.journal.events(f.sha).length, 3);
    await f.call({ action: "decide", expectedRevision: 2, requestKey: rev.requestKey, outcome: "approved" });
    assert.equal(f.journal.events(f.sha).length, 4);
  } finally { f.close(); }
});

for (const allow of [["document.handoff", "document.package"], ["document.local-review", "document.package"], ["document.local-review", "document.handoff"]]) test(`production denies original selection missing a required dependency: ${allow.join(",")}`, async () => {
  const f = await fixture(false, allow);
  try {
    for (const operation of [{ action: "show" }, { action: "request", expectedRevision: 0 }, { action: "decide", expectedRevision: 0, requestKey: "b".repeat(64), outcome: "approved" }, { action: "revoke", expectedRevision: 0, decisionId: "decision-example" }]) {
      await assert.rejects(() => f.call(operation), /DOCUMENT_AUTHORITY/);
    }
    assert.equal(f.journal.events(f.sha).length, 0);
  } finally { f.close(); }
});

for (const field of ["runtime", "parent_deployment_id", "resumed_from_deployment_id", "fallback", "ticket_id"] as const) test(`production denies incompatible saved origin ${field}`, async () => {
  const f = await fixture();
  try {
    f.db.prepare(`UPDATE registry_events SET ${field}=? WHERE event='started'`).run(field === "runtime" ? "opencode" : field === "fallback" ? 1 : field === "ticket_id" ? "EX-2" : "d-000001");
    await assert.rejects(() => f.call({ action: "show" }));
    assert.equal(f.journal.events(f.sha).length, 0);
  } finally { f.close(); }
});
