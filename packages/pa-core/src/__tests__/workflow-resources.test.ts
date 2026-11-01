import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureWorkflowResources, assertRetainedConfigIdentity, materializeWorkflowResources, retainedTemplateHost, retainedWorkflowSelection, retainedWorkflowTeam } from "../workflows/resources.js";
import { loadSelectedWorkflows } from "../workflows/selected.js";
import { digest } from "../workflows/contracts.js";
import { templateService } from "../templates/service.js";
import { reviewBundleTemplateConsumer } from "../workflows/producer.js";
import { generatePrimer } from "../primer/index.js";
import { workflowReadService } from "../workflows/public.js";
import { bytes, fixtureEvidence } from "./workflow-fixtures.js";
import { committedConfigFixture } from "./committed-config-fixture.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";

function setup() {
  const f = workflowRuntimeFixture(), config = committedConfigFixture();
  f.selection = loadSelectedWorkflows(); f.bundle.workflow.sha256 = f.selection.definitions[0]!.sha256;
  f.host.resources = captureWorkflowResources;
  const request = (bundle = f.bundle) => bytes({ action: "render", id: "review-bundle", version: "1", bindings: { bundle } });
  return { ...f, config, request, close: () => { config.close(); f.close(); } };
}

test("native resource owner retains exact committed templates/instructions and uses them across compatible config advances", async () => {
  const f = setup(); try {
    let displayedResources: unknown;
    const capture = f.host.capture; f.host.capture = async input => { displayedResources = input.resources; return { ...await capture(input), outcome: "changes-requested" }; };
    const run = f.service.admitProduced(f.selection, f.request(), {});
    assert.equal(run.resources!.configRevision, f.config.revision);
    for (const path of ["contracts/templates-v1.json", "workflows/manifest.json", "teams/requirements.yaml", "teams/builder.yaml", "skills/requirements/analyst.md", "skills/builder/orchestrator.md", "skills/global/pa-startup/SKILL.md", "docs/common.md", "docs/example.md"]) assert.ok(run.resources!.files.some(file => file.path === path), path);
    await f.service.decide(run.runId, 1, "approve"); assert.deepEqual(displayedResources, run.resources);
    const originalEvents = f.journal.read(run.runId), originalTemplate = retainedTemplateHost(f.journal, run).resources!.get("skills/templates/review-bundle.md")!;
    f.config.write("skills/builder/orchestrator.md", "# Changed current instructions\nFOREIGN CURRENT BODY\n");
    f.config.write("skills/global/pa-startup/SKILL.md", "# Changed current skill\nFOREIGN CURRENT SKILL\n");
    const entry = f.config.registry.entries.find(entry => entry.id === "review-bundle")!;
    f.config.write(entry.source.path, "{{bundle}}\n\n"); entry.source.sha256 = digest("{{bundle}}\n\n");
    const manifest = JSON.parse(readFileSync(join(f.config.root, "workflows/manifest.json"), "utf8")); manifest.bindings[0].enabled = false;
    f.config.write("workflows/manifest.json", JSON.stringify(manifest)); const nextRevision = f.config.commit();
    assert.notEqual(nextRevision, run.configRevision);
    const pinned = retainedTemplateHost(f.journal, f.service.status(run.runId));
    assert.equal(Buffer.from(pinned.resources!.get(entry.source.path)!).toString(), Buffer.from(originalTemplate).toString());
    assert.equal(retainedWorkflowSelection(f.journal, run).configRevision, run.configRevision);
    assert.equal(retainedWorkflowSelection(f.journal, run).bindings[0]!.enabled, true);
    const directory = join(f.root, "projection"); mkdirSync(directory);
    assertRetainedConfigIdentity(run);
    const root = materializeWorkflowResources(f.journal, run, directory), team = retainedWorkflowTeam(f.journal, run, "builder", "orchestrator");
    const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: "orchestrator", skillsDir: join(root, "skills/global"), resolveFile: relative => join(root, relative), configResourceRoot: root });
    assert.match(primer, /Do only authorized work/); assert.ok(!primer.includes("FOREIGN CURRENT"));
    assert.match(readFileSync(join(root, "skills/global/pa-startup/SKILL.md"), "utf8"), /Inspect current bulletins/);
    const next = structuredClone(f.bundle); next.revision++; next.subjectId = "package-two";
    next.requirements.ref = "requirements:agent-teams/requirements/artifacts/resource-two.md"; next.matrix.ref = next.requirements.ref;
    for (const [ref, raw] of fixtureEvidence(next)) f.evidence.set(ref, raw);
    const expected = templateService(f.request(next), { ...pinned, team: "requirements", mode: "analyze", reviewBundleConsumer: reviewBundleTemplateConsumer });
    assert.equal(expected.ok, true);
    const revised = f.service.reviseProduced(run.runId, 2, retainedWorkflowSelection(f.journal, run), f.request(next), {});
    assert.equal(revised.subjectSha256, digest(expected.candidate as string)); assert.equal(revised.configRevision, run.configRevision);
    assert.deepEqual(revised.resources, run.resources); assert.deepEqual(f.journal.read(run.runId).slice(0, originalEvents.length), originalEvents);
    // An unsupported *current* registry cannot migrate or erase the old run.
    Object.assign(f.config.registry, { runtimeContract: "pa-template-runtime/future" }); f.config.commit();
    assert.equal(templateService('{"action":"list"}').ok, false);
    assert.equal(templateService('{"action":"list"}', retainedTemplateHost(f.journal, revised)).ok, true);
    assert.equal(f.service.status(run.runId).resources!.registrySha256, run.resources!.registrySha256);
  } finally { f.close(); }
});

