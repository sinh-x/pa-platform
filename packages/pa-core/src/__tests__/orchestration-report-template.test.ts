import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = join(repoRoot, "../pa-platform-config", "skills", "templates", "orchestration-report.md");

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
  assert.match(template, /\| Iteration \| Feedback Source \| Objective Artifact Path \| Child Deploy ID \| Child Status \| Verification Summary \| Confirmation \|/);
  assert.match(template, /\| 5\.6-c1 \| sinh-uat-comment:<ticket-id>#<comment-id> \| agent-teams\/builder\/artifacts\/YYYY-MM-DD-<topic>-fix-objective-c1\.md \| d-fix123 \| success \|/);
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
