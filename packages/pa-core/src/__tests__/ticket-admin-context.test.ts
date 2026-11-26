import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTicketCommand } from "../cli/commands/ticket.js";
import { createAgentApiApp } from "../agent-api/index.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { parseModeCapabilityBinding } from "../mode-capabilities.js";
import { resolveTrustedTicketMutationContext, TicketStore } from "../tickets/store.js";
import { statusVersion } from "../tickets/status-intent.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import type { CreateTicketInput, Ticket, UpdateTicketInput } from "../tickets/types.js";

const input: CreateTicketInput = { project: "other", title: "Cross-project administration", summary: "", description: "", status: "idea", priority: "medium", type: "task", estimate: "S", assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] };
const modes = [["analyst", "analyze"], ["builder", "implement"], ["coordinator", "coordinate"], ["instruction-lab", "develop"], ["review", "verify"], ["rogue-one", "rogue-one"], ["rollout", "rollout"]] as const;

async function fixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap334-admin-")); closeDb();
  try {
    for (const key of Object.keys(process.env)) if (/^PA_/.test(key)) delete process.env[key];
    const config = join(root, "config"), selected = join(root, "selected"), other = join(root, "other");
    for (const dir of [config, selected, other]) mkdirSync(dir);
    writeFileSync(join(config, "config.yaml"), `repos:\n selected:\n  path: ${selected}\n  prefix: SEL\n other:\n  path: ${other}\n  prefix: OTH\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    process.chdir(selected);
    await run(root);
  } finally { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); }
}

function started(id: string, team: string, mode: string, binding?: string): void {
  appendRegistryEvent({ deployment_id: id, team, mode, event: "started", runtime: "pi", timestamp: "2026-11-24T00:00:00Z", ...(binding !== undefined ? { mode_capability_binding: binding } : {}) });
}

function readonlyBinding(root: string, team: string, mode: string): string {
  return JSON.stringify(parseModeCapabilityBinding({ schemaVersion: "pa-mode-capability-binding/v3", configRoot: join(root, "config"), configRevision: "a".repeat(40),
    resourcePath: `teams/${team}.yaml`, resourceSha256: "b".repeat(64), profile: "pa-readonly-document/v1", policy: { version: "pa-mode-capabilities/v1", allow: [] }, repoKey: "selected",
    identity: { publicTeam: team, publicMode: mode, effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }, resources: [{ path: `teams/${team}.yaml`, sha256: "b".repeat(64) }] }));
}

for (const [team, mode] of modes) test(`PAP-334 ${team}/${mode}: generic CLI and authenticated REST administer another registered project`, async () => {
  await fixture(async root => {
    const id = "d-334001";
    started(id, team, mode, team === "analyst" ? readonlyBinding(root, team, mode) : undefined);
    process.env.PA_DEPLOYMENT_ID = id;
    // Environment role spelling and selected repository are not permission keys.
    Object.assign(process.env, { PA_TEAM: "untrusted-role", PA_MODE: "untrusted-mode" });
    const stdout: string[] = [], stderr: string[] = [], io = { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) };
    assert.equal(runTicketCommand(["create", "--project", "other", "--title", mode, "--type", "task", "--priority", "medium", "--estimate", "S", "--assignee", "sinh"], io), 0);
    assert.equal(runTicketCommand(["update", "OTH-001", "--status", "implementing", "--assignee", "sinh", "--title", "Edited title", "--summary", "Edited summary", "--description", "Edited description", "--priority", "high", "--estimate", "L", "--tags", "crossproject,admin", "--blocked-by", "SEL-001"], io), 0);
    assert.deepEqual(stderr, []);
    const store = new TicketStore(), ticket = store.get("OTH-001")!;
    assert.equal(ticket.project, "other"); assert.equal(ticket.status, "implementing"); assert.equal(ticket.title, "Edited title");
    assert.equal(ticket.description, "Edited description"); assert.equal(ticket.priority, "high"); assert.equal(ticket.estimate, "L");
    assert.deepEqual(ticket.tags, ["crossproject", "admin"]); assert.deepEqual(ticket.blockedBy, ["SEL-001"]);
    assert.equal(store.readAudit().at(-1)?.action, "updated");
    const api = createAgentApiApp({ ticketMutationAuth: { deploymentId: id, credential: "synthetic-admin-credential" } });
    const headers = { "content-type": "application/json", Authorization: ["Bearer", "synthetic-admin-credential"].join(" "), "X-PA-Deployment-ID": id };
    try {
      const created = await api.app.request("/api/tickets", { method: "POST", headers, body: JSON.stringify(input) });
      assert.equal(created.status, 201, await created.clone().text());
      const createdTicket = (await created.json() as { ticket: { id: string } }).ticket;
      const patch = { status: "review-uat", assignee: "sinh", title: "REST title", summary: "REST summary", description: "REST description", priority: "critical", estimate: "XL", tags: ["rest"], blockedBy: [] };
      const updated = await api.app.request(`/api/tickets/${createdTicket.id}`, { method: "PATCH", headers, body: JSON.stringify(patch) });
      assert.equal(updated.status, 200, await updated.clone().text());
      const persisted = store.get(createdTicket.id)!;
      for (const [key, value] of Object.entries(patch)) assert.deepEqual(Reflect.get(persisted, key), value, key);
      assert.equal(persisted.project, "other");
    } finally { api.cleanup(); }
  });
});

test("PAP-352 REST keeps the original typed custody reason in its existing error field and status", async () => {
  await fixture(async () => {
    const id = "d-352030", competitor = "d-352031"; started(id, "builder", "implement");
    const store = new TicketStore(), ticket = store.create(input), before = store.get(ticket.id), audit = store.readAudit();
    appendRegistryEvent({ deployment_id: competitor, team: "builder", mode: "implement", event: "started", ticket_id: ticket.id, timestamp: "2026-11-24T00:00:01Z" });
    const credential = "inert-diagnostic-fixture";
    const api = createAgentApiApp({ ticketMutationAuth: { deploymentId: id, credential } });
    const headers = { "content-type": "application/json", Authorization: ["Bearer", credential].join(" "), "X-PA-Deployment-ID": id };
    const call = () => api.app.request(`/api/tickets/${ticket.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "review-uat" }) });
    try {
      for (const scenario of ["active", "missing-pid", "present-pid", "document-unreadable"] as const) {
        if (scenario === "missing-pid") appendRegistryEvent({ deployment_id: competitor, team: "builder", event: "completed", timestamp: "2026-11-24T00:00:02Z", status: "partial" });
        if (scenario === "present-pid") appendRegistryEvent({ deployment_id: competitor, team: "builder", event: "pid", timestamp: "2026-11-24T00:00:03Z", pid: process.pid });
        const original = RegistryDocumentJournal.prototype.events;
        if (scenario === "document-unreadable") RegistryDocumentJournal.prototype.events = () => { throw Error("private upstream fixture"); };
        try {
          const response = await call(); assert.equal(response.status, 400);
          const body = await response.json() as { error: string; code: string };
          assert.deepEqual(Object.keys(body).sort(), ["code", "error"]); assert.equal(body.code, "UPDATE_FAILED");
          const expected = scenario === "active" ? /registered outside/ : scenario === "missing-pid" ? /no usable process ID/ : scenario === "present-pid" ? /reused ID/ : /document registry could not be inspected/;
          assert.match(body.error, expected); assert.ok(body.error.length <= 2000);
          assert.ok(!body.error.includes("private upstream fixture"));
          for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(body.error.split(`${label}:`).length, 2);
          assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
        } finally { RegistryDocumentJournal.prototype.events = original; }
      }
    } finally { api.cleanup(); }
  });
});

