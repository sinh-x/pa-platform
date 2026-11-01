import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runTemplateCommand } from "../cli/commands/template.js";
import { digest, JsonWorkflowError } from "../workflows/contracts.js";
import { templateService } from "../templates/service.js";
import { reviewBundleTemplateConsumer } from "../workflows/producer.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import { templateFixture } from "./template-fixture.js";

function fixture() {
  const f = workflowRuntimeFixture(), t = templateFixture();
  const entry = structuredClone(t.registry.entries[0]!); entry.id = "review-bundle";
  entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}\n"), selector: null };
  entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
  t.registry.entries.push(entry); writeFileSync(join(t.root, entry.source.path), "{{bundle}}\n");
  const templates = t.save();
  f.selection = { ...f.selection, configRoot: t.root, definitions: f.selection.definitions.map(d => ({ ...d, configRoot: t.root })) };
  const request = () => bytes({ action: "render", id: "review-bundle", version: "1", bindings: { bundle: f.bundle } });
  return { ...f, t, templates, request, close: () => { f.close(); t.dispose(); } };
}
test("actual shared producer retains exact candidate, provenance and artifact/matrix bytes without issuing authority", async () => {
  const f = fixture(); try {
    const host = { selection: f.templates, team: "requirements", mode: "analyze", reviewBundleConsumer: reviewBundleTemplateConsumer };
    const rendered = templateService(f.request(), host); assert.equal(rendered.ok, true);
    const run = f.service.admitProduced(f.selection, f.request(), host);
    assert.equal(run.subjectSha256, digest(rendered.candidate as string)); assert.deepEqual(run.decisions, []);
    assert.equal(Buffer.from(f.journal.snapshot(run.subjectSha256)).toString(), rendered.candidate);
    const admitted = f.journal.read(run.runId)[0]!.event.data;
    const provenance = JSON.parse(Buffer.from(f.journal.snapshot(admitted.producerSha256 as string)).toString());
    assert.equal(provenance.unsigned, true); assert.equal(provenance.producer.sourceSha256, f.t.registry.entries.at(-1)!.source.sha256);
    assert.equal(provenance.producer.registrySha256, f.templates.registrySha256);
    assert.equal(provenance.producer.bindingsSha256.length, 64);
    assert.equal(digest(f.journal.snapshot(run.subject.matrix.sha256)), run.subject.matrix.sha256);
    const output: string[] = [];
    const code = await runTemplateCommand(["render", "review-bundle", "--version", "1"], { stdout: s => output.push(s), stderr: () => {} }, { ...host, reviewBundleConsumer: undefined, input: (async function* () { yield JSON.stringify({ bindings: { bundle: f.bundle } }); })() });
    // CLI owns registration even when no caller callback was provided.
    assert.equal(code, 0); assert.equal(JSON.parse(output[0]!).candidate, rendered.candidate);
  } finally { f.close(); }
});
test("producer mismatch, injected receipts, malformed bundles and bad referenced evidence cause zero admission writes", () => {
  const f = fixture(); try {
    const host = { selection: f.templates };
    const writes = () => (f.db.prepare("SELECT count(*) AS n FROM workflow_events").get() as { n: number }).n;
    const reject = (request = f.request()) => { assert.throws(() => f.service.admitProduced(f.selection, request, host), JsonWorkflowError); assert.equal(writes(), 0); };
    const good = f.request(); const parsed = JSON.parse(good.toString());
    reject(bytes({ ...parsed, producer: { approved: true } }));
    reject(bytes({ ...parsed, bindings: { bundle: { ...f.bundle, actor: "operator", approved: true } } }));
    const original = f.selection; f.selection = { ...original, configRevision: "b".repeat(40) }; reject(); f.selection = original;
    f.bundle.matrix.sha256 = f.bundle.requirements.sha256; reject(); // Whole-document digest is not matrix identity.
    f.bundle.matrix.sha256 = "c".repeat(64); reject();
    assert.equal(writes(), 0);
  } finally { f.close(); }
});
test("actual producer links revised candidate/provenance without re-enabling a disabled binding or accepting config drift", async () => {
  const f = fixture(); try {
    const host = { selection: f.templates }, capture = f.host.capture;
    f.host.capture = async r => ({ ...await capture(r), outcome: "changes-requested" });
    const run = f.service.admitProduced(f.selection, f.request(), host);
    await f.service.decide(run.runId, 1, "approve");
    f.bundle.revision = 2; f.bundle.subjectId = "package-two";
    f.bundle.requirements.ref = "requirements:agent-teams/requirements/artifacts/revised.md";
    f.bundle.matrix.ref = f.bundle.requirements.ref;
    for (const [ref, raw] of fixtureEvidence(f.bundle)) f.evidence.set(ref, raw);
    const disabled = { ...f.selection, bindings: f.selection.bindings.map(b => ({ ...b, enabled: false })) };
    assert.throws(() => f.service.reviseProduced(run.runId, 2, { ...disabled, configRevision: "c".repeat(40) }, f.request(), host), /WORKFLOW_SOURCE/);
    assert.throws(() => f.service.reviseProduced(run.runId, 2, disabled, bytes({ ...JSON.parse(f.request().toString()), outcome: "approved" }), host), /WORKFLOW_/);
    assert.equal(f.service.status(run.runId).revision, 2);
    const rendered = templateService(f.request(), { ...host, reviewBundleConsumer: reviewBundleTemplateConsumer });
    const revised = f.service.reviseProduced(run.runId, 2, disabled, f.request(), host);
    assert.equal(Buffer.from(f.journal.snapshot(revised.subjectSha256)).toString(), rendered.candidate);
    assert.equal(revised.decisions.length, 1); assert.equal(revised.outcomes.approve, undefined);
    const event = f.journal.read(run.runId).at(-1)!.event;
    assert.equal(event.type, "subject-revised"); assert.equal(event.data.previousSubjectSha256, run.subjectSha256);
    const provenance = JSON.parse(Buffer.from(f.journal.snapshot(event.data.producerSha256 as string)).toString());
    assert.equal(provenance.producer.candidateSha256, revised.subjectSha256);
    assert.equal(provenance.producer.registrySha256, f.templates.registrySha256);
    assert.equal(disabled.bindings[0]!.enabled, false);
  } finally { f.close(); }
});
test("producer preserves selected-pair and capability causes instead of erasing them as WORKFLOW_SOURCE", () => {
  const f = fixture(); try {
    assert.throws(() => f.service.admitProduced(f.selection, f.request(), { selection: { ...f.templates, registrySha256: "b".repeat(64) } }), /TEMPLATE_PAIR/);
    f.t.registry.entries.at(-1)!.capabilities.render = false;
    const templates = f.t.save();
    assert.throws(() => f.service.admitProduced(f.selection, f.request(), { selection: templates }), /TEMPLATE_CAPABILITY/);
    assert.deepEqual(f.journal.runs(f.bundle.repository.key, f.bundle.ticket), []);
  } finally { f.close(); }
});
test("evidence mutation during the native dialog cannot mint a decision", async () => {
  const f = fixture(); try {
    const run = f.service.admitProduced(f.selection, f.request(), { selection: f.templates });
    const capture = f.host.capture;
    f.host.capture = async r => { f.evidence.set(f.bundle.requirements.ref, Buffer.from("Approved, but substituted")); return capture(r); };
    await assert.rejects(f.service.decide(run.runId, 1, "approve"), /WORKFLOW_SOURCE/);
    assert.equal(f.service.status(run.runId).revision, 1); assert.equal(f.service.status(run.runId).decisions.length, 0);
  } finally { f.close(); }
});
