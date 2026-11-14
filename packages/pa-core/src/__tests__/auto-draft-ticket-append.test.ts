import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { AutoDraftTicketAppendError, autoDraftTicketVersion, autoDraftAppendKey, type AutoDraftTicketAppend, type AutoDraftTicketAppendHooks } from "../tickets/auto-draft-append.js";
import { digest } from "../workflows/contracts.js";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup(); try { run(f); } finally { f.close(); }
}
function setup() {
  const env = process.env, root = mkdtempSync(join(tmpdir(), "pap302-draft-append-")), cfg = join(root, "config"), dir = join(root, "tickets");
  mkdirSync(cfg); writeFileSync(join(cfg, "repos.yaml"), `repos:\n pa-platform:\n  path: ${root}/repo\n  prefix: PAP\n pa-platform-config:\n  path: ${root}/config\n  prefix: PAPC\n`);
  process.env = { ...env, PA_PLATFORM_CONFIG: cfg, PA_AI_USAGE_HOME: root }; delete process.env.PA_DEPLOYMENT_ID;
  const store = new TicketStore(dir), before = store.create({ project: "pa-platform", title: "Human title", summary: "Human summary", description: "Human description", status: "idea", priority: "high", type: "feature", assignee: "sinh", estimate: "L", from: "human", to: "", tags: ["preserve"], blockedBy: ["PAP-999"],
    doc_refs: [{ type: "requirements", path: "old-approved.md", primary: true, addedAt: "2026-11-14T00:00:00.000Z", addedBy: "human" }], comments: [{ id: "c-human", author: "sinh", content: "Human history", timestamp: "2026-11-14T00:00:00.000Z" }] });
  const input: AutoDraftTicketAppend = { schemaVersion: "pa-auto-draft-ticket-append/v1", ticket: before.id, project: "pa-platform", itemId: "auto-11111111-2222-3333-4444-555555555555", generation: 1, deploymentId: "d-a1b2c3", requestId: "operation-11111111-2222-3333-4444-555555555555", expectedVersion: autoDraftTicketVersion(before),
    artifacts: (["brief", "requirements", "uat"] as const).map(role => {
      const path = `agent-teams/requirements/artifacts/drafts/d-a1b2c3/${role}.md`, body = `Agent-authored UNAPPROVED draft.\n# ${role}\nSynthetic finite document; UAT not run.\n`;
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); return { role, path, sha256: digest(body) };
    }), comment: "Own unsigned draft documents are ready for their owning review flow." };
  let generation = 1;
  const hooks: AutoDraftTicketAppendHooks = { assertCurrent(request) {
    if (request.itemId !== input.itemId || request.generation !== generation || request.deploymentId !== input.deploymentId || request.ticket !== before.id) throw new Error("native generation/caller fence");
  }, assertArtifacts(request) {
    for (const artifact of request.artifacts) if (digest(readFileSync(join(root, artifact.path))) !== artifact.sha256) throw new Error("native artifact evidence changed");
  } };
  return { root, dir, store, before, input, hooks, setGeneration(n: number) { generation = n; }, close() { process.env = env; rmSync(root, { recursive: true, force: true }); } };
}

test("append-only ticket owner adds its own unsigned nonprimary evidence once and preserves every protected field/history", () => fixture(f => {
  const result = f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks);
  assert.equal(result.reused, false); assert.equal(result.ticket.doc_refs.length, 4); assert.equal(result.ticket.comments.length, 2);
  assert.deepEqual(result.ticket.doc_refs[0], f.before.doc_refs[0]); assert.deepEqual(result.ticket.comments[0], f.before.comments[0]);
  for (const ref of result.ticket.doc_refs.slice(1)) { assert.equal(ref.primary, false); assert.equal(ref.addedBy, "requirements/auto-draft"); }
  assert.match(result.ticket.comments[1]!.content, /^Agent-authored UNAPPROVED/);
  const { doc_refs: _d, comments: _c, updatedAt: _u, ...protectedAfter } = result.ticket;
  const { doc_refs: _bd, comments: _bc, updatedAt: _bu, ...protectedBefore } = f.before;
  assert.deepEqual(protectedAfter, protectedBefore); assert.deepEqual(f.store.pendingAutoDraftAppends(f.before.id), []);
  assert.equal(f.store.readAudit().length, 2);
  f.store.comment(f.before.id, "sinh", "Later human changes must remain.");
  const later = f.store.get(f.before.id)!;
  const replay = f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks);
  assert.equal(replay.reused, true); assert.equal(replay.appliedVersion, result.appliedVersion); assert.deepEqual(replay.ticket, later); assert.equal(f.store.readAudit().length, 3);
}));

