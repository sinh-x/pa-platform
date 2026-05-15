import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { getPlatformHomeDir } from "../index.js";

const configRoot = getPlatformHomeDir();
const modePath = join(configRoot, "teams", "builder", "modes", "orchestrator.md");

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
  assert.match(modeDoc, /before any orchestration side effect: no sub-deploy,\s+no branch creation\/switching, no ticket creation, and no orchestration report\s+mutation\./);
  assert.match(modeDoc, /The one-line stderr error above is the only allowed output\./);

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

test("builder orchestrator mode requires durable Phase 5.x feedback-loop evidence fields", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /Durable evidence contract for each Phase 5\.x feedback\/fix\/confirmation iteration:/);
  assert.match(modeDoc, /Record `feedback_source`/);
  assert.match(modeDoc, /Record `objective_artifact_path`/);
  assert.match(modeDoc, /Record `child_deploy_id` and `child_status`/);
  assert.match(modeDoc, /Record `verification_summary`/);
  assert.match(modeDoc, /Record confirmation as either `confirmation_text`/);
  assert.match(modeDoc, /or `confirmation_state=pending-confirmation`/);
});

test("builder orchestrator mode requires one-bundle objective shape and branch reuse for Phase 5.x", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const modeDoc = readFileSync(modePath, "utf-8");

  assert.match(modeDoc, /Map exactly one Sinh feedback bundle to exactly one builder\/implement objective\./);
  assert.match(modeDoc, /The objective MUST use this section structure and section names:/);
  assert.match(modeDoc, /- `Goal`/);
  assert.match(modeDoc, /- `Requirements`/);
  assert.match(modeDoc, /- `Verification`/);
  assert.match(modeDoc, /- `Context`/);
  assert.match(modeDoc, /- `Guardrails`/);
  assert.match(modeDoc, /Reuse the target ticket's active feature branch for every Phase 5\.x/);
  assert.match(modeDoc, /Do not create a separate branch per feedback item\./);
});
