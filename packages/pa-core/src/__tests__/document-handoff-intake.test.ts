import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDOFF_SESSION_VERSION, intakeNativeHandoffTicket, type HandoffIntakeHost } from "../documents/handoff-intake.js";
import { appendRegistryEvent, associateDeploymentTicket, closeDb, getDb, getDeploymentEvents, queryDeploymentStatus } from "../registry/index.js";
import { TicketStore } from "../tickets/store.js";

// Never restore live state/identity into a test process.
for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
const input = { title: "Synthetic native intake", content: "Complete synthetic requirements intake, not human approval." };
function fixture(note = HANDOFF_SESSION_VERSION, launchTicket?: string) {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "handoff-intake-")), repo = join(root, "repo"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(config); mkdirSync(join(root, "usage", "tickets"), { recursive: true });
  writeFileSync(join(config, "config.yaml"), `repos:\n  example:\n    path: ${repo}\n    prefix: EX\n`);
  process.env.PA_AI_USAGE_HOME = join(root, "usage"); process.env.PA_PLATFORM_CONFIG = config; process.env.PA_REGISTRY_DB = join(root, "registry.db");
  closeDb(); getDb();
  const dir = join(root, "usage", "tickets"), store = new TicketStore();
  writeFileSync(join(dir, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Supplied ticket", status: "idea", assignee: "sinh", doc_refs: [], comments: [], createdAt: "2026-11-15T06:00:00.000Z", updatedAt: "2026-11-15T06:00:00.000Z" }));
  const start = { deployment_id: "d-abcdef", event: "started" as const, team: "requirements", mode: "analyze", runtime: "pi" as const, binary: "ppa" as const,
    timestamp: "2026-11-15T06:00:00.000Z", repo_root: repo, repo, worktree_root: repo, note, ...(launchTicket ? { ticket_id: launchTicket } : {}) };
  appendRegistryEvent(start);
  const host: HandoffIntakeHost = { authenticate: () => ({ deploymentId: "d-abcdef", sessionId: "synthetic-session", repoKey: "example", repoRoot: repo,
    selectionSha256: "a".repeat(64), ticket: queryDeploymentStatus("d-abcdef")?.ticket_id || null }), assertAvailable() {} };
  const run = (value = input) => intakeNativeHandoffTicket(store, host, value);
  const edges = () => getDeploymentEvents("d-abcdef").filter(e => e.event === "ticket-associated");
  const tickets = () => readdirSync(dir).filter(name => /^EX-\d+\.json$/.test(name));
  return { root, repo, dir, store, host, start, run, edges, tickets, close() { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}

test("supplied ticket is reused and independently associated without ticket/lifecycle mutation", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dir, "EX-1.json")), start = getDeploymentEvents("d-abcdef")[0];
    const result = intakeNativeHandoffTicket(f.store, f.host, { ticket: "EX-1" });
    assert.equal(result.ticket.id, "EX-1"); assert.equal(result.ticket.status, "idea"); assert.equal(result.ticket.assignee, "sinh");
    assert.deepEqual(result.association, { deploymentId: "d-abcdef", ticket: "EX-1", verified: true });
    assert.equal(intakeNativeHandoffTicket(f.store, f.host, { ticket: "EX-1" }).ticket.id, "EX-1");
    assert.deepEqual(readFileSync(join(f.dir, "EX-1.json")), before); assert.deepEqual(getDeploymentEvents("d-abcdef")[0], start);
    assert.equal(f.edges().length, 1); assert.equal(f.edges()[0]!.actor, "requirements/analyze"); assert.equal(f.tickets().length, 1);
    assert.throws(() => f.run(), /DOCUMENT_UNCERTAIN/); assert.equal(f.tickets().length, 1);
  } finally { f.close(); }
});

test("ticketless intake has one native identity, exact readback and one independent association", () => {
  const f = fixture();
  try {
    const first = f.run(); const again = f.run();
    assert.equal(first.reused, false); assert.equal(again.reused, true); assert.deepEqual(again, { ...first, reused: true });
    assert.equal(first.ticket.status, "requirement-review"); assert.equal(first.ticket.assignee, "requirements/team-manager");
    assert.equal(f.tickets().length, 2); assert.equal(f.edges().length, 1);
    const audit = readFileSync(join(f.dir, "audit.jsonl"), "utf8");
    assert.equal(audit.trim().split("\n").length, 1);
    assert.throws(() => f.run({ ...input, content: "Changed content" }), /TICKET_CREATE_CONFLICT/);
    assert.equal(f.tickets().length, 2); assert.equal(f.edges().length, 1);
    // Legitimate later ticket work is not reset to the original creation payload.
    f.store.update(first.ticket.id, { title: "Later legitimate title" });
    assert.equal(f.run().ticket.title, "Later legitimate title");
  } finally { f.close(); }
});

