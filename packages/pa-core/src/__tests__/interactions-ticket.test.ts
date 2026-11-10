import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { createTicketInteraction, parseTicketIntakeRequest, TicketInteractionError, TICKET_INTERACTIONS_PROFILE, ticketIntakeRequestSchema, type TicketInteractionCaller } from "../interactions/tickets.js";

const request = { schemaVersion: "pa-ticket-intake/v1", action: "create", requestId: "requested-companion-1", kind: "companion", project: "other", title: "Explicit companion", summary: "Requested work", description: "Source fixture, not customer data" };
function fixture(run: (store: TicketStore, caller: TicketInteractionCaller, dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-intake-service-")), env = process.env;
  process.env = { ...env, PA_PLATFORM_CONFIG: join(root, "config"), PA_AI_USAGE_HOME: root };
  delete process.env.PA_DEPLOYMENT_ID;
  mkdirSync(process.env.PA_PLATFORM_CONFIG!, { recursive: true });
  writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "repos.yaml"), "repos:\n  sample:\n    path: /tmp/sample\n    prefix: SMP\n  other:\n    path: /tmp/other\n    prefix: OTH\n");
  const dir = join(root, "tickets"), store = new TicketStore(dir);
  const parent = store.create({ project: "sample", title: "Primary", summary: "", description: "", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] });
  const caller: TicketInteractionCaller = { profile: TICKET_INTERACTIONS_PROFILE, deploymentId: "d-abcdef", repoKey: "sample", ticket: parent.id, identitySha256: "a".repeat(64) };
  try { run(store, caller, dir); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}

test("strict raw intake contract shares published fields and rejects authority, duplicates, Unicode and oversized inputs", () => {
  assert.equal(ticketIntakeRequestSchema.additionalProperties, false);
  assert.equal(parseTicketIntakeRequest(JSON.stringify(request)).kind, "companion");
  for (const raw of [
    JSON.stringify({ ...request, actor: "sinh" }), JSON.stringify({ ...request, status: "done" }), JSON.stringify({ ...request, root: "/other" }),
    JSON.stringify({ ...request, project: "../other" }), JSON.stringify({ ...request, requestId: "../intent" }), JSON.stringify({ ...request, kind: "arbitrary" }),
    JSON.stringify({ ...request, priority: "normal" }), JSON.stringify({ ...request, title: "" }), JSON.stringify({ ...request, title: "é".repeat(513) }),
    '{"action":"create","action":"create"}', JSON.stringify(request).replace("Explicit companion", "\\ud800"), " ".repeat(65537),
    JSON.stringify({ ...request, description: "x".repeat(32769) }), JSON.stringify({ ...request, approval: true }), JSON.stringify({ ...request, expectedProject: "sample" }),
  ]) assert.throws(() => parseTicketIntakeRequest(raw), TicketInteractionError);
  assert.throws(() => parseTicketIntakeRequest(JSON.stringify({ ...request, kind: "intake" })), /TICKET_INTERACTION_INPUT/);
});

test("bound companion uses exact registered project, defaults, derived actor and original owner recovery without reassociation", () => fixture((store, caller, dir) => {
  const before = readFileSync(join(dir, `${caller.ticket}.json`), "utf8"), authenticate = () => ({ ...caller });
  const first = createTicketInteraction(JSON.stringify(request), { store, authenticate });
  assert.equal(first.ticket.id, "OTH-001"); assert.equal(first.ticket.project, "other"); assert.equal(first.reusedIntent, false);
  assert.equal(first.primaryTicket, caller.ticket);
  const ticket = store.get(first.ticket.id)!;
  assert.equal(ticket.type, "feature"); assert.equal(ticket.priority, "medium"); assert.equal(ticket.estimate, "M"); assert.equal(ticket.assignee, "sinh"); assert.equal(ticket.status, "idea");
  assert.deepEqual(ticket.linkedBranches, []); assert.deepEqual(ticket.doc_refs, []);
  assert.equal(store.readAudit().find(row => row.ticket_id === ticket.id)!.actor, "requirements/analyze");
  const again = createTicketInteraction(JSON.stringify(request), { store, authenticate });
  assert.equal(again.ticket.id, ticket.id); assert.equal(again.reusedIntent, true); assert.equal(store.list().length, 2);
  assert.equal(readFileSync(join(dir, `${caller.ticket}.json`), "utf8"), before);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 51200); assert.ok(!JSON.stringify(first).includes(request.description));
  for (const changed of [{ title: "Different request" }, { description: `${request.description};` }])
    assert.throws(() => createTicketInteraction(JSON.stringify({ ...request, ...changed }), { store, authenticate }), /TICKET_CREATE_CONFLICT/);
}));

