import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_DEPLOYMENT_EVENT_BODY_BYTES, closeDb, createAgentApiApp, getDeploymentEvents, queryDeploymentStatus, sanitizeTextInput } from "../index.js";

const DEPLOYMENT_CREDENTIAL = "deployment-credential";
const OPERATOR_CREDENTIAL = "operator-credential";

function withApiEnv(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-deploy-status-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  return fn(root).finally(() => {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    rmSync(root, { recursive: true, force: true });
  });
}

function securedApi(deploymentId = "d-a1b2c3") {
  return createAgentApiApp({ ticketMutationAuth: { deploymentId, credential: DEPLOYMENT_CREDENTIAL, operatorCredential: OPERATOR_CREDENTIAL } }).app;
}

function headers(credential = DEPLOYMENT_CREDENTIAL): Record<string, string> {
  return { "content-type": "application/json", Authorization: `Bearer ${credential}` };
}

function correlatedStart(deploymentId: string): Record<string, unknown> {
  return {
    deploymentId,
    team: "builder",
    ticketId: "PAP-001",
    repo: "/treehouse/PAP-001",
    repoRoot: "/repo",
    worktreeRoot: "/treehouse/PAP-001",
    repositorySlot: "implement",
    parentDeploymentId: "d-abcdef",
    builderAuthority: "parented-implement",
    treehousePath: "/treehouse/PAP-001",
    treehouseLeaseId: "lease-1",
    treehouseLeaseHolder: "pa:repo:PAP-001",
    branchState: "materialized",
    branchBaseSha: "a".repeat(40),
    branchHeadSha: "b".repeat(40),
    ticketSlotId: "pa:repo:PAP-001",
    repositoryPermit: 1,
    mode: "implement",
    runtime: "pi",
    binary: "ppa",
  };
}

async function post(app: ReturnType<typeof securedApi>, path: string, body: Record<string, unknown>, credential = DEPLOYMENT_CREDENTIAL): Promise<Response> {
  return app.request(path, { method: "POST", headers: headers(credential), body: JSON.stringify(body) });
}

test("deploy status API accepts authenticated lifecycle events and bounded correlation projections", async () => {
  await withApiEnv(async () => {
    const app = securedApi();
    const deployId = "d-a1b2c3";
    assert.equal((await post(app, "/api/deploy/start", correlatedStart(deployId))).status, 200);
    assert.equal((await post(app, "/api/deploy/pid", { deploymentId: deployId, team: "builder", pid: 12345 })).status, 200);

    let response = await app.request(`/api/deploy/status/${deployId}`);
    let body = await response.json() as { status?: Record<string, unknown> };
    assert.equal(response.status, 200);
    assert.equal(body.status?.["pid"], 12345);
    assert.deepEqual({
      parent: body.status?.["parent_deployment_id"], authority: body.status?.["builder_authority"], path: body.status?.["treehouse_path"],
      lease: body.status?.["treehouse_lease_id"], holder: body.status?.["treehouse_lease_holder"], branch: body.status?.["branch_state"],
      base: body.status?.["branch_base_sha"], head: body.status?.["branch_head_sha"], slot: body.status?.["ticket_slot_id"], permit: body.status?.["repository_permit"],
    }, { parent: "d-abcdef", authority: "parented-implement", path: "/treehouse/PAP-001", lease: "lease-1", holder: "pa:repo:PAP-001", branch: "materialized", base: "a".repeat(40), head: "b".repeat(40), slot: "pa:repo:PAP-001", permit: 1 });

    assert.equal((await post(app, "/api/deploy/complete", { deploymentId: deployId, team: "builder", status: "success", summary: "done", branchState: "materialized", branchBaseSha: "a".repeat(40), branchHeadSha: "c".repeat(40) })).status, 200);
    response = await app.request(`/api/deploy/status/${deployId}`);
    body = await response.json() as { status?: Record<string, unknown> };
    assert.equal(body.status?.["status"], "success");
    assert.equal(body.status?.["branch_head_sha"], "c".repeat(40));
  });
});

