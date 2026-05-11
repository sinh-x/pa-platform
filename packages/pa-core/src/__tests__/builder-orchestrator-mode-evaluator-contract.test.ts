import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const modePath = join(repoRoot, "teams", "builder", "modes", "orchestrator.md");

test("builder orchestrator mode requires evaluator child coverage before handoff", () => {
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /Child coverage contract: for every builder implement child deployment that reaches terminal status, the orchestration report must record child deployment ID, child terminal status, evaluator launch status, and evaluator deployment ID or failure\/skip reason\./);
  assert.match(modeDoc, /Child coverage write timing: persist child evaluator coverage in the sub-deploy row immediately after `opa status <deploy-id> --wait` returns and before advancing to the next phase or handoff\./);
  assert.match(modeDoc, /Evaluator Launch=in-flight/);
});
