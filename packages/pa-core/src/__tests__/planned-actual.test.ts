import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPlannedActual, attachPlannedActual, extractAcceptanceRows, plannedActualReadFailure, parseActualRecord, type ActualScopeDetails, type PlannedActualHost, type PlannedRecord, type ActualRecord } from "../tickets/planned-actual.js";
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
test("optional structured scope retains all admitted facts while legacy records remain readable", async () => {
  const legacy = parseActualRecord(actual);
  assert.equal(Object.hasOwn(legacy, "scopeDetails"), false);
  assert.equal(Object.hasOwn((await project()).actuals[0]!, "scopeDetails"), false);
  const scopeDetails: ActualScopeDetails = { admitted: { scope: "s".repeat(4096), paths: Array.from({ length: 64 }, (_, i) => `src/${i}-${"p".repeat(90)}.ts`) }, scopeProven: true,
    custody: { state: "orchestrator-direct", observation: `Native custody observation\n${"c".repeat(65_510)}` }, omissions: Array.from({ length: 64 }, (_, i) => `Omission ${i}: ${"o".repeat(90)}`) };
  const record = { ...actual, scope: "Full sanitized scope facts are in scopeDetails.", scopeDetails };
  assert.deepEqual(parseActualRecord(record).scopeDetails, scopeDetails);
  const projected = await project([record]); assert.equal(projected.state, "available");
  assert.deepEqual(projected.actuals[0]?.scopeDetails, scopeDetails); assert.equal(projected.actuals[0]?.scope, record.scope);
  assert.throws(() => parseActualRecord({ ...actual, scope: "s".repeat(4097) }), "the summary limit does not grow");
  const noPlan = { ...scopeDetails, admitted: null, scopeProven: false, omissions: [] };
  assert.deepEqual(parseActualRecord({ ...record, scopeDetails: noPlan }).scopeDetails, noPlan);
});
test("structured scope has finite producer-compatible bounds and rejects malformed facts without truncation", () => {
  const details: ActualScopeDetails = { admitted: { scope: "s".repeat(40_960), paths: ["p".repeat(40_960)] }, scopeProven: true,
    custody: { state: "c".repeat(40_960), observation: "c".repeat(655_360) }, omissions: ["o".repeat(655_360)] };
  assert.deepEqual(parseActualRecord({ ...actual, scopeDetails: details }).scopeDetails, details);
  assert.equal(parseActualRecord({ ...actual, scopeDetails: { ...details, omissions: Array.from({ length: 128 }, () => "Omission") } }).scopeDetails?.omissions.length, 128);
  for (const scopeDetails of [
    null, { ...details, extra: true }, { ...details, scopeProven: "true" },
    { ...details, admitted: { scope: "s".repeat(40_961), paths: ["p"] } },
    { ...details, admitted: { scope: "scope", paths: ["p".repeat(40_961)] } },
    { ...details, admitted: { scope: "scope", paths: Array.from({ length: 65 }, () => "p") } },
    { ...details, admitted: { scope: "scope", paths: [] } },
    { ...details, admitted: { scope: "scope", paths: [7] } },
    { ...details, custody: { ...details.custody, observation: "c".repeat(655_361) } },
    { ...details, custody: { ...details.custody, state: "c".repeat(40_961) } },
    { ...details, omissions: ["o".repeat(655_360), "one too many"] },
    { ...details, omissions: Array.from({ length: 129 }, () => "Omission") },
    { ...details, omissions: ["Unsafe\u001b[0m"] },
  ]) assert.throws(() => parseActualRecord({ ...actual, scopeDetails }));
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
test("acceptance extraction preserves nested obligations and ignores fenced, quoted and nested example identities", () => {
  const markdown = [
    "# Acceptance", "- AC-01: Export approved records.", "  - Never include deleted records.",
    "", "  | Flag | Required behavior |", "  | --- | --- |", "  | Deleted | Excluded |", "",
    "  ```text", "  AC-99: This is an example inside the criterion.", "  ```", "- AC-02: Complete the export.",
    "", "# Examples", "```markdown", "- AC-03: Fenced example, not a criterion.", "```",
    "> AC-04: Quoted example.", "", "- Example:", "  - AC-05: Nested example.", "",
  ].join("\n");
  const rows = extractAcceptanceRows(markdown);
  assert.deepEqual(rows.map(row => row.id), ["AC-01", "AC-02"]);
  assert.equal(rows[0]?.expectation, [
    "Export approved records.", "  - Never include deleted records.", "", "  | Flag | Required behavior |",
    "  | --- | --- |", "  | Deleted | Excluded |", "", "  ```text", "  AC-99: This is an example inside the criterion.", "  ```",
  ].join("\n"));
  assert.equal(rows[1]?.expectation, "Complete the export.");
  assert.deepEqual(extractAcceptanceRows("AC-06: Main obligation.\n\nMore required detail.\n\n- A nested condition.\n\nAC-07: Next obligation.\n"), [
    { id: "AC-06", expectation: "Main obligation.\n\nMore required detail.\n\n- A nested condition." },
    { id: "AC-07", expectation: "Next obligation." },
  ]);
  assert.deepEqual(extractAcceptanceRows("| AC | Expected behavior |\n| --- | --- |\n| AC-08 | Full **required** behavior |\n"), [{ id: "AC-08", expectation: "| AC-08 | Full **required** behavior |" }]);
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
