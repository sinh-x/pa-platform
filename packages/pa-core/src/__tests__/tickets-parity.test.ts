import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildFocusList, closeDb, compareTicketIds, deriveDocRefTitle, formatDocRefBadge, matchAssignee, parseDocRefValue, TicketStore, buildBoardView, computeSprintMetrics } from "../index.js";

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
  const previousDeploymentId = process.env["PA_DEPLOYMENT_ID"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_PLATFORM_TEAMS"] = teams;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_AI_USAGE_HOME"] = root;
  delete process.env["PA_DEPLOYMENT_ID"];
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
    if (previousDeploymentId === undefined) delete process.env["PA_DEPLOYMENT_ID"];
    else process.env["PA_DEPLOYMENT_ID"] = previousDeploymentId;
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
    const store = new TicketStore(ticketsDir, { privileged: true });
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

test("board sorts every status group by deterministic natural ticket ID", () => {
  withTicketEnv((_root, ticketsDir) => {
    mkdirSync(ticketsDir, { recursive: true });
    const writeTicket = (id: string, status: "implementing" | "pending-approval", priority: "critical" | "high" | "medium" | "low") => {
      writeFileSync(join(ticketsDir, `${id}.json`), JSON.stringify({
        id,
        project: id.startsWith("PA-") ? "personal" : "pa-platform",
        title: id,
        status,
        priority,
        type: "task",
        assignee: "builder/team-manager",
        tags: [],
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z",
      }));
    };

    writeTicket("PAP-10", "implementing", "critical");
    writeTicket("PAP-2", "implementing", "low");
    writeTicket("PAP-002", "implementing", "high");
    writeTicket("PA-10", "implementing", "medium");
    writeTicket("PA-2", "implementing", "medium");
    writeTicket("TASK-10", "pending-approval", "high");
    writeTicket("TASK-2", "pending-approval", "medium");
    writeTicket("TASK-002", "pending-approval", "low");

    const sequences = Array.from({ length: 10 }, () => buildBoardView().columns.map((column) => column.tickets.map((ticket) => ticket.id)));
    assert.deepEqual(sequences.slice(1), Array(9).fill(sequences[0]), "10 consecutive builds return identical sequences");

    const board = buildBoardView();
    const implementing = board.columns.find((column) => column.status === "implementing")!;
    assert.deepEqual(implementing.tickets.map((ticket) => ticket.id), ["PA-2", "PA-10", "PAP-002", "PAP-2", "PAP-10"]);
    assert.deepEqual(implementing.tickets.slice(-2).map((ticket) => ticket.priority), ["low", "critical"], "priority metadata remains but cannot override ID order");

    const pendingApproval = board.columns.find((column) => column.status === "pending-approval")!;
    assert.deepEqual(pendingApproval.tickets.map((ticket) => ticket.id), ["TASK-002", "TASK-2", "TASK-10"]);
    assert.deepEqual(board.columns.map((column) => column.status), ["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat", "done", "rejected", "cancelled"]);
    assert.equal(board.total, 8);
  });
});

test("ticket ID comparison handles arbitrary-size suffixes and raw-text ties", () => {
  assert.equal(compareTicketIds("PAP-2", "PAP-10"), -1);
  assert.equal(compareTicketIds("PAP-999999999999999999999999999999", "PAP-1000000000000000000000000000000"), -1);
  assert.equal(compareTicketIds("PAP-002", "PAP-2"), -1);
  assert.equal(compareTicketIds("TASK-item2", "TASK-item10"), -1);
  assert.equal(compareTicketIds("TASK-item02", "TASK-item2"), -1);
});

