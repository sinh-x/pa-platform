import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TicketStore } from "../tickets/store.js";
import { ticketPlanningVersion, TicketPlanningIntentError } from "../tickets/planning-intent.js";

function fixture(run: (store: TicketStore, id: string, dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ticket-planning-")), env = process.env;
  process.env = { ...env, PA_PLATFORM_CONFIG: join(root, "config"), PA_AI_USAGE_HOME: root };
  delete process.env.PA_DEPLOYMENT_ID;
  mkdirSync(process.env.PA_PLATFORM_CONFIG!);
  writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "repos.yaml"), "repos:\n sample:\n  path: /tmp/sample\n  prefix: SMP\n");
  const dir = join(root, "tickets"), store = new TicketStore(dir);
  const ticket = store.create({ project: "sample", title: "Original", summary: "", description: "", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: ["preserved"], blockedBy: [], doc_refs: [], comments: [] });
  try { run(store, ticket.id, dir); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}
const identity = { scope: "a".repeat(64), requestId: "original-plan" };
const current = { assertCurrent() {} };

test("finite planning owner CAS persists one result/audit and replays without overwriting later work", () => fixture((store, id) => {
  const before = store.get(id)!, version = ticketPlanningVersion(before);
  const result = store.patchPlanningWithIntent(id, version, { title: "Requested plan", priority: "high" }, "requirements/analyze", identity, current);
  assert.equal(result.reused, false); assert.equal(result.ticket.title, "Requested plan");
  assert.deepEqual(result.ticket.tags, before.tags); assert.deepEqual(result.ticket.comments, before.comments);
  assert.equal(result.appliedVersion, ticketPlanningVersion(result.ticket));
  const audits = store.readAudit(); assert.equal(audits.length, 2);
  store.comment(id, "fixture", "Later additive work");
  const changed = store.get(id)!;
  const replay = store.patchPlanningWithIntent(id, version, { priority: "high", title: "Requested plan" }, "requirements/analyze", identity, current);
  assert.equal(replay.reused, true); assert.deepEqual(replay.ticket, changed); assert.equal(replay.appliedVersion, result.appliedVersion);
  assert.equal(store.readAudit().length, 3);
  assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Different payload" }, "requirements/analyze", identity, current), /TICKET_PLAN_CONFLICT/);
  assert.throws(() => store.patchPlanningWithIntent(id, version, { summary: "Stale competing update" }, "requirements/analyze", { ...identity, requestId: "different" }, current), /TICKET_PLAN_STALE/);
}));

test("interrupted intent/ticket/audit stages recover original request with one update and no duplicates", () => {
  for (const stop of ["intent", "ticket", "audit"] as const) fixture((store, id, dir) => {
    const version = ticketPlanningVersion(store.get(id)!);
    assert.throws(() => store.patchPlanningWithIntent(id, version, { summary: "Recover this" }, "requirements/analyze", identity, { ...current, afterPersist(stage) { if (stage === stop) throw Error("simulated reply loss"); } }), /simulated reply loss/);
    assert.equal(readdirSync(dir).filter(name => name.startsWith(".ticket-plan-")).length, 1);
    const result = store.patchPlanningWithIntent(id, version, { summary: "Recover this" }, "requirements/analyze", identity, current);
    assert.equal(result.reused, true); assert.equal(result.ticket.summary, "Recover this"); assert.equal(store.readAudit().length, 2);
  });
});

test("unfinished same-target intent blocks a fresh identity and preserves intervening ordinary work", () => fixture((store, id, dir) => {
  const version = ticketPlanningVersion(store.get(id)!);
  assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, { ...current, afterPersist(stage) { if (stage === "ticket") throw Error("stop"); } }));
  const pending = store.get(id)!;
  assert.throws(() => store.patchPlanningWithIntent(id, ticketPlanningVersion(pending), { title: "Fresh ID bypass" }, "requirements/analyze", { ...identity, requestId: "replacement" }, current), /TICKET_PLAN_UNCERTAIN/);
  store.comment(id, "fixture", "Intervening work cannot be discarded");
  const preserved = readFileSync(join(dir, `${id}.json`), "utf8");
  assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, current), /TICKET_PLAN_UNCERTAIN/);
  assert.equal(readFileSync(join(dir, `${id}.json`), "utf8"), preserved);
}));

test("strict finite patches and synchronous admission reject before planning effects", () => fixture((store, id, dir) => {
  const version = ticketPlanningVersion(store.get(id)!), before = readdirSync(dir).sort();
  for (const patch of [{}, { status: "done" }, { assignee: "sinh" }, { tags: [] }, { blockedBy: [] }, { doc_refs: [] }, { title: "" }, { priority: "normal" }, { estimate: "XXL" }, { summary: "x".repeat(8193) }, { title: "\ud800" }])
    assert.throws(() => store.patchPlanningWithIntent(id, version, patch as any, "requirements/analyze", identity, current), TicketPlanningIntentError);
  assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Denied" }, "requirements/analyze", identity, { assertCurrent() { throw Error("not current"); } }), /not current/);
  assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Async" }, "requirements/analyze", identity, { assertCurrent: (() => Promise.resolve()) as any }), /TICKET_PLAN_INPUT/);
  assert.deepEqual(readdirSync(dir).sort(), before); assert.equal(store.readAudit().length, 1);
}));

