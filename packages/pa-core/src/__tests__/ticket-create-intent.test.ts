import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { TicketCreateIntentError } from "../tickets/create-intent.js";
import type { CreateTicketInput } from "../tickets/types.js";

const input: CreateTicketInput = { project: "sample", title: "Explicit requested companion", summary: "Summary", description: "Description", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] };
const intent = { scope: "a".repeat(64), requestId: "request-1" };
const actor = "requirements/analyst";
function fixture(run: (store: TicketStore, dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-create-intent-"));
  const env = process.env;
  process.env = { ...env, PA_PLATFORM_CONFIG: join(root, "config"), PA_AI_USAGE_HOME: root };
  delete process.env.PA_DEPLOYMENT_ID;
  mkdirSync(process.env.PA_PLATFORM_CONFIG!, { recursive: true });
  writeFileSync(join(process.env.PA_PLATFORM_CONFIG!, "repos.yaml"), "repos:\n  sample:\n    path: /tmp/sample\n    prefix: SMP\n");
  const dir = join(root, "tickets");
  try { run(new TicketStore(dir), dir); } finally { process.env = env; rmSync(root, { recursive: true, force: true }); }
}

test("creation-owner diagnostics are bounded, static and preserve possible partial effects", () => {
  for (const code of ["TICKET_CREATE_INPUT", "TICKET_CREATE_CONFLICT", "TICKET_CREATE_UNCERTAIN"] as const) {
    const error = new TicketCreateIntentError(code);
    assert.equal(error.code, code);
    assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length - 1, 1);
    assert.match(error.message, /Impact: read-only/);
    assert.match(error.message, /Actor: agent or operator/);
    assert.match(error.message, /admission again/);
  }
  assert.match(new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN").message, /may be partial/);
});

test("ticket owner persists one same-intent creation and one audit across response loss and later changes", () => fixture((store, dir) => {
  let checks = 0;
  const first = store.createWithIntent(input, actor, intent, { assertCurrent: () => { checks++; } });
  assert.equal(first.ticket.id, "SMP-001");
  assert.equal(first.reused, false);
  const again = new TicketStore(dir).createWithIntent({ ...input }, actor, intent, { assertCurrent: () => { checks++; } });
  assert.equal(again.ticket.id, first.ticket.id);
  assert.equal(again.reused, true);
  assert.equal(store.readAudit().filter(row => row.action === "created").length, 1);
  store.update(first.ticket.id, { title: "Legitimate later edit", tags: ["progress"] }, actor);
  assert.equal(store.createWithIntent(input, actor, intent, { assertCurrent() {} }).ticket.title, "Legitimate later edit");
  assert.equal(store.list().length, 1);
  assert.ok(checks >= 2);
  assert.throws(() => store.createWithIntent({ ...input, title: "changed payload" }, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_CONFLICT/);
  assert.throws(() => store.createWithIntent(input, "sinh", intent, { assertCurrent() {} }), /TICKET_CREATE_CONFLICT/);
}));

test("intent is durable before counter/ticket/audit effects and reservation survives interruption", () => {
  for (const stage of ["intent", "ticket", "audit"] as const) fixture((store, dir) => {
    assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {}, afterPersist(observed) { if (observed === stage) throw new Error("fixture interruption"); } }), /fixture interruption/);
    const records = readdirSync(dir).filter(name => name.startsWith(".ticket-create-"));
    assert.equal(records.length, 1);
    const saved = JSON.parse(readFileSync(join(dir, records[0]!), "utf8"));
    assert.equal(saved.ticket.id, "SMP-001");
    if (stage === "intent") {
      assert.equal(store.list().length, 0);
      assert.equal(store.readAudit().length, 0);
      assert.ok(!readdirSync(dir).includes("counter.json"));
    }
    // Ordinary legacy writers share the mutex and must not consume a reserved ID.
    const other = store.create({ ...input, title: "Unrelated ordinary ticket" }, actor);
    assert.equal(other.id, "SMP-002");
    const resumed = new TicketStore(dir).createWithIntent(input, actor, intent, { assertCurrent() {} });
    assert.equal(resumed.ticket.id, "SMP-001");
    assert.equal(resumed.reused, true);
    assert.equal(store.list().length, 2);
    assert.equal(store.readAudit().filter(row => row.ticket_id === "SMP-001" && row.action === "created").length, 1);
  });
});

test("stale caller, malformed identity and unknown persisted state reject without replacement effects", () => fixture((store, dir) => {
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() { throw new Error("stale"); } }), /stale/);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent: async () => {} }), /TICKET_CREATE_INPUT/);
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent: async () => { throw new Error("untrusted asynchronous owner failure"); } }), /TICKET_CREATE_INPUT/);
  assert.equal(readdirSync(dir).filter(name => name.startsWith(".ticket-create-")).length, 0);
  assert.throws(() => store.createWithIntent(input, actor, { ...intent, requestId: "../escape" }, { assertCurrent() {} }), /TICKET_CREATE_INPUT/);
  assert.equal(store.list().length, 0);
  const forged = { ...intent, actor: "sinh" };
  assert.throws(() => store.createWithIntent(input, actor, forged, { assertCurrent() {} }), /TICKET_CREATE_INPUT/);
  assert.equal(readdirSync(dir).filter(name => name.startsWith(".ticket-create-")).length, 0);
  store.createWithIntent(input, actor, intent, { assertCurrent() {} });
  const record = readdirSync(dir).find(name => name.startsWith(".ticket-create-"))!;
  const saved = readFileSync(join(dir, record), "utf8");
  writeFileSync(join(dir, record), "{broken");
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.throws(() => store.create(input, actor), /TICKET_CREATE_UNCERTAIN/);
  writeFileSync(join(dir, record), saved);
  unlinkSync(join(dir, "SMP-001.json"));
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.equal(store.list().length, 0, "deleted ticket is never silently recreated from an intent");
}));

