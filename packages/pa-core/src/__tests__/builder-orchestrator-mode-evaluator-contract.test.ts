import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const modePath = join(repoRoot, "../pa-platform-config", "teams", "builder", "modes", "orchestrator.md");

test("builder orchestrator mode requires evaluator child coverage before handoff", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /Child coverage contract: for every builder implement child deployment that reaches terminal status, the orchestration report must record child deployment ID, child terminal status, evaluator launch status, and evaluator deployment ID or failure\/skip reason\./);
  assert.match(modeDoc, /Child coverage write timing: persist child evaluator coverage in the sub-deploy row immediately after `opa status <deploy-id> --wait` returns and before advancing to the next phase or handoff\./);
  assert.match(modeDoc, /Evaluator Launch=in-flight/);
});

test("builder orchestrator mode keeps no-ticket hard fail before Phase 0", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /No `ticket_id` → hard fail\./);
  assert.match(modeDoc, /orchestrator requires ticket_id; none provided/);
  assert.match(modeDoc, /Do not run Phase 0 or any later phase\./);

  const noTicketRuleIndex = modeDoc.indexOf("- **No `ticket_id` → hard fail.");
  const phaseZeroIndex = modeDoc.indexOf("## Phase 0: Repo Resolution (mandatory pre-flight)");

  assert.notEqual(noTicketRuleIndex, -1);
  assert.notEqual(phaseZeroIndex, -1);
  assert.ok(
    noTicketRuleIndex < phaseZeroIndex,
    "no-ticket hard fail rule must appear before Phase 0 instructions",
  );
});

test("builder orchestrator mode enforces Phase 5.x user confirmation loop gate", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /Phase 5\.x confirmation gate rule: this gate applies only when Sinh\/user feedback\s+is involved\./);
  assert.match(modeDoc, /the orchestrator MUST record the result and ask Sinh for\s+explicit confirmation before any Phase 6 action, routine merge work, or ticket\s+handoff\./);
  assert.match(modeDoc, /Continue this loop until Sinh approves or explicitly stops the loop\./);
  assert.match(modeDoc, /Phase 6\s+is blocked\s+unless state is `approved` or `stopped`\./);
  assert.match(modeDoc, /Phase 6 entry gate: if any Phase 5\.x user-feedback-derived fix result is still/);
});