test("claimed/active/terminal/approved and moved tickets cannot use the unclaimed planning primitive", () => fixture((store, id) => {
  const original = store.get(id)!;
  for (const change of [{ status: "implementing" }, { assignee: "builder/team-manager" }, { status: "done" }, { add_doc_ref: { type: "req", path: "approved.md", primary: true } }]) {
    const ticket = store.create({ ...original, ...change } as any);
    if ("add_doc_ref" in change) store.update(ticket.id, change);
    assert.throws(() => store.patchPlanningWithIntent(ticket.id, ticketPlanningVersion(store.get(ticket.id)!), { title: "Not admitted" }, "requirements/analyze", identity, current), /TICKET_PLAN_SCOPE/);
  }
  assert.throws(() => store.patchPlanningWithIntent("SMP-999", ticketPlanningVersion(original), { title: "Missing" }, "requirements/analyze", identity, current), /TICKET_PLAN_SCOPE/);
}));

test("corrupt intent, symlink and torn audit are unknown, never absent or successful", () => {
  for (const kind of ["corrupt", "alias", "audit"] as const) fixture((store, id, dir) => {
    const version = ticketPlanningVersion(store.get(id)!);
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, { ...current, afterPersist(stage) { if (stage === "intent") throw Error("stop"); } }));
    const file = readdirSync(dir).find(name => name.startsWith(".ticket-plan-"))!, path = join(dir, file);
    if (kind === "corrupt") writeFileSync(path, "{}");
    if (kind === "alias") { rmSync(path); symlinkSync(join(dir, `${id}.json`), path); }
    if (kind === "audit") writeFileSync(join(dir, "audit.jsonl"), '{"torn":');
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, current), /TICKET_PLAN_UNCERTAIN/);
    assert.equal(store.get(id)!.title, "Original");
  });
});

test("locked owner rechecks detect changed caller, policy, raw binding and persisted actor", () => {
  fixture((store, id) => {
    const version = ticketPlanningVersion(store.get(id)!); let calls = 0;
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Requested" }, "requirements/analyze", identity, { assertCurrent() { if (++calls === 2) throw Error("caller changed"); } }), /caller changed/);
    assert.equal(store.readAudit().length, 1); assert.equal(store.get(id)!.title, "Original");
    store.patchPlanningWithIntent(id, version, { title: "Requested" }, "requirements/analyze", identity, { ...current, requestBinding: "b".repeat(64) });
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Requested" }, "requirements/analyze", identity, { ...current, requestBinding: "c".repeat(64) }), /TICKET_PLAN_CONFLICT/);
  });
  fixture((store, id) => {
    const version = ticketPlanningVersion(store.get(id)!); let calls = 0;
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Requested" }, "requirements/analyze", identity, { assertCurrent() {
      if (++calls === 2) writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "sensitive-patterns.yaml"), "contents:\n - 'Requested'\n");
    } }), /TICKET_PLAN_INPUT/);
    assert.equal(store.readAudit().length, 1); assert.equal(store.get(id)!.title, "Original");
  });
  fixture((store, id, dir) => {
    const version = ticketPlanningVersion(store.get(id)!);
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, { ...current, afterPersist() { throw Error("stop"); } }));
    const path = join(dir, readdirSync(dir).find(name => name.startsWith(".ticket-plan-"))!);
    const row = JSON.parse(readFileSync(path, "utf8")); row.actor = "sinh"; writeFileSync(path, JSON.stringify(row));
    assert.throws(() => store.patchPlanningWithIntent(id, version, { title: "Partial" }, "requirements/analyze", identity, current), /TICKET_PLAN_CONFLICT/);
    assert.equal(store.readAudit().length, 1);
  });
});

test("real concurrent owners reconcile same intent and accept at most one competing CAS", async () => {
  for (const competing of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "planning-race-")), config = join(root, "config"), dir = join(root, "tickets"), saved = process.env;
    mkdirSync(config); writeFileSync(join(config, "repos.yaml"), "repos:\n sample:\n  path: /tmp/sample\n  prefix: SMP\n");
    const env = { ...saved, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root }; delete env.PA_DEPLOYMENT_ID;
    let id: string, version: string;
    try {
      process.env = env;
      const store = new TicketStore(dir), ticket = store.create({ project: "sample", title: "Original", summary: "", description: "", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] });
      id = ticket.id; version = ticketPlanningVersion(ticket);
    } finally { process.env = saved; }
    const script = `import { TicketStore } from ${JSON.stringify(fileURLToPath(new URL("../tickets/store.ts", import.meta.url)))};
      try { const result = new TicketStore(process.argv[1]).patchPlanningWithIntent(process.argv[2], process.argv[3], {title: process.argv[4]}, 'requirements/analyze', JSON.parse(process.argv[5]), {assertCurrent(){}}); console.log(JSON.stringify({reused:result.reused,version:result.appliedVersion})); }
      catch(error) { console.error(error.code); process.exitCode=1; }`;
    const launch = (other: boolean) => new Promise<{ exit: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, dir, id, version, other ? "Competing" : "Requested", JSON.stringify(other ? { ...identity, requestId: "competitor" } : identity)], { env, timeout: 15000, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ exit: error ? 1 : 0, stdout, stderr }));
    });
    try {
      const results = await Promise.all([launch(false), launch(competing)]);
      const store = new TicketStore(dir); assert.equal(store.readAudit().length, 2);
      if (competing) { assert.equal(results.filter(row => row.exit === 0).length, 1); assert.match(results.find(row => row.exit !== 0)!.stderr, /TICKET_PLAN_STALE/); }
      else { assert.deepEqual(results.map(row => row.exit), [0, 0]); assert.deepEqual(results.map(row => JSON.parse(row.stdout).reused).sort(), [false, true]); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("planning diagnostics stay bounded, outcome-first and static", () => {
  for (const code of ["TICKET_PLAN_INPUT", "TICKET_PLAN_CONFLICT", "TICKET_PLAN_STALE", "TICKET_PLAN_SCOPE", "TICKET_PLAN_UNCERTAIN"] as const) {
    const error = new TicketPlanningIntentError(code); assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
  }
});