test("unsafe intent paths are preserved, never normalized into success", () => fixture((store, dir) => {
  store.createWithIntent(input, actor, intent, { assertCurrent() {} });
  const record = readdirSync(dir).find(name => name.startsWith(".ticket-create-"))!;
  const content = readFileSync(join(dir, record), "utf8");
  unlinkSync(join(dir, record));
  const foreign = join(dir, "foreign.txt");
  writeFileSync(foreign, content);
  symlinkSync(foreign, join(dir, record));
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.equal(readFileSync(foreign, "utf8"), content);
}));


test("concurrent owner processes share reservation and audit identity", async () => {
  for (const conflicting of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "pa-create-race-"));
    const config = join(root, "config"), dir = join(root, "tickets");
    mkdirSync(config);
    writeFileSync(join(config, "repos.yaml"), "repos:\n  sample:\n    path: /tmp/sample\n    prefix: SMP\n");
    const env = { ...process.env, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root };
    delete env.PA_DEPLOYMENT_ID;
    const script = `import { TicketStore } from ${JSON.stringify(fileURLToPath(new URL("../tickets/store.ts", import.meta.url)))};
      try { const result = new TicketStore(process.argv[1]).createWithIntent(JSON.parse(process.argv[2]), "requirements/analyst", JSON.parse(process.argv[3]), { assertCurrent() {} }); console.log(JSON.stringify(result)); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const launch = (value: CreateTicketInput) => new Promise<{ exit: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, dir, JSON.stringify(value), JSON.stringify(intent)],
        { env, timeout: 15000, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ exit: error ? 1 : 0, stdout, stderr }));
    });
    try {
      const results = await Promise.all([launch(input), launch(conflicting ? { ...input, title: "Conflicting payload" } : input)]);
      const store = new TicketStore(dir);
      assert.equal(store.list().length, 1);
      assert.equal(store.readAudit().filter(row => row.action === "created").length, 1);
      if (conflicting) {
        assert.equal(results.filter(row => row.exit === 0).length, 1);
        assert.match(results.find(row => row.exit !== 0)!.stderr, /TICKET_CREATE_CONFLICT/);
      } else {
        assert.deepEqual(results.map(row => row.exit), [0, 0]);
        assert.deepEqual(results.map(row => JSON.parse(row.stdout).reused).sort(), [false, true]);
        assert.equal(JSON.parse(results[0]!.stdout).ticket.id, JSON.parse(results[1]!.stdout).ticket.id);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("candidate checksum and torn audit failures preserve original intent without a new allocation", () => fixture((store, dir) => {
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {}, afterPersist(stage) { if (stage === "intent") throw new Error("interrupt"); } }), /interrupt/);
  const record = readdirSync(dir).find(name => name.startsWith(".ticket-create-"))!;
  const saved = readFileSync(join(dir, record), "utf8");
  const changed = JSON.parse(saved); changed.ticket.title = "Corrupt candidate";
  writeFileSync(join(dir, record), JSON.stringify(changed));
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.equal(store.list().length, 0);
  writeFileSync(join(dir, record), saved);
  writeFileSync(join(dir, "audit.jsonl"), '{"ticket_id":');
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.equal(store.list().length, 0);
  assert.equal(readdirSync(dir).filter(name => name.startsWith(".ticket-create-")).length, 1);
}));


test("counter and audit aliases cannot redirect owner reads or writes", () => {
  for (const name of ["counter.json", "audit.jsonl"]) fixture((store, dir) => {
    const foreign = join(dir, "foreign.txt"), content = name === "counter.json" ? '{"SMP":7}' : '';
    writeFileSync(foreign, content);
    symlinkSync(foreign, join(dir, name));
    assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
    assert.equal(readFileSync(foreign, "utf8"), content);
    assert.equal(store.list().length, 0);
  });
});


test("a mismatched creation audit is unknown, not a successful replay", () => fixture((store, dir) => {
  store.createWithIntent(input, actor, intent, { assertCurrent() {} });
  const audit = store.readAudit()[0]!;
  audit.changes.status = ["", "done"];
  const changed = JSON.stringify(audit) + "\n";
  writeFileSync(join(dir, "audit.jsonl"), changed);
  assert.throws(() => store.createWithIntent(input, actor, intent, { assertCurrent() {} }), /TICKET_CREATE_UNCERTAIN/);
  assert.equal(readFileSync(join(dir, "audit.jsonl"), "utf8"), changed);
  assert.equal(store.list().length, 1);
}));
