import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy } from "../mode-capabilities.js";
import { patchTicketPlanningInteraction, createTicketInteraction, readTicketInteraction, parseTicketIntakeRequest, parseTicketIntakeOperation, ticketIntakeInterface, TicketInteractionError, TICKET_INTERACTIONS_PROFILE, ticketIntakeRequestSchema, type TicketInteractionCaller } from "../interactions/tickets.js";

const request = { schemaVersion: "pa-ticket-intake/v1", action: "create", requestId: "requested-companion-1", kind: "companion", project: "other", title: "Explicit companion", summary: "Requested work", description: "Source fixture, not customer data" };
function fixture(run: (store: TicketStore, caller: TicketInteractionCaller, dir: string) => void): void {
  for (const profile of [TICKET_INTERACTIONS_PROFILE, MODE_CAPABILITY_SESSION]) fixtureProfile(profile, run);
}
function fixtureProfile(profile: string, run: (store: TicketStore, caller: TicketInteractionCaller, dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-intake-service-")), env = process.env;
  process.env = { ...env, PA_PLATFORM_CONFIG: join(root, "config"), PA_AI_USAGE_HOME: root };
  delete process.env.PA_DEPLOYMENT_ID;
  mkdirSync(process.env.PA_PLATFORM_CONFIG!, { recursive: true });
  writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "repos.yaml"), "repos:\n  sample:\n    path: /tmp/sample\n    prefix: SMP\n  other:\n    path: /tmp/other\n    prefix: OTH\n");
  const dir = join(root, "tickets"), store = new TicketStore(dir);
  const parent = store.create({ project: "sample", title: "Primary", summary: "", description: "", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] });
  const caller: TicketInteractionCaller = { profile, deploymentId: "d-abcdef", repoKey: "sample", ticket: parent.id, identitySha256: "a".repeat(64),
    ...(profile === MODE_CAPABILITY_SESSION ? { capabilities: createModeCapabilityBinding("a".repeat(40), Buffer.from("synthetic config"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["ticket.intake"] })) } : {}) };
  try { run(store, caller, dir); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}

test("policy intake needs its exact selected binding even inside the ticket owner mutex", () => fixtureProfile(MODE_CAPABILITY_SESSION, (store, caller) => {
  const omitted = createModeCapabilityBinding("a".repeat(40), Buffer.from("synthetic omitted"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["capability.discover"] }));
  const audit = store.readAudit(), count = store.list().length;
  for (const current of [{ ...caller, capabilities: undefined }, { ...caller, capabilities: omitted }, { ...caller, profile: TICKET_INTERACTIONS_PROFILE }, { ...caller, profile: "requirements-document-confirmation/v3" }]) {
    assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => current }), /TICKET_INTERACTION_SESSION/);
    assert.deepEqual(store.readAudit(), audit); assert.equal(store.list().length, count);
  }
  let checks = 0;
  assert.throws(() => createTicketInteraction(JSON.stringify(request), { store, authenticate: () => ++checks === 1 ? caller : { ...caller, capabilities: omitted } }), /TICKET_INTERACTION_SESSION/);
  assert.ok(checks >= 2); assert.deepEqual(store.readAudit(), audit); assert.equal(store.list().length, count);
}));

test("intake interface discovery is strict bounded metadata, not an effect or installed/admitted claim",  () => {
  const raw = JSON.stringify({ schemaVersion: "pa-ticket-intake/v1", action: "capabilities" });
  assert.equal(parseTicketIntakeOperation(raw).action, "capabilities");
  assert.equal(parseTicketIntakeOperation(JSON.stringify(request)).action, "create");
  const metadata = ticketIntakeInterface();
  assert.deepEqual(metadata.supportedActions, ["capabilities", "inspect", "reuse", "create", "patch-planning"]);
  assert.equal(metadata.schemas.create, ticketIntakeRequestSchema);
  assert.equal(metadata.availability.installed, "unproven"); assert.equal(metadata.availability.admitted, "not-checked");
  assert.equal(metadata.authorityGranted, false);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 51200);
  for (const extra of [{ actor: "sinh" }, { project: "other" }, { requestId: "new-effect" }, { command: "anything" }, { approval: true }])
    assert.throws(() => parseTicketIntakeOperation(JSON.stringify({ schemaVersion: "pa-ticket-intake/v1", action: "capabilities", ...extra })), TicketInteractionError);
  assert.throws(() => parseTicketIntakeOperation('{"schemaVersion":"pa-ticket-intake/v1","action":"capabilities","action":"create"}'), TicketInteractionError);
});

