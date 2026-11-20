import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DocumentPackageError } from "../documents/package-contract.js";
import {
  HANDOFF_INTENT_VERSION, HANDOFF_REQUEST_VERSION, HANDOFF_REVIEW_VERSION,
  handoffBranchIntentSha, handoffReviewSubjectSha, parseHandoffBranchIntent, parseHandoffRequest, parseHandoffReviewSubject,
  type HandoffBranchIntent, type HandoffReviewSubject,
} from "../documents/handoff-contract.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

const sha = (digit: string) => digit.repeat(64);
function intent(): HandoffBranchIntent {
  return { schemaVersion: HANDOFF_INTENT_VERSION, requestId: "original-request", callerIdentitySha256: sha("a"), expectedTicketVersion: sha("b"),
    repository: { key: "example", root: "/tmp/example", physicalIdentitySha256: sha("c") }, ticket: "EX-1", branch: "feature/EX-1-handoff", action: "create",
    base: { ref: "refs/heads/develop", sha: "d".repeat(40), observedDevelopSha: "d".repeat(40), observedAt: "2026-11-14T12:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" },
    plannedLinkSha256: sha("e"), lineage: null };
}
function review(): HandoffReviewSubject {
  return { schemaVersion: HANDOFF_REVIEW_VERSION, documentSubjectSha256: sha("1"), branchIntentSha256: handoffBranchIntentSha(intent()), deliverySha256: sha("2"),
    selectionSha256: sha("3"), callerIdentitySha256: sha("a"), effects: { publish: true, branchRef: true, queue: false } };
}
function rejects(call: () => unknown) {
  assert.throws(call, (error: unknown) => error instanceof DocumentPackageError && error.code === "DOCUMENT_INPUT");
}

test("P1 candidate intent preserves exact observed base and has deterministic structural identity, not authority", () => {
  const original = intent();
  assert.deepEqual(parseHandoffBranchIntent(original), original);
  const first = handoffBranchIntentSha(original);
  // Captured on the unchanged 3d7e95c baseline before PAP-324 product edits.
  assert.equal(first, "e57f7039b1c4dd65ed81035e9be91bb6554caf5d302e35301e679a81f48568d3");
  assert.equal(handoffReviewSubjectSha(review()), "b9336bf93d17c6fc753a8ef07c5deeb41c228c4c6d374ae2add5d0af03d49702");
  assert.equal(first, handoffBranchIntentSha(JSON.parse(JSON.stringify(original))));
  assert.equal(first, handoffBranchIntentSha(Object.fromEntries(Object.entries(original).reverse()) as unknown as HandoffBranchIntent));
  for (const mutate of [
    (x: HandoffBranchIntent) => { x.requestId = "changed-request"; },
    (x: HandoffBranchIntent) => { x.callerIdentitySha256 = sha("f"); },
    (x: HandoffBranchIntent) => { x.expectedTicketVersion = sha("f"); },
    (x: HandoffBranchIntent) => { x.repository.physicalIdentitySha256 = sha("f"); },
    (x: HandoffBranchIntent) => { x.repository.key = "other"; },
    (x: HandoffBranchIntent) => { x.repository.root = "/tmp/other"; },
    (x: HandoffBranchIntent) => { x.branch = "feature/EX-1-other"; },
    (x: HandoffBranchIntent) => { x.base.sha = x.base.observedDevelopSha = "f".repeat(40); },
    (x: HandoffBranchIntent) => { x.base.observedAt = "2026-11-14T12:00:01.000Z"; },
    (x: HandoffBranchIntent) => { x.plannedLinkSha256 = sha("f"); },
  ]) {
    const next = structuredClone(original); mutate(next);
    assert.notEqual(handoffBranchIntentSha(next), first);
  }
});

test("registered-convention history parsing accepts safe feat/work branches without consulting current policy", () => {
  for (const prefix of ["feat", "work", "feature"]) {
    const original = { ...intent(), ticket: "HR-005", branch: `${prefix}/HR-005-global-meta-recents` };
    assert.deepEqual(parseHandoffBranchIntent(original), original);
    const request = { schemaVersion: HANDOFF_REQUEST_VERSION, action: "plan", ticket: original.ticket,
      branch: original.branch, requestId: "hr-005-d-3c9cf8-branch-plan-r001", expectedTicketVersion: original.expectedTicketVersion };
    assert.deepEqual(parseHandoffRequest(JSON.stringify(request)), request);
  }
  const alphanumeric = { ...intent(), ticket: "P2-1", branch: "feat/P2-1-safe-topic" };
  assert.deepEqual(parseHandoffBranchIntent(alphanumeric), alphanumeric);
});