test("tickets validate and store linked git branches and commits", () => {
  withTicketEnv((root, ticketsDir) => {
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["branch", "develop"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["branch", "feature/PAP-001-test"], { cwd: repoDir, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
    writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repoDir}\n    prefix: PAP\n`);

    const store = new TicketStore(ticketsDir, { privileged: true });
    const ticket = store.create({
      project: "pa-platform",
      title: "Link git work",
      summary: "Summary",
      description: "",
      status: "implementing",
      priority: "medium",
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

    const linked = store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-test" }, add_linked_commit: { repo: "pa-platform", sha } }, "test");
    assert.equal(linked.linkedBranches[0]?.branch, "feature/PAP-001-test");
    assert.equal(linked.linkedBranches[0]?.state, "materialized");
    assert.equal(linked.linkedBranches[0]?.baseSha, sha);
    assert.equal(linked.linkedBranches[0]?.headSha, sha);
    assert.equal(linked.linkedBranches[0]?.sha, sha);
    assert.equal(linked.linkedCommits[0]?.sha, sha);
    assert.equal(linked.linkedCommits[0]?.message, "initial");

    const removalAuditsBefore = store.readAudit().filter((entry) => entry.action === "branch_link_removed").length;
    const unlinked = store.update(ticket.id, { remove_linked_branch: "pa-platform:feature/PAP-001-test", remove_linked_commit: sha }, "test");
    assert.equal(unlinked.linkedBranches.length, 0);
    assert.equal(unlinked.linkedCommits.length, 0);
    assert.equal(unlinked.title, ticket.title);
    assert.equal(store.readAudit().filter((entry) => entry.action === "branch_link_removed").length, removalAuditsBefore + 1);

    const absentExact = store.update(ticket.id, { remove_linked_branch: "pa-platform:feature/PAP-001-test" }, "test");
    assert.deepEqual(absentExact.linkedBranches, []);
    assert.deepEqual(new TicketStore(ticketsDir, { privileged: true }).get(ticket.id)?.linkedBranches, []);
    assert.equal(store.readAudit().filter((entry) => entry.action === "branch_link_removed").length, removalAuditsBefore + 1);
  });
});

test("archive and unarchive store methods toggle the archived tag and enforce terminal status", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir, { privileged: true });
    const ticket = store.create({
      project: "pa-platform",
      title: "Archive candidate",
      summary: "Summary",
      description: "",
      status: "implementing",
      priority: "medium",
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

    assert.throws(
      () => store.archive(ticket.id, "test"),
      /Cannot archive/,
      "archive should reject non-terminal-status tickets",
    );
    assert.equal(store.get(ticket.id)?.tags.includes("archived"), false, "no archive tag after failed archive");

    store.update(ticket.id, { status: "done" }, "test");
    const archived = store.archive(ticket.id, "test");
    assert.equal(archived.tags.includes("archived"), true, "archive adds archived tag");
    const reArchived = store.archive(ticket.id, "test");
    assert.equal(reArchived.tags.filter((t) => t === "archived").length, 1, "archive is idempotent");

    const unarchived = store.unarchive(ticket.id, "test");
    assert.equal(unarchived.tags.includes("archived"), false, "unarchive removes archived tag");
    const reUnarchived = store.unarchive(ticket.id, "test");
    assert.equal(reUnarchived.tags.includes("archived"), false, "unarchive is idempotent");
  });
});

test("board --include-archived surfaces archived tickets while default board hides them", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir);
    const active = store.create({
      project: "pa-platform",
      title: "Active work",
      summary: "Summary",
      description: "",
      status: "implementing",
      priority: "medium",
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
    const done = store.create({
      project: "pa-platform",
      title: "Done and archived",
      summary: "Summary",
      description: "",
      status: "done",
      priority: "medium",
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
    store.archive(done.id, "test");

    const defaultBoard = buildBoardView("pa-platform", { excludeTags: ["backlog", "archived"] });
    const defaultTitles = defaultBoard.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title));
    assert.equal(defaultTitles.includes("Active work"), true, "active ticket appears on default board");
    assert.equal(defaultTitles.includes("Done and archived"), false, "archived ticket hidden on default board");

    const includeArchivedBoard = buildBoardView("pa-platform", { excludeTags: ["backlog"] });
    const includeTitles = includeArchivedBoard.columns.flatMap((column) => column.tickets.map((ticket) => ticket.title));
    assert.equal(includeTitles.includes("Active work"), true, "active ticket appears on include-archived board");
    assert.equal(includeTitles.includes("Done and archived"), true, "archived ticket visible on include-archived board");

    assert.equal(active.tags.includes("archived"), false);
  });
});

test("implement context rejects hard and soft delete without mutation", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir, { team: "builder", mode: "implement", privileged: true });
    const ticket = store.create({ project: "pa-platform", title: "Protected", summary: "Summary", description: "", status: "implementing", priority: "high", type: "task", assignee: "builder/team-manager", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "test");
    const before = store.get(ticket.id);
    const auditBefore = store.readAudit();
    assert.throws(() => store.delete(ticket.id, "implement-child", false), /implement-child agents/);
    assert.throws(() => store.delete(ticket.id, "implement-child", true), /implement-child agents/);
    assert.deepEqual(store.get(ticket.id), before);
    assert.deepEqual(store.readAudit(), auditBefore);
  });
});

test("TicketStore reads and filtered lists stay mutation-free while serialized comments are retained", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir);
    const ticket = store.create({
      project: "pa-platform",
      title: "Read-only list target",
      summary: "Needle summary",
      description: "",
      status: "implementing",
      priority: "high",
      type: "task",
      assignee: "builder/team-manager",
      estimate: "S",
      from: "",
      to: "",
      tags: ["target"],
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, "test");
    const beforeReads = store.get(ticket.id);
    const auditBeforeReads = store.readAudit();

    assert.equal(store.get(ticket.id)?.id, ticket.id);
    assert.deepEqual(store.list({ project: "pa-platform", status: "implementing", assignee: "builder", priority: "high", type: "task", tags: ["target"], search: "Needle" }).map((item) => item.id), [ticket.id]);
    assert.deepEqual(store.get(ticket.id), beforeReads);
    assert.deepEqual(store.readAudit(), auditBeforeReads);

    store.comment(ticket.id, "first", "First serialized comment");
    store.comment(ticket.id, "second", "Second serialized comment");
    assert.deepEqual(store.get(ticket.id)?.comments.map((comment) => comment.content), ["First serialized comment", "Second serialized comment"]);
    assert.equal(store.readAudit().filter((entry) => entry.action === "commented").length, 2);
  });
});

test("ticket list --archived filters down to archived tickets only", () => {
  withTicketEnv((_root, ticketsDir) => {
    const store = new TicketStore(ticketsDir);
    const active = store.create({
      project: "pa-platform",
      title: "Active list item",
      summary: "Summary",
      description: "",
      status: "implementing",
      priority: "medium",
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
    const archived = store.create({
      project: "pa-platform",
      title: "Archived list item",
      summary: "Summary",
      description: "",
      status: "done",
      priority: "medium",
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
    store.archive(archived.id, "test");

    const all = store.list({ project: "pa-platform" });
    const allTitles = all.map((ticket) => ticket.title);
    assert.equal(allTitles.includes("Active list item"), true);
    assert.equal(allTitles.includes("Archived list item"), true);

    const archivedOnly = store.list({ project: "pa-platform", tags: ["archived"] });
    const archivedTitles = archivedOnly.map((ticket) => ticket.title);
    assert.equal(archivedTitles.includes("Archived list item"), true);
    assert.equal(archivedTitles.includes("Active list item"), false);

    const excludeArchived = store.list({ project: "pa-platform", excludeTags: ["archived"] });
    const excludeTitles = excludeArchived.map((ticket) => ticket.title);
    assert.equal(excludeTitles.includes("Active list item"), true);
    assert.equal(excludeTitles.includes("Archived list item"), false);
  });
});