test("exact aligned reuse is a read-only caller-bound snapshot, not a claim or reassociation", () => fixture((store, caller, dir) => {
  const selected = store.create({ ...store.get(caller.ticket!)!, project: "other", title: "Existing requested companion" });
  const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "companion", project: "other", ticket: selected.id };
  const authenticate = () => ({ ...caller });
  const before = store.readAudit(), primary = store.get(caller.ticket!);
  const observed = readTicketInteraction(JSON.stringify(inspect), { store, authenticate });
  assert.equal(observed.action, "inspect"); assert.equal(observed.ticket.id, selected.id);
  assert.equal(observed.primaryTicket, caller.ticket); assert.match(observed.version, /^[a-f0-9]{64}$/);
  const reuse = { ...inspect, action: "reuse", expectedVersion: observed.version, expectedTitle: selected.title, expectedType: selected.type };
  const result = readTicketInteraction(JSON.stringify(reuse), { store, authenticate });
  assert.equal(result.action, "reuse"); assert.equal(result.version, observed.version); assert.equal(result.authorityGranted, false);
  assert.deepEqual(store.readAudit(), before); assert.deepEqual(store.get(caller.ticket!), primary);
  assert.equal(store.list().length, 2);
  for (const change of [{ expectedTitle: "Different work" }, { expectedType: "bug" }, { expectedVersion: "b".repeat(64) }])
    assert.throws(() => readTicketInteraction(JSON.stringify({ ...reuse, ...change }), { store, authenticate }), /TICKET_INTERACTION_STALE/);
  store.comment(selected.id, "fixture", "A concurrent change invalidates the complete snapshot");
  assert.throws(() => readTicketInteraction(JSON.stringify(reuse), { store, authenticate }), /TICKET_INTERACTION_STALE/);
  assert.throws(() => readTicketInteraction(JSON.stringify(inspect), { store, authenticate: () => ({ ...caller, ticket: null }) }), /TICKET_INTERACTION_PROJECT/);
  assert.throws(() => readTicketInteraction(JSON.stringify({ ...inspect, kind: "intake" }), { store, authenticate }), /TICKET_INTERACTION_PROJECT/);
  assert.throws(() => readTicketInteraction(JSON.stringify({ ...inspect, ticket: caller.ticket }), { store, authenticate }), /TICKET_INTERACTION_SELECTION/);
  assert.throws(() => readTicketInteraction(JSON.stringify({ ...inspect, ticket: "OTH-999" }), { store, authenticate }), /TICKET_INTERACTION_SELECTION/);
  writeFileSync(join(dir, "OTH-002.json"), JSON.stringify({ _alias: true, movedTo: selected.id }));
  assert.throws(() => readTicketInteraction(JSON.stringify({ ...inspect, ticket: "OTH-002" }), { store, authenticate }), /TICKET_INTERACTION_SELECTION/);
  const otherSession = { ...caller, identitySha256: "b".repeat(64) };
  assert.throws(() => readTicketInteraction(JSON.stringify(reuse), { store, authenticate: () => otherSession }), /TICKET_INTERACTION_STALE/);
}));

