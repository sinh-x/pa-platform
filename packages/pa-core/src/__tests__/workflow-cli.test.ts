import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowReadService } from "../workflows/public.js";
import { runWorkflowCommand } from "../cli/commands/workflow.js";
import { queryWorkflow } from "../workflows/queries.js";
import { digest, JsonWorkflowError } from "../workflows/contracts.js";
import type { WorkflowSelection } from "../workflows/selected.js";
import { bytes, definition } from "./workflow-fixtures.js";

test("public CLI and read API agree; help and static validation never select/adopt local bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-workflow-cli-"));
  try {
    const file = join(root, "definition.json"); writeFileSync(file, JSON.stringify(definition(), null, 2));
    let selections = 0; const host = { selection: () => { selections++; throw new Error("must not select local definition"); } };
    const output: string[] = [], io = { stdout: (s: string) => output.push(s), stderr: () => {} };
    assert.equal(runWorkflowCommand("workflow", ["--help"], io, host), 0); assert.equal(selections, 0);
    output.length = 0;
    assert.equal(runWorkflowCommand("workflow", ["validate", "--definition-file", file, "--json"], io, host), 0);
    assert.deepEqual(JSON.parse(output[0]!), workflowReadService(JSON.stringify({ action: "validate", definitionFile: file }), host)); assert.equal(selections, 0);
    assert.equal((JSON.parse(output[0]!).result as { stepCount: number }).stepCount, 1);
    for (const flags of [["--force"], ["--actor", "operator"], ["--passed"], ["--json", "--json"]]) {
      output.length = 0; assert.equal(runWorkflowCommand("workflow", ["validate", "--definition-file", file, ...flags], io, host), 1); assert.ok(output[0]!.length < 2000);
    }
    assert.equal(workflowReadService('{"action":"list","action":"status"}', host).ok, false);
    assert.equal(workflowReadService(`{"action":"show","id":"\uD800"}`, host).ok, false);
    assert.equal(workflowReadService(JSON.stringify({ action: "capture", outcome: "approved" }), host).ok, false);
    assert.equal(runWorkflowCommand("decision", ["approve", "--ticket", "EX-1", "--id", "invented", "--json"], io), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared read projection is deterministic and validate never selects/adopts local input", () => {
  const d = definition(); const raw = bytes(d);
  const selected: WorkflowSelection = { schemaVersion: "pa-workflow-selection/v1", configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: null, bindings: [], definitions: [] };
  assert.deepEqual(queryWorkflow(selected, { action: "list" }), queryWorkflow(selected, { action: "list" }));
  const before = JSON.stringify(selected);
  const result = queryWorkflow(selected, { action: "validate", raw }) as { executionAdmitted: boolean };
  assert.equal(result.executionAdmitted, false); assert.equal(JSON.stringify(selected), before);
  assert.throws(() => queryWorkflow(selected, { action: "show", id: "software" }), JsonWorkflowError);
  const enabled = { ...selected, definitions: [{ definition: d, raw, sha256: digest(raw), configRoot: "/selected", configRevision: "a".repeat(40), manifestSha256: "a".repeat(64) }] };
  assert.ok(queryWorkflow(enabled, { action: "show", id: "software" }));
});
