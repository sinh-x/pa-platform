import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketStore } from "../tickets/store.js";
import { TICKET_STATUSES, statusVersion, TicketStatusError } from "../tickets/status-intent.js";
import { ticketStatusService, parseTicketStatusRequest } from "../tickets/status-service.js";
import { createModeCapabilityBinding, parseModeCapabilityPolicy, MODE_CAPABILITY_SESSION } from "../mode-capabilities.js";
import { closeDb } from "../registry/db.js";
const input = { project: "example", title: "Synthetic status ticket", summary: "", description: "", status: "idea" as const, priority: "medium" as const, type: "feature" as const, estimate: "M" as const, assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] };

// Disposable ticket root; source mechanics only, no production records/decisions.
test("status owner covers all 81 enum edges, lifecycle denials, CAS and original-intent recovery", () => {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "status-owner-")); closeDb();
  try {
    const config = join(root, "config"); mkdirSync(config);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db") });
    writeFileSync(join(config, "config.yaml"), "repos:\n example:\n  path: /tmp/synthetic-status-repo\n  prefix: EX\n");
    const store = new TicketStore(join(root, "tickets"), { privileged: true, team: "requirements", mode: "analyze" });
    let seq = 0;
    const set = (id: string, status: typeof TICKET_STATUSES[number], hooks: any = { assertCurrent() {} }) => store.setStatusWithIntent(id, statusVersion(store.get(id)!), status, "requirements/analyze", { scope: "a".repeat(64), requestId: `request-${seq++}` }, hooks);
    for (const before of TICKET_STATUSES) for (const after of TICKET_STATUSES) {
      const ticket = store.create({ ...input, status: before });
      const result = set(ticket.id, after).ticket;
      assert.equal(result.status, after); assert.equal(result.assignee, ticket.assignee);
      if (before !== after) assert.equal(result.resolvedAt !== null, ["done", "rejected", "cancelled"].includes(after));
    }
    const ticket = store.create(input), expected = statusVersion(ticket), identity = { scope: "a".repeat(64), requestId: "lost-reply" };
    assert.throws(() => store.setStatusWithIntent(ticket.id, expected, "requirement-review", "requirements/analyze", identity, { assertCurrent() {}, afterPersist(stage) { if (stage === "ticket") throw Error("synthetic lost reply"); } }), /synthetic lost reply/);
    const recovered = store.setStatusWithIntent(ticket.id, expected, "requirement-review", "requirements/analyze", identity, { assertCurrent() {} });
    assert.equal(recovered.reused, true); assert.equal(recovered.ticket.status, "requirement-review");
    const audit = store.readAudit();
    assert.equal(store.setStatusWithIntent(ticket.id, expected, "requirement-review", "requirements/analyze", identity, { assertCurrent() {} }).reused, true);
    assert.deepEqual(store.readAudit(), audit);
    assert.throws(() => store.setStatusWithIntent(ticket.id, expected, "done", "requirements/analyze", identity, { assertCurrent() {} }), /TICKET_STATUS_CONFLICT/);
    assert.throws(() => store.setStatusWithIntent(ticket.id, expected, "done", "requirements/analyze", { ...identity, requestId: "stale" }, { assertCurrent() {} }), /TICKET_STATUS_STALE/);
    store.update(ticket.id, { summary: "Later work must survive replay" });
    assert.equal(store.setStatusWithIntent(ticket.id, expected, "requirement-review", "requirements/analyze", identity, { assertCurrent() {} }).ticket.summary, "Later work must survive replay");
    store.addSubTicket(ticket.id, { title: "Open child", summary: "", assignee: "sinh", priority: "medium", estimate: "S" });
    assert.throws(() => set(ticket.id, "done"), /TICKET_STATUS_INPUT/);
    for (const context of [{}, { privileged: true, team: "builder", mode: "implement" }]) {
      const denied = new TicketStore(join(root, "tickets"), context);
      assert.throws(() => denied.setStatusWithIntent(ticket.id, statusVersion(store.get(ticket.id)!), "cancelled", "synthetic", { scope: "a".repeat(64), requestId: `denied-${seq++}` }, { assertCurrent() {} }), /parent flow/);
    }
    for (const stage of ["intent", "audit"] as const) {
      const t = store.create(input), version = statusVersion(t), intent = { scope: "b".repeat(64), requestId: stage };
      assert.throws(() => store.setStatusWithIntent(t.id, version, "requirement-review", "requirements/analyze", intent, { assertCurrent() {}, afterPersist(s) { if (s === stage) throw Error("fault"); } }), /fault/);
      assert.equal(store.setStatusWithIntent(t.id, version, "requirement-review", "requirements/analyze", intent, { assertCurrent() {} }).ticket.status, "requirement-review");
    }
  } finally { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test("finite service rejects forged fields, omission and foreign scope; diagnostics bounded", () => {
  for (const raw of ['{}', '{"action":"inspect","action":"set"}', JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "set", project: "example", ticket: "EX-001", requestId: "r", expectedVersion: "a".repeat(64), status: "approved" })]) assert.throws(() => parseTicketStatusRequest(raw));
  for (const code of ["TICKET_STATUS_INPUT", "TICKET_STATUS_SESSION", "TICKET_STATUS_OWNER", "TICKET_STATUS_STALE", "TICKET_STATUS_CONFLICT", "TICKET_STATUS_UNCERTAIN"] as const) {
    const text = new TicketStatusError(code).message; assert.ok(text.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
  }
  const caller = { deploymentId: "d-292001", repoKey: "example", profile: MODE_CAPABILITY_SESSION, capabilities: createModeCapabilityBinding("a".repeat(40), Buffer.from("fixture"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: [] })) };
  const raw = JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: "EX-001" });
  assert.throws(() => ticketStatusService(raw, { store: {} as TicketStore, authenticate: () => caller }), /TICKET_STATUS_SESSION/);
  assert.throws(() => parseTicketStatusRequest(JSON.stringify({ ...JSON.parse(raw), actor: "sinh" })), /TICKET_STATUS_INPUT/);
});