test("P1 advanced reuse requires explicit original-base lineage and preserves a distinct observed develop/head", () => {
  const record = intent(); record.action = "reuse"; record.base.provenance = "native-original-base";
  record.base.observedDevelopSha = "e".repeat(40);
  record.lineage = { operationSha256: sha("f"), originalBaseSha: record.base.sha, observedHeadSha: "a".repeat(40) };
  assert.deepEqual(parseHandoffBranchIntent(record), record);
  const noLineage = structuredClone(record); noLineage.lineage = null;
  rejects(() => parseHandoffBranchIntent(noLineage));
  const wrongBase = structuredClone(record); wrongBase.lineage!.originalBaseSha = "b".repeat(40);
  rejects(() => parseHandoffBranchIntent(wrongBase));
  const wrongProvenance = structuredClone(record); wrongProvenance.base.provenance = "local-develop-ref";
  rejects(() => parseHandoffBranchIntent(wrongProvenance));
  // Neither this parser nor a structurally valid lineage proves ancestry or ownership.
});

test("P1 intent rejects unknown fields, invalid pins/provenance/roots, foreign branch and legacy grants", () => {
  const original = intent();
  const cases: unknown[] = [
    { ...original, schemaVersion: "pa-document-package/v1" }, { ...original, authorityGranted: true },
    { ...original, outcome: "approved" }, { ...original, branch: "feature/EX-2-handoff" },
    { ...original, ticket: "ex-1" }, { ...original, branch: "feature/EX-1-topic/../escape" },
    { ...original, branch: "feature/EX-1-topic.lock" }, { ...original, requestId: "x\ncommand" },
    { ...original, callerIdentitySha256: "A".repeat(64) },
    { ...original, lineage: { operationSha256: sha("f"), originalBaseSha: original.base.sha, observedHeadSha: original.base.sha } },
    ...["relative", "/tmp/../example", "/tmp//example", "/tmp/example/", "/tmp\\example"].map(root => ({ ...original, repository: { ...original.repository, root } })),
    ...["main", "refs/remotes/origin/develop"].map(ref => ({ ...original, base: { ...original.base, ref } })),
    ...["a".repeat(7), "A".repeat(40), "not-a-sha"].map(pin => ({ ...original, base: { ...original.base, sha: pin } })),
    ...["2026-02-30T12:00:00.000Z", "2026-11-14T12:00:00+00:00", "unknown"].map(observedAt => ({ ...original, base: { ...original.base, observedAt } })),
    { ...original, base: { ...original.base, remoteFreshness: "fresh" } },
    { ...original, base: { ...original.base, sha: "f".repeat(40) } },
    { ...original, base: { ...original.base, provenance: "caller" } },
    { ...original, base: { ...original.base, extraGrant: true } },
  ];
  for (const candidate of cases) rejects(() => parseHandoffBranchIntent(candidate));
});

test("P1 review has four finite effect selections; document scopes cannot be substituted", () => {
  for (const effects of [
    { publish: false, branchRef: false, queue: false }, { publish: true, branchRef: false, queue: false },
    { publish: true, branchRef: true, queue: false }, { publish: true, branchRef: true, queue: true },
  ]) assert.deepEqual(parseHandoffReviewSubject({ ...review(), effects }).effects, effects);
  for (const effects of [
    { publish: false, branchRef: true, queue: false }, { publish: false, branchRef: false, queue: true },
    { publish: true, branchRef: false, queue: true }, { publish: false, branchRef: true, queue: true },
    { publish: "true", branchRef: true, queue: false }, { publish: true, branchRef: true, queue: false, launch: true },
  ]) rejects(() => parseHandoffReviewSubject({ ...review(), effects }));
  for (const extra of [{ scope: "publish-and-queue" }, { decisionId: "imported" }, { principal: "human" }, { outcome: "approved" }, { permissions: ["git.local"] }]) {
    rejects(() => parseHandoffReviewSubject({ ...review(), ...extra }));
  }
  rejects(() => parseHandoffReviewSubject({ ...review(), schemaVersion: "pa-document-confirmation/v1" }));
  const original = review(), hash = handoffReviewSubjectSha(original);
  for (const field of ["documentSubjectSha256", "branchIntentSha256", "deliverySha256", "selectionSha256", "callerIdentitySha256"] as const) {
    assert.notEqual(handoffReviewSubjectSha({ ...original, [field]: sha("f") }), hash);
  }
  assert.notEqual(handoffReviewSubjectSha({ ...original, effects: { ...original.effects, queue: true } }), hash);
});

