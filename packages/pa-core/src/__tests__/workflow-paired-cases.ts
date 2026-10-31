import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateWorkflowPair } from "../workflows/paired.js";
import { produceWorkflowSubject } from "../workflows/producer.js";
import { selectNewWorkflow } from "../workflows/selected.js";
import { digest } from "../workflows/contracts.js";
import { bytes } from "./workflow-fixtures.js";
import { templateFixture } from "./template-fixture.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";

test("selected typed pair requires actual producer/consumer, both handoffs and exact artifact/matrix identities without effects", () => {
  const f = workflowRuntimeFixture(), t = templateFixture();
  try {
    const entry = structuredClone(t.registry.entries[0]!); entry.id = "review-bundle";
    entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}"), selector: null };
    entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
    t.registry.entries.push(entry); writeFileSync(join(t.root, entry.source.path), "{{bundle}}");
    const templates = t.save(), selection = { ...f.selection, configRoot: t.root, definitions: f.selection.definitions.map(d => ({ ...d, configRoot: t.root })) };
    const fixtures = ["fresh", "amendment"].map(handoff => {
      const bundle = structuredClone(f.bundle);
      if (handoff === "amendment") bundle.handoff = { type: "amendment", baseSha: bundle.handoff.baseSha, branch: bundle.handoff.branch, branchAction: "reuse", featureSha: "b".repeat(40) };
      const producer = JSON.stringify({ action: "render", id: "review-bundle", version: "1", bindings: { bundle } }, null, 2);
      const produced = produceWorkflowSubject(selection, Buffer.from(producer), { selection: templates, team: "requirements", mode: "analyze" });
      return { id: handoff, team: "requirements", mode: "analyze", producer, requirementsFile: "workflows/fixtures/requirements.md", uatFile: "workflows/fixtures/uat.md", candidateSha256: digest(produced.raw) };
    });
    const document = { schemaVersion: "pa-workflow-fixtures/v1", fixtures };
    const read = (path: string) => f.evidence.get(path.endsWith("requirements.md") ? f.bundle.requirements.ref : f.bundle.uat.ref)!;
    assert.equal(validateWorkflowPair(selection, templates, bytes(document), read).fixtures.length, 2);
    const disabled = { ...selection, bindings: selection.bindings.map(b => ({ ...b, enabled: false })) };
    const before = JSON.stringify(disabled);
    const draft = validateWorkflowPair(disabled, templates, bytes(document), read);
    assert.equal(draft.fixtures.length, 2); assert.ok(draft.fixtures.every(c => c.bindingEnabled === false));
    assert.equal(JSON.stringify(disabled), before);
    assert.throws(() => selectNewWorkflow(disabled, "requirements", "analyze"), /WORKFLOW_DISABLED/);
    assert.throws(() => validateWorkflowPair(disabled, templates, bytes({ ...document, fixtures: [fixtures[0]] }), read), /WORKFLOW_SOURCE/);
    assert.throws(() => validateWorkflowPair(selection, templates, bytes({ ...document, fixtures: [fixtures[0]] }), read), /WORKFLOW_SOURCE/);
    assert.throws(() => validateWorkflowPair(selection, templates, bytes({ ...document, fixtures: fixtures.map(row => ({ ...row, candidateSha256: "c".repeat(64) })) }), read), /WORKFLOW_SOURCE/);
    assert.throws(() => validateWorkflowPair(selection, templates, bytes({ ...document, passed: true }), read), /WORKFLOW_CONTRACT/);
    assert.throws(() => validateWorkflowPair(selection, templates, bytes(document), () => Buffer.from("substituted bytes")), /WORKFLOW_SOURCE/);
    assert.throws(() => validateWorkflowPair({ ...selection, configRevision: "b".repeat(40) }, templates, bytes(document), read), /WORKFLOW_SOURCE/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM workflow_events").get() as { n: number }).n, 0);
  } finally { f.close(); t.dispose(); }
});