test("ordinary intake retains required metadata and CLI sanitization with bounded nonsecret warnings", () => fixture((store, caller) => {
  const raw = { ...request, kind: "intake", project: "sample", type: "bug", priority: "high", estimate: "S", assignee: "sinh", title: "Text; $without& shell\\ syntax" };
  const result = createTicketInteraction(JSON.stringify(raw), { store, authenticate: () => caller });
  assert.equal(store.get(result.ticket.id)!.title, "Text without shell syntax");
  assert.deepEqual(result.sanitizedFields, ["title"]);
  assert.equal(store.get(result.ticket.id)!.type, "bug");
  assert.throws(() => createTicketInteraction(JSON.stringify({ ...raw, kind: "companion" }), { store, authenticate: () => caller }), /TICKET_CREATE_CONFLICT/);
  assert.throws(() => createTicketInteraction(JSON.stringify({ ...raw, project: "other", requestId: "wrong-project" }), { store, authenticate: () => caller }), /TICKET_INTERACTION_PROJECT/);
}));

test("new profile, role scope, primary ticket and exact project are rechecked under shared ticket mutex", () => fixture((store, caller) => {
  for (const bad of [
    { ...caller, profile: "requirements-document-confirmation/v3" }, { ...caller, profile: "pa-advisory-runtime/v1" },
    { ...caller, ticket: "OTH-999" }, { ...caller, ticket: null }, { ...caller, identitySha256: "forged" },
  ]) assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => bad }), TicketInteractionError);
  for (const project of ["OTH", "/tmp/other", "missing", "othe"])
    assert.throws(() => createTicketInteraction(JSON.stringify({ ...request, project }), { store, authenticate: () => caller }), TicketInteractionError);
  let checks = 0;
  assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => ++checks === 1 ? caller : { ...caller, identitySha256: "b".repeat(64) } }), /TICKET_INTERACTION_SESSION/);
  assert.ok(checks >= 2); assert.equal(store.list().length, 1);
}));

test("mutable trusted caller objects and changed sensitive policy cannot evade locked reauthentication", () => {
  fixture((store, caller) => {
    let calls = 0;
    assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => {
      if (++calls === 2) caller.identitySha256 = "b".repeat(64);
      return caller;
    } }), /TICKET_INTERACTION_SESSION/);
    assert.equal(store.list().length, 1);
  });
  fixture((store, caller) => {
    let calls = 0;
    assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => {
      if (++calls === 2) writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "sensitive-patterns.yaml"), "contents:\n  - 'Explicit companion'\n");
      return caller;
    } }), /TICKET_INTERACTION_SENSITIVE/);
    assert.equal(store.list().length, 1);
  });
});

test("ticketless same-project intake is distinct from companion and sensitive input is never echoed", () => fixture((store, caller) => {
  const ticketless = { ...caller, ticket: null };
  const raw = { ...request, kind: "intake", project: "sample", type: "task", priority: "medium", estimate: "M", assignee: "sinh" };
  assert.equal(createTicketInteraction(JSON.stringify(raw), { store, authenticate: () => ticketless }).primaryTicket, null);
  for (const sensitive of ["-----BEGIN SYNTHETIC PRIVATE KEY-----", "-----BEGIN SYNTHETIC; PRIVATE KEY-----"]) {
    assert.throws(() => createTicketInteraction(JSON.stringify({ ...raw, requestId: "sensitive", description: sensitive }), { store, authenticate: () => ticketless }), (error: unknown) => error instanceof TicketInteractionError && error.code === "TICKET_INTERACTION_SENSITIVE" && !error.message.includes(sensitive));
  }
  assert.equal(store.list().length, 2);
  for (const code of ["TICKET_INTERACTION_INPUT", "TICKET_INTERACTION_SESSION", "TICKET_INTERACTION_PROJECT", "TICKET_INTERACTION_SENSITIVE", "TICKET_INTERACTION_UNCERTAIN"] as const) {
    const error = new TicketInteractionError(code); assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
    assert.match(error.message, /Impact:/); assert.match(error.message, /Actor:/); assert.match(error.message, /New approval:/); assert.match(error.message, /Prerequisite:/);
  }
}));
