import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TicketStore } from "../tickets/store.js";
import { creationDigest } from "../tickets/create-intent.js";
import { handoffKey, readHandoffIntent, TicketHandoffError, type TicketHandoffChange } from "../tickets/handoff-intent.js";
import type { HandoffBranchIntent } from "../documents/handoff-contract.js";

const identity = { scope: "a".repeat(64), requestId: "original-plan" };
const actor = "requirements/analyze";
const hooks = { assertCurrent() {}, assertSnapshot() {} };
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const saved = process.env, f = setup();
  try { run(f); } finally { process.env = saved; rmSync(f.root, { recursive: true, force: true }); }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "handoff-ticket-")), config = join(root, "config"), repo = join(root, "repo"), dir = join(root, "tickets");
  mkdirSync(config); mkdirSync(repo);
  process.env = { ...process.env, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root }; delete process.env.PA_DEPLOYMENT_ID;
  writeFileSync(join(config, "repos.yaml"), `repos:\n sample:\n  path: ${repo}\n  prefix: SMP\n`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD"), store = new TicketStore(dir);
  const ticket = store.create({ project: "sample", title: "Original", summary: "", description: "", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: ["preserve"], blockedBy: [], doc_refs: [], comments: [] });
  const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: identity.requestId, callerIdentitySha256: "b".repeat(64), expectedTicketVersion: creationDigest(ticket),
    repository: { key: "sample", root: repo, physicalIdentitySha256: "c".repeat(64) }, ticket: ticket.id, branch: `feature/${ticket.id}-handoff`, action: "create",
    base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-14T16:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" }, plannedLinkSha256: creationDigest(null), lineage: null };
  const plan = (extra = hooks) => store.applyHandoffWithIntent(ticket.id, creationDigest(ticket), { kind: "plan", intent }, actor, identity, extra);
  return { root, config, repo, dir, git, base, store, ticket, intent, plan };
}

test("real TicketStore writes a correlated planned link and full native intent without invalid legacy SHA fields", () => fixture(f => {
  const result = f.plan(), stored = readHandoffIntent(f.dir, result.key)!;
  assert.deepEqual(stored.change, { kind: "plan", intent: f.intent });
  assert.equal(result.ticket.linkedBranches.length, 1);
  assert.deepEqual(Object.keys(result.ticket.linkedBranches[0]!).sort(), ["repo", "branch", "state", "linkedAt", "linkedBy"].sort());
  assert.equal(result.ticket.linkedBranches[0]!.state, "planned");
  assert.equal(f.git("for-each-ref", `refs/heads/${f.intent.branch}`), "");
  assert.equal(f.store.readAudit().length, 2);
  f.store.comment(f.ticket.id, "fixture", "Later work");
  const later = f.store.get(f.ticket.id)!;
  assert.deepEqual(f.plan().ticket, later); assert.equal(f.plan().reused, true);
  assert.equal(f.store.readAudit().length, 3);
  assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, creationDigest(f.ticket), { kind: "plan", intent: { ...f.intent, branch: `${f.intent.branch}-changed` } }, actor, identity, hooks), /TICKET_HANDOFF_CONFLICT/);
}));

for (const stop of ["intent", "ticket", "audit"] as const) test(`original plan recovers after ${stop} boundary without duplicate ticket/link/audit`, () => fixture(f => {
  assert.throws(() => f.plan({ ...hooks, afterPersist(stage: string) { if (stage === stop) throw Error("reply lost"); } } as any), /reply lost/);
  const result = f.plan(); assert.equal(result.reused, true);
  assert.equal(result.ticket.linkedBranches.length, 1); assert.equal(f.store.readAudit().length, 2);
  assert.equal(readdirSync(f.dir).filter(name => name.startsWith(".ticket-handoff-")).length, 1);
}));

test("incomplete intent blocks replacement identity; intervening ordinary work is never discarded", () => fixture(f => {
  assert.throws(() => f.plan({ ...hooks, afterPersist(stage: string) { if (stage === "ticket") throw Error("lost"); } } as any));
  const current = f.store.get(f.ticket.id)!;
  assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, creationDigest(current), { kind: "stage", stage: "analysis" }, actor, { ...identity, requestId: "replacement" }, hooks), /TICKET_HANDOFF_UNCERTAIN/);
  f.store.comment(f.ticket.id, "fixture", "Must survive");
  const before = readFileSync(join(f.dir, `${f.ticket.id}.json`));
  assert.throws(() => f.plan(), /TICKET_HANDOFF_UNCERTAIN/);
  assert.deepEqual(readFileSync(join(f.dir, `${f.ticket.id}.json`)), before);
}));

