import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { HandoffReviewService, LocalHandoffReviewService } from "../../../pa-core/src/documents/handoff-review.js";
import { handoffBranchIntentSha, type HandoffBranchIntent, type HandoffReviewSubject } from "../../../pa-core/src/documents/handoff-contract.js";
import { nativeHandoffPlanIdentity } from "../../../pa-core/src/documents/handoff-planning.js";
import { localHandoffReviewHooks } from "../../../pa-core/src/documents/local-review.js";
import { creationDigest } from "../../../pa-core/src/tickets/create-intent.js";
import { MODE_CAPABILITY_SESSION } from "../../../pa-core/src/mode-capabilities.js";
import { withRepositoryRefAdmission } from "../../../pa-core/src/deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../../../pa-core/src/deploy/ticket-concurrency.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { documentRuntimeFixture } from "../../../pa-core/src/__tests__/document-runtime-fixture.js";
import test from "node:test";
import { ContentReviewService, RegistryHandoffReviewJournal, readDocumentSources, presentFullDocumentReader, documentPackageSha, NativeExecutionEvidence, PHASE_REPORT_SECTIONS, PhaseReportService, TicketStore, indexPhaseReport, parsePhaseReport, workflowDigest, type PhaseReportHost, type SourceVersion } from "@pa-platform/pa-core";
import { type PlannedRecord, attachPlannedActual, projectPlannedActual, plannedActualReadFailure } from "@pa-platform/pa-core/tickets/planned-actual";
import { nativePlannedActualHost, plannedRecordFromContentReview } from "../phase-report-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { createPaTicketTool } from "../pi-extension/ticket-tool.js";
import { createPiPhaseReportModule, type PiPhaseReportBinding } from "../pi-extension/prepared-workflow.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";

const sha = "a".repeat(40), time = "2026-11-21T00:00:00.000Z";
const source = (ref: string): SourceVersion => ({ ref, version: "v1", sha256: workflowDigest(ref) });
const plan: PlannedRecord = { reference: `review:${"b".repeat(64)}`, repository: { key: "test", root: "/test" }, ticket: "TEST-1", subjectSha256: "c".repeat(64), revision: 3, manifestSha256: "d".repeat(64), deliverySha256: "e".repeat(64), state: "approved", entry: "file:///planned/index.html", rows: [{ id: "AC-01", expectation: "Print every member." }] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pap327-native-actual-"));
  const authority = new PiPreparedNativeAuthority({ root: join(root, "protected"), aiUsageRoot: join(root, "artifacts") });
  const store = authority.reports(true, "d-aaaaaa")!;
  const evidence = new NativeExecutionEvidence(store, authority.reportEvidenceRoot("d-aaaaaa"), { repository: run => run(), worktree: run => run() });
  const blob = (bytes: Buffer) => { const id = workflowDigest(bytes); const sink = evidence.sink(id, "stdout"); assert.equal(sink.write(bytes), true); return sink.close(); };
  const actor = { deploymentId: "d-aaaaaa", team: "builder", mode: "orchestrator", ticket: "TEST-1", process: null, repoKey: "test", repoRoot: "/test", worktreeRoot: "/test", gitDir: "/test/.git", startedAt: time };
  const actorId = workflowDigest(JSON.stringify(actor));
  const diff = blob(Buffer.from("Native fixture diff.\n"));
  const checks = [{ command: "fixture-source-check", candidateSha: sha, state: "passed", exitCode: 0, output: evidence.publish("fixture-check", { exitCode: 0, candidateSha: sha }) }];
  const facts = evidence.publish("report-facts", { actor: actorId, blob: blob(Buffer.from(JSON.stringify({ actor, snapshot: { head: sha }, checks, execution: null, scopeProven: false, operations: [], omissions: [], sourceFailure: false, privateDiff: diff }))) });
  const report = parsePhaseReport({ schemaVersion: "phase-report/v1", identity: { date: "2026-11-21", team: "builder", ticket: "TEST-1", deploymentId: "d-aaaaaa", phaseId: "phase-5", attempt: 1, executor: "orchestrator-direct" }, outcome: "partial", startedAt: time, finishedAt: time, baseSha: sha, candidateSha: sha, commitState: "no-commit", sections: Object.fromEntries(PHASE_REPORT_SECTIONS.map(k => [k, "Native fixture; no acceptance claimed."])), checks, previousAttempts: [], evidence: facts });
  const captured = evidence.publish("phase-report", { actor: actorId, facts, report: blob(Buffer.from(JSON.stringify(report))), diff, phaseId: "phase-5", attempt: 1 });
  const publicRoot = join(authority.aiUsageRoot, "agent-teams/builder/artifacts"); mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
  const ownerPath = join(publicRoot, "2026-11-21-TEST-1-d-aaaaaa-owner.md"); let owner = "# Existing orchestration owner\n";
  const host: PhaseReportHost = { authorize() {}, verifyReport() {}, sanitize: s => s, assertPublic() {}, verifyCanonical() {}, index(r) { owner = indexPhaseReport(owner, workflowDigest(owner), r).markdown; writeFileSync(ownerPath, owner, { mode: 0o600 }); }, resolvePublicDiff: () => evidence.blob(diff), resolveDelivery() { throw new Error("missing"); }, loadDeliverySources: () => [], recordDelivery() {} };
  const service = new PhaseReportService(publicRoot, host); const receipt = service.publish(report);
  const receiptRef = evidence.publish("report-receipt", { actor: actorId, source: captured, receipt });
  const payload = { actor: actorId, report: receiptRef, plannedReference: plan.reference, binding: { repository: plan.repository, ticket: plan.ticket, subjectSha256: plan.subjectSha256, revision: 3, manifestSha256: plan.manifestSha256, candidateSha: sha }, observations: [{ ac: "AC-01", observation: "Print not checked.", disposition: "unverified", difference: "Unverified", impact: "Unknown", owner: "Builder" }], actualOnly: [], deliveries: [], human: [] };
  const index = evidence.publish("planned-actual", payload); const locator = service.publishPlannedActualLocator(receipt, index);
  const native = nativePlannedActualHost(authority); const projectionHost = { ...native, resolvePlan: async () => plan };
  const tickets = join(root, "tickets"); mkdirSync(tickets);
  writeFileSync(join(tickets, "TEST-1.json"), JSON.stringify({ id: "TEST-1", project: "test", title: "Fixture", doc_refs: [], status: "implementing", assignee: "builder/team-manager" }));
  return { root, authority, evidence, payload, locator, projectionHost, native, ticketStore: new TicketStore(tickets), service, receipt, receiptRef, report, captured, ownerPath };
}

