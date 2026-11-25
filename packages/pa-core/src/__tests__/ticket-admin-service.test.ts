import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../registry/index.js";
import { emitStartedEvent, emitPidEvent, emitCompletedEvent } from "../deploy/events.js";
import { getTicketsDir } from "../paths.js";
import { autoDraftTicketVersion, type AutoDraftTicketAppend } from "../tickets/auto-draft-append.js";
import { digest } from "../workflows/contracts.js";
import { TicketStore, resolveTrustedTicketMutationContext } from "../tickets/store.js";
import { ticketAdminService, parseTicketAdminRequest, TicketAdminError, type TicketAdminCaller } from "../tickets/admin-service.js";
import { statusVersion } from "../tickets/status-intent.js";
import { ticketStatusService } from "../tickets/status-service.js";
import { workflowRuntimeFixture } from "./workflow-runtime-fixture.js";
import { MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy } from "../mode-capabilities.js";

function fixture(run: (root: string, store: TicketStore, caller: TicketAdminCaller) => void): void {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "ticket-admin-service-")); closeDb();
  try {
    for (const key of Object.keys(process.env)) if (/^PA_/.test(key)) delete process.env[key];
    const config = join(root, "config"); mkdirSync(config);
    writeFileSync(join(config, "config.yaml"), `repos:\n selected:\n  path: ${root}\n  prefix: SEL\n other:\n  path: ${config}\n  prefix: OTH\n pa-platform:\n  path: ${root}\n  prefix: PAP\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    emitStartedEvent({ deploymentId: "d-334100", team: "builder", mode: "implement", runtime: "pi" });
    const caller = { deploymentId: "d-334100", team: "builder", mode: "implement", repoKey: "selected", identitySha256: "a".repeat(64) };
    run(root, new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false)), caller);
  } finally { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
test("generic owner: cross-project create/replay, field CAS, status replay and native actor audit", () => fixture((_root, store, caller) => {
  const call = (request: unknown) => ticketAdminService(JSON.stringify(request), { store, authenticate: () => caller });
  const request = { action: "create", project: "other", requestId: "original", fields: { title: "A; title", assignee: "sinh" } };
  const created = call(request); assert.equal(created.id, "OTH-001");
  assert.equal(store.get("OTH-001")!.title, "A title");
  assert.equal(call(request).reusedIntent, true);
  assert.throws(() => call({ ...request, fields: { ...request.fields, title: "A title" } }), /TICKET_CREATE_CONFLICT/, "raw input remains bound across lossy sanitization");
  const finiteCaller = { ...caller, profile: MODE_CAPABILITY_SESSION, capabilities: createModeCapabilityBinding("a".repeat(40), Buffer.from("disposable"),
    parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["ticket.status"] })) };
  const inspected = ticketStatusService(JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "other", ticket: created.id }),
    { store, authenticate: () => finiteCaller });
  assert.equal(inspected.project, "other", "retained finite status may inspect an exact different registered project");
  assert.equal(ticketStatusService(JSON.stringify({ schemaVersion: "pa-ticket-status/v1", action: "set", project: "other", ticket: created.id,
    requestId: "finite-crossproject", expectedVersion: inspected.version, status: "requirement-review" }), { store, authenticate: () => finiteCaller }).status, "requirement-review");
  const version = statusVersion(store.get("OTH-001")!);
  const changed = call({ action: "update", project: "other", id: created.id, expectedVersion: version,
    fields: { title: "Edited", summary: "Summary", description: "Description", priority: "critical", estimate: "XL", type: "bug", tags: ["admin"], blockedBy: ["SEL-001"], from: "fixture", to: "operator" } });
  assert.equal(store.get("OTH-001")!.estimate, "XL");
  const before = store.get("OTH-001"), audit = store.readAudit();
  assert.throws(() => call({ action: "update", project: "other", id: created.id, expectedVersion: version, fields: { summary: "Stale" } }), /TICKET_ADMIN_STALE/);
  assert.deepEqual(store.get("OTH-001"), before); assert.deepEqual(store.readAudit(), audit);
  const status = { action: "set-status", project: "other", id: created.id, expectedVersion: changed.version, requestId: "status", status: "implementing" };
  assert.equal(call(status).status, "implementing");
  assert.equal(call(status).reusedIntent, true);
  const comment = call({ action: "comment", project: "other", id: created.id, content: "Native comment" });
  assert.deepEqual(comment.comment, store.get("OTH-001")!.comments[0]);
  assert.equal(store.get("OTH-001")!.comments[0]!.author, "builder/implement");
  assert.equal(store.readAudit().filter(row => row.actor === "requirements/analyze").length, 1, "retained finite status keeps its effective actor");
  assert.ok(store.readAudit().filter(row => row.actor !== "requirements/analyze").every(row => row.actor === "builder/implement"));
  assert.equal(call({ action: "inspect", project: "other", id: created.id }).version, statusVersion(store.get("OTH-001")!));
}));
test("native administration fences unsettled creation and reauthenticates at the actual field write boundary", () => fixture((_root, store, caller) => {
  const input = { project: "other", title: "Original creation", summary: "", description: "", status: "idea" as const, priority: "medium" as const,
    type: "task" as const, estimate: "M" as const, assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] };
  const identity = { scope: "b".repeat(64), requestId: "original-creation" };
  assert.throws(() => store.createWithIntent(input, "builder/implement", identity, { assertCurrent() {}, afterPersist(stage) { if (stage === "ticket") throw new Error("Synthetic lost response"); } }), /lost response/);
  const ticket = store.get("OTH-001")!;
  const request = { action: "update", project: "other", id: ticket.id, expectedVersion: statusVersion(ticket), fields: { summary: "Not written" } };
  assert.throws(() => ticketAdminService(JSON.stringify(request), { store, authenticate: () => caller }), /TICKET_HANDOFF_UNCERTAIN/);
  assert.equal(store.createWithIntent(input, "builder/implement", identity, { assertCurrent() {} }).reused, true);
  const before = store.get(ticket.id), audit = store.readAudit(); let checks = 0;
  assert.throws(() => store.updateAdministrativeFields(ticket.id, statusVersion(ticket), { summary: "Not written" }, "builder/implement", () => {
    if (++checks === 2) throw new Error("Synthetic native revocation at final fence");
  }), /final fence/);
  assert.equal(checks, 2); assert.deepEqual(store.get(ticket.id), before); assert.deepEqual(store.readAudit(), audit);
}));
test("incomplete auto-draft appends fence every generic mutation after terminal owner exit, but original recovery remains available", () => {
  for (const stop of ["intent", "ticket"] as const) fixture((root, store, caller) => {
    const call = (request: unknown) => ticketAdminService(JSON.stringify(request), { store, authenticate: () => caller });
    const created = call({ action: "create", project: "pa-platform", requestId: "draft-target", fields: { title: "Own draft target" } });
    const id = String(created.id), before = store.get(id)!;
    const input: AutoDraftTicketAppend = { schemaVersion: "pa-auto-draft-ticket-append/v1", ticket: id, project: "pa-platform",
      itemId: "auto-11111111-2222-3333-4444-555555555555", generation: 1, deploymentId: "d-334101",
      requestId: "operation-11111111-2222-3333-4444-555555555555", expectedVersion: autoDraftTicketVersion(before),
      artifacts: (["brief", "requirements", "uat"] as const).map(role => {
        const path = `agent-teams/requirements/artifacts/drafts/d-334101/${role}.md`, content = `Unsigned ${role} draft.\n`;
        mkdirSync(join(root, "agent-teams/requirements/artifacts/drafts/d-334101"), { recursive: true });
        writeFileSync(join(root, path), content);
        return { role, path, sha256: digest(content) };
      }), comment: "Own unsigned evidence only" };
    const raw = Buffer.from(JSON.stringify(input));
    const hooks = { assertCurrent() {}, assertArtifacts() {
      for (const artifact of input.artifacts) assert.equal(digest(readFileSync(join(root, artifact.path))), artifact.sha256);
    } };
    emitStartedEvent({ deploymentId: input.deploymentId, team: "requirements", mode: "auto-draft", ticketId: id, runtime: "pi" });
    const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    assert.equal(existsSync(`/proc/${deadPid}`), false);
    emitPidEvent({ deploymentId: input.deploymentId, team: "requirements", pid: deadPid });
    assert.throws(() => store.appendAutoDraftWithIntent(raw, { ...hooks, afterPersist(stage) {
      if (stage === stop) throw Error("Original append interrupted");
    } }), /Original append interrupted/);
    emitCompletedEvent({ deploymentId: input.deploymentId, team: "requirements", status: "partial" });
    assert.equal(store.observeAutoDraftAppend(raw).state, stop);
    const current = store.get(id)!, audit = store.readAudit(), files = readdirSync(getTicketsDir()).sort();
    for (const request of [
      { action: "comment", project: "pa-platform", id, content: "Must not cross partial evidence" },
      { action: "update", project: "pa-platform", id, expectedVersion: statusVersion(current), fields: { summary: "Must not write" } },
      { action: "set-status", project: "pa-platform", id, expectedVersion: statusVersion(current), requestId: "blocked-status", status: "implementing" },
    ]) {
      assert.throws(() => call(request), /TICKET_HANDOFF_UNCERTAIN/);
      assert.deepEqual(store.get(id), current); assert.deepEqual(store.readAudit(), audit);
      assert.deepEqual(readdirSync(getTicketsDir()).sort(), files);
    }
    assert.equal(call({ action: "inspect", project: "pa-platform", id }).id, id, "inspection remains available");
    const recovered = store.appendAutoDraftWithIntent(raw, hooks);
    assert.equal(recovered.reused, true); assert.equal(recovered.ticket.doc_refs.length, 3); assert.equal(recovered.ticket.comments.length, 1);
    assert.equal(store.pendingAutoDraftAppends(id).length, 0); assert.equal(store.readAudit().length, 2);
    assert.equal(call({ action: "comment", project: "pa-platform", id, content: "Completed append is history" }).id, id);
    const updated = call({ action: "update", project: "pa-platform", id, expectedVersion: statusVersion(store.get(id)!), fields: { summary: "Later maintenance" } });
    assert.equal(call({ action: "set-status", project: "pa-platform", id, expectedVersion: updated.version, requestId: "settled-status", status: "review-uat" }).status, "review-uat");
    store.assertHandoffSettled(id);
    assert.deepEqual(store.appendAutoDraftWithIntent(raw, hooks).ticket, store.get(id), "audit completeness, not equality to an old snapshot, settles the append");
  });
});
test("comments validate final current auth/policy before any write, not between ticket and audit", () => fixture((root, store, caller) => {
  let current = caller;
  const call = (request: unknown) => ticketAdminService(JSON.stringify(request), { store, authenticate: () => current });
  const created = call({ action: "create", project: "other", requestId: "comment-target", fields: { title: "Retained comment candidate" } });
  const id = String(created.id), before = store.get(id), audit = store.readAudit(), policy = join(root, "config/sensitive-patterns.yaml");
  const comment = store.comment.bind(store);
  for (const revocation of ["auth", "policy"] as const) {
    store.comment = (ticket, author, content, check) => comment(ticket, author, content, candidate => {
      if (revocation === "auth") current = { ...caller, identitySha256: "b".repeat(64) };
      else writeFileSync(policy, "contents:\n - 'Retained comment candidate'\n");
      check?.(candidate);
    });
    assert.throws(() => call({ action: "comment", project: "other", id, content: "Safe new content" }),
      revocation === "auth" ? /TICKET_ADMIN_SESSION/ : /TICKET_ADMIN_INPUT/);
    assert.deepEqual(store.get(id), before); assert.deepEqual(store.readAudit(), audit);
    current = caller; writeFileSync(policy, "contents: []\n");
  }
  store.comment = comment;
  const get = store.get.bind(store);
  let postwrite = false;
  store.get = ticket => {
    const observed = get(ticket);
    if (!postwrite && observed?.comments.length === 1) {
      postwrite = true; current = { ...caller, identitySha256: "b".repeat(64) };
      writeFileSync(policy, "contents:\n - 'Retained comment candidate'\n");
    }
    return observed;
  };
  assert.equal(call({ action: "comment", project: "other", id, content: "Already admitted comment" }).id, id);
  assert.equal(postwrite, true); assert.equal(get(id)!.comments.length, 1);
  assert.equal(store.readAudit().at(-1)!.action, "commented", "postwrite revocation cannot strand an unaudited comment");
}));
test("comment postwrite failures restore ticket and audit together; unproven recovery stays uncertain", () => {
  for (const recovery of ["proven", "unknown"] as const) fixture((_root, store, caller) => {
    const call = (request: unknown) => ticketAdminService(JSON.stringify(request), { store, authenticate: () => caller });
    const created = call({ action: "create", project: "other", requestId: "comment-failure", fields: { title: "Safe" } });
    const id = String(created.id), path = join(getTicketsDir(), `${id}.json`), auditPath = join(getTicketsDir(), "audit.jsonl");
    const before = readFileSync(path), audit = readFileSync(auditPath), get = store.get.bind(store);
    let failed = false;
    const original = new Error("Synthetic postwrite readback interruption");
    store.get = ticket => {
      const observed = get(ticket);
      if (!failed && observed?.comments.length === 1) {
        failed = true;
        writeFileSync(auditPath, "{\"torn\":");
        throw original;
      }
      if (failed && recovery === "unknown") throw Error("Synthetic recovery verification failure");
      return observed;
    };
    assert.throws(() => call({ action: "comment", project: "other", id, content: "Must be recoverable" }),
      recovery === "proven" ? error => error === original : /TICKET_ADMIN_UNAVAILABLE/);
    assert.equal(failed, true); assert.deepEqual(readFileSync(path), before); assert.deepEqual(readFileSync(auditPath), audit);
    store.get = get;
    if (recovery === "proven") {
      call({ action: "comment", project: "other", id, content: "Safe after proven rollback" });
      assert.equal(get(id)!.comments.length, 1); assert.equal(store.readAudit().length, 2);
    }
  });
});
test("strict parser rejects unknown/duplicate/oversized/sensitive/privilege and protected fields", () => {
  const base = { action: "create", project: "other", requestId: "original", fields: { title: "Safe" } };
  for (const row of [ { ...base, actor: "sinh" }, { ...base, author: "sinh" }, { ...base, privileged: true }, { ...base, fields: { status: "done" } },
    { ...base, fields: { linkedBranches: [] } }, { ...base, fields: { doc_refs: [] } }, { ...base, fields: { title: "x".repeat(1025) } },
    { ...base, fields: { title: "Safe", type: ["feature"] } }, { ...base, fields: { title: "Safe", priority: "urgent" } }, { ...base, fields: { title: "Safe", description: "-----BEGIN PRIVATE KEY-----" } },
    { ...base, fields: { title: "\ud800" } }, { ...base, fields: { title: "Safe", tags: ["same", "same"] } },
    { ...base, fields: { title: "Safe", blockedBy: ["../unsafe"] } }, { ...base, fields: { title: "Safe", assignee: "unregistered/role" } } ]) {
    assert.throws(() => parseTicketAdminRequest(JSON.stringify(row)), /TICKET_ADMIN_INPUT/);
  }
  assert.throws(() => parseTicketAdminRequest('{"action":"create","action":"inspect"}'), /TICKET_ADMIN_INPUT/);
  assert.throws(() => parseTicketAdminRequest(" ".repeat(65537)), /TICKET_ADMIN_INPUT/);
  for (const code of ["TICKET_ADMIN_INPUT", "TICKET_ADMIN_SESSION", "TICKET_ADMIN_STALE", "TICKET_ADMIN_UNAVAILABLE"] as const) {
    const text = new TicketAdminError(code).message;
    assert.ok(text.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
  }
});
test("sensitive checks cover post-sanitization, validated defaults and exact candidates at effect-time policy changes", () => fixture((root, store, caller) => {
  const call = (r: unknown) => ticketAdminService(JSON.stringify(r), { store, authenticate: () => caller });
  const policy = join(root, "config/sensitive-patterns.yaml");
  for (const title of ["-----BEGIN PRIVATE; KEY-----", "-----BEGIN PRIVATE\u0001 KEY-----"]) {
    assert.throws(() => call({ action: "create", project: "other", requestId: "post-sanitization", fields: { title } }), /TICKET_ADMIN_INPUT/);
  }
  writeFileSync(policy, "contents:\n - '^sinh$'\n");
  assert.throws(() => call({ action: "create", project: "other", requestId: "default", fields: { title: "Safe" } }), /TICKET_ADMIN_INPUT/);
  writeFileSync(policy, "contents: []\n");
  const created = call({ action: "create", project: "other", requestId: "safe", fields: { title: "Retained candidate text" } });
  const before = store.get(String(created.id)), audit = store.readAudit();
  const comment = store.comment.bind(store);
  store.comment = (...args) => {
    writeFileSync(policy, "contents:\n - 'Retained candidate text'\n");
    return comment(...args);
  };
  assert.throws(() => call({ action: "comment", project: "other", id: created.id, content: "Safe new comment" }), /TICKET_ADMIN_INPUT/);
  assert.deepEqual(store.get(String(created.id)), before); assert.deepEqual(store.readAudit(), audit);
  writeFileSync(policy, "contents: []\n");
  let boundary = 0;
  assert.throws(() => store.updateAdministrativeFields(String(created.id), statusVersion(before!), { summary: "Safe patch" }, "builder/implement", () => {
    if (++boundary === 2) writeFileSync(policy, "contents:\n - 'Retained candidate text'\n");
  }), /TICKET_ADMIN_INPUT/);
  assert.deepEqual(store.get(String(created.id)), before); assert.deepEqual(store.readAudit(), audit);
  writeFileSync(policy, "contents: []\n");
  const status = store.setStatusWithIntent.bind(store);
  store.setStatusWithIntent = (id, version, value, actor, identity, hooks) => status(id, version, value, actor, identity, { ...hooks, afterPersist(stage) {
    if (stage === "intent") writeFileSync(policy, "contents:\n - 'Retained candidate text'\n");
  } });
  assert.throws(() => call({ action: "set-status", project: "other", id: created.id, expectedVersion: statusVersion(before!), status: "review-uat", requestId: "policy-status" }), /TICKET_ADMIN_INPUT/);
  assert.deepEqual(store.get(String(created.id)), before); assert.deepEqual(store.readAudit(), audit);
  writeFileSync(policy, "contents: []\n");
  const create = store.createWithIntent.bind(store);
  store.createWithIntent = (input, actor, identity, hooks) => create(input, actor, identity, { ...hooks, afterPersist(stage) {
    if (stage === "intent") writeFileSync(policy, "contents:\n - 'New candidate'\n");
  } });
  assert.throws(() => call({ action: "create", project: "other", requestId: "policy-change", fields: { title: "New candidate" } }), /TICKET_ADMIN_INPUT/);
  assert.equal(store.get("OTH-002"), undefined, "a changed policy blocks the reserved candidate before ticket/counter effects");
  assert.deepEqual(store.readAudit(), audit);
  assert.throws(() => call({ action: "create", project: "other", requestId: "policy-change", fields: { title: "New candidate" } }), /TICKET_ADMIN_INPUT/);
}));
test("retained workflow preparation and decision history do not block generic writes; its unresolved intent does", async () => {
  const previous = process.env, f = workflowRuntimeFixture();
  try {
    process.env = { ...previous, PA_AI_USAGE_HOME: f.root, PA_PLATFORM_CONFIG: join(f.root, "config"), PA_REGISTRY_DB: join(f.root, "registry.db") };
    mkdirSync(process.env.PA_PLATFORM_CONFIG!);
    writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "config.yaml"), `repos:\n example:\n  path: ${f.bundle.repository.root}\n  prefix: EX\n`);
    const store = new TicketStore(undefined, { privileged: true });
    writeFileSync(join(f.root, "tickets/EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Workflow history", status: "requirement-review", comments: [], doc_refs: [] }));
    const caller = { deploymentId: "d-334100", team: "review", mode: "verify", repoKey: "example", identitySha256: "a".repeat(64) };
    const call = (content: string) => ticketAdminService(JSON.stringify({ action: "comment", project: "example", id: "EX-1", content }), { store, authenticate: () => caller });
    const run = f.service.admit(f.selection, f.subject);
    assert.equal(call("An adopted workflow is not an effect owner").id, "EX-1");
    const decision = await f.service.decide(run.runId, run.revision, "approve");
    assert.equal(call("Approved history does not deny ticket maintenance").id, "EX-1");
    const version = statusVersion(store.get("EX-1")!);
    ticketAdminService(JSON.stringify({ action: "set-status", project: "example", id: "EX-1", requestId: "history-status", expectedVersion: version, status: "review-uat" }), { store, authenticate: () => caller });
    const owners = new Map(f.host.owners);
    owners.set("publication.pair", { admit() {}, observe: async () => ({ state: "absent" }), execute: async () => { throw Error("Synthetic unresolved publication"); }, verify: () => false });
    f.host.owners = owners;
    await assert.rejects(f.service.requestStep(run.runId, f.service.status(run.runId).revision, "publish", decision.decisionId), /unresolved publication/);
    assert.throws(() => call("Cannot cross the unresolved owner"), /TICKET_STATUS_OWNER/);
  } finally { process.env = previous; f.close(); }
});
test("authentication drift and competing native custody leave ticket and audit unchanged", () => fixture((_root, store, caller) => {
  const call = (r: unknown) => ticketAdminService(JSON.stringify(r), { store, authenticate: () => caller });
  const created = call({ action: "create", project: "other", requestId: "original", fields: { title: "Safe" } });
  const update = { action: "update", project: "other", id: created.id, expectedVersion: created.version, fields: { summary: "Not written" } };
  const before = store.get("OTH-001"), audits = store.readAudit(); let count = 0;
  assert.throws(() => ticketAdminService(JSON.stringify(update), { store, authenticate: () => ({ ...caller, identitySha256: (++count > 1 ? "b" : "a").repeat(64) }) }), /TICKET_ADMIN_SESSION/);
  assert.throws(() => ticketAdminService(JSON.stringify(update), { store, authenticate: () => { throw new Error("Synthetic unauthenticated"); } }), /unauthenticated/);
  assert.throws(() => call({ ...update, project: "missing" }), /TICKET_ADMIN_INPUT/);
  assert.throws(() => call({ ...update, project: "selected" }), /TICKET_ADMIN_INPUT/);
  emitStartedEvent({ deploymentId: "d-334101", team: "review", mode: "verify", ticketId: "OTH-001", runtime: "pi" });
  assert.throws(() => call(update), /TICKET_STATUS_OWNER/);
  assert.deepEqual(store.get("OTH-001"), before); assert.deepEqual(store.readAudit(), audits);
}));
