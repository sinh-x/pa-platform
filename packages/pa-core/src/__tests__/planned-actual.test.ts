import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPlannedActual, attachPlannedActual, extractAcceptanceRows, plannedActualReadFailure, type PlannedActualHost, type PlannedRecord, type ActualRecord } from "../tickets/planned-actual.js";
import { ArtifactPolicyError } from "../artifacts/policy.js";
import { TicketStore } from "../tickets/store.js";
import type { Ticket } from "../tickets/types.js";
const sha = (c: string, n = 64) => c.repeat(n);
const plan: PlannedRecord = { reference: `review:${sha("a")}`, repository: { key: "test", root: "/repo" }, ticket: "TEST-1", subjectSha256: sha("b"), revision: 3, manifestSha256: sha("c"), deliverySha256: sha("d"), state: "approved", entry: "/planned/index.html", rows: [{ id: "AC-01", expectation: "Print closed content." }, { id: "AC-02", expectation: "Reveal the target." }] };
const locator = `/reports/planned-actual-d-aaaaaa-${sha("e")}.json`;
const actual: ActualRecord = { locator, binding: { repository: plan.repository, ticket: plan.ticket, subjectSha256: plan.subjectSha256, revision: plan.revision, manifestSha256: plan.manifestSha256, candidateSha: sha("f", 40) }, plannedReference: plan.reference, reportId: sha("1"), reportSourceSha256: sha("2"), reportPath: "/reports/report.md", ownerPath: "/reports/owner.md", outcome: "partial", scope: "Native phase P5", observations: [{ ac: "AC-01", observation: "All content prints.", disposition: "matches", difference: "None", impact: "None", owner: "Builder" }, { ac: "AC-02", observation: "Target stayed closed.", disposition: "deviates", difference: "Fragment does not reveal", impact: "Keyboard access", owner: "Builder" }], actualOnly: ["Extra regression check"], evidence: [{ class: "source", state: "passed", locator: "native:check", observedAt: "2026-11-21T00:00:00.000Z", coverage: ["AC-01"], trust: "native" }] };
function ticket(refs = [locator]): Ticket { return { id: "TEST-1", project: "test", title: "Fixture", summary: "Fixture", description: "Fixture", status: "implementing", priority: "medium", type: "task", assignee: "builder/team-manager", estimate: "M", from: "", to: "", tags: [], blockedBy: [], linkedBranches: [], linkedCommits: [], comments: [], subTickets: [], nextSubTicketCounter: 0, createdAt: "2026-11-21T00:00:00.000Z", updatedAt: "2026-11-21T00:00:00.000Z", resolvedAt: null, doc_refs: refs.map(path => ({ type: "attachment", path, primary: false, addedAt: "2026-11-21", addedBy: "native" })) }; }
function host(records = [actual]): PlannedActualHost { return { discoverPlans: async () => ({ references: [], issues: [] }), resolvePlan: async () => plan, resolveActual: async key => { const r = records.find(r => r.locator === key); if (!r) throw new Error("missing"); return r; } }; }
const project = (records = [actual], t = ticket(records.map(r => r.locator))) => projectPlannedActual(t, plan.reference, actual.binding.candidateSha, host(records));
test("exact binding projects every AC, deviations, actual-only and separate Not run handback evidence", async () => {
  const discovery = await projectPlannedActual(ticket(), undefined, undefined, host());
  assert.equal(discovery.state, "selection-required");
  assert.deepEqual(discovery.choices, [{ reference: plan.reference, state: "approved", candidate: actual.binding.candidateSha, reportId: actual.reportId }]);
  const r = await project(); assert.equal(r.state, "available");
  assert.deepEqual(r.actuals[0]?.binding, actual.binding);
  assert.equal(r.actuals[0]?.rows[1]?.disposition, "deviates"); assert.equal(r.actuals[0]?.rows[1]?.impact, "Keyboard access");
  assert.equal(r.actuals[0]?.actualOnly[0], "Extra regression check");
  assert.equal(r.actuals[0]?.narrativeTrust, "agent-labelled-not-acceptance");
  for (const kind of ["installed", "independent", "browser", "human-uat"]) assert.deepEqual(r.actuals[0]?.evidence.filter(e => e.class === kind).map(e => e.state), ["not-run"]);
});
test("independent Planned discovery includes approved and draft without inventing Actual candidates", async () => {
  for (const state of ["approved", "draft"] as const) {
    let discovered = 0, actualReads = 0;
    const selected = { ...plan, state };
    const h: PlannedActualHost = { discoverPlans: async t => { assert.equal(t.id, plan.ticket); discovered++; return { references: [plan.reference], issues: [] }; }, resolvePlan: async () => selected, resolveActual: async () => { actualReads++; throw new Error("No Actual exists"); } };
    const discovery = await projectPlannedActual(ticket([]), undefined, undefined, h);
    assert.equal(discovery.state, "selection-required");
    assert.deepEqual(discovery.choices, [{ reference: plan.reference, state }]);
    assert.equal(discovered, 1); assert.equal(actualReads, 0);
    const read = await projectPlannedActual(ticket([]), plan.reference, undefined, h);
    assert.equal(read.state, state === "approved" ? "no-handback" : "draft");
    assert.deepEqual(read.planned, selected); assert.deepEqual(read.actuals, []);
    assert.doesNotMatch(JSON.stringify(read), /candidateSha/);
  }
  const read = await projectPlannedActual(ticket(), plan.reference, undefined, host());
  assert.equal(read.state, "selection-required"); assert.equal(read.actuals.length, 0);
  assert.equal(read.choices?.[0]?.candidate, actual.binding.candidateSha);
  const older = { ...plan, reference: `review:${sha("7")}`, revision: 1, state: "draft" as const };
  const many: PlannedActualHost = { ...host(), discoverPlans: async () => ({ references: [plan.reference, older.reference, plan.reference], issues: [] }), resolvePlan: async ref => ref === older.reference ? older : plan };
  const choices = await projectPlannedActual(ticket([]), undefined, undefined, many);
  assert.deepEqual(choices.choices, [{ reference: plan.reference, state: "approved" }, { reference: older.reference, state: "draft" }]);
  assert.equal(choices.planned, undefined); assert.equal(choices.actuals.length, 0);
});
test("discovery preserves verified choices alongside denied owners and suppresses mismatched Planned content", async () => {
  const privateRef = `review:${sha("8")}`;
  const h: PlannedActualHost = { ...host(), discoverPlans: async () => ({ references: [plan.reference, privateRef], issues: [] }), resolvePlan: async ref => ref === privateRef ? { state: "denied" } : plan };
  const mixed = await projectPlannedActual(ticket([]), undefined, undefined, h);
  assert.equal(mixed.state, "denied"); assert.deepEqual(mixed.choices, [{ reference: plan.reference, state: "approved" }]);
  assert.doesNotMatch(JSON.stringify(mixed), new RegExp(privateRef));
  for (const changed of [{ ticket: "TEST-2" }, { repository: { key: "other", root: "/private" } }, { reference: privateRef }]) {
    const wrong: PlannedActualHost = { ...h, discoverPlans: async () => ({ references: [plan.reference], issues: [] }), resolvePlan: async () => ({ ...plan, ...changed, rows: [{ id: "AC-01", expectation: "PRIVATE CONTENT" }] }) };
    for (const ref of [undefined, plan.reference]) {
      const result = await projectPlannedActual(ticket([]), ref, undefined, wrong);
      assert.equal(result.state, "unmatched"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT|\/private/);
    }
  }
  const broken = await projectPlannedActual(ticket(), undefined, undefined, { ...host(), discoverPlans: async () => { throw new Error("PRIVATE exception"); } });
  assert.equal(broken.state, "unknown"); assert.equal(broken.choices?.length, 1);
  assert.doesNotMatch(JSON.stringify(broken), /PRIVATE/);
  const overBound = await projectPlannedActual(ticket(Array.from({ length: 257 }, () => locator)), undefined, undefined, { ...h, discoverPlans: async () => ({ references: [plan.reference], issues: [] }) });
  assert.equal(overBound.state, "unknown");
  assert.deepEqual(overBound.choices, [{ reference: plan.reference, state: "approved" }]);
});
test("wrong repository, ticket, subject, revision, manifest, candidate and reference stay unmatched", async () => {
  for (const binding of [{ repository: { key: "other", root: "/repo" } }, { repository: { key: "test", root: "/other" } }, { ticket: "TEST-2" }, { subjectSha256: sha("9") }, { revision: 4 }, { manifestSha256: sha("9") }, { candidateSha: sha("9", 40) }]) {
    const r = await project([{ ...actual, binding: { ...actual.binding, ...binding } }]); assert.equal(r.state, "unmatched"); assert.equal(r.actuals.length, 0); assert.equal(r.unmatched.length, 1);
  }
  assert.equal((await project([{ ...actual, plannedReference: `review:${sha("9")}` }])).state, "unmatched");
});
test("missing, denied, unverified plan, no handback and native conflict are explicit without disclosure", async () => {
  assert.equal((await project([], ticket([]))).state, "no-handback");
  for (const state of ["missing", "denied", "integrity-failure", "conflict", "unknown"] as const) {
    const h: PlannedActualHost = { ...host(), resolvePlan: async () => ({ state }) };
    const r = await projectPlannedActual(ticket(), plan.reference, actual.binding.candidateSha, h); assert.equal(r.state, state); assert.doesNotMatch(JSON.stringify(r), /Print closed|report.md/);
  }
  const broken = locator.replace(sha("e"), sha("6"));
  // Deliberately violate the trusted port's type to exercise runtime validation of corrupt persisted owner data.
  const mixedHost: PlannedActualHost = { ...host(), resolveActual: async key => key === locator ? actual : { ...actual, locator: broken, observations: [{ ...actual.observations[0]!, disposition: "invalid" }] } as unknown as ActualRecord };
  const mixed = await projectPlannedActual(ticket([locator, broken]), plan.reference, actual.binding.candidateSha, mixedHost);
  assert.equal(mixed.actuals.length, 1); assert.equal(mixed.state, "integrity-failure");
  const r = await projectPlannedActual(ticket(), plan.reference, actual.binding.candidateSha, { ...host(), resolveActual: async () => ({ state: "denied" }) });
  assert.equal(r.state, "denied"); assert.doesNotMatch(JSON.stringify(r), /report.md|All content prints/);
  assert.equal((await projectPlannedActual(ticket(), plan.reference, actual.binding.candidateSha, { ...host(), resolveActual: async () => { throw new Error("PRIVATE sentinel"); } })).state, "unknown");
});
test("later matching human observations append, retain handback Not run, and conflicts never latest-win", async () => {
  const before = JSON.stringify(actual);
  const later = { ...actual, locator: locator.replace(sha("e"), sha("3")), evidence: [...actual.evidence, { class: "human-uat" as const, state: "passed" as const, locator: "native:human-1", observedAt: "2026-11-21T01:00:00.000Z", coverage: ["AC-01"], trust: "local-unverified" as const }] };
  const r = await project([actual, later]); assert.equal(r.state, "available"); assert.equal(r.actuals.length, 1);
  assert.deepEqual(r.actuals[0]?.evidence.filter(e => e.class === "human-uat").map(e => e.state), ["not-run", "passed"]);
  assert.equal(JSON.stringify(actual), before);
  const reversed = await project([later, actual]);
  assert.deepEqual(reversed.actuals[0]?.evidence.filter(e => e.class === "human-uat").map(e => e.state), ["not-run", "passed"]);
  const bad = { ...later, locator: locator.replace(sha("e"), sha("4")), evidence: [{ ...later.evidence[1]!, state: "failed" as const }] };
  assert.equal((await project([actual, later, bad])).state, "conflict");
  assert.equal((await project([{ ...actual, observations: [] }])).actuals[0]?.rows[0]?.disposition, "unverified");
  const unmet = { ...actual, observations: [{ ...actual.observations[0]!, disposition: "unmet" as const }] };
  assert.equal((await project([unmet])).actuals[0]?.rows[0]?.disposition, "unmet");
  assert.equal((await project([actual, { ...unmet, reportId: sha("7"), locator: locator.replace(sha("e"), sha("8")) }])).state, "conflict");
});
test("historical source checks stay distinct and cannot conflict with current evidence", async () => {
  const old = { ...actual.evidence[0]!, applicability: "historical" as const };
  const current = { ...old, state: "failed" as const, applicability: "current" as const };
  const r = await project([{ ...actual, evidence: [old, current] }]);
  assert.equal(r.state, "available");
  assert.deepEqual(r.actuals[0]?.evidence.filter(e => e.class === "source").map(e => [e.state, e.applicability]), [["passed", "historical"], ["failed", "current"]]);
  const unverified = await project();
  assert.ok(unverified.actuals[0]?.evidence.some(e => e.class === "source" && e.state === "not-run"));
  assert.ok(unverified.actuals[0]?.evidence.some(e => e.class === "source" && e.state === "passed" && e.applicability === "unverified"));
});