test("PAP-334 generic store reauthenticates before effects and preserves deletion restrictions", async () => {
  await fixture(root => {
    const id = "d-334002"; started(id, "builder", "implement");
    const context = resolveTrustedTicketMutationContext({ deploymentId: id }, false), store = new TicketStore(undefined, context);
    assert.equal(context.privileged, true);
    const ticket = store.create(input);
    assert.equal(store.update(ticket.id, { status: "implementing" }).status, "implementing");
    const before = store.get(ticket.id), audit = store.readAudit();
    for (const hard of [false, true]) assert.throws(() => store.delete(ticket.id, "synthetic", hard), /implement-child/);
    // Revocation after context capture must still be observed by status writes.
    // Creation/non-status authentication retains its existing route-owned policy.
    appendRegistryEvent({ deployment_id: id, team: "builder", event: "completed", timestamp: "2026-11-24T00:00:01Z", status: "success" });
    assert.throws(() => store.update(ticket.id, { status: "done", summary: "Must not persist" }), /TICKET_STATUS_SESSION/);
    assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
    for (const principal of [{}, { operator: true }, { deploymentId: "d-unknown" }]) {
      const denied = resolveTrustedTicketMutationContext(principal, false);
      assert.equal(denied.privileged, false);
      assert.throws(() => new TicketStore(undefined, denied).update(ticket.id, { status: "done" }), /TICKET_STATUS_SESSION/);
    }
    assert.equal(resolveTrustedTicketMutationContext({ operator: true }, true).privileged, true);
    for (const [index, binding] of ["", "private-invalid-binding", JSON.stringify({ schemaVersion: "pa-mode-capability-binding/v3" })].entries()) {
      const malformedId = `d-malformed-${index}`; started(malformedId, "analyst", "analyze", binding);
      const denied = resolveTrustedTicketMutationContext({ deploymentId: malformedId }, false);
      assert.equal(denied.privileged, false, "malformed capability bindings fail closed");
      assert.throws(() => new TicketStore(undefined, denied).update(ticket.id, { status: "done" }), /TICKET_STATUS_SESSION/);
    }
    const v3id = "d-334003"; started(v3id, "builder", "report", readonlyBinding(root, "builder", "report"));
    const v3store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: v3id }, false));
    assert.equal(v3store.update(ticket.id, { status: "review-uat" }).status, "review-uat");
    for (const hard of [false, true]) assert.throws(() => v3store.delete(ticket.id, "synthetic", hard), /status transitions/);
  });
});

