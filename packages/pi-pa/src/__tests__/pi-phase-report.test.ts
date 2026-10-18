import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PHASE_REPORT_SECTIONS, PhaseReportService, indexPhaseReport, indexPhaseReportDelivery, phaseReportDeliverySources, parsePhaseReport, workflowDigest, type PhaseReportHost, type PhaseReportReceipt, type SourceVersion } from "@pa-platform/pa-core";
import { createPiPhaseReportModule, PiPhaseReportParams, type PiPhaseReportBinding } from "../pi-extension/prepared-workflow.js";
import { createPiSessionLifecycle, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";
const sha = "a".repeat(40); const time = "2026-10-17T00:00:00.000Z";
const source = (ref: string): SourceVersion => ({ ref: `fixture:${ref}`, version: "v1", sha256: workflowDigest(ref) });
function tools(env: NodeJS.ProcessEnv, binding: () => PiPhaseReportBinding | null = () => null) {
  const registered: PiToolDefinition[] = [];
  const pi = { registerTool(tool: PiToolDefinition) { registered.push(tool); } } as PiRuntime;
  const lifecycle = createPiSessionLifecycle(() => undefined);
  createPiPhaseReportModule({ env, resolveBinding: binding })(pi, lifecycle);
  return { registered, lifecycle, execute(input: Record<string, unknown>) { return registered[0]!.execute("native-tool-call", input, undefined, undefined, {}); } };
}
test("AC14 mode-scoped report-only registration permits ticketless rogue-one, not requirements; inactive rejects publication", async () => {
  for (const env of [{}, { PA_TEAM: "requirements", PA_MODE: "analyze" }]) assert.equal(tools(env).registered.length, 0);
  for (const env of [{ PA_TEAM: "rogue-one", PA_MODE: "rogue-one" }, { PA_TEAM: "builder", PA_MODE: "implement" }, { PA_TEAM: "builder", PA_MODE: "orchestrator" }]) {
    const r = tools(env); assert.equal(r.registered[0]!.name, "pa_phase_report");
    assert.equal((await r.execute({ action: "status" })).details.state, "inactive");
    await assert.rejects(r.execute({ action: "publish", source: source("report") }));
  }
  assert.doesNotMatch(JSON.stringify(PiPhaseReportParams), /repoRoot|root|path|token|process|builder_authority|ticket_slot/);
});

test("AC14/17/19 actual report dispatch publishes native source and retains presentation debt; model cannot assert browser success", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap256-pi-report-"));
  try {
    let owner = "# Existing rogue-one owner\n"; let receipt: PhaseReportReceipt | undefined; let missing = false;
    const input = parsePhaseReport({ schemaVersion: "phase-report/v1", identity: { date: "2026-10-17", team: "rogue-one", ticket: null, deploymentId: "d-aaaaaa", phaseId: "phase-4", attempt: 1, executor: "rogue-one" }, outcome: "partial", startedAt: time, finishedAt: time, baseSha: sha, candidateSha: sha, commitState: "no-commit",
      sections: Object.fromEntries(PHASE_REPORT_SECTIONS.map((key) => [key, `${key}: native source; no completion claim.`])), checks: [], previousAttempts: [], evidence: source("input") });
    const host: PhaseReportHost = {
      authorize() {}, verifyReport() { if (missing) throw new Error("PRIVATE-NATIVE-EVIDENCE missing"); }, sanitize: (text) => text, assertPublic() {},
      verifyCanonical() { if (missing) throw new Error("PRIVATE-NATIVE-EVIDENCE drifted"); },
      index(value) { receipt = value; owner = indexPhaseReport(owner, workflowDigest(owner), value).markdown; },
      resolveDelivery() { throw new Error("not a native operator observation"); },
      loadDeliverySources(value) { return phaseReportDeliverySources(owner, value); },
      recordDelivery(value, delivery) { owner = indexPhaseReportDelivery(owner, workflowDigest(owner), value, delivery).markdown; },
    };
    const service = new PhaseReportService(root, host);
    const binding: PiPhaseReportBinding = { service, resolveReport(ref) { if (ref.ref !== "fixture:input") throw new Error("not the authenticated phase source"); return input; }, resolveReceipt(ref) { if (ref.ref !== "fixture:receipt" || !receipt) throw new Error("not a native receipt"); return receipt; } };
    const r = tools({ PA_TEAM: "rogue-one", PA_MODE: "rogue-one" }, () => binding);
    const published = await r.execute({ action: "publish", source: source("input") });
    assert.equal(published.details.outcome, "partial"); assert.deepEqual(published.details.presentationDebt, ["browser", "obsidian"]);
    assert.equal(published.details.phaseDeliveryReady, false); assert.equal(published.details.humanProductUatClaimed, false);
    const before = owner;
    await r.execute({ action: "publish", source: source("input") }); assert.equal(owner, before);
    await assert.rejects(r.execute({ action: "settle", report: source("receipt"), deliveries: [], browser: true }));
    await assert.rejects(r.execute({ action: "publish", source: source("input"), root: "/unapproved", author: "sinh" }));
    await assert.rejects(r.execute({ action: "settle", report: source("receipt"), deliveries: [source("model-text-says-opened")] }));
    missing = true;
    await assert.rejects(r.execute({ action: "status", report: source("receipt") }), (error: Error) => !error.message.includes("PRIVATE-NATIVE-EVIDENCE"));
    missing = false;
    await r.lifecycle.shutdown();
    await assert.rejects(r.execute({ action: "status", report: source("receipt") }));
    assert.equal(readdirSync(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC14 revoked/async/untrusted report source fails before artifact writes", async () => {
  const r = tools({ PA_TEAM: "rogue-one", PA_MODE: "rogue-one" }, (async () => null) as unknown as () => PiPhaseReportBinding);
  await assert.rejects(r.execute({ action: "status" }));
});
