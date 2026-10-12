import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_COLUMNS, type BoardView, type TicketStatus } from "../tickets/index.js";
import { formatBoard, formatRegistryShow } from "../cli/formatters.js";
import type { Ticket } from "../tickets/types.js";
import type { DeploymentStatus } from "../types.js";

function withUtc(run: () => void): void {
  const previous = process.env["TZ"];
  process.env["TZ"] = "UTC";
  try { run(); }
  finally {
    if (previous === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previous;
  }
}

test("formatRegistryShow keeps literal non-review bytes and the existing Team/mode contract", () => {
  withUtc(() => {
    const deployment: DeploymentStatus = { deploy_id: "d-a1b2c3", team: "builder", status: "success", started_at: "2026-10-05T00:00:00Z", completed_at: "2026-10-05T00:01:00Z", agents: ["team-manager"], runtime: "opencode", repo_root: "/canonical/pa-platform", worktree_root: "/canonical/pa-platform", ticket_id: "PAP-232", summary: "done" };
    const baseline = "Deployment: d-a1b2c3\n  Team:     builder\n  Status:   success\n  Started:  2026-10-05 00:00:00 +00:00\n  Ended:    2026-10-05 00:01:00 +00:00\n  Runtime:  opencode\n  Agents:   team-manager\n  Repo Root: /canonical/pa-platform\n  Launch Ticket: PAP-232\n  Current Ticket: PAP-232\n  Summary:  done\n  Events:   2";
    assert.equal(formatRegistryShow(deployment, 2, "PAP-232"), baseline);
    assert.equal(formatRegistryShow({ ...deployment, mode: "" }, 2, "PAP-232"), baseline);
    assert.equal(formatRegistryShow({ ...deployment, mode: "implement" }, 2, "PAP-232"), "Deployment: d-a1b2c3\n  Team:     builder/implement\n  Status:   success\n  Started:  2026-10-05 00:00:00 +00:00\n  Ended:    2026-10-05 00:01:00 +00:00\n  Runtime:  opencode\n  Agents:   team-manager\n  Repo Root: /canonical/pa-platform\n  Launch Ticket: PAP-232\n  Current Ticket: PAP-232\n  Summary:  done\n  Events:   2");
  });
});

test("formatRegistryShow prints exactly three read-only review identity lines without mutation capacity", () => {
  withUtc(() => {
    const deployment: DeploymentStatus = {
      deploy_id: "d-232abc", team: "requirements", mode: "review-auto", status: "running", started_at: "2026-10-05T00:00:00Z", agents: [], runtime: "pi", repo: "/treehouse/PAP-232", repo_root: "/canonical/pa-platform", worktree_root: "/treehouse/PAP-232", ticket_id: "PAP-232",
      review_checkout: { kind: "existing-review-checkout", repoKey: "pa-platform", repoRoot: "/canonical/pa-platform", worktreeRoot: "/treehouse/PAP-232", ticket: "PAP-232", leaseId: "lease-review-232", leaseHolder: "pa:pa-platform:PAP-232", branch: "feature/PAP-232-review-auto-candidate-binding", branchState: "materialized", baseSha: "a".repeat(40), headSha: "b".repeat(40), featureSha: "b".repeat(40) },
    };
    const output = formatRegistryShow(deployment, 1, "PAP-232");
    assert.equal(output, "Deployment: d-232abc\n  Team:     requirements/review-auto\n  Status:   running\n  Started:  2026-10-05 00:00:00 +00:00\n  Runtime:  pi\n  Repo Root: /canonical/pa-platform\n  Worktree:  /treehouse/PAP-232\n  Review Candidate: /treehouse/PAP-232\n  Review Branch: feature/PAP-232-review-auto-candidate-binding base=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa feature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  Review Lease: lease-review-232 (pa:pa-platform:PAP-232)\n  Launch Ticket: PAP-232\n  Current Ticket: PAP-232\n  Events:   1");
    assert.deepEqual(output.split("\n").filter((line) => line.startsWith("  Review ")), [
      "  Review Candidate: /treehouse/PAP-232",
      "  Review Branch: feature/PAP-232-review-auto-candidate-binding base=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa feature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "  Review Lease: lease-review-232 (pa:pa-platform:PAP-232)",
    ]);
    assert.equal(output.split("\n").filter((line) => line.startsWith("  Team:")).length, 1);
    assert.doesNotMatch(output, /Repo Slot:|Ticket Slot:|Repo Permit:|Authority:/);
  });
});

function makeTicket(input: { id: string; status: TicketStatus; priority: string; title: string; assignee: string; hasRunningDeployment?: boolean }): Ticket {
  const ticket = {
    id: input.id,
    project: "pa-platform",
    title: input.title,
    summary: "",
    description: "",
    status: input.status,
    priority: input.priority as Ticket["priority"],
    type: "task",
    assignee: input.assignee,
    estimate: "S",
    from: "",
    to: "",
    tags: [],
    blockedBy: [],
    doc_refs: [],
    linkedBranches: [],
    linkedCommits: [],
    comments: [],
    subTickets: [],
    nextSubTicketCounter: 0,
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    resolvedAt: null,
  } as Ticket & { hasRunningDeployment?: boolean };
  if (input.hasRunningDeployment) ticket.hasRunningDeployment = true;
  return ticket;
}

function buildColumns(): BoardView["columns"] {
  return BOARD_COLUMNS.map((status) => ({ status, tickets: [], count: 0 }));
}

test("formatBoard prints separated status sections and empty placeholders", () => {
  const columns = buildColumns();
  columns[BOARD_COLUMNS.indexOf("implementing")].tickets.push(
    makeTicket({ id: "PAP-002", status: "implementing", priority: "high", title: "Implement formatting", assignee: "builder/team-manager" }),
  );
  columns[BOARD_COLUMNS.indexOf("implementing")].count = 1;
  columns[BOARD_COLUMNS.indexOf("review-uat")].tickets.push(makeTicket({ id: "PAP-001", status: "review-uat", priority: "low", title: "Needs uat review", assignee: "" }));
  columns[BOARD_COLUMNS.indexOf("review-uat")].count = 1;

  const board: BoardView = {
    project: "pa-platform",
    total: 2,
    assigneeCounts: {},
    columns,
  };

  const output = formatBoard(board);
  const byLine = output.split("\n");

  assert.match(output, /^Board: pa-platform \(2 tickets\)$/m);
  for (const column of BOARD_COLUMNS) {
    const expectedCount = columns[BOARD_COLUMNS.indexOf(column)]?.count ?? 0;
    assert.match(output, new RegExp(`^${column} \\(${expectedCount}\\)$`, "m"));
  }
  assert.equal(byLine.filter((line) => line === "  (empty)").length >= 7, true);
  assert.match(output, /\[low\] /);
  assert.match(output, /unassigned/);
  assert.doesNotMatch(output, /\u001b\[[0-9;]*m/);
});

test("formatBoard supports deterministic color on status headers, priority labels, and deploying marker", () => {
  const columns = buildColumns();
  columns[BOARD_COLUMNS.indexOf("implementing")].tickets.push(
    makeTicket({ id: "PAP-100", status: "implementing", priority: "critical", title: "Needs color", assignee: "builder/team-manager", hasRunningDeployment: true }),
  );
  columns[BOARD_COLUMNS.indexOf("implementing")].count = 1;

  const board: BoardView = {
    project: "pa-platform",
    total: 1,
    assigneeCounts: {},
    columns,
  };

  const noColor = formatBoard(board);
  const withColor = formatBoard(board, { colorEnabled: true });

  assert.equal(noColor, noColor.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(noColor, /\nimplementing \(1\)\n/);
  assert.match(noColor, /\[critical\]/);
  assert.match(noColor, /\[deploying\]/);

  assert.equal(withColor.includes("\x1b"), true);
  assert.match(withColor, /\n\x1b\[1;36mimplementing \(1\)\x1b\[0m\n/);
  assert.match(withColor, /\x1b\[31m\[critical\]\x1b\[0m/);
  assert.match(withColor, /\x1b\[35m \[deploying\]\x1b\[0m/);
});

test("formatBoard preserves and styles unknown priority labels", () => {
  const columns = buildColumns();
  columns[BOARD_COLUMNS.indexOf("implementing")].tickets.push(
    makeTicket({ id: "PAP-200", status: "implementing", priority: "normal", title: "Legacy priority label", assignee: "builder" }),
    makeTicket({ id: "PAP-201", status: "implementing", priority: "unknown", title: "Mystery priority", assignee: "builder" }),
  );
  columns[BOARD_COLUMNS.indexOf("implementing")].count = 2;

  const board: BoardView = {
    project: "pa-platform",
    total: 2,
    assigneeCounts: {},
    columns,
  };

  const withColor = formatBoard(board, { colorEnabled: true });

  assert.match(withColor, /\[normal\]/);
  assert.match(withColor, /\[unknown\]/);
  assert.match(withColor, /\x1b\[[0-9;]*m/);
});

test("formatBoard aligns id, priority, assignee, and title columns", () => {
  const columns = buildColumns();
  columns[BOARD_COLUMNS.indexOf("implementing")].tickets.push(
    makeTicket({ id: "PAP-1", status: "implementing", priority: "critical", title: "Short title", assignee: "aa" }),
    makeTicket({ id: "PAP-100", status: "implementing", priority: "low", title: "This task is deploying", assignee: "builder/team-manager", hasRunningDeployment: true }),
  );
  columns[BOARD_COLUMNS.indexOf("implementing")].count = 2;

  const board: BoardView = {
    project: "all",
    total: 2,
    assigneeCounts: {},
    columns,
  };

  const lines = formatBoard(board).split("\n");
  const ticketLines = lines.filter((line) => /^  \S+\s+\[[^\]]+\]/.test(line));

  assert.equal(ticketLines.length, 2);
  const parsed = ticketLines.map((line) => {
    const match = line.match(/^  (\S+)\s+(\[[^\]]+\])\s+(\S+)\s+(.*)$/);
    if (!match) throw new Error(`Unexpected row format: ${line}`);
    const lineWithoutPrefix = line.slice(2);
    const id = match[1]!;
    const priority = match[2]!;
    const assignee = match[3]!;
    const title = match[4]!;
    const priorityStart = lineWithoutPrefix.indexOf(priority);
    const assigneeStart = lineWithoutPrefix.indexOf(assignee);
    const titleStart = lineWithoutPrefix.indexOf(title);
    return { id, priority, assignee, title: title.replace(/ \[deploying\]$/, ""), priorityStart, assigneeStart, titleStart };
  });

  const priorityStarts = parsed.map((row) => row.priorityStart);
  const assigneeStarts = ticketLines.map((line) => {
    const match = line.match(/^  \S+\s+(\[[^\]]+\])\s+(\S+)/);
    if (!match) throw new Error(`Unexpected row format: ${line}`);
    const lineWithoutPrefix = line.slice(2);
    return lineWithoutPrefix.indexOf(match[2]!);
  });
  const titleStarts = parsed.map((row) => row.titleStart);

  assert.equal(new Set(priorityStarts).size, 1);
  assert.equal(new Set(assigneeStarts).size, 1);
  assert.equal(new Set(titleStarts).size, 1);
  assert.match(ticketLines[1], /\[deploying\]$/);

  assert.ok(parsed[0]!.id !== "" && parsed[1]!.id !== "");
  assert.ok(parsed.some((row) => row.title === "This task is deploying"));
});
