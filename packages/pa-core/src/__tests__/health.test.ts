import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendRegistryEvent, checkAgents, checkDeployments, checkTickets, closeDb, detectErrorLoops, formatPrimerHealthSummary, generateHealthReport, listHealthSnapshots, parseActivityLog, saveHealthSnapshot, TicketStore } from "../index.js";

function withHealthEnv(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-health-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_PLATFORM_CONFIG"] = join(root, "config");
  mkdirSync(join(root, "config"), { recursive: true });
  try {
    fn(root);
  } finally {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
}

test("health deployment checks and snapshots use registry state", () => {
  withHealthEnv((root) => {
    const now = new Date(1714000000000).toISOString();
    const logFile = join(root, "session.md");
    writeFileSync(logFile, "## Session Rating\n## Timeline\n## What Happened\n");
    appendRegistryEvent({ deployment_id: "d-health", team: "builder", event: "started", timestamp: now, log_file: logFile });
    appendRegistryEvent({ deployment_id: "d-health", team: "builder", event: "completed", timestamp: now, status: "success", log_file: logFile });

    const window = { since: "2000-01-01T00:00:00.000Z", until: "2999-01-01T00:00:00.000Z" };
    const deployments = checkDeployments(window);
    assert.equal(deployments.stats?.successCount, 1);
    assert.equal(deployments.score, 100);

    const report = generateHealthReport({ category: "deployments", window });
    assert.equal(report.overallScore, 100);
    assert.match(formatPrimerHealthSummary(report), /PA Health: 100\/100/);
    saveHealthSnapshot(report);
    assert.equal(listHealthSnapshots(1)[0]?.overallScore, 100);
  });
});

test("health activity parser detects tool failures and loops", () => {
  withHealthEnv((root) => {
    const deployDir = join(root, "deployments", "d-loop");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, "activity.jsonl"), [
      { ts: "1", deploy_id: "d-loop", agent: "builder", event: "tool_failure", data: {} },
      { ts: "2", deploy_id: "d-loop", agent: "builder", event: "tool_failure", data: {} },
      { ts: "3", deploy_id: "d-loop", agent: "builder", event: "tool_failure", data: {} },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const analysis = parseActivityLog("d-loop");
    assert.equal(analysis.totalCalls, 3);
    assert.equal(analysis.failures, 3);
    assert.equal(analysis.errorLoops.length, 1);
    assert.equal(detectErrorLoops([]).length, 0);
  });
});

test("health tickets check flags missing doc refs", () => {
  withHealthEnv((root) => {
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "repos.yaml"), "repos:\n  pa-platform:\n    path: /tmp/pa-platform\n    prefix: PAP\n");
    const store = new TicketStore(join(root, "tickets"));
    store.create({ project: "pa-platform", title: "Needs docs", summary: "", description: "", status: "review-uat", priority: "high", type: "task", assignee: "builder", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
    const result = checkTickets({ since: "2000-01-01T00:00:00.000Z", until: "2999-01-01T00:00:00.000Z" }, store);
    assert.equal(result.stats?.missingDocRefCount, 1);
    assert.equal(result.findings.some((finding) => finding.severity === "fail"), true);
  });
});
