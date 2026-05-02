import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_COLUMNS, type BoardView, type TicketStatus } from "../tickets/index.js";
import { formatBoard } from "../cli/formatters.js";
import type { Ticket } from "../tickets/types.js";

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
