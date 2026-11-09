import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ADVISORY_CASES, accountAdvisoryCases, qualify, validatePolicy } from "./verify_advisory_runtime.mjs";

function events() {
  return [...ADVISORY_CASES.map(([, owner, name]) => ({ type: "test:pass", data: { name, file: join("/fixture/harness", owner.replace(/\.ts$/, ".js")), details: { type: "test" } } })),
    { type: "test:summary", data: { success: true, counts: { passed: ADVISORY_CASES.length, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
}
test("installed advisory accounting requires every exact native case owner, no duplicate/skip/cancel/forged summary", () => {
  const original = events(); assert.equal(accountAdvisoryCases(original, "/fixture/harness").cases.length, 20);
  for (const change of [
    e => e.splice(0, 1), e => e.unshift(e[0]), e => { e[0].data.file = "/foreign/file.js"; }, e => { e[0].data.skip = true; },
    e => { e[0].type = "test:fail"; }, e => e.pop(), e => { e.at(-1).data.counts.cancelled = 1; }, e => { e.at(-1).data.counts.passed = 100; },
  ]) { const e = structuredClone(original); change(e); assert.throws(() => accountAdvisoryCases(e, "/fixture/harness")); }
});
test("exact installed verifier rejects source/module/config/results/skip override and abbreviated candidate", async () => {
  for (const args of [[], ["--source"], ["--selected-installed", "--require-candidate", "HEAD", "--require-paired-config"],
    ["--selected-installed", "--require-candidate", "a".repeat(40), "--require-paired-config", "--skip"],
    ["--selected-installed", "--require-candidate", "a".repeat(40), "--config-root", "/fixture"]]) await assert.rejects(() => qualify(args));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./verify_advisory_runtime.mjs", import.meta.url)), "--source"], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 1); const report = JSON.parse(run.stdout);
  assert.equal(report.status, "blocked"); assert.equal(report.installationPerformed, false); assert.equal(report.humanUat, false);
  assert.ok(report.cases.every(row => row.status === "not-run"));
});
test("PAPC qualification interface is structural, bounded and separate from runtime ordinary-tool admission", () => {
  const policy = { schemaVersion: "pa-advisory-policy/v1", runtimeContract: "pa-advisory-runtime/v1", resultContract: "pa-operation-result/v1", owner: "PAPC-074", sources: ["teams/builder.yaml", "teams/builder/modes/orchestrator.md"] };
  assert.equal(validatePolicy(policy), policy);
  for (const value of [{ ...policy, owner: "model" }, { ...policy, approved: true }, { ...policy, sources: [] }, { ...policy, sources: ["teams/../secret.yaml"] }, { ...policy, sources: ["/outside.md"] }, { ...policy, sources: ["teams/a.md", "teams/a.md"] }]) assert.throws(() => validatePolicy(value));
});
