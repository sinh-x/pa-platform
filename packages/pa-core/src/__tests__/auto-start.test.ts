import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb } from "../registry/db.js";
import { RegistryAutoJournal } from "../auto/coordination.js";
import { AUTO_LOCAL_EFFECTS, AUTO_EXCLUDED_EFFECTS, autoStartSha256, parseAutoStartIntent, type AutoStartIntent } from "../auto/intent.js";
import { routeAutoTicket } from "../auto/waitlist.js";
import { RegistryDocumentJournal, documentDecisionRecords } from "../registry/documents.js";
import { AutoStartDecisionService, type AutoStartCaptureHost } from "../documents/auto-start.js";
import { digest } from "../workflows/contracts.js";
import type { DocumentPackage } from "../documents/package-contract.js";
function fixture(outcome: "approved" | "rejected" | "cancelled" | "changes-requested" = "approved", scope: AutoStartIntent["documentScope"] = "publish-and-queue") {
  const db = getDb(":memory:"), coordination = new RegistryAutoJournal(db), documents = new RegistryDocumentJournal(db);
  const bytes = ["Brief", "Requirements", "UAT not run"].map(s => Buffer.from(s));
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "synthetic", revision: 1, repository: { key: "pa-platform", root: "/synthetic" }, ticket: "PAP-1", predecessor: null,
    members: (["brief", "requirements", "uat"] as const).map((role, i) => ({ id: role, role, mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/drafts/d-aaaaaa/${role}.md`, description: "Synthetic", bytes: bytes[i]!.length, sha256: digest(bytes[i]!) })), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  const subjectSha256 = documents.freeze(subject, 0, bytes), entry = routeAutoTicket({ id: "PAP-1", project: "pa-platform", title: "Synthetic", priority: "medium", status: "requirement-review", createdAt: new Date().toISOString(), ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "pending", subjectSha256 } });
  const item = coordination.select(entry, "/synthetic", () => entry, () => {});
  const intent: AutoStartIntent = { schemaVersion: "pa-auto-start/v1", itemId: item.itemId, ticket: item.ticket, repository: subject.repository as AutoStartIntent["repository"], materialTicketSha256: "a".repeat(64), ticketVersion: "a".repeat(64), initialStatus: "requirement-review", initialAssignee: "sinh", subjectSha256, documentRevision: 1,
    runtime: "pi", team: "builder", mode: "orchestrator", provider: "openai-codex", model: "configured-fixture", configRoot: "/synthetic/config", configRevision: "b".repeat(40), configResourcesSha256: "c".repeat(64), objective: "Local fixture work only", timeoutSeconds: 1800, deadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
    branch: { name: "feature/PAP-1-auto", baseSha: "b".repeat(40), state: "planned", headSha: null }, validation: { matrixSha256: "d".repeat(64), commands: ["corepack pnpm test"] }, sourceScope: { files: ["src/fixture.ts"], directories: [], newPaths: [] }, localEffects: AUTO_LOCAL_EFFECTS, excludedEffects: AUTO_EXCLUDED_EFFECTS, documentScope: scope };
  let prompts = 0, live = true;
  const host: AutoStartCaptureHost = { authenticate: () => { if (!live) throw new Error("stale native caller"); return "e".repeat(64); }, assertCurrent() {}, capture: async () => {
    prompts++; const evidence = Buffer.from(`Synthetic native-port fixture ${prompts}, not a genuine human decision`);
    return { outcome, principal: "fixture", interactionId: `interaction-${prompts}`, evidence, evidenceSha256: digest(evidence) };
  } };
  return { db, coordination, documents, item, intent, host, service: new AutoStartDecisionService(documents, coordination), prompts: () => prompts, stale: () => { live = false; } };
}
test("native start binds complete exact intent and reconciles same request with one prompt", async () => {
  const f = fixture(); try {
    const proposal = f.service.propose(f.item, f.intent, f.host), approved = await f.service.review(proposal, f.host);
    assert.equal(approved.state, "approved-pending-dispatch"); assert.equal(approved.startSha256, autoStartSha256(f.intent));
    assert.equal((await f.service.review(approved, f.host)).decisionId, approved.decisionId); assert.equal(f.prompts(), 1);
    assert.equal(f.service.authorize(approved, f.host).provider, f.intent.provider);
    assert.equal(f.service.baseline(approved, f.host).schemaVersion, "auto-task-baseline/v1");
    assert.equal(documentDecisionRecords(f.documents.events(f.item.project, f.item.ticket), f.item.subjectSha256!).at(-1)?.decisionId, approved.decisionId);
  } finally { f.db.close(); }
});
test("ready work start/queue-only does not manufacture a new content approval", async () => {
  for (const scope of ["none", "queue-only"] as const) { const f = fixture("approved", scope); try {
    const approved = await f.service.review(f.service.propose(f.item, f.intent, f.host), f.host);
    assert.equal(approved.state, "approved-pending-dispatch"); assert.equal(f.prompts(), 1);
    assert.equal(documentDecisionRecords(f.documents.events(f.item.project, f.item.ticket), f.item.subjectSha256!).length, 0);
  } finally { f.db.close(); } }
});
test("reject, default cancel and request changes confer no dispatch authority", async () => {
  for (const outcome of ["rejected", "cancelled", "changes-requested"] as const) { const f = fixture(outcome); try {
    const result = await f.service.review(f.service.propose(f.item, f.intent, f.host), f.host);
    assert.throws(() => f.service.authorize(result, f.host));
    assert.equal(f.prompts(), 1); if (outcome === "rejected") assert.equal(f.coordination.active(), null); else assert.ok(f.coordination.active());
  } finally { f.db.close(); } }
});
test("old package decisions, revoked starts and changed intent bytes do not grant start", async () => {
  const f = fixture(); try {
    const proposal = f.service.propose(f.item, f.intent, f.host); assert.throws(() => f.service.authorize(proposal, f.host));
    assert.throws(() => f.service.propose(proposal, { ...f.intent, model: "changed" }, f.host));
    const approved = await f.service.review(proposal, f.host), evidence = Buffer.from("Synthetic revocation");
    f.documents.append(f.item.project, f.item.ticket, f.documents.events(f.item.project, f.item.ticket).length, { kind: "revoked", subjectSha256: f.item.subjectSha256!, decisionId: approved.decisionId!, evidenceSha256: digest(evidence) }, [evidence]);
    assert.throws(() => f.service.authorize(approved, f.host));
  } finally { f.db.close(); }
});
test("caller drift and failed native freshness checks leave no grant", async () => {
  const f = fixture(); try {
    const proposal = f.service.propose(f.item, f.intent, f.host);
    f.host.capture = async () => { f.stale(); return { outcome: "approved", principal: "fixture", interactionId: "interaction-stale", evidence: Buffer.from("fixture"), evidenceSha256: digest(Buffer.from("fixture")) }; };
    await assert.rejects(() => f.service.review(proposal, f.host)); assert.equal(f.service.decision(proposal), null);
  } finally { f.db.close(); }
});
test("explicit withdrawal preserves the old decision and denies its reuse without hiding pending work", async () => {
  const f = fixture(); try {
    const approved = await f.service.review(f.service.propose(f.item, f.intent, f.host), f.host);
    const evidence = Buffer.from("Synthetic explicit withdrawal fixture");
    f.host.withdraw = async () => ({ outcome: "approved", principal: "fixture", evidence, evidenceSha256: digest(evidence) });
    const revised = await f.service.requestChanges(approved, f.host);
    assert.equal(revised.startSha256, null); assert.equal(revised.decisionId, null); assert.equal(revised.state, "awaiting-review");
    assert.throws(() => f.service.authorize(approved, f.host));
    assert.ok(f.documents.events(f.item.project, f.item.ticket).some(e => e.data.kind === "revoked"));
  } finally { f.db.close(); }
});
test("start schema rejects imported authority, runtime fallback and broadened local effects", () => {
  const f = fixture(); try {
    for (const patch of [{ approved: true }, { runtime: "opencode" }, { team: "rogue-one" }, { excludedEffects: [] }, { localEffects: [...AUTO_LOCAL_EFFECTS, "remote.push"] }, { sourceScope: { files: ["../escape"], directories: [], newPaths: [] } }]) {
      assert.throws(() => parseAutoStartIntent(Buffer.from(JSON.stringify({ ...f.intent, ...patch }))));
    }
  } finally { f.db.close(); }
});