test("original intent/ticket/audit interruption recovers once without duplicate refs, comments, audit or approvals", () => {
  for (const stop of ["intent", "ticket", "audit"] as const) fixture(f => {
    assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, afterPersist(stage) { if (stage === stop) throw new Error("original reply lost"); } }), /original reply lost/);
    assert.equal(f.store.pendingAutoDraftAppends(f.before.id).length, stop === "audit" ? 0 : 1);
    const result = f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks);
    assert.equal(result.reused, true); assert.equal(result.ticket.doc_refs.length, 4); assert.equal(result.ticket.comments.length, 2); assert.equal(f.store.readAudit().length, 2);
    assert.equal(readdirSync(f.dir).filter(n => n.startsWith(".ticket-auto-draft-")).length, 1);
  });
});

test("stale native snapshot, changed same request and a fresh-ID bypass cannot replace partial append evidence", () => fixture(f => {
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, afterPersist(stage) { if (stage === "intent") throw new Error("stop"); } }));
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded({ ...f.input, comment: "Changed original payload" }), f.hooks), /TICKET_APPEND_CONFLICT/);
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded({ ...f.input, requestId: "operation-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }), f.hooks), /TICKET_APPEND_UNCERTAIN/);
  f.store.update(f.before.id, { title: "Concurrent human clarification" }, "sinh");
  const preserved = readFileSync(join(f.dir, `${f.before.id}.json`));
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /TICKET_APPEND_UNCERTAIN/);
  assert.deepEqual(readFileSync(join(f.dir, `${f.before.id}.json`)), preserved); assert.equal(f.store.pendingAutoDraftAppends(f.before.id).length, 1);
}));

test("a new request with a proven stale precondition writes no append intent", () => fixture(f => {
  f.store.comment(f.before.id, "sinh", "Human changed the ticket before append.");
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /TICKET_APPEND_STALE/);
  assert.equal(readdirSync(f.dir).some(n => n.startsWith(".ticket-auto-draft-")), false);
}));

test("strict append schema rejects planning/lifecycle/primary/actor imports, foreign artifacts and malformed bytes", () => fixture(f => {
  const original = readFileSync(join(f.dir, `${f.before.id}.json`));
  for (const patch of [{ title: "overwrite" }, { status: "done" }, { assignee: "builder/team-manager" }, { doc_refs: [] }, { actor: "sinh" }, { approved: true }, { primary: true }, { generation: 0 }, { project: "other" }, { comment: "private-sentinel\n" }])
    assert.throws(() => f.store.appendAutoDraftWithIntent(encoded({ ...f.input, ...patch }), f.hooks), AutoDraftTicketAppendError);
  for (const artifacts of [[{ ...f.input.artifacts[0], primary: true }], [{ ...f.input.artifacts[0], path: "agent-teams/requirements/artifacts/drafts/d-ffffff/brief.md" }], [f.input.artifacts[0], f.input.artifacts[0]], []])
    assert.throws(() => f.store.appendAutoDraftWithIntent(encoded({ ...f.input, artifacts }), f.hooks), AutoDraftTicketAppendError);
  for (const raw of [Buffer.from('{"ticket":"PAP-1","ticket":"PAP-2"}'), Buffer.from([0xff]), Buffer.alloc(65_537, 32)]) assert.throws(() => f.store.appendAutoDraftWithIntent(raw, f.hooks), AutoDraftTicketAppendError);
  assert.deepEqual(readFileSync(join(f.dir, `${f.before.id}.json`)), original); assert.equal(f.store.readAudit().length, 1);
}));