test("only typed native artifact-stale errors become integrity failures, never prose or imported flags", () => {
  assert.deepEqual(plannedActualReadFailure(new ArtifactPolicyError("ARTIFACT_STALE")), { state: "integrity-failure" });
  for (const error of [new Error("ARTIFACT_STALE private"), { diagnostic: "ARTIFACT_STALE" }, null, new ArtifactPolicyError("ARTIFACT_RUNTIME_FAILED")]) assert.deepEqual(plannedActualReadFailure(error), { state: "unknown" });
});

test("acceptance expectations come verbatim from signed requirements, not report prose", () => {
  assert.deepEqual(extractAcceptanceRows("# Acceptance\n- AC-01: Print closed content.\n- AC-02: Reveal the target.\n"), plan.rows);
  assert.throws(() => extractAcceptanceRows("- AC-01: one\n- AC-01: conflicting"));
  assert.deepEqual(extractAcceptanceRows("- AC-01: First line.\n  Continuation must remain.\n\n  Another paragraph.\n- AC-02: Next.\n"), [{ id: "AC-01", expectation: "First line.\n  Continuation must remain.\n\n  Another paragraph." }, { id: "AC-02", expectation: "Next." }]);
  const row = "| AC-03 | Expected exact behavior | Automated check |";
  assert.deepEqual(extractAcceptanceRows(`## 10. Acceptance criteria\n${row}\n`), [{ id: "AC-03", expectation: row }]);
});
test("exact attachment uses existing mutex/ref/audit owner, no primary/status change or conflicting path overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap327-p5-"));
  try {
    const t = ticket([]); writeFileSync(join(root, "TEST-1.json"), JSON.stringify(t)); const store = new TicketStore(root);
    let admitted = true; const authorize = () => { if (!admitted) throw new Error("denied"); };
    await attachPlannedActual(store, "TEST-1", locator, host(), authorize);
    const after = store.get("TEST-1")!; assert.deepEqual(after.doc_refs.map(r => [r.type, r.path, r.primary]), [["orch", actual.ownerPath, false], ["impl", actual.reportPath, false], ["attachment", locator, false]]);
    const bytes = readFileSync(join(root, "TEST-1.json"));
    await attachPlannedActual(store, "TEST-1", locator, host(), authorize); assert.deepEqual(readFileSync(join(root, "TEST-1.json")), bytes);
    admitted = false; await assert.rejects(attachPlannedActual(store, "TEST-1", locator, host(), authorize));
    admitted = true;
    await assert.rejects(attachPlannedActual(store, "TEST-1", locator, host([{ ...actual, binding: { ...actual.binding, ticket: "TEST-2" } }]), authorize));
    after.doc_refs[0]!.type = "url"; writeFileSync(join(root, "TEST-1.json"), JSON.stringify(after));
    await assert.rejects(attachPlannedActual(store, "TEST-1", locator, host(), authorize));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