test("all deployment mutation routes reject missing, wrong, and mismatched principals before persistence", async () => {
  await withApiEnv(async () => {
    const app = securedApi();
    const deployId = "d-a1b2c3";
    const startBody = correlatedStart(deployId);
    for (const credential of [undefined, "wrong-credential"]) {
      const response = await app.request("/api/deploy/start", { method: "POST", headers: { "content-type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(startBody) });
      assert.equal(response.status, 401);
    }
    assert.equal(queryDeploymentStatus(deployId), null);

    const mismatch = await post(app, "/api/deploy/start", correlatedStart("d-b2c3d4"));
    assert.equal(mismatch.status, 403);
    assert.equal(queryDeploymentStatus("d-b2c3d4"), null);

    assert.equal((await post(app, "/api/deploy/start", startBody)).status, 200);
    const cases = [
      ["/api/deploy/pid", { deploymentId: deployId, team: "builder", pid: 42 }],
      ["/api/deploy/complete", { deploymentId: deployId, team: "builder", status: "success" }],
      ["/api/deploy/crash", { deploymentId: deployId, team: "builder", error: "nope" }],
      ["/api/deploy/amend", { deploymentId: deployId, team: "builder", note: "nope" }],
    ] as const;
    for (const [path, body] of cases) {
      for (const credential of [undefined, "wrong-credential"]) {
        const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body) });
        assert.equal(response.status, 401, `${path} ${credential ?? "missing"}`);
      }
    }
    assert.equal(getDeploymentEvents(deployId).length, 1);
  });
});

test("deployment correlation validator rejects malformed, oversized, noncanonical, and contradictory evidence", async () => {
  await withApiEnv(async () => {
    const app = createAgentApiApp({ ticketMutationAuth: { operatorCredential: OPERATOR_CREDENTIAL } }).app;
    const invalid: Array<{ name: string; patch: Record<string, unknown> }> = [
      { name: "relative path", patch: { treehousePath: "relative/worktree" } },
      { name: "nonnormal path", patch: { treehousePath: "/treehouse/../forged" } },
      { name: "oversized lease", patch: { treehouseLeaseId: "x".repeat(257) } },
      { name: "uppercase SHA", patch: { branchHeadSha: "A".repeat(40) } },
      { name: "invalid authority", patch: { builderAuthority: "borrowed" } },
      { name: "invalid permit", patch: { repositoryPermit: 5 } },
      { name: "planned SHA contradiction", patch: { branchState: "planned", branchBaseSha: "a".repeat(40), branchHeadSha: undefined } },
      { name: "incomplete binding", patch: { treehouseLeaseId: undefined } },
      { name: "parent contradiction", patch: { builderAuthority: "orchestrator" } },
      { name: "holder mismatch", patch: { ticketSlotId: "pa:other:PAP-001" } },
      { name: "worktree mismatch", patch: { worktreeRoot: "/treehouse/other" } },
    ];
    for (const [index, scenario] of invalid.entries()) {
      const deploymentId = `d-${(index + 1).toString(16).padStart(6, "0")}`;
      const response = await post(app, "/api/deploy/start", { ...correlatedStart(deploymentId), ...scenario.patch }, OPERATOR_CREDENTIAL);
      assert.equal(response.status, 400, scenario.name);
      const error = await response.json() as { error: string };
      assert.ok(error.error.length <= 2_000, scenario.name);
      assert.equal(queryDeploymentStatus(deploymentId), null, scenario.name);
    }

    const deploymentId = "d-fffffe";
    const oversized = await post(app, "/api/deploy/start", { deploymentId, team: "builder", objective: "x".repeat(MAX_DEPLOYMENT_EVENT_BODY_BYTES) }, OPERATOR_CREDENTIAL);
    assert.equal(oversized.status, 413);
    assert.equal(queryDeploymentStatus(deploymentId), null);
  });
});