test("native current-generation and own-artifact checks are mandatory, synchronous, repeated and cannot mutate request data", () => fixture(f => {
  const before = readFileSync(join(f.dir, `${f.before.id}.json`));
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { assertCurrent() {} } as any), /TICKET_APPEND_INPUT/);
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, assertCurrent: (() => Promise.resolve()) as any }), /TICKET_APPEND_INPUT/);
  f.setGeneration(2); assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /generation\/caller fence/); f.setGeneration(1);
  writeFileSync(join(f.root, f.input.artifacts[0]!.path), "Foreign changed artifact");
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /artifact evidence changed/);
  assert.deepEqual(readFileSync(join(f.dir, `${f.before.id}.json`)), before);
}));

test("trusted callback mutation cannot rewrite the original append candidate or artifact identities", () => fixture(f => {
  let checks = 0;
  const result = f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, assertCurrent(request) {
    f.hooks.assertCurrent(request); checks++;
    (request as any).comment = "forged callback mutation";
    (request.artifacts[0] as any).path = "foreign.md";
  } });
  assert.ok(checks >= 4); assert.match(result.ticket.comments.at(-1)!.content, /Own unsigned draft documents/);
  assert.doesNotMatch(result.ticket.comments.at(-1)!.content, /forged/); assert.equal(result.ticket.doc_refs[1]!.path, f.input.artifacts[0]!.path);
}));

test("generation revocation between intent and ticket blocks late appends and retains unresolved native intent", () => fixture(f => {
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, afterPersist(stage) { if (stage === "intent") f.setGeneration(2); } }), /generation\/caller fence/);
  assert.deepEqual(f.store.get(f.before.id), f.before); assert.equal(f.store.pendingAutoDraftAppends(f.before.id).length, 1);
  assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /generation\/caller fence/);
}));

test("unknown extra ticket fields, malformed intent/audit and source aliases refuse rather than normalize or clear evidence", () => {
  for (const kind of ["extra-field", "hardlink", "symlink", "intent", "audit", "unknown-marker"] as const) fixture(f => {
    const ticketPath = join(f.dir, `${f.before.id}.json`), original = readFileSync(ticketPath);
    if (kind === "extra-field") writeFileSync(ticketPath, JSON.stringify({ ...f.before, foreignFutureField: "preserve" }));
    if (kind === "hardlink") linkSync(ticketPath, join(f.root, "foreign-ticket-copy.json"));
    if (kind === "symlink") { rmSync(ticketPath); writeFileSync(join(f.root, "foreign.json"), original); symlinkSync(join(f.root, "foreign.json"), ticketPath); }
    if (["intent", "audit"].includes(kind)) {
      assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), { ...f.hooks, afterPersist(stage) { if (stage === "intent") throw new Error("stop"); } }));
      if (kind === "intent") writeFileSync(join(f.dir, `.ticket-auto-draft-${autoDraftAppendKey(f.input)}.json`), "{}");
      else writeFileSync(join(f.dir, "audit.jsonl"), '{"torn":');
    }
    if (kind === "unknown-marker") writeFileSync(join(f.dir, ".ticket-auto-draft-unknown.json"), "{}");
    const preserved = readFileSync(ticketPath);
    assert.throws(() => f.store.appendAutoDraftWithIntent(encoded(f.input), f.hooks), /TICKET_APPEND_UNCERTAIN/);
    assert.deepEqual(readFileSync(ticketPath), preserved);
  });
});

test("two real native append owner processes racing one original request produce one audit/comment/ref set", async () => {
  const f = setup();
  try {
    const script = new URL("./fixtures/auto-draft-append-worker.mts", import.meta.url), inputPath = join(f.root, "request.json"); writeFileSync(inputPath, encoded(f.input));
    const start = () => new Promise<number>(resolve => execFile(process.execPath, ["--import=tsx", script.pathname, f.dir, inputPath], { env: process.env, timeout: 15_000 }, error => resolve(error ? 2 : 0)));
    assert.deepEqual(await Promise.all([start(), start()]), [0, 0]);
    const ticket = f.store.get(f.before.id)!; assert.equal(ticket.doc_refs.length, 4); assert.equal(ticket.comments.length, 2); assert.equal(f.store.readAudit().length, 2);
  } finally { f.close(); }
});