test("P1 desired requests exclude all caller-supplied observations, paths, programs and grants", () => {
  const requests = [
    { schemaVersion: HANDOFF_REQUEST_VERSION, action: "plan", ticket: "EX-1", requestId: "original-request", branch: "feature/EX-1-handoff", expectedTicketVersion: sha("a") },
    { schemaVersion: HANDOFF_REQUEST_VERSION, action: "review", subjectSha256: sha("b"), expectedRevision: 0 },
    { schemaVersion: HANDOFF_REQUEST_VERSION, action: "complete-branch", subjectSha256: sha("b"), decisionId: "decision-original", expectedRevision: 2 },
    { schemaVersion: HANDOFF_REQUEST_VERSION, action: "open", deliverySha256: sha("c") },
  ];
  for (const request of requests) {
    assert.deepEqual(parseHandoffRequest(JSON.stringify(request)), request);
    for (const extra of [{ root: "/tmp/other" }, { baseSha: "d".repeat(40) }, { actor: "operator" }, { outcome: "approved" },
      { url: "https://example.invalid" }, { path: "/tmp/reader.html" }, { program: "browser" }, { callback: "exec" }, { env: {} },
      { receipt: "imported" }, { authorityGranted: true }, { effects: { branchRef: true } }, { selectionSha256: sha("a") }]) {
      rejects(() => parseHandoffRequest(JSON.stringify({ ...request, ...extra })));
    }
  }
  rejects(() => parseHandoffRequest(JSON.stringify({ ...requests[1], deliverySha256: sha("c") })));
  rejects(() => parseHandoffRequest(JSON.stringify({ ...requests[2], expectedRevision: -1 })));
  rejects(() => parseHandoffRequest(JSON.stringify({ ...requests[2], expectedRevision: 1.5 })));
  rejects(() => parseHandoffRequest(JSON.stringify({ ...requests[0], branch: "feature/EX-2-handoff" })));
  rejects(() => parseHandoffRequest(JSON.stringify({ ...requests[3], action: "launch" })));
  rejects(() => parseHandoffRequest('{"schemaVersion":"pa-handoff-request/v1","action":"open","action":"review","deliverySha256":"' + sha("c") + '"}'));
  rejects(() => parseHandoffRequest('{"schemaVersion":"pa-handoff-request/v1","action":"open","deliverySha256":"' + sha("c") + '","delivery\\u0053ha256":"' + sha("c") + '"}'));
  rejects(() => parseHandoffRequest(" ".repeat(65537)));
  rejects(() => parseHandoffRequest("\ud800"));
});

test("P1 disposable owner reproduction: retained service has inspection/companions but no handoff effect or full reader", async () => {
  const f = documentRuntimeFixture();
  try {
    f.host.workspaceProfile = true; f.host.confirmationProfile = true;
    f.host.inspectBranch = () => ({ code: "MISSING_LINK", launchReady: false, authorityGranted: false });
    const capabilities = (await f.call({ action: "capabilities" })).result as Record<string, unknown>;
    assert.equal(capabilities.sourceWriting, false);
    assert.equal(capabilities.branchBridge, "read-only-existing-owner-inspection");
    assert.equal(capabilities.preview, "safe-static-html-companion");
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    const revision = f.revision(), ticketPath = join(f.root, "tickets", "EX-1.json"), before = readFileSync(ticketPath);
    const presentation = await f.call({ action: "present", sha256: f.sha256 });
    assert.equal(presentation.ok, true);
    const result = presentation.result as Record<string, unknown>;
    assert.equal(result.schemaVersion, "pa-document-presentation/v1");
    assert.equal(Object.hasOwn(result, "entry"), false);
    assert.equal(Object.hasOwn(result, "index"), false);
    const manifest = JSON.parse(readFileSync(fileURLToPath(result.manifest as string), "utf8"));
    assert.equal(manifest.members.length, f.subject.members.length);
    for (const action of ["plan", "review", "complete-branch", "open"]) {
      const reply = await f.call({ action, subjectSha256: sha("b") });
      assert.equal(reply.ok, false); assert.equal(reply.code, "DOCUMENT_INPUT");
    }
    assert.equal(f.revision(), revision);
    assert.deepEqual(readFileSync(ticketPath), before);
  } finally { f.close(); }
});
