import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../registry/db.js";
import { RegistryWorkflowJournal } from "../registry/workflows.js";
import { digest, type EvidenceRef, type WorkflowDefinition, type ReviewBundle } from "../workflows/contracts.js";
import { parseWorkflowDefinition } from "../workflows/definition.js";
import { JsonWorkflowService, type WorkflowHost } from "../workflows/service.js";
import type { WorkflowSelection } from "../workflows/selected.js";
import { bundle, bytes, definition, fixtureEvidence } from "./workflow-fixtures.js";

export interface WorkflowRuntimeFixture {
  root: string; db: Database.Database; journal: RegistryWorkflowJournal; host: WorkflowHost; selection: WorkflowSelection;
  service: JsonWorkflowService; bundle: ReviewBundle; evidence: Map<string, Buffer>; subject: Buffer; close(): void;
}
export function workflowRuntimeFixture(): WorkflowRuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "pa-json-workflow-")); const db: Database.Database = getDb(join(root, "registry.db"));
  const journal = new RegistryWorkflowJournal(db); const d: WorkflowDefinition = definition();
  d.requiredCapabilities.push("artifact.paired-publication"); d.steps[0]!.transitions.approved = "publish";
  d.steps.push({ id: "publish", order: 2, title: "Publish exact pair", kind: "publication", owner: "tickets", dependsOn: [{ stepId: "approve", outcome: "approved" }], when: true,
    inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }, { name: "decision", schemaVersion: "pa-decision/v1", source: "output", stepId: "approve", output: "decision" }],
    operation: { id: "publication.pair", version: "v1" }, authorization: ["artifact.publish-pair"], effects: ["artifact.write-pair"], outputs: [{ name: "pair", schemaVersion: "pa-publication-pair/v1" }],
    verification: [{ id: "publication.exact-pair", version: "v1", inputs: ["package", "decision"] }], transitions: { completed: "completed", failed: "blocked", unknown: "blocked" }, failurePolicy: { strategy: "reconcile", correctionOwner: "tickets" } });
  const raw = bytes(d); parseWorkflowDefinition(raw); const b = bundle(); b.workflow.sha256 = digest(raw);
  const evidence = fixtureEvidence(b);
  const selection: WorkflowSelection = { schemaVersion: "pa-workflow-selection/v1", configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64), bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "requirements", mode: "analyze", enabled: true, workflowId: d.workflowId, workflowVersion: d.version }], definitions: [{ definition: d, raw, sha256: digest(raw), configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64) }] };
  let captures = 0;
  const ref = (): EvidenceRef => ({ schemaVersion: "pa-workflow-evidence-ref/v1", ref: `synthetic-capture-${++captures}`, version: "v1", sha256: digest(`synthetic-${captures}`) });
  const host: WorkflowHost = { authenticate: () => ({ deploymentId: "d-abcdef", repoKey: b.repository.key, repoRoot: b.repository.root, ticket: b.ticket, team: "requirements", mode: "analyze", identitySha256: "a".repeat(64) }),
    observations: () => ({ capabilities: new Set(d.requiredCapabilities), projectProfile: "supported", producerContract: "supported", readEvidence: r => evidence.get(r.ref) ?? null }),
    capture: async () => ({ outcome: "approved", principal: "synthetic-test-operator", evidence: ref() }), owners: new Map(), now: () => "2026-10-28T00:00:00.000Z" };
  const service = new JsonWorkflowService(journal, host);
  return { root, db, journal, host, selection, service, bundle: b, evidence, subject: bytes(b), close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