test("native materialization preserves the reviewed base and original link attribution, separate from queue and checkout", () => fixture(f => {
  const plan = f.plan(), originalLink = plan.ticket.linkedBranches[0]!;
  // This fixture's ref mutation is independent; the production adapter must
  // authenticate correlation/authority, not treat this callback as human UAT.
  f.git("update-ref", `refs/heads/${f.intent.branch}`, f.base, "0".repeat(40));
  const change = { kind: "materialize", planKey: plan.key, operationId: "d".repeat(64), headSha: f.base } as const;
  const current = f.store.get(f.ticket.id)!, version = creationDigest(current);
  const native = { ...hooks, assertSnapshot() { assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), change.headSha); } };
  const result = f.store.applyHandoffWithIntent(f.ticket.id, version, change, actor, { ...identity, requestId: "original-ref-link" }, native);
  assert.deepEqual(result.ticket.linkedBranches[0], { ...originalLink, state: "materialized", baseSha: f.base, headSha: f.base, sha: f.base });
  assert.equal(result.ticket.status, "idea"); assert.equal(result.ticket.assignee, "sinh");
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  assert.equal(f.store.readAudit().length, 3);
  assert.equal(f.store.applyHandoffWithIntent(f.ticket.id, version, change, actor, { ...identity, requestId: "original-ref-link" }, native).reused, true);
}));

for (const stop of ["intent", "ticket", "audit"] as const) test(`materialized ticket result recovers original ${stop} boundary`, () => fixture(f => {
  const plan = f.plan(), version = creationDigest(plan.ticket), change = { kind: "materialize", planKey: plan.key, operationId: "d".repeat(64), headSha: f.base } as const;
  const id = { ...identity, requestId: "materialize" };
  assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, version, change, actor, id, { ...hooks, afterPersist(stage) { if (stage === stop) throw Error("lost"); } }), /lost/);
  const result = f.store.applyHandoffWithIntent(f.ticket.id, version, change, actor, id, hooks);
  assert.equal(result.reused, true); assert.equal(result.ticket.linkedBranches[0]!.baseSha, f.base); assert.equal(f.store.readAudit().length, 3);
}));

test("finite lifecycle pairs reject advanced work, concurrent assignees and incompatible primary refs", () => fixture(f => {
  for (const stage of ["analysis", "review", "changes-requested"] as const) {
    const current = f.store.get(f.ticket.id)!;
    const result = f.store.applyHandoffWithIntent(f.ticket.id, creationDigest(current), { kind: "stage", stage }, actor, { ...identity, requestId: stage }, hooks);
    assert.equal(result.ticket.status, stage === "review" ? "pending-approval" : "requirement-review");
    assert.equal(result.ticket.assignee, stage === "review" ? "sinh" : "requirements/team-manager");
  }
  const original = f.store.get(f.ticket.id)!;
  for (const patch of [{ status: "implementing" }, { status: "pending-implementation", assignee: "builder/team-manager" }, { status: "done" }, { assignee: "requirements/other" }, { doc_refs: [{ type: "attachment", path: "history.md", primary: true, addedAt: original.createdAt, addedBy: "fixture" }] }]) {
    const ticket = f.store.create({ ...original, ...patch } as any);
    assert.throws(() => f.store.applyHandoffWithIntent(ticket.id, creationDigest(ticket), { kind: "stage", stage: "analysis" }, actor, { ...identity, requestId: ticket.id }, hooks), /TICKET_HANDOFF_SCOPE/);
    assert.deepEqual(f.store.get(ticket.id), ticket);
  }
}));

test("stale CAS, foreign/multiple/planned legacy names and malformed finite dictionaries reject without overwrites", () => fixture(f => {
  assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, "f".repeat(64), { kind: "plan", intent: f.intent }, actor, identity, hooks), /TICKET_HANDOFF_STALE/);
  for (const change of [{ kind: "stage", stage: "done" }, { kind: "stage", stage: "analysis", assignee: "builder/team-manager" }, { kind: "materialize", planKey: "f".repeat(64), operationId: "d".repeat(64), headSha: "truncated" }])
    assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, creationDigest(f.ticket), change as any, actor, identity, hooks), TicketHandoffError);
  f.store.update(f.ticket.id, { add_linked_branch: { repo: "sample", branch: f.intent.branch } }, "fixture");
  const current = f.store.get(f.ticket.id)!;
  const intent = { ...f.intent, expectedTicketVersion: creationDigest(current), plannedLinkSha256: creationDigest(current.linkedBranches[0]) };
  assert.throws(() => f.store.applyHandoffWithIntent(f.ticket.id, creationDigest(current), { kind: "plan", intent }, actor, identity, hooks), /TICKET_HANDOFF_CONFLICT/);
  assert.deepEqual(f.store.get(f.ticket.id), current);
}));

