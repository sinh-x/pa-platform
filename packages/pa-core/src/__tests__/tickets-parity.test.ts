import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildFocusList, closeDb, deriveDocRefTitle, formatDocRefBadge, matchAssignee, parseDocRefValue, TicketStore, buildBoardView, computeSprintMetrics } from "../index.js";

function withTicketEnv(fn: (root: string, ticketsDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-ticket-parity-"));
  const config = join(root, "config");
  const teams = join(root, "teams");
  const tickets = join(root, "tickets");
  mkdirSync(config, { recursive: true });
  mkdirSync(teams, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: /tmp/pa-platform\n    prefix: PAP\n`);
  writeFileSync(join(teams, "builder.yaml"), `name: builder\ndescription: Builder\nobjective: Build\nagents: []\n`);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousTeams = process.env["PA_PLATFORM_TEAMS"];
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  try {
    fn(root, tickets);
  } finally {
    closeDb();
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousTeams === undefined) delete process.env["PA_PLATFORM_TEAMS"];
    else process.env["PA_PLATFORM_TEAMS"] = previousTeams;
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    rmSync(root, { recursive: true, force: true });
  }
}

test("doc-ref helpers normalize, badge, and derive titles", () => {
  withTicketEnv((root) => {
    mkdirSync(join(root, "agent-teams/builder/artifacts"), { recursive: true });
    writeFileSync(join(root, "agent-teams/builder/artifacts/2026-04-26-example.md"), "# Example Title\n\nBody");
    assert.deepEqual(parseDocRefValue("requirements:agent-teams/builder/artifacts/2026-04-26-example.md"), { type: "req", path: "agent-teams/builder/artifacts/2026-04-26-example.md" });
    assert.equal(formatDocRefBadge({ type: "req", primary: true }), "[*REQ]");
    assert.equal(deriveDocRefTitle({ path: "agent-teams/builder/artifacts/2026-04-26-example.md" }), "Example Title");
  });
});

test("assignee matching supports team and agent filters", () => {
  const teams = new Set(["builder"]);
  assert.equal(matchAssignee("builder/team-manager", "builder", teams), true);
  assert.equal(matchAssignee("builder/team-manager", "team-manager", teams), true);
  assert.equal(matchAssignee("requirements/team-manager", "builder", teams), false);
});

test("board, focus, and metrics build from TicketStore", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir);
    const ticket = store.create({
      project: "pa-platform",
      title: "Core parity",
      summary: "Summary",
      description: "",
      status: "pending-implementation",
      priority: "high",
      type: "task",
      assignee: "builder/team-manager",
      estimate: "S",
      from: "",
      to: "",
      tags: [],
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, "test");
    store.update(ticket.id, { status: "done" }, "test");
    const board = buildBoardView("pa-platform");
    assert.equal(board.total >= 0, true);
    const focus = buildFocusList({}, store);
    assert.equal(focus.wip.total, 0);
    const metrics = computeSprintMetrics("2000-01-01", "2999-01-01", "pa-platform", store);
    assert.equal(metrics.throughput, 1);
    assert.equal(metrics.velocityPoints, 2);
  });
});
