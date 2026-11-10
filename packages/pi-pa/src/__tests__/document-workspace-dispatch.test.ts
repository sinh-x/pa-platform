import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrimer, parseTeamYamlContent } from "@pa-platform/pa-core";
import { documentSessionToolAllowed, createDocumentTool } from "../pi-extension/document-tool.js";

test("workspace profile parser/primer/loadout dispatch is explicit and leaves legacy and OPA projections intact", () => {
  const yaml = "name: requirements\nobjective: Source fixture\nagents: []\ndeploy_modes:\n  - id: analyze\n    document_profile: pa-document-workspace/v2\n";
  const teamConfig = parseTeamYamlContent(yaml);
  assert.equal(teamConfig.deploy_modes![0]!.document_profile, "pa-document-workspace/v2");
  const options = { teamConfig, mode: "analyze", skillsDir: "/nonexistent-fixture-skills", requirementsDocument: true };
  const primer = generatePrimer({ ...options, runtime: "pi" });
  for (const expected of ["Native profile: pa-document-workspace/v2", "pa_workspace capabilities", "approval is unavailable", "attested original", "Okular export is unavailable"]) assert.ok(primer.includes(expected), expected);
  assert.ok(!primer.includes("Native profile: pa-document-package/v1"));
  const opa = generatePrimer({ ...options, runtime: "opencode" }); assert.ok(!opa.includes("Native profile: pa-document-workspace/v2"));
  const retained = generatePrimer({ ...options, runtime: "pi", workflow: { runId: "old", workflowId: "old", version: "r001", sha256: "a".repeat(64), configRevision: "b".repeat(40), nextOwner: "owner", nextAction: "reconcile" } });
  assert.ok(!retained.includes("Native profile: pa-document-workspace/v2"));
  for (const name of ["bash", "write", "edit", "pa_execution", "pa_workflow", "functions.pa_workspace", "mcp.pa_workspace"]) assert.equal(documentSessionToolAllowed({ toolName: name, input: {} }, undefined, true), false);
  assert.equal(documentSessionToolAllowed({ toolName: "pa_workspace", input: {} }), false);
  assert.equal(documentSessionToolAllowed({ toolName: "pa_workspace", input: {} }, undefined, true), true);
  assert.ok(createDocumentTool(undefined, true).description.includes("capture/revoke are unavailable"));
  assert.ok(createDocumentTool().description.includes("Native foreground capture only"));
  for (const invalid of [yaml.replace("requirements", "builder"), yaml.replace("analyze", "auto"), yaml.replace("v2", "v3")]) assert.throws(() => parseTeamYamlContent(invalid));
});
