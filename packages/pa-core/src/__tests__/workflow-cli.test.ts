import assert from "node:assert/strict";
import { test } from "node:test";
import { queryWorkflow } from "../workflows/queries.js";
import { digest, JsonWorkflowError } from "../workflows/contracts.js";
import type { WorkflowSelection } from "../workflows/selected.js";
import { bytes, definition } from "./workflow-fixtures.js";

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