test("reuse framing, sensitive output and caller changes reject without exposing target content", () => fixture((store, caller) => {
  const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "intake", project: "sample", ticket: caller.ticket };
  for (const extra of [{ actor: "sinh" }, { requestId: "write" }, { expectedVersion: "a".repeat(64) }, { command: "anything" }, { approval: true }])
    assert.throws(() => parseTicketIntakeOperation(JSON.stringify({ ...inspect, ...extra })), TicketInteractionError);
  for (const ticket of ["SMP", "../SMP-001", "SMP-001\n"])
    assert.throws(() => parseTicketIntakeOperation(JSON.stringify({ ...inspect, ticket })), TicketInteractionError);
  assert.throws(() => parseTicketIntakeOperation(JSON.stringify({ ...inspect, action: "reuse" })), TicketInteractionError);
  const before = store.readAudit(); let calls = 0;
  assert.throws(() => readTicketInteraction(JSON.stringify(inspect), { store, authenticate: () => ++calls === 1 ? caller : { ...caller, identitySha256: "b".repeat(64) } }), /TICKET_INTERACTION_SESSION/);
  assert.deepEqual(store.readAudit(), before);
  store.update(caller.ticket!, { title: "-----BEGIN SYNTHETIC PRIVATE KEY-----" });
  assert.throws(() => readTicketInteraction(JSON.stringify(inspect), { store, authenticate: () => caller }), (error: unknown) => error instanceof TicketInteractionError && error.code === "TICKET_INTERACTION_SENSITIVE" && !error.message.includes("SYNTHETIC"));
}));

test("selection rejects concurrent drift, oversized legacy metadata, duplicates and authority fields", () => fixture((store, caller, dir) => {
  const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "intake", project: "sample", ticket: caller.ticket };
  const raw = JSON.stringify(inspect);
  assert.throws(() => parseTicketIntakeOperation(raw.replace('"action":"inspect"', '"action":"inspect","action":"inspect"')), TicketInteractionError);
  let checks = 0;
  assert.throws(() => readTicketInteraction(raw, { store, authenticate: () => {
    if (++checks === 2) store.comment(caller.ticket!, "fixture", "Concurrent source change");
    return caller;
  } }), /TICKET_INTERACTION_STALE/);
  const current = store.get(caller.ticket!)!;
  writeFileSync(join(dir, `${caller.ticket}.json`), JSON.stringify({ ...current, title: "x".repeat(1025) }));
  assert.throws(() => readTicketInteraction(raw, { store, authenticate: () => caller }), /TICKET_INTERACTION_SELECTION/);
  for (const code of ["TICKET_INTERACTION_SELECTION", "TICKET_INTERACTION_STALE"] as const) {
    const error = new TicketInteractionError(code); assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
  }
}));

test("native scalar planning binds inspected caller and owner snapshot, preserves arrays and replays original intent", () => fixture((store, caller) => {
  const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "intake", project: "sample", ticket: caller.ticket! };
  let ownerChecks = 0;
  const owner = { store, authenticate: () => ({ ...caller }), assertPlanningOwner: () => { ownerChecks++; } };
  const selection = readTicketInteraction(JSON.stringify(inspect), owner);
  const packet = { ...inspect, action: "patch-planning", requestId: "planning-1", expectedVersion: selection.version,
    expectedSnapshotVersion: selection.snapshotVersion, patch: { title: "Updated scoped plan", priority: "high" } };
  const before = store.get(caller.ticket!)!, result = patchTicketPlanningInteraction(JSON.stringify(packet), owner);
  assert.equal(result.action, "patch-planning"); assert.equal(result.reusedIntent, false); assert.equal(result.primaryTicket, caller.ticket);
  assert.equal(result.ticket.id, caller.ticket); assert.match(result.appliedVersion, /^[a-f0-9]{64}$/); assert.ok(ownerChecks >= 2);
  const after = store.get(caller.ticket!)!;
  assert.equal(after.title, packet.patch.title); assert.deepEqual(after.tags, before.tags); assert.deepEqual(after.comments, before.comments);
  assert.equal(store.readAudit().at(-1)!.actor, "requirements/analyze");
  store.comment(caller.ticket!, "fixture", "Later ordinary work must survive completed replay");
  const audit = store.readAudit();
  assert.equal(patchTicketPlanningInteraction(JSON.stringify(packet), owner).reusedIntent, true);
  assert.deepEqual(store.readAudit(), audit); assert.equal(store.get(caller.ticket!)!.comments.length, 1);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify({ ...packet, patch: { title: "Changed request" } }), owner), /TICKET_PLAN_CONFLICT/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify({ ...packet, requestId: "stale-new-id" }), owner), /TICKET_PLAN_STALE/);
}));

