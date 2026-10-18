import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PHASE_REPORT_SECTIONS, PhaseReportService, indexPhaseReport, indexPhaseReportDelivery, phaseReportDeliverySources, parsePhaseReport, phaseReportMarkdown, redactPhaseReportText, type PhaseReport, type PhaseReportDelivery, type PhaseReportHost, type PhaseReportReceipt } from "../artifacts/phase-report.js";
import { renderMarkdown, renderReadingMarkdown } from "../artifacts/render.js";
import { workflowDigest, type SourceVersion } from "../deploy/prepared-workflow.js";
const sha = "a".repeat(40); const time = "2026-10-17T00:00:00.000Z";
const source = (ref: string): SourceVersion => ({ ref: `fixture:${ref}`, version: "v1", sha256: workflowDigest(ref) });
function report(outcome: PhaseReport["outcome"] = "success"): PhaseReport {
  return parsePhaseReport({ schemaVersion: "phase-report/v1", identity: { date: "2026-10-17", team: "rogue-one", ticket: null, deploymentId: "d-aaaaaa", phaseId: "phase-4", attempt: 1, executor: "rogue-one" }, outcome, startedAt: time, finishedAt: time, baseSha: sha, candidateSha: sha, commitState: "no-commit",
    sections: Object.fromEntries(PHASE_REPORT_SECTIONS.map((key) => [key, `${key}: no additional facts claimed; see native evidence.`])),
    checks: [{ command: "corepack pnpm typecheck", candidateSha: sha, state: "passed", exitCode: 0, output: source("typecheck-output") }], previousAttempts: [], evidence: source("input") });
}
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap256-phase-report-"));
  try { run(setup(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  let owner = "# Existing owner report\n"; let deny = false; let missing = false; let indexFail = false;
  const deliveries = new Map<string, PhaseReportDelivery>();
  const host: PhaseReportHost = {
    authorize() { if (deny) throw new Error("PRIVATE-AUTHORITY-SENTINEL"); }, verifyReport() { if (missing) throw new Error("native check/Git evidence missing"); },
    sanitize(markdown) { return redactPhaseReportText(markdown, ["SECRET-SENTINEL", "PRIVATE-PATH-SENTINEL", "UNRELATED-SENTINEL"]); },
    assertPublic(bytes) { assert.doesNotMatch(bytes.toString(), /SECRET-SENTINEL|PRIVATE-PATH-SENTINEL|UNRELATED-SENTINEL/); },
    verifyCanonical() { if (missing) throw new Error("missing/stale native canonical evidence"); },
    index(receipt) { if (indexFail) throw new Error("owner CAS conflict"); owner = indexPhaseReport(owner, workflowDigest(owner), receipt).markdown; },
    resolveDelivery(ref) { const delivery = deliveries.get(ref.ref); if (!delivery) throw new Error("not an operator delivery record"); return delivery; },
    loadDeliverySources(receipt) { return phaseReportDeliverySources(owner, receipt); },
    recordDelivery(receipt, delivery) { owner = indexPhaseReportDelivery(owner, workflowDigest(owner), receipt, delivery).markdown; },
  };
  const service = new PhaseReportService(root, host);
  const path = (attempt = 1) => join(root, "2026-10-17-ticketless-phase-4-d-aaaaaa", `attempt-${attempt}`);
  const observe = (receipt: PhaseReportReceipt, application: "browser" | "obsidian", kind: PhaseReportDelivery["kind"] = "native-operator") => {
    const evidence = source(`delivery-${application}`);
    deliveries.set(evidence.ref, { application, kind, reportId: receipt.reportId, sourceSha256: receipt.sourceSha256, htmlSha256: receipt.htmlSha256, observedAt: time, evidence }); return evidence;
  };
  return { root, host, service, path, observe, deliveries, owner: () => owner, setDeny(value: boolean) { deny = value; }, setMissing(value: boolean) { missing = value; }, setIndexFail(value: boolean) { indexFail = value; } };
}

test("AC14/15 strict cross-mode corpus covers all outcomes and honest no-commit/ticketless/reconstruction", () => {
  for (const outcome of ["success", "partial", "failed", "interrupted"] as const) {
    for (const executor of ["implement", "orchestrator-direct", "rogue-one"] as const) {
      const input = report(outcome);
      const identity = { ...input.identity, executor, team: executor === "rogue-one" ? "rogue-one" as const : "builder" as const, ticket: executor === "rogue-one" ? null : "PAP-256" };
      const parsed = parsePhaseReport({ ...input, identity, sections: { ...input.sections, reconstruction: outcome === "interrupted" ? "Reconstructed from proven native terminal/check/Git records. Origin and close cause unknown." : "Not reconstructed: ordinary native evidence." } });
      const md = phaseReportMarkdown(parsed);
      for (const key of PHASE_REPORT_SECTIONS) assert.ok(md.includes(`## ${key}\n`));
      assert.match(md, /commit state: no-commit/); assert.ok(md.includes(`Outcome: ${outcome}`));
      assert.ok(md.includes("corepack pnpm typecheck")); assert.ok(md.includes(source("typecheck-output").sha256));
    }
  }
  const input = report();
  for (const patch of [{ identity: { ...input.identity, team: "builder" } }, { unknown: true }, { sections: { ...input.sections, failures: "" } }, { checks: [] }, { candidateSha: null }]) assert.throws(() => parsePhaseReport({ ...input, ...patch }));
  const bad = { ...input.checks[0], state: "not-run", exitCode: 0 };
  assert.throws(() => parsePhaseReport({ ...input, checks: [bad] }));
  assert.throws(() => parsePhaseReport({ ...input, checks: [{ ...input.checks[0], candidateSha: "b".repeat(40) }] }));
  assert.throws(() => parsePhaseReport({ ...input, finishedAt: "2026-10-16T00:00:00.000Z" }));
  assert.throws(() => parsePhaseReport({ ...input, identity: { ...input.identity, phaseId: "../../escape" } }));
});

test("native full safe diff is fixed-path, source-bound, immutable and verified on settlement", () => fixture((f) => {
  const diff = Buffer.from("diff --git a/a.ts b/a.ts\n+bounded source\n");
  f.host.resolvePublicDiff = () => diff;
  const input = report("partial"); const value = { ...input, sections: { ...input.sections, diff: `[Full safe diff](diff.patch) SHA-256 ${workflowDigest(diff)}` } };
  const receipt = f.service.publish(value);
  assert.deepEqual(readFileSync(join(f.path(), "diff.patch")), diff);
  assert.match(readFileSync(join(f.path(), "report.html"), "utf8"), /href="diff.patch"/);
  assert.equal(f.service.settle(receipt).canonicalEvidenceAvailable, true);
  f.host.resolvePublicDiff = () => Buffer.from("conflicting diff"); assert.throws(() => f.service.publish(value));
  writeFileSync(join(f.path(), "diff.patch"), "tampered"); assert.throws(() => f.service.settle(receipt));
}));

test("unsafe or oversized native diff cannot persist public report bytes", () => fixture((f) => {
  f.host.resolvePublicDiff = () => Buffer.from("SECRET-SENTINEL"); assert.throws(() => f.service.publish(report())); assert.equal(existsSync(f.path()), false);
  f.host.resolvePublicDiff = () => Buffer.alloc(1_048_577, 65); assert.throws(() => f.service.publish(report())); assert.equal(existsSync(f.path()), false);
}));

test("AC15 failed/no-commit and unknown checks are evidence, never fabricated passes", () => fixture((f) => {
  const input = report("failed");
  const failed = { ...input, checks: [{ ...input.checks[0]!, state: "failed" as const, exitCode: 2 }], sections: { ...input.sections, failures: "Original exact command exit 2; remedy/recheck not run. Unknown cause retained." } };
  const receipt = f.service.publish(failed);
  assert.equal(f.service.settle(receipt).phaseDeliveryReady, false);
  const text = readFileSync(join(f.path(), "report.md"), "utf8"); assert.match(text, /exit: 2/); assert.match(text, /Unknown cause retained/);
  const next = { ...report("partial"), identity: { ...input.identity, attempt: 2 }, previousAttempts: [source("attempt-1")], checks: [{ command: "not executed", candidateSha: null, state: "not-run" as const, exitCode: null, output: null }] };
  f.service.publish(next);
  assert.match(readFileSync(join(f.path(2), "report.md"), "utf8"), /not proven/);
  assert.ok(existsSync(join(f.path(), "report.md")));
}));

test("AC16 reading view reuses escaped tables/code and source anchors; legacy Lavish renderer links remain inert", () => {
  const sourceRef = "/tmp/phase-report-fixture/report.md";
  const md = Buffer.from("# Header\n\n[here](#source-L1-L1) [source](report.md) [external](https://example.invalid) [escape](../private) [script](javascript:alert(1)) [encoded](%2e%2e/secret)\n\n| a | b |\n|---|---|\n| one | two |\n\n```ts\n<script>sentinel</script>\n```\n");
  const legacy = renderMarkdown(md, sourceRef); const reading = renderReadingMarkdown(md, sourceRef, ["report.md"]);
  assert.doesNotMatch(legacy.html.toString(), /<a href=/);
  assert.match(reading.html.toString(), /<a href="#source-L1-L1"/); assert.match(reading.html.toString(), /<a href="report.md"/);
  assert.doesNotMatch(reading.html.toString(), /<a href="(?:https:|javascript:|\.\.|%)/);
  assert.match(reading.html.toString(), /<table>/); assert.match(reading.html.toString(), /&lt;script&gt;sentinel/);
  assert.doesNotMatch(reading.html.toString(), /<script|<img|<iframe/);
  assert.deepEqual(reading, renderReadingMarkdown(md, sourceRef, ["report.md"])); assert.deepEqual(reading.anchors, legacy.anchors);
  for (const path of ["../escape", "/absolute", "https://external", ".git/config", "safe/../../private", "foo%2fbar", "safe//file"]) assert.throws(() => renderReadingMarkdown(md, sourceRef, [path]));
});

test("AC18 redact private sentinels in metadata/diff/binary/rename sections BEFORE Markdown/HTML/manifest/index", () => fixture((f) => {
  const input = report();
  const changed = { ...input, sections: { ...input.sections, gitInventory: "rename PRIVATE-PATH-SENTINEL -> safe.ts; binary omitted UNRELATED-SENTINEL", diff: "+ SECRET-SENTINEL", omissions: "Private/binary/unrelated content omitted; safe inventory reference retained." } };
  const receipt = f.service.publish(changed);
  for (const file of ["report.md", "report.html", "report.json"]) assert.doesNotMatch(readFileSync(join(f.path(), file), "utf8"), /SECRET-SENTINEL|PRIVATE-PATH-SENTINEL|UNRELATED-SENTINEL/);
  assert.doesNotMatch(f.owner(), /SECRET-SENTINEL|PRIVATE-PATH-SENTINEL|UNRELATED-SENTINEL/);
  assert.match(readFileSync(join(f.path(), "report.md"), "utf8"), /Redaction: private values omitted/);
  assert.equal(f.service.settle(receipt).canonicalEvidenceAvailable, true);
}));

test("AC17 generation has debt, labelled manual/native observations bind exact source and HTML; no human UAT claim", () => fixture((f) => {
  const receipt = f.service.publish(report());
  const initial = f.service.settle(receipt); assert.deepEqual(initial.presentationDebt, ["browser", "obsidian"]); assert.equal(initial.dependentWorkMayContinue, true); assert.equal(initial.phaseDeliveryReady, false);
  const browser = f.observe(receipt, "browser");
  assert.deepEqual(f.service.settle(receipt, [browser]).presentationDebt, ["obsidian"]);
  const obsidian = f.observe(receipt, "obsidian", "labelled-manual");
  const complete = f.service.settle(receipt, [browser, obsidian]); assert.equal(complete.phaseDeliveryReady, true); assert.equal(complete.humanProductUatClaimed, false);
  assert.equal(f.service.settle(receipt).phaseDeliveryReady, true); // observations survive subsequent calls via owner Markdown
  const reopened = new PhaseReportService(f.root, f.host); assert.equal(reopened.settle(receipt).phaseDeliveryReady, true);
  assert.throws(() => f.service.settle(receipt, [browser, browser]));
  f.deliveries.set(browser.ref, { ...f.deliveries.get(browser.ref)!, sourceSha256: "b".repeat(64) });
  assert.throws(() => f.service.settle(receipt, [browser, obsidian]));
  assert.throws(() => f.service.settle(receipt, [source("file-exists-not-access-evidence")]));
}));

test("AC17 missing canonical/check evidence pauses dependent work; no HTML-only completion", () => fixture((f) => {
  const receipt = f.service.publish(report()); f.setMissing(true);
  assert.throws(() => f.service.settle(receipt)); f.setMissing(false);
  unlinkSync(join(f.path(), "report.md")); assert.throws(() => f.service.settle(receipt));
  assert.ok(existsSync(join(f.path(), "report.html")));
}));

test("AC19 immutable duplicate publication/index is idempotent, contradictory attempts never overwrite history", () => fixture((f) => {
  const input = report(); const receipt = f.service.publish(input); const owner = f.owner();
  assert.deepEqual(f.service.publish(input), receipt); assert.equal(f.owner(), owner);
  assert.throws(() => f.service.publish({ ...input, outcome: "partial" }));
  assert.throws(() => f.service.publish({ ...input, sections: { ...input.sections, summary: "Contradictory same attempt." } }));
  assert.equal(readFileSync(join(f.path(), "report.json"), "utf8"), `${JSON.stringify(receipt)}\n`);
  const indexed = indexPhaseReport("# Owner\n", workflowDigest("# Owner\n"), receipt);
  assert.equal(indexPhaseReport(indexed.markdown, workflowDigest("stale allowed for exact no-op"), receipt).changed, false);
  assert.throws(() => indexPhaseReport("# Owner\n", workflowDigest("stale"), receipt));
  assert.throws(() => indexPhaseReport(indexed.markdown, indexed.sha256, { ...receipt, outcome: "partial" }));
  const contradiction = indexed.markdown.replace("attempt 1: success", "attempt 1: failed");
  assert.throws(() => indexPhaseReport(contradiction, workflowDigest(contradiction), receipt));
}));

test("AC19 index failure leaves durable original publication for reconciliation, no false settlement", () => fixture((f) => {
  f.setIndexFail(true); assert.throws(() => f.service.publish(report()));
  assert.ok(existsSync(join(f.path(), "report.md"))); assert.ok(existsSync(join(f.path(), "report.html")));
  assert.equal(f.owner(), "# Existing owner report\n");
  f.setIndexFail(false); const receipt = f.service.publish(report()); assert.equal(f.service.settle(receipt).canonicalEvidenceAvailable, true);
}));

test("NFR2/5 report aliases, symlinks, insecure records and tampering stop without repair", () => {
  for (const kind of ["alias", "symlink", "mode", "tamper"] as const) fixture((f) => {
    const receipt = f.service.publish(report()); const path = join(f.path(), "report.md");
    if (kind === "alias") linkSync(path, join(f.root, "retained-alias"));
    if (kind === "symlink") { unlinkSync(path); writeFileSync(join(f.root, "other"), "preserve"); symlinkSync(join(f.root, "other"), path); }
    if (kind === "mode") chmodSync(path, 0o644);
    if (kind === "tamper") writeFileSync(path, "tampered");
    assert.throws(() => f.service.settle(receipt)); assert.ok(existsSync(path));
  });
  fixture((f) => {
    f.setDeny(true); assert.throws(() => f.service.publish(report()), (error: Error) => !error.message.includes("PRIVATE-AUTHORITY-SENTINEL"));
    assert.deepEqual(readdirSync(f.root), []);
    const unsafe = new PhaseReportService(f.root, { ...f.host, verifyReport: (async () => undefined) as unknown as PhaseReportHost["verifyReport"] });
    assert.throws(() => unsafe.publish(report()));
    assert.deepEqual(readdirSync(f.root), []);
  });
});