for (const version of ["v1", "v2"] as const) test(`retained combined ${version} Planned resolves and attaches without a replacement decision`, async () => {
  const f = documentRuntimeFixture();
  try {
    Object.assign(process.env, { PA_REGISTRY_DB: join(f.root, "registry.db"), PA_AI_USAGE_HOME: f.root });
    f.db.pragma("synchronous = FULL");
    f.store.update("EX-1", { title: "Stable retained Planned fixture" });
    const member = f.subject.members.find(m => m.role === "requirements")!;
    const raw = Buffer.from("# Acceptance\n- AC-01: Preserve the original approval.\n");
    member.bytes = raw.length; member.sha256 = workflowDigest(raw); writeFileSync(join(f.root, member.source), raw);
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    const binding = JSON.stringify({ schemaVersion: "pa-mode-capability-binding/v1", configRevision: "a".repeat(40), resourcePath: "teams/requirements.yaml", resourceSha256: "b".repeat(64), profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: ["document.handoff", "document.local-review", "document.package"] } });
    const caller = { identitySha256: "a".repeat(64), selectionSha256: workflowDigest(binding), deploymentId: "d-314001", sessionId: "retained", repoKey: "example", repoRoot: f.repo, ticket: "EX-1" };
    const planIdentity = nativeHandoffPlanIdentity(caller, "native-plan"), before = f.store.get("EX-1")!, base = git("rev-parse", "HEAD");
    const physicalIdentitySha256 = withRepositoryRefTicketExclusion("example", f.repo, exclusion => withRepositoryRefAdmission(f.repo, exclusion, id => id));
    const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "native-plan", callerIdentitySha256: caller.identitySha256, expectedTicketVersion: creationDigest(before), repository: { key: "example", root: f.repo, physicalIdentitySha256 }, ticket: "EX-1", branch: "feature/EX-1-retained", action: "create", base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: time, provenance: "local-develop-ref", remoteFreshness: "not-established" }, plannedLinkSha256: creationDigest(null), lineage: null };
    f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "plan", intent }, "requirements/analyze", planIdentity, { assertCurrent() {}, assertSnapshot() {} });
    f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
    const delivery = await presentFullDocumentReader(f.subject, f.root, hash => f.journal.snapshot(hash));
    f.db.prepare("INSERT INTO registry_events(deployment_id,team,event,timestamp,mode,runtime,binary,note,repo,repo_root,worktree_root,ticket_id,mode_capability_binding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(caller.deploymentId, "requirements", "started", time, "analyze", "pi", "ppa", MODE_CAPABILITY_SESSION, f.repo, f.repo, f.repo, "EX-1", binding);
    const effects = { publish: true, branchRef: true, queue: false };
    const common = { documentSubjectSha256: documentPackageSha(f.subject), branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: String(delivery.deliverySha256), selectionSha256: caller.selectionSha256, callerIdentitySha256: caller.identitySha256, effects };
    const subject: HandoffReviewSubject = version === "v1" ? { schemaVersion: "pa-handoff-review/v1", ...common } : { schemaVersion: "pa-handoff-review/v2", ...common, origin: { deploymentId: caller.deploymentId, sessionId: caller.sessionId, planIdentity } };
    const journal = new RegistryHandoffReviewJournal(f.db), subjectSha = journal.freeze(subject, intent);
    if (version === "v1") {
      const review = new HandoffReviewService(journal, { artifactRoot: f.root, tickets: f.store, authenticate: () => caller, assertAvailable() {}, async capture(request) { return Buffer.from(JSON.stringify({ schemaVersion: "pa-handoff-native-evidence/v1", method: "pi-native-handoff-review", request, outcome: "approved", principal: `local-uid:${process.getuid?.()}`, interactionId: "fixture-retained", boundary: "native-foreground-not-hostile-same-uid-isolation" })); } });
      await review.review(subjectSha, 0);
    } else {
      const review = new LocalHandoffReviewService(journal, { artifactRoot: f.root, tickets: f.store, ...localHandoffReviewHooks(f.db, f.store, journal, f.root) });
      const pending = await review.request(subjectSha, 0); await review.decide(subjectSha, 0, String(pending.requestKey), "approved");
    }
    const saved = journal.events(subjectSha), ticketBytes = readFileSync(join(f.root, "tickets/EX-1.json"));
    const native = nativePlannedActualHost(new PiPreparedNativeAuthority({ root: join(f.root, "protected"), aiUsageRoot: f.root }));
    for (const reference of [subjectSha, `review:${subjectSha}`]) {
      const planned = await native.resolvePlan(reference); assert.equal(planned.state, "approved");
      assert.ok("reference" in planned); if (!("reference" in planned)) continue;
      assert.equal(planned.reference, reference); assert.equal(planned.subjectSha256, common.documentSubjectSha256);
      assert.deepEqual(planned.approvalOwner?.scope, effects); assert.equal(planned.approvalOwner?.subjectSha256, subjectSha);
    }
    assert.deepEqual(journal.events(subjectSha), saved); assert.deepEqual(readFileSync(join(f.root, "tickets/EX-1.json")), ticketBytes);
    const presentationPath = fileURLToPath(String(delivery.entry)); const bytes = readFileSync(presentationPath); writeFileSync(presentationPath, "tampered");
    assert.notEqual((await native.resolvePlan(subjectSha)).state, "approved"); writeFileSync(presentationPath, bytes);
    const planned = await native.resolvePlan(subjectSha); assert.ok("reference" in planned); if (!("reference" in planned)) return;
    // Exercise the join/ref owner with a verified retained Planned and a separate
    // trusted Actual port; native report metadata is covered by the fixture below.
    const locator = `/reports/planned-actual-d-aaaaaa-${"e".repeat(64)}.json`;
    const host = { ...native, resolveActual: async () => ({ locator, binding: { repository: planned.repository, ticket: planned.ticket, subjectSha256: planned.subjectSha256, revision: planned.revision, manifestSha256: planned.manifestSha256, candidateSha: sha }, plannedReference: subjectSha, reportId: "1".repeat(64), reportSourceSha256: "2".repeat(64), reportPath: "/reports/report.md", ownerPath: "/reports/owner.md", outcome: "partial" as const, scope: "Fixture join", observations: [], actualOnly: [], evidence: [] }) };
    await attachPlannedActual(f.store, "EX-1", locator, host, () => undefined);
    assert.equal((await projectPlannedActual(f.store.get("EX-1")!, undefined, undefined, host)).state, "selection-required");
    assert.equal((await projectPlannedActual(f.store.get("EX-1")!, subjectSha, sha, host)).state, "available");
    assert.deepEqual(journal.events(subjectSha), saved);
  } finally { f.close(); }
});