test("exact start replay is idempotent while conflicting identity or correlation cannot overwrite", async () => {
  await withApiEnv(async () => {
    const app = securedApi();
    const deploymentId = "d-a1b2c3";
    const start = correlatedStart(deploymentId);
    assert.equal((await post(app, "/api/deploy/start", start)).status, 200);
    assert.equal((await post(app, "/api/deploy/start", start)).status, 200);
    assert.equal(getDeploymentEvents(deploymentId).length, 1);

    for (const patch of [{ objective: "replacement" }, { branchHeadSha: "c".repeat(40) }, { team: "requirements" }]) {
      const response = await post(app, "/api/deploy/start", { ...start, ...patch });
      assert.equal(response.status, 409);
      assert.ok(((await response.json()) as { error: string }).error.length <= 2_000);
    }
    assert.equal(getDeploymentEvents(deploymentId).length, 1);
    assert.equal(queryDeploymentStatus(deploymentId)?.branch_head_sha, "b".repeat(40));

    const conflictingTerminal = await post(app, "/api/deploy/complete", { deploymentId, team: "builder", status: "success", branchState: "materialized", branchBaseSha: "d".repeat(40), branchHeadSha: "c".repeat(40) });
    assert.equal(conflictingTerminal.status, 409);
    assert.equal(queryDeploymentStatus(deploymentId)?.status, "running");
  });
});

test("authenticated legacy lifecycle rows may omit optional correlation fields", async () => {
  await withApiEnv(async () => {
    const app = securedApi("d-123abc");
    assert.equal((await post(app, "/api/deploy/start", { deploymentId: "d-123abc", team: "builder", runtime: "opencode" })).status, 200);
    assert.equal((await post(app, "/api/deploy/crash", { deploymentId: "d-123abc", team: "builder", error: "SIGSEGV", exitCode: 139 })).status, 200);
    const status = queryDeploymentStatus("d-123abc");
    assert.equal(status?.status, "crashed");
    assert.equal(status?.treehouse_path, undefined);
    assert.equal(status?.branch_head_sha, undefined);
  });
});

test("deploy status API rejects bad requests without weakening read routes", async () => {
  await withApiEnv(async () => {
    const app = securedApi();
    const missingId = await app.request("/api/deploy/start", { method: "POST", headers: headers(), body: JSON.stringify({ team: "builder" }) });
    assert.equal(missingId.status, 400);
    assert.equal((await post(app, "/api/deploy/start", { deploymentId: "d-a1b2c3", team: "builder" })).status, 200);
    const missingPid = await post(app, "/api/deploy/pid", { deploymentId: "d-a1b2c3", team: "builder" });
    assert.equal(missingPid.status, 400);
    assert.equal((await app.request("/api/deploy/status/d-000000")).status, 404);
  });
});

test("deploy paths helpers manage primer and deploy directories", async () => {
  await withApiEnv(async () => {
    const { ensureDeployDir, getDeployPaths, writePrimerFile, readPrimerFile } = await import("../index.js");
    const deployId = "d-paths-test";
    const dir = ensureDeployDir(deployId);
    assert.ok(dir.includes("d-paths-test"));
    const paths = getDeployPaths(deployId);
    assert.ok(paths.deployDir.includes("d-paths-test"));
    assert.ok(paths.primerPath.endsWith(`${deployId}-primer.md`));
    assert.ok(paths.sessionPath.includes("sessions"));
    assert.ok(paths.activityLogPath.includes("activity.jsonl"));
    const content = "# Primer\n\nTest content";
    writePrimerFile(deployId, content);
    assert.equal(readPrimerFile(deployId), content);
  });
});

test("sanitizeTextInput removes invalid characters and reports count", () => {
  assert.deepEqual(sanitizeTextInput(""), { sanitized: "", removed: 0 });
  assert.deepEqual(sanitizeTextInput("\x00\x08\x0b\x0c\x0e\x1f\x7f$\\;&"), { sanitized: "", removed: 11 });
  assert.deepEqual(sanitizeTextInput("Hello, world! 123"), { sanitized: "Hello, world! 123", removed: 0 });
  assert.deepEqual(sanitizeTextInput("Hello\x00 world\x1f with $special\\chars & more; text"), { sanitized: "Hello world with specialchars  more text", removed: 6 });
  assert.deepEqual(sanitizeTextInput("café 汉字 ñ"), { sanitized: "café 汉字 ñ", removed: 0 });
  assert.deepEqual(sanitizeTextInput("\t\n\r"), { sanitized: "\t\n\r", removed: 0 });
});
