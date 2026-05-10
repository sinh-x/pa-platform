import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = join(repoRoot, "skills", "templates", "orchestration-report.md");

test("orchestration report template includes evaluator child coverage columns", () => {
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /\| Phase \| Deploy ID \| Mode \| Status \| Severity \| Evaluator Launch \| Evaluator Deploy ID \| Evaluator Notes \|/);
  assert.match(template, /\| 4\.1 \(<brief scope>\) \| d-abc123 \| builder\/implement \| success \| - \| launched \| d-eval123 \| target=d-abc123 \|/);
});

test("orchestration report template guidance defines durable evaluator evidence semantics", () => {
  const template = readFileSync(templatePath, "utf-8");

  assert.match(template, /Evaluator Launch` should be one of: `launched`, `failed`, `skipped`, `not-applicable`, or `in-flight`/);
  assert.match(template, /initialize evaluator fields to: `Evaluator Launch=in-flight`, `Evaluator Deploy ID=-`, `Evaluator Notes=awaiting-child-completion`/);
  assert.match(template, /`Evaluator Notes` is required for `builder\/implement` rows and must include the target deployment ID \(`target=<child-deploy-id>`\)/);
});