test("snapshot authentication and revocation are rechecked under mutex before each write and replay", () => fixture(f => {
  let calls = 0;
  assert.throws(() => f.plan({ ...hooks, assertCurrent() { if (++calls === 2) throw Error("revoked"); } }), /revoked/);
  assert.equal(f.store.get(f.ticket.id)!.linkedBranches.length, 0);
  assert.throws(() => f.plan({ ...hooks, assertSnapshot: (() => Promise.resolve()) as any }), /TICKET_HANDOFF_INPUT/);
  const plan = f.plan(), before = readFileSync(join(f.dir, `${f.ticket.id}.json`));
  assert.throws(() => f.plan({ ...hooks, assertSnapshot() { throw Error("historical owner retained"); } }), /historical owner/);
  assert.deepEqual(readFileSync(join(f.dir, `${f.ticket.id}.json`)), before);
  assert.equal(readHandoffIntent(f.dir, plan.key)!.change.kind, "plan");
}));

test("corrupt original records, materialize self-reference and torn audits are uncertain, never absent", () => {
  for (const kind of ["record", "self-reference", "audit"] as const) fixture(f => {
    const plan = f.plan(), file = join(f.dir, `.ticket-handoff-${plan.key}.json`);
    if (kind === "record") writeFileSync(file, "{}");
    if (kind === "audit") writeFileSync(join(f.dir, "audit.jsonl"), '{"torn":');
    if (kind === "self-reference") {
      const row = JSON.parse(readFileSync(file, "utf8")); row.change = { kind: "materialize", planKey: plan.key, operationId: "d".repeat(64), headSha: f.base };
      row.payloadSha256 = creationDigest({ id: row.before.id, expectedVersion: row.expectedVersion, change: row.change, actor: row.actor }); writeFileSync(file, JSON.stringify(row));
    }
    assert.throws(() => f.plan(), /TICKET_HANDOFF_UNCERTAIN/);
  });
});

test("real separate processes share the native ticket mutex for same and competing original stage operations", async () => {
  for (const competing of [false, true]) {
    const saved = process.env, f = setup(), env = process.env; process.env = saved;
    const script = `import {TicketStore} from ${JSON.stringify(fileURLToPath(new URL("../tickets/store.ts", import.meta.url)))};
      try { const result=new TicketStore(process.argv[1]).applyHandoffWithIntent(process.argv[2],process.argv[3],JSON.parse(process.argv[4]),'requirements/analyze',JSON.parse(process.argv[5]),{assertCurrent(){},assertSnapshot(){}}); console.log(JSON.stringify({reused:result.reused})); }
      catch(error){console.error(error.code);process.exitCode=1;}`;
    const launch = (other: boolean) => new Promise<{ exit: number; out: string; err: string }>(resolve => execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, f.dir, f.ticket.id, creationDigest(f.ticket), JSON.stringify({ kind: "stage", stage: other ? "review" : "analysis" }), JSON.stringify({ ...identity, requestId: other ? "competitor" : "original" })], { env, timeout: 15000 }, (error, out, err) => resolve({ exit: error ? 1 : 0, out, err })));
    try {
      const results = await Promise.all([launch(false), launch(competing)]);
      assert.equal(new TicketStore(f.dir).readAudit().length, 2);
      if (competing) { assert.equal(results.filter(r => r.exit === 0).length, 1); assert.match(results.find(r => r.exit !== 0)!.err, /TICKET_HANDOFF_STALE/); }
      else { assert.deepEqual(results.map(r => r.exit), [0, 0]); assert.deepEqual(results.map(r => JSON.parse(r.out).reused).sort(), [false, true]); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("handoff diagnostics have one bounded static blocker envelope, with plain-text owner action", () => {
  for (const code of ["TICKET_HANDOFF_INPUT", "TICKET_HANDOFF_STALE", "TICKET_HANDOFF_CONFLICT", "TICKET_HANDOFF_SCOPE", "TICKET_HANDOFF_UNCERTAIN"] as const) {
    const text = new TicketHandoffError(code).message; assert.ok(text.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length - 1, 1);
  }
});
