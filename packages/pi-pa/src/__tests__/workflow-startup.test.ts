import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflowReadService, workflowDigest } from "@pa-platform/pa-core";
import { piWorkflowObservations, piWorkflowReadHost } from "../workflow-host.js";
import { ProjectCommandContract } from "../project-command-contract.js";
import { createJsonWorkflowModule } from "../pi-extension/workflow.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";
import { templateFixture } from "../../../pa-core/src/__tests__/template-fixture.js";
import { workflowRuntimeFixture } from "../../../pa-core/src/__tests__/workflow-runtime-fixture.js";

function fixture(run: (f: { root: string; repo: string; config: string; save: (projectCommands?: unknown) => void }) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "pap273-observe-")), env = process.env;
  const repo = join(root, "repo"), config = join(root, "config"); mkdirSync(repo); mkdirSync(config);
  process.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PA_|PI_|GIT_)/.test(key) || key === "PA_SQLITE_NATIVE_BINDING"));
  Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "absent.db"), PATH: root });
  const save = (projectCommands?: unknown) => writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo, prefix: "EX", ...(projectCommands ? { projectCommands } : {}) } } }));
  save();
  try { return run({ root, repo, config, save }); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}

test("native observations distinguish uninspected, registered missing, supported and unsupported before a subject exists", () => fixture(f => {
  assert.equal(piWorkflowObservations().projectProfile, "uninspected");
  assert.equal(piWorkflowObservations(undefined, { key: "example", root: f.repo }).projectProfile, "missing");
  assert.equal(piWorkflowObservations(undefined, { key: "other", root: f.repo }).projectProfile, "unsupported");
  assert.equal(piWorkflowObservations(undefined, { key: "example", root: f.root }).projectProfile, "unsupported");
  const script = "inert prerequisite bytes\n"; writeFileSync(join(f.repo, "check.txt"), script);
  // Root-owned system executable: the test never executes it or requires namespace support.
  const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [{ id: "check", executable: realpathSync("/bin/sh"), argv: ["--version"], environment: {}, readPaths: [], prerequisites: [{ path: "check.txt", sha256: workflowDigest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 }] });
  writeFileSync(join(f.repo, "checks.json"), manifest); f.save({ manifest: "checks.json", sha256: workflowDigest(manifest) });
  assert.equal(piWorkflowObservations(undefined, { key: "example", root: f.repo }).projectProfile, "supported");
  writeFileSync(join(f.repo, "check.txt"), "changed prerequisite\n");
  assert.equal(piWorkflowObservations(undefined, { key: "example", root: f.repo }).projectProfile, "unsupported");
  // Static deferral never changes the real executor's closed contract validation.
  const checkout = join(f.root, "checkout"); mkdirSync(checkout);
  assert.throws(() => ProjectCommandContract.resolve("example", f.repo, checkout), /EXECUTION_PROJECT_CONTRACT_INVALID/);
}));

test("selected registry failure retains TEMPLATE_PAIR instead of reporting a nonexistent producer", () => fixture(() => {
  const observations = piWorkflowObservations();
  assert.equal(observations.producerContract, "unsupported");
  assert.equal(observations.producerFailure?.code, "TEMPLATE_PAIR");
  assert.equal(observations.producerFailure?.gateId, "selected-template-pair");
  assert.ok(!JSON.stringify(observations.producerFailure).includes("/tmp/"));
}));

test("fresh native read and CLI service projections agree on later execution blockers and true pair failure", async () => {
  const f = workflowRuntimeFixture(), templates = templateFixture(), env = process.env;
  try {
    const tickets = join(f.root, "tickets"); mkdirSync(tickets);
    writeFileSync(join(templates.root, "config.yaml"), JSON.stringify({ repos: { example: { path: f.root, prefix: "EX" } } }));
    writeFileSync(join(tickets, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", doc_refs: [] }));
    process.env = { ...env, PA_PLATFORM_CONFIG: templates.root, PA_AI_USAGE_HOME: f.root, PA_REGISTRY_DB: join(f.root, "absent.db") };
    const readHost = { ...piWorkflowReadHost(), selection: () => f.selection };
    const tools = new Map<string, PiToolDefinition>();
    createJsonWorkflowModule({ readHost })({ registerTool: tool => tools.set(tool.name, tool as PiToolDefinition) } as PiRuntime);
    for (const action of ["preflight", "status", "next"]) {
      const request = JSON.stringify({ action, ticket: "EX-1" });
      const expected = workflowReadService(request, readHost);
      const actual = await tools.get("pa_workflow")!.execute("startup", { request }, undefined, undefined, {});
      assert.deepEqual(JSON.parse(actual.content[0]!.text), expected);
      assert.equal(expected.ok, true); assert.equal(expected.executionAdmitted, false);
      const projection = expected.result as Record<string, any>, preflight = action === "preflight" ? projection : projection.preflight;
      assert.equal(preflight.projectProfile, "missing"); assert.equal(preflight.executionPrerequisites[0].outcome, "blocked");
      assert.equal(preflight.status, "blocked"); assert.ok(preflight.gates.some((g: any) => g.code === "TEMPLATE_PAIR"));
      assert.ok(!preflight.gates.some((g: any) => g.gateId === "shared-producer-contract-required"));
      if (action !== "preflight") assert.equal(projection.runState, "selected-without-run");
    }
  } finally { process.env = env; templates.dispose(); f.close(); }
});