test("saved approval cannot bypass complete native Planned entry/raw/member/manifest verification", async () => {
  const f = documentRuntimeFixture();
  try {
    f.db.pragma("synchronous = FULL"); // New disposable database only; retained registries are never opened writable.
    const member = f.subject.members.find(m => m.role === "requirements")!;
    const raw = Buffer.from("# FR-1\n\n- AC-01: Print every required member.\n  Include closed content.\n");
    member.bytes = raw.length; member.sha256 = workflowDigest(raw); writeFileSync(join(f.root, member.source), raw);
    f.journal.freeze(f.subject, 0, readDocumentSources(f.subject, f.root));
    const delivery = await presentFullDocumentReader(f.subject, f.root, sha => f.journal.snapshot(sha));
    const journal = new RegistryHandoffReviewJournal(f.db);
    const service = new ContentReviewService(journal, { artifactRoot: f.root, assertOrigin() {}, assertDocument(document) { assert.equal(document.repository.root, f.repo); } });
    const reference = await service.prepare(documentPackageSha(f.subject), String(delivery.deliverySha256), { callerIdentitySha256: "a".repeat(64), selectionSha256: "b".repeat(64), deploymentId: "d-aaaaaa", sessionId: "disposable-p5" });
    await service.request(reference);
    await service.decide(reference, "approved");
    const view = await service.show(reference); const planned = plannedRecordFromContentReview(view);
    assert.equal(planned.state, "approved");
    if (typeof view.presentation.entry !== "string" || typeof view.presentation.manifest !== "string") throw new Error("Missing verified delivery");
    const entry = fileURLToPath(view.presentation.entry), manifest = fileURLToPath(view.presentation.manifest);
    const paths = [entry, manifest, join(dirname(entry), "raw/member-2.md"), join(dirname(entry), "members/member-2.html")];
    for (const path of paths) {
      const before = readFileSync(path); writeFileSync(path, "tampered fixture");
      const saved = await service.show(reference); assert.equal(saved.approval, "approved");
      assert.deepEqual(plannedRecordFromContentReview(saved), { state: "integrity-failure" });
      writeFileSync(path, before);
      unlinkSync(path);
      // Exercise the same finite resolver discriminator/classifier as production:
      // missing-file throws and unverified saved history both fail integrity, without
      // altering the existing reader/review owner or trusting exception prose.
      const missing = await service.show(reference).then(plannedRecordFromContentReview, plannedActualReadFailure);
      assert.deepEqual(missing, { state: "integrity-failure" });
      writeFileSync(path, before, { mode: 0o600 });
    }
    assert.equal(plannedRecordFromContentReview(await service.show(reference)).state, "approved");
  } finally { f.close(); }
});