for (const variant of ["missing-link", "head-drift", "wrong-skills-root", "unretained-route"] as const) {
  test(`resource capture rejects ${variant} with zero admission/snapshot writes`, () => {
    const f = setup(); try {
      if (variant === "missing-link") { f.config.write("skills/requirements/analyst.md", "Read [missing](../../docs/missing.md).\n"); f.config.commit(); f.selection = loadSelectedWorkflows(); }
      if (variant === "head-drift") { f.config.write("docs/changed.md", "New commit\n"); f.config.commit(); }
      if (variant === "wrong-skills-root") process.env.PA_PLATFORM_SKILLS = f.root;
      if (variant === "unretained-route") f.bundle.route = { team: "builder", mode: "missing" };
      assert.throws(() => f.service.admitProduced(f.selection, f.request(), {}), /WORKFLOW_SOURCE/);
      assert.deepEqual(f.journal.runs(f.bundle.repository.key, f.bundle.ticket), []);
      assert.equal((f.db.prepare("SELECT count(*) AS n FROM workflow_snapshots").get() as { n: number }).n, 0);
    } finally { f.close(); }
  });
}

test("inert bare-path prose references retain committed absence rather than forcing runtime docs into config or adopting later bytes", () => {
  const f = setup(); try {
    f.config.write("skills/requirements/analyst.md", "# Analyst\nRuntime companion: `docs/runtime-only.md`.\n"); f.config.commit(); f.selection = loadSelectedWorkflows();
    const run = f.service.admitProduced(f.selection, f.request(), {});
    assert.deepEqual(run.resources!.absentReferences, ["docs/runtime-only.md"]);
    f.config.write("docs/runtime-only.md", "new current config bytes, not original evidence\n"); f.config.commit();
    const retained = retainedTemplateHost(f.journal, run);
    assert.equal(retained.resources!.has("docs/runtime-only.md"), false);
    assert.deepEqual(f.service.status(run.runId).resources!.absentReferences, ["docs/runtime-only.md"]);
  } finally { f.close(); }
});