for (const point of ["intent", "ticket", "audit", "association"] as const) test(`lost reply after ${point} resumes original intake and does not duplicate the ticket/edge`, () => {
  const f = fixture();
  try {
    f.host.afterPersist = stage => { if (stage === point) throw Error("synthetic response loss"); };
    assert.throws(() => f.run(), /synthetic response loss/);
    delete f.host.afterPersist;
    const result = f.run(); assert.equal(result.association.ticket, result.ticket.id);
    assert.equal(f.tickets().length, 2); assert.equal(f.edges().length, 1);
    assert.equal(readFileSync(join(f.dir, "audit.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(f.run().ticket.id, result.ticket.id);
  } finally { f.close(); }
});

test("missing original creation after association never reserves a replacement ID", () => {
  const f = fixture();
  try {
    const result = f.run(), name = readdirSync(f.dir).find(name => name.startsWith(".ticket-create-"))!;
    unlinkSync(join(f.dir, name));
    assert.throws(() => f.run(), /DOCUMENT_UNCERTAIN/);
    assert.equal(f.tickets().length, 2); assert.equal(f.edges().length, 1);
    assert.equal(queryDeploymentStatus("d-abcdef")?.ticket_id, result.ticket.id);
  } finally { f.close(); }
});

for (const note of ["requirements-document-policy/v1", "requirements-document-confirmation/v3", "rogue-one"]) test(`retained/unselected start ${note} cannot enter the new intake`, () => {
  const f = fixture(note);
  try { assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/); assert.equal(f.tickets().length, 1); assert.equal(f.edges().length, 0); }
  finally { f.close(); }
});

test("foreign/current AND historical owners, foreign project and replaced association block without theft", () => {
  const f = fixture();
  try {
    appendRegistryEvent({ ...f.start, deployment_id: "d-123456", ticket_id: "EX-1" });
    appendRegistryEvent({ deployment_id: "d-123456", team: "requirements", event: "completed", timestamp: "2026-11-15T06:01:00.000Z", status: "success" });
    assert.throws(() => intakeNativeHandoffTicket(f.store, f.host, { ticket: "EX-1" }), /DOCUMENT_CONFLICT/);
    writeFileSync(join(f.dir, "OTH-1.json"), JSON.stringify({ id: "OTH-1", project: "foreign", title: "foreign" }));
    assert.throws(() => intakeNativeHandoffTicket(f.store, f.host, { ticket: "OTH-1" }), /DOCUMENT_AUTHORITY/);
    associateDeploymentTicket({ deploymentId: "d-abcdef", ticketId: "EX-1", expectedTicketId: null, actor: "operator", reason: "foreign context owner" });
    assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/); assert.equal(f.tickets().length, 1);
  } finally { f.close(); }
});

test("native authentication/selection failure, async hooks and unknown fields produce zero intake effects", () => {
  const f = fixture();
  try {
    assert.throws(() => intakeNativeHandoffTicket(f.store, f.host, { ...input, actor: "operator" } as typeof input), /DOCUMENT_INPUT/);
    f.host.assertAvailable = async () => {};
    assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/);
    f.host.assertAvailable = () => { throw Error("native selected-owner denial"); };
    assert.throws(() => f.run(), /native selected-owner denial/);
    assert.equal(f.tickets().length, 1); assert.equal(f.edges().length, 0);
  } finally { f.close(); }
});

test("already supplied aligned launch ticket needs no association edge or creation", () => {
  const f = fixture(HANDOFF_SESSION_VERSION, "EX-1");
  try {
    assert.equal(intakeNativeHandoffTicket(f.store, f.host, { ticket: "EX-1" }).ticket.id, "EX-1");
    assert.equal(f.edges().length, 0); assert.equal(f.tickets().length, 1);
    assert.throws(() => f.run(), /DOCUMENT_UNCERTAIN/);
  } finally { f.close(); }
});