test("PAP-334 generic status rechecks authority at the locked effect boundary", async () => {
  await fixture(() => {
    const id = "d-334006"; started(id, "analyst", "analyze");
    const context = resolveTrustedTicketMutationContext({ deploymentId: id }, false), observer = new TicketStore(), ticket = observer.create(input);
    const before = observer.get(ticket.id), audit = observer.readAudit();
    let revoke = true;
    class RevokingStore extends TicketStore {
      override get(ticketId: string): Ticket | undefined {
        const result = super.get(ticketId);
        if (revoke) {
          revoke = false;
          appendRegistryEvent({ deployment_id: id, team: "analyst", event: "completed", timestamp: "2026-11-24T00:00:01Z", status: "success" });
        }
        return result;
      }
    }
    assert.throws(() => new RevokingStore(undefined, context).update(ticket.id, { status: "implementing", summary: "Must not persist" }), /TICKET_STATUS_SESSION/);
    assert.equal(revoke, false, "authority was revoked only after the first locked check");
    assert.deepEqual(observer.get(ticket.id), before); assert.deepEqual(observer.readAudit(), audit);
  });
});

test("PAP-334 generic status cannot replace an unsettled native operation", async () => {
  await fixture(() => {
    const id = "d-334007"; started(id, "analyst", "analyze");
    const native = new TicketStore(undefined, { privileged: true }), ticket = native.create(input), version = statusVersion(ticket);
    const identity = { scope: "a".repeat(64), requestId: "original-native-status" };
    assert.throws(() => native.setStatusWithIntent(ticket.id, version, "implementing", "requirements/analyze", identity, {
      assertCurrent() {}, afterPersist(stage) { if (stage === "ticket") throw new Error("Synthetic lost response"); },
    }), /Synthetic lost response/);
    const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: id }, false)), before = store.get(ticket.id), audit = store.readAudit();
    assert.throws(() => store.update(ticket.id, { status: "review-uat" }), /TICKET_HANDOFF_UNCERTAIN/);
    assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
    assert.equal(native.setStatusWithIntent(ticket.id, version, "implementing", "requirements/analyze", identity, { assertCurrent() {} }).reused, true);
    assert.equal(store.update(ticket.id, { status: "review-uat" }).status, "review-uat");
  });
});

test("PAP-334 invalid status, open subtickets, branch evidence and competing owners fail without ticket/audit effects", async () => {
  await fixture(() => {
    const id = "d-334004"; started(id, "analyst", "analyze");
    const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: id }, false)), ticket = store.create(input);
    store.addSubTicket(ticket.id, { title: "Open child", summary: "", assignee: "sinh", priority: "medium", estimate: "S" });
    const before = store.get(ticket.id), audit = store.readAudit();
    // Exercise runtime validation at an untyped input boundary, not a typed API escape hatch.
    const invalidStatus: UpdateTicketInput = JSON.parse('{"status":"approved","summary":"Must not persist"}');
    assert.throws(() => store.update(ticket.id, invalidStatus), /Invalid status/);
    assert.throws(() => store.update(ticket.id, { status: "done", title: "Must not persist" }), /sub-tickets are open/);
    assert.throws(() => store.update(ticket.id, { add_linked_branch: { repo: "unregistered", branch: "feature/invalid" } }), /[Rr]epo/);
    assert.throws(() => store.update("../outside", { status: "done" }), /Ticket not found/);
    assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
    appendRegistryEvent({ deployment_id: "d-334005", team: "builder", mode: "implement", event: "started", ticket_id: ticket.id, timestamp: "2026-11-24T00:00:01Z" });
    assert.throws(() => store.update(ticket.id, { status: "review-uat", summary: "Must not persist" }), /TICKET_STATUS_OWNER/);
    const operator = new TicketStore(undefined, resolveTrustedTicketMutationContext({ operator: true }, true));
    assert.throws(() => operator.update(ticket.id, { status: "review-uat" }), /TICKET_STATUS_OWNER/);
    assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
    assert.equal(store.update(ticket.id, { summary: "Metadata is not execution custody" }).summary, "Metadata is not execution custody");
  });
});
