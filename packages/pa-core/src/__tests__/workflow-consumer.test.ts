import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getDb } from "../registry/db.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { digest } from "../workflows/contracts.js";
import { authorizeStructuredConsumer, structuredTaskBaseline } from "../workflows/consumers.js";
import { bundle, bytes, definition } from "./workflow-fixtures.js";

test("structured baseline uses issued registry authority and exact artifacts, never approval paragraphs or additional resources", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-structured-consumer-")); const db = getDb(join(root, "registry.db"));
  try {
    const journal = new RegistryWorkflowJournal(db); const d = definition(); const b = bundle();
    const req = Buffer.from("# Deliberately no Approved status or approval paragraph\n"); const uat = Buffer.from("# UAT plan, not executed\n");
    b.requirements.sha256 = digest(req); b.uat.sha256 = digest(uat);
    const subjectRaw = bytes(b); const subjectSha256 = digest(subjectRaw); const definitionRaw = bytes(d);
    journal.append("wf-consumer", 0, () => ({ type: "admitted", eventId: "event-admitted", data: { definitionSha256: digest(definitionRaw), subjectSha256, configRevision: "a".repeat(40), caller: { deploymentId: "d-abcdef", repoKey: b.repository.key, repoRoot: b.repository.root, ticket: b.ticket, team: "requirements", mode: "analyze", identitySha256: "a".repeat(64) } } }), [subjectRaw, definitionRaw]);
    const capture = { schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-capture", version: "v1", sha256: "a".repeat(64) };
    journal.append("wf-consumer", 1, () => ({ type: "decision", eventId: "event-decision", data: { record: { schemaVersion: "pa-decision/v1", decisionId: "decision-one", kind: "package", runId: "wf-consumer", stepId: "approve", subjectRef: b.subjectId, subjectSha256,
      outcome: "approved", permissions: b.requestedPermissions, captureEvidenceRef: capture, principal: "synthetic-test-operator", issuedAt: "2026-10-28T00:00:00.000Z" } } }));
    const context = { repoKey: b.repository.key, repoRoot: b.repository.root, ticket: b.ticket, branch: b.handoff.branch, team: "builder", mode: "orchestrator", primaryRequirementsRef: b.requirements.ref };
    const read = (ref: string) => ref === b.requirements.ref ? req : uat;
    const baseline = structuredTaskBaseline(journal, "wf-consumer", "decision-one", context, read);
    assert.equal(baseline.baseSha, b.handoff.baseSha); assert.equal(baseline.schemaVersion, "structured-task-baseline/v1");
    assert.throws(() => authorizeStructuredConsumer(journal, "wf-consumer", "forged", context, ["git.commit-local"], read), /WORKFLOW_AUTHORITY/);
    assert.throws(() => structuredTaskBaseline(journal, "wf-consumer", "decision-one", { ...context, branch: "feature/EX-1-foreign" }, read), /WORKFLOW_AUTHORITY/);
    assert.throws(() => structuredTaskBaseline(journal, "wf-consumer", "decision-one", context, () => Buffer.from("Approved!")), /WORKFLOW_SOURCE/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM review_authorization_claims").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deployments").get() as { n: number }).n, 0);
    journal.append("wf-consumer", 2, () => ({ type: "revocation", eventId: "event-revoke", data: { decisionId: "decision-one", captureEvidenceRef: { ...capture, ref: "synthetic-revoke" }, principal: "synthetic-test-operator" } }));
    assert.throws(() => structuredTaskBaseline(journal, "wf-consumer", "decision-one", context, read), /WORKFLOW_AUTHORITY/);
    assert.equal(journal.read("wf-consumer").length, 3);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