test("resource drift after capture aborts the same registry transaction before any new source or event is retained", () => {
  const f = setup(); try {
    f.host.resources = (selection, subject, caller) => {
      const captured = captureWorkflowResources(selection, subject, caller);
      f.config.write("docs/common.md", "changed after native capture\n"); return captured;
    };
    assert.throws(() => f.service.admitProduced(f.selection, f.request(), {}));
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM workflow_snapshots").get() as { n: number }).n, 0);
    assert.deepEqual(f.journal.runs(f.bundle.repository.key, f.bundle.ticket), []);
  } finally { f.close(); }
});

test("materialized retained bytes reject tampering without overwrite or laundering current instructions", () => {
  const f = setup(); try {
    const run = f.service.admitProduced(f.selection, f.request(), {}), directory = join(f.root, "projection"); mkdirSync(directory);
    const root = materializeWorkflowResources(f.journal, run, directory), path = join(root, "docs/common.md");
    assert.equal(materializeWorkflowResources(f.journal, run, directory), root);
    chmodSync(path, 0o600); writeFileSync(path, "foreign bytes\n");
    assert.throws(() => materializeWorkflowResources(f.journal, run, directory), /retained-resource-closure/);
    assert.equal(readFileSync(path, "utf8"), "foreign bytes\n");
    process.env.PA_PLATFORM_HOME = f.root;
    assert.throws(() => assertRetainedConfigIdentity(run), /retained-resource-closure/);
  } finally { f.close(); }
});

test("legacy runs remain readable/revocable and may settle proven intent, but cannot adopt current resources for new work", async () => {
  const f = workflowRuntimeFixture(); try {
    delete f.host.resources;
    const run = f.service.admit(f.selection, f.subject); assert.equal(run.resources, undefined);
    const view = workflowReadService('{"action":"status","ticket":"EX-1"}', { state: () => run, observations: f.host.observations });
    assert.equal(view.ok, true); assert.equal((view.result as any).resourceState, "legacy-missing");
    assert.deepEqual(f.service.next(run.runId).blocked, [{ stepId: "approve", code: "WORKFLOW_SOURCE" }]);
    await assert.rejects(f.service.decide(run.runId, 1, "approve"), /retained-resource-closure/);
    // Synthetic historical issued event/intent. This is fixture history only;
    // no public capture/import or migration endpoint is introduced.
    const record = { schemaVersion: "pa-decision/v1", decisionId: "historical-decision", kind: "package", runId: run.runId, stepId: "approve", subjectRef: run.subject.subjectId, subjectSha256: run.subjectSha256, outcome: "approved", permissions: run.subject.requestedPermissions, captureEvidenceRef: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-historical-capture", version: "v1", sha256: "c".repeat(64) }, principal: "synthetic-historical-operator", issuedAt: "2026-10-28T00:00:00.000Z" };
    f.journal.append(run.runId, 1, () => ({ type: "decision", eventId: "historical-issued", data: { record } }));
    await assert.rejects(f.service.requestStep(run.runId, 2, "publish", record.decisionId), /retained-resource-closure/);
    const intent = { intentId: "historical-intent", runId: run.runId, stepId: "publish", owner: "tickets", decisionId: record.decisionId, subjectSha256: run.subjectSha256 };
    f.journal.append(run.runId, 2, () => ({ type: "intent", eventId: "historical-pending", data: { intent } }));
    const revoked = await f.service.revoke(run.runId, 3, record.decisionId); assert.ok(revoked.revoked.includes(record.decisionId));
    let dispatches = 0;
    (f.host.owners as Map<string, any>).set("publication.pair", { admit: () => { dispatches++; }, observe: async () => ({ state: "proven", outcome: "completed", evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: "synthetic-existing-effect", version: "v1", sha256: "d".repeat(64) }] }), execute: () => { dispatches++; }, verify: () => true });
    const settled = await f.service.reconcile(run.runId, revoked.revision, intent.intentId);
    assert.equal(settled.outcomes.publish, "completed"); assert.equal(dispatches, 0); assert.equal(settled.resources, undefined);
    assert.deepEqual(settled.decisions, revoked.decisions);
  } finally { f.close(); }
});
