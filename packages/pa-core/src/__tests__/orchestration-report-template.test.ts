import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { getPlatformHomeDir } from "../index.js";

const configRoot = getPlatformHomeDir();
const templatePath = join(configRoot, "skills", "templates", "orchestration-report.md");

test("orchestration report template includes evaluator child coverage columns", (t) => {
  if (!existsSync(templatePath)) return t.skip("external pa-platform-config fixture not available");
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /\| Phase \| Deploy ID \| Mode \| Status \| Severity \| Evaluator Launch \| Evaluator Deploy ID \| Evaluator Notes \|/);
  assert.match(template, /\| 4\.1 \(<brief scope>\) \| d-abc123 \| builder\/implement \| success \| - \| launched \| d-eval123 \| target=d-abc123 \|/);
});

test("orchestration report template guidance defines durable evaluator evidence semantics", (t) => {
  if (!existsSync(templatePath)) return t.skip("external pa-platform-config fixture not available");
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /Evaluator Launch` should be one of: `launched`, `failed`, `skipped`, `not-applicable`, or `in-flight`/);
  assert.match(template, /initialize evaluator fields to: `Evaluator Launch=in-flight`, `Evaluator Deploy ID=-`, `Evaluator Notes=awaiting-child-completion`/);
  assert.match(template, /`Evaluator Notes` is required for `builder\/implement` rows and must include the target deployment ID \(`target=<child-deploy-id>`\)/);
});

test("orchestration report template requires Phase 5.x feedback loop evidence fields", (t) => {
  if (!existsSync(templatePath)) return t.skip("external pa-platform-config fixture not available");
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /### Phase 5\.x Feedback Loop Evidence/);
  assert.match(template, /\| Iteration \| Feedback Source \| Objective Artifact Path \| Plan-Review Evidence \(Pre-Launch\) \| Child Deploy ID \| Child Status \| Post-Completion Verification Evidence \| Confirmation \|/);
  assert.match(template, /\| 5\.6-c1 \| sinh-uat-comment:<ticket-id>#<comment-id> \| agent-teams\/builder\/artifacts\/YYYY-MM-DD-<topic>-fix-objective-c1\.md \| approved: sinh confirmed objective comment <ticket-id>#<comment-id> before launch \| d-fix123 \| success \| all required checks passed after d-fix123; key finding IDs CQ-3,CQ-4 closed \| pending-confirmation \|/);
  assert.match(template, /`Confirmation` must be either explicit confirmation text/);
  assert.match(template, /or `pending-confirmation` while waiting\./);
});

test("orchestration report template preserves launch-completion bracketing with evaluator columns", (t) => {
  if (!existsSync(templatePath)) return t.skip("external pa-platform-config fixture not available");
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /Keep launch\/completion report bracketing intact for every sub-deploy update/);
  assert.match(template, /Phase 5\.x evidence rows add detail but do not replace timeline \+ sub-deploy row writes\./);
  assert.match(template, /For each `builder\/implement` child deployment, record evaluator coverage in `Evaluator Launch`, `Evaluator Deploy ID`, and `Evaluator Notes`\./);
});
