import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../workflows/contracts.js";
import { documentPackageSha, DocumentPackageError } from "../documents/package-contract.js";
import { handoffBranchIntentSha, type HandoffBranchIntent, type HandoffReviewSubject } from "../documents/handoff-contract.js";
import { completeHandoffBranch, RegistryHandoffBranchJournal, type HandoffBranchHost, type HandoffMaterializedLink, type HandoffRefObservation } from "../documents/handoff-branch.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

/** Actual disposable Git refs and durable SQLite; link/admission/serialization
 * ports are controlled source fixtures, NOT admitted native owner qualification. */
function fixture() {
  const f = documentRuntimeFixture();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("init", "-b", "develop"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-m", "fixture base");
  const base = git("rev-parse", "HEAD");
  const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "original-request", callerIdentitySha256: "a".repeat(64), expectedTicketVersion: "b".repeat(64),
    repository: { ...f.subject.repository, physicalIdentitySha256: "c".repeat(64) }, ticket: "EX-1", branch: "feature/EX-1-handoff", action: "create",
    base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-14T12:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" },
    plannedLinkSha256: "d".repeat(64), lineage: null };
  const subject: HandoffReviewSubject = { schemaVersion: "pa-handoff-review/v1", documentSubjectSha256: documentPackageSha(f.subject), branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: "e".repeat(64),
    selectionSha256: "f".repeat(64), callerIdentitySha256: "a".repeat(64), effects: { publish: true, branchRef: true, queue: false } };
  const journal = new RegistryHandoffBranchJournal(f.db);
  let approved = true, published = true, available = true, identity = "a".repeat(64), link: HandoffMaterializedLink | null = null, revision = 0, creates = 0, links = 0;
  let crash: "ref" | "link" | null = null, observation: HandoffRefObservation | undefined;
  const version = () => digest(JSON.stringify([revision, link]));
  const host: HandoffBranchHost = {
    serialize: run => run(), authenticate: () => ({ identitySha256: identity, selectionSha256: subject.selectionSha256 }),
    assertAvailable() { if (!available) throw new DocumentPackageError("DOCUMENT_CONFLICT"); },
    assertDecision() { if (!approved) throw new DocumentPackageError("DOCUMENT_AUTHORITY"); },
    assertPublished() { if (!published) throw new DocumentPackageError("DOCUMENT_AUTHORITY"); },
    isAncestor(a, b) { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } },
    observeRef(i, operationId) {
      if (observation) return observation;
      let headSha: string; try { headSha = git("rev-parse", "--verify", `refs/heads/${i.branch}`); } catch { return { state: "absent", history: "never-created" }; }
      let log = ""; try { log = git("reflog", "show", "--format=%gs", `refs/heads/${i.branch}`); } catch { /* no proof */ }
      const own = log.split("\n").includes(`handoff:${operationId}`);
      return { state: "present", headSha, evidenceSha256: digest(own ? `handoff:${operationId}` : "foreign"), owner: own ? { kind: "operation", id: operationId } : { kind: "unproven" } };
    },
    createRef(i, operationId) { creates++; git("update-ref", "--create-reflog", "-m", `handoff:${operationId}`, `refs/heads/${i.branch}`, i.base.sha, "0".repeat(40)); if (crash === "ref") { crash = null; throw Error("fixture crash after ref"); } },
    inspectLink: () => ({ version: version(), link }),
    materializeLink(_i, expected, next) { assert.equal(version(), expected); links++; link = structuredClone(next); revision++; if (crash === "link") { crash = null; throw Error("fixture crash after link"); } },
  };
  const run = (j = journal) => completeHandoffBranch(j, host, subject, intent, f.subject, "decision-fixture");
  return { ...f, document: f.subject, git, base, intent, subject, journal, host, run, counts: () => ({ creates, links }), getLink: () => link,
    revoke: () => { approved = false; }, unpublished: () => { published = false; }, occupied: () => { available = false; }, foreignCaller: () => { identity = "b".repeat(64); },
    crash: (point: "ref" | "link") => { crash = point; }, observe: (value: HandoffRefObservation) => { observation = value; }, advanceTicket: () => { revision++; } };
}
function rejectsCode(run: () => unknown, code: string) {
  assert.throws(run, (e: unknown) => e instanceof DocumentPackageError && e.code === code);
}

test("inactive branch core creates exactly the reviewed ref/link, preserves develop dirt and is idempotent", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "unrelated.txt"), "preserve this dirt");
    const before = f.git("status", "--porcelain=v2", "--untracked-files=all"), branch = f.git("branch", "--show-current");
    // Move develop after review: the reviewed pin is still used.
    f.git("commit", "--allow-empty", "-m", "develop advanced");
    const result = f.run();
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.base);
    assert.equal(f.git("branch", "--show-current"), branch);
    assert.equal(f.git("status", "--porcelain=v2", "--untracked-files=all"), before);
    assert.deepEqual(f.counts(), { creates: 1, links: 1 });
    assert.equal(result.launchReady, false); assert.equal(result.authorityGranted, false);
    assert.equal(result.queue, "not-performed-by-this-operation");
    assert.deepEqual(f.run(new RegistryHandoffBranchJournal(f.db)), result);
    assert.deepEqual(f.counts(), { creates: 1, links: 1 });
    assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  } finally { f.close(); }
});

