import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BulletinStore, TicketStore } from "../index.js";

test("TicketStore creates, updates, comments, and filters tickets", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-ticket-"));
  const config = join(root, "config");
  const tickets = join(root, "tickets");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "repos.yaml"), "repos:\n  pa-platform:\n    path: /tmp/pa-platform\n    prefix: PAP\n");
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    const store = new TicketStore(tickets);
    const ticket = store.create({
      project: "pa-platform",
      title: "Port core",
      summary: "Summary",
      description: "",
      status: "pending-implementation",
      priority: "high",
      type: "task",
      assignee: "builder",
      estimate: "M",
      from: "",
      to: "",
      tags: [],
      blockedBy: [],
      doc_refs: [],
      comments: [],
    }, "test");
    assert.equal(ticket.id, "PAP-001");
    const updated = store.update(ticket.id, { status: "implementing", add_doc_ref: { type: "impl", path: "agent-teams/builder/artifacts/core.md", primary: true } }, "test");
    assert.equal(updated.status, "implementing");
    assert.equal(updated.doc_refs[0]?.primary, true);
    store.comment(ticket.id, "builder/team-manager", "Started");
    assert.equal(store.get(ticket.id)?.comments.length, 1);
    assert.equal(store.list({ status: "implementing", search: "Port" }).length, 1);
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BulletinStore creates and resolves active bulletins", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-bulletin-"));
  try {
    const store = new BulletinStore(root);
    const bulletin = store.create({ title: "Stop deploys", block: "all", body: "Blocked" });
    assert.equal(bulletin.id, "B-001");
    assert.equal(store.readActive().length, 1);
    assert.equal(store.resolve(bulletin.id), true);
    assert.equal(store.readActive().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