test("native ticket/report owner exercise: authenticated metadata attachment and normal pa_ticket dispatch", async () => {
  const f = fixture();
  try {
    const actual = await f.native.resolveActual(f.locator); assert.ok("binding" in actual); if (!("binding" in actual)) return;
    assert.equal(actual.binding.candidateSha, sha); assert.equal(actual.reportId, f.receipt.reportId);
    assert.deepEqual(actual.evidence.map(e => [e.class, e.state, e.coverage]), [["source", "passed", []]]);
    const companion = readFileSync(f.locator);
    await assert.rejects(attachPlannedActual(f.ticketStore, "TEST-1", f.locator, f.projectionHost, () => { throw new Error("fixture admission denied"); }));
    assert.equal(f.ticketStore.get("TEST-1")?.doc_refs.length, 0);
    assert.deepEqual(readFileSync(f.locator), companion);
    await attachPlannedActual(f.ticketStore, "TEST-1", f.locator, f.projectionHost, () => undefined);
    assert.ok(f.ticketStore.get("TEST-1")?.doc_refs.every(ref => existsSync(ref.path) && !ref.primary));
    const tool = createPaTicketTool({ store: f.ticketStore, plannedActualHost: f.projectionHost });
    const result = await tool.execute("read", { action: "read", id: "TEST-1", reference: plan.reference, candidate: sha }, undefined, undefined, {});
    const text = result.content.find(c => c.type === "text"); assert.ok(text && "text" in text);
    const projected = JSON.parse(text.text); assert.equal(projected.state, "available"); assert.equal(projected.actuals[0].rows[0].disposition, "unverified"); assert.equal(projected.actuals[0].evidence.find((e: { class: string }) => e.class === "human-uat").state, "not-run");
    assert.equal(f.ticketStore.get("TEST-1")?.status, "implementing");
    const discovered = await tool.execute("discover", { action: "read", id: "TEST-1", plannedActual: true }, undefined, undefined, {});
    assert.match(JSON.stringify(discovered), /selection-required/);
    await assert.rejects(tool.execute("bad-selector", { action: "read", id: "TEST-1", reference: plan.reference }, undefined, undefined, {}));
    const before = readFileSync(f.ownerPath);
    const human = f.evidence.publish("planned-actual-human", { binding: f.payload.binding, report: f.payload.report, state: "passed", observedAt: "2026-11-21T01:00:00.000Z", coverage: ["AC-01"] });
    const later = f.evidence.publish("planned-actual", { ...f.payload, human: [human] });
    const next = f.service.publishPlannedActualLocator(f.receipt, later);
    await attachPlannedActual(f.ticketStore, "TEST-1", next, f.projectionHost, () => undefined);
    const appended = await tool.execute("read2", { action: "read", id: "TEST-1", reference: plan.reference, candidate: sha }, undefined, undefined, {});
    assert.match(JSON.stringify(appended), /local-unverified/); assert.deepEqual(readFileSync(f.ownerPath), before);
    writeFileSync(f.locator, "tampered locator");
    assert.deepEqual(await f.native.resolveActual(f.locator), { state: "integrity-failure" });
    writeFileSync(f.locator, companion);
    assert.deepEqual(await f.native.resolveActual(join(f.root, "relocated", f.locator.split("/").at(-1)!)), { state: "integrity-failure" });
    writeFileSync(actual.reportPath, "tampered");
    const bad = await f.native.resolveActual(f.locator); assert.deepEqual(bad, { state: "integrity-failure" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("normal phase-report dispatch exposes only native join and foreground observation, rejects imported authority", async () => {
  const f = fixture();
  try {
    const calls: string[] = []; const tools: PiToolDefinition[] = [];
    const binding: PiPhaseReportBinding = { service: f.service, resolveReport: () => f.report, resolveReceipt(ref) { assert.deepEqual(ref, f.receiptRef); return f.receipt; }, async attachActual(receipt, reference, observations, work) { assert.deepEqual(receipt, f.receipt); assert.equal(reference, plan.reference); assert.deepEqual(observations, f.payload.observations); assert.deepEqual(work, []); calls.push("attach"); return f.locator; }, async observeActual(locator) { assert.equal(locator, f.locator); calls.push("observe"); return null; } };
    const runtime = { registerTool(tool: PiToolDefinition) { tools.push(tool); } };
    // Registration uses only the runtime's tool port; the composed editor graph is intentionally absent.
    createPiPhaseReportModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" }, resolveBinding: () => binding })(runtime as PiRuntime);
    const run = (input: Record<string, unknown>) => tools[0]!.execute("call", input, undefined, undefined, {});
    assert.equal((await run({ action: "attach-actual", report: f.receiptRef, reference: plan.reference, observations: f.payload.observations, actualOnly: [] })).details.acceptanceClaimed, false);
    assert.equal((await run({ action: "observe-actual", locator: f.locator })).details.state, "not-observed");
    await assert.rejects(run({ action: "observe-actual", locator: f.locator, state: "passed" }));
    for (const extra of [{ evidence: source("arbitrary") }, { passed: true }, { outcome: "approved" }, { candidateSha: sha }, { root: "/other" }]) await assert.rejects(run({ action: "attach-actual", report: f.receiptRef, reference: plan.reference, observations: [], actualOnly: [], ...extra }));
    assert.deepEqual(calls, ["attach", "observe"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