for (const point of ["ref", "link"] as const) test(`inactive branch core resumes original operation after ${point} write/reply loss without duplicate effects`, () => {
  const f = fixture();
  try {
    f.crash(point); assert.throws(() => f.run(), /fixture crash/);
    const result = f.run(new RegistryHandoffBranchJournal(f.db));
    assert.equal(result.completion, "verified"); assert.deepEqual(f.counts(), { creates: 1, links: 1 });
    assert.equal(f.journal.events(result.operationId as string).length, 5);
  } finally { f.close(); }
});

test("inactive branch core revocation after ref prevents missing linkage, but already-written linkage can settle", () => {
  for (const point of ["ref", "link"] as const) {
    const f = fixture();
    try {
      f.crash(point); assert.throws(() => f.run()); f.revoke();
      if (point === "ref") { rejectsCode(() => f.run(), "DOCUMENT_AUTHORITY"); assert.equal(f.getLink(), null); }
      else assert.equal(f.run().completion, "verified");
      assert.equal(f.counts().creates, 1);
    } finally { f.close(); }
  }
});

test("inactive branch core rejects unproven collision, unknown absence, ownership, caller and publication failures", () => {
  for (const scenario of ["foreign-ref", "unknown", "uncertain-absence", "revoked", "unpublished", "occupied", "caller"] as const) {
    const f = fixture();
    try {
      if (scenario === "foreign-ref") f.git("update-ref", `refs/heads/${f.intent.branch}`, f.base);
      if (scenario === "unknown") f.observe({ state: "unknown" });
      if (scenario === "uncertain-absence") f.observe({ state: "absent", history: "uncertain" });
      if (scenario === "revoked") f.revoke(); if (scenario === "unpublished") f.unpublished();
      if (scenario === "occupied") f.occupied(); if (scenario === "caller") f.foreignCaller();
      assert.throws(() => f.run(), DocumentPackageError);
      assert.deepEqual(f.counts(), { creates: 0, links: 0 });
    } finally { f.close(); }
  }
});

test("inactive branch core refuses completed ref deletion/replacement instead of repairing history", () => {
  const f = fixture();
  try {
    f.run(); f.git("update-ref", "-d", `refs/heads/${f.intent.branch}`);
    rejectsCode(() => f.run(), "DOCUMENT_CONFLICT");
    assert.deepEqual(f.counts(), { creates: 1, links: 1 });
  } finally { f.close(); }
});

test("inactive branch core complete-ticket CAS rejects concurrent changes after physical creation", () => {
  const f = fixture();
  try {
    f.crash("ref"); assert.throws(() => f.run()); f.advanceTicket();
    rejectsCode(() => f.run(), "DOCUMENT_CONFLICT");
    assert.deepEqual(f.counts(), { creates: 1, links: 0 });
  } finally { f.close(); }
});

test("inactive branch core preserves authenticated advanced reuse at its original base without creating a ref", () => {
  const f = fixture();
  try {
    f.git("commit", "--allow-empty", "-m", "advanced descendant");
    const head = f.git("rev-parse", "HEAD");
    f.git("update-ref", `refs/heads/${f.intent.branch}`, head);
    f.intent.action = "reuse"; f.intent.base.provenance = "native-original-base"; f.intent.base.observedDevelopSha = head;
    f.intent.lineage = { operationSha256: "1".repeat(64), originalBaseSha: f.base, observedHeadSha: head };
    f.subject.branchIntentSha256 = handoffBranchIntentSha(f.intent);
    f.host.observeRef = () => ({ state: "present", headSha: f.git("rev-parse", `refs/heads/${f.intent.branch}`), evidenceSha256: "2".repeat(64), owner: { kind: "lineage", sha256: "1".repeat(64) } });
    assert.equal(f.run().completion, "verified");
    assert.equal(f.getLink()!.baseSha, f.base); assert.equal(f.getLink()!.headSha, head);
    assert.deepEqual(f.counts(), { creates: 0, links: 1 });
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), head);
  } finally { f.close(); }
});

test("inactive branch journal detects corrupted sequences and payloads instead of inventing absent state", () => {
  const f = fixture();
  try {
    const result = f.run(), operation = result.operationId as string;
    f.db.prepare("UPDATE handoff_branch_events SET payload = ? WHERE operation_id = ? AND sequence = 3").run("{}", operation);
    rejectsCode(() => f.run(), "DOCUMENT_INPUT");
    assert.deepEqual(f.counts(), { creates: 1, links: 1 });
  } finally { f.close(); }
});

test("inactive branch core cannot consume content/legacy decisions or changed document/intent/caller bindings", () => {
  const f = fixture();
  try {
    const original = structuredClone(f.subject);
    for (const patch of [{ effects: { publish: false, branchRef: false, queue: false } }, { documentSubjectSha256: "0".repeat(64) },
      { branchIntentSha256: "0".repeat(64) }, { callerIdentitySha256: "0".repeat(64) }]) {
      rejectsCode(() => completeHandoffBranch(f.journal, f.host, { ...original, ...patch }, f.intent, f.document, "decision-fixture"), "DOCUMENT_AUTHORITY");
    }
    assert.deepEqual(f.counts(), { creates: 0, links: 0 });
  } finally { f.close(); }
});