test("native planning response loss reconciles original caller-bound versions at each owner boundary", () => {
  for (const stop of ["intent", "ticket", "audit"] as const) fixture((store, caller) => {
    const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "intake", project: "sample", ticket: caller.ticket! };
    const owner = { store, authenticate: () => ({ ...caller }), assertPlanningOwner: () => {} };
    const selection = readTicketInteraction(JSON.stringify(inspect), owner);
    const packet = { ...inspect, action: "patch-planning", requestId: "recover-native", expectedVersion: selection.version,
      expectedSnapshotVersion: selection.snapshotVersion, patch: { summary: "One original planning effect" } };
    const original = store.patchPlanningWithIntent.bind(store);
    store.patchPlanningWithIntent = (id, version, patch, actor, identity, hooks) => original(id, version, patch, actor, identity,
      { ...hooks, afterPersist(stage) { if (stage === stop) throw Error("source fixture response loss"); } });
    assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet), owner), /source fixture response loss/);
    store.patchPlanningWithIntent = original;
    assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet), { ...owner, authenticate: () => ({ ...caller, identitySha256: "d".repeat(64) }) }), /TICKET_INTERACTION_STALE/);
    const result = patchTicketPlanningInteraction(JSON.stringify(packet), owner);
    assert.equal(result.reusedIntent, true); assert.equal(store.get(caller.ticket!)!.summary, packet.patch.summary);
    assert.equal(store.readAudit().filter(row => row.action === "updated").length, 1);
  });
});

test("planning rejects forged fields, caller/version/project and retained owners before intent or ticket effects", () => fixture((store, caller, dir) => {
  const inspect = { schemaVersion: "pa-ticket-intake/v1", action: "inspect", kind: "intake", project: "sample", ticket: caller.ticket! };
  const selection = readTicketInteraction(JSON.stringify(inspect), { store, authenticate: () => caller });
  const packet = { ...inspect, action: "patch-planning", requestId: "invalid-plan", expectedVersion: selection.version,
    expectedSnapshotVersion: selection.snapshotVersion, patch: { summary: "New planning content" } };
  const owner = { store, authenticate: () => ({ ...caller }), assertPlanningOwner: () => {} };
  const before = readFileSync(join(dir, `${caller.ticket}.json`), "utf8"), audit = store.readAudit();
  for (const extra of [{ actor: "sinh" }, { status: "done" }, { approval: true }, { patch: { tags: [] } }, { patch: {} }, { patch: { title: "é".repeat(513) } }])
    assert.throws(() => patchTicketPlanningInteraction(JSON.stringify({ ...packet, ...extra }), owner), /TICKET_/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet).replace('"summary":"New planning content"', '"summary":"New planning content","summary":"Other"'), owner), /TICKET_INTERACTION_INPUT/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify({ ...packet, expectedVersion: "b".repeat(64) }), owner), /TICKET_INTERACTION_STALE/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet), { ...owner, authenticate: () => ({ ...caller, identitySha256: "b".repeat(64) }) }), /TICKET_INTERACTION_STALE/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify({ ...packet, project: "other" }), owner), /TICKET_INTERACTION_PROJECT/);
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet), { ...owner, assertPlanningOwner: () => { throw new TicketInteractionError("TICKET_INTERACTION_OWNER"); } }), /TICKET_INTERACTION_OWNER/);
  assert.equal(readFileSync(join(dir, `${caller.ticket}.json`), "utf8"), before); assert.deepEqual(store.readAudit(), audit);
  let checks = 0;
  assert.throws(() => patchTicketPlanningInteraction(JSON.stringify(packet), { ...owner, authenticate: () => ++checks === 1 ? caller : { ...caller, identitySha256: "c".repeat(64) } }), /TICKET_INTERACTION_SESSION/);
  assert.equal(readFileSync(join(dir, `${caller.ticket}.json`), "utf8"), before);
}));

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
  for (const code of ["TICKET_INTERACTION_INPUT", "TICKET_INTERACTION_SESSION", "TICKET_INTERACTION_PROJECT", "TICKET_INTERACTION_SENSITIVE", "TICKET_INTERACTION_UNCERTAIN", "TICKET_INTERACTION_OWNER"] as const) {
    const error = new TicketInteractionError(code); assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
    assert.match(error.message, /Impact:/); assert.match(error.message, /Actor:/); assert.match(error.message, /New approval:/); assert.match(error.message, /Prerequisite:/);
  }
}));
