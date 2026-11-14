import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb } from "../registry/db.js";
import { RegistryAutoDrafts, type AutoDraftGenerationHost, type AutoDraftProcessObservation } from "../auto/draft-journal.js";
import { AutoWaitlistError } from "../auto/waitlist.js";
import { shortlistFixture } from "./auto-shortlist-fixture.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const fp = { pid: 12345, startTimeTicks: "1111", bootId: "11111111-2222-3333-4444-555555555555" };
const observed: AutoDraftProcessObservation = { state: "completed", pid: fp.pid, fingerprint: fp, startedAt: "2026-11-14T03:02:00.000Z", completedAt: "2026-11-14T03:03:00.000Z", exitCode: 0, signal: null, groupSettled: true, stderrBytes: 0 };
async function fixture() {
  const db = getDb(":memory:"), s = shortlistFixture(db), saved = s.saved(); await s.store.choose(saved.shortlist.version, s.host);
  const item = s.store.items.active()!, drafts = new RegistryAutoDrafts(s.store.items);
  let permitted = true, now = "2026-11-14T03:02:00.000Z";
  const reference = { decisionId: "decision-11111111-2222-3333-4444-555555555555", policySha256: "b".repeat(64), expiresAt: "2026-11-14T04:00:00.000Z" };
  const host: AutoDraftGenerationHost = { authenticate: () => "a".repeat(64), now: () => now, authorize() { if (!permitted) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); return { ...reference }; }, assertCurrent() {} };
  const reserve = () => drafts.reserve(item, { request: bytes({ fixtureOnly: "No native/human policy is claimed by these data-owner tests." }), ticketVersion: "c".repeat(64) }, host);
  return { db, s, item, drafts, host, reserve, revoke: () => { permitted = false; }, now: (value: string) => { now = value; } };
}

test("new draft generation binds original accepted choice and native policy reference before any provider effect", async () => {
  const f = await fixture(); try {
    const g = f.reserve(); assert.equal(g.generation, 1); assert.equal(g.state, "reserved"); assert.equal(g.selectionId, f.s.store.selectionForItem(f.item.itemId)!.requestId);
    assert.equal(f.drafts.current(f.item.itemId)!.operationId, f.s.store.items.active()!.draft!.operationId);
    assert.throws(() => f.reserve(), AutoWaitlistError);
    const running = f.drafts.start(g, f.host); assert.equal(running.operationId, g.operationId);
    assert.throws(() => f.drafts.start(running, f.host), AutoWaitlistError);
  } finally { f.db.close(); }
});

test("native policy denial, forged references and async callbacks cannot reserve a draft or import a start grant", async () => {
  const f = await fixture(); try {
    f.revoke(); assert.throws(() => f.reserve(), AutoWaitlistError); assert.equal(f.drafts.current(f.item.itemId), null); assert.equal(f.s.store.items.active()!.draft, null);
    assert.throws(() => f.drafts.reserve(f.item, { request: bytes({}), ticketVersion: "c".repeat(64) }, { ...f.host, authorize: (() => Promise.reject(new Error("synthetic"))) as any }), AutoWaitlistError);
    assert.equal(f.s.store.items.active()!.decisionId, null);
  } finally { f.db.close(); }
});

test("durable turn claim and incarnation precede provider result; missing/unknown replies never authorize another turn", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host), turn = f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host);
    assert.equal(turn.turn, 0); assert.equal(f.drafts.blob(turn.promptSha256).toString(), '{"prompt":"one"}');
    assert.throws(() => f.drafts.claimTurn(g, bytes({ prompt: "replacement" }), f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.observeTurn(g, 0, observed, bytes({ action: "finish" }), f.host), AutoWaitlistError);
    f.drafts.anchor(g, 0, fp, f.host);
    f.drafts.observeTurn(g, 0, { ...observed, state: "unknown", exitCode: null, groupSettled: false }, bytes({ partial: true }), f.host);
    const uncertain = f.drafts.uncertain(g, f.host); assert.equal(uncertain.state, "uncertain");
    assert.throws(() => f.drafts.claimTurn(uncertain, bytes({ prompt: "again" }), f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.resumeKnown(uncertain, f.host), AutoWaitlistError);
    assert.equal(f.s.store.items.active()!.itemId, f.item.itemId);
  } finally { f.db.close(); }
});

test("known original source result can continue only at the next unclaimed turn under current authorization", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host); f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host); f.drafts.anchor(g, 0, fp, f.host); f.drafts.observeTurn(g, 0, observed, bytes({ action: "read", path: "README.md" }), f.host);
    f.drafts.source(g, 0, Buffer.from("Original safe source bytes"), f.host);
    const next = f.drafts.claimTurn(g, bytes({ prompt: "two" }), f.host); assert.equal(next.turn, 1);
    assert.equal(f.drafts.blob(f.drafts.turns(g)[0]!.sourceSha256!).toString(), "Original safe source bytes");
    assert.throws(() => f.drafts.claimTurn(g, bytes({ prompt: "duplicate" }), f.host), AutoWaitlistError);
  } finally { f.db.close(); }
});

test("revocation fences dependent effects but preserves original in-flight observations as historical evidence", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host); f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host); f.drafts.anchor(g, 0, fp, f.host);
    f.revoke(); f.drafts.observeTurn(g, 0, observed, bytes({ action: "finish" }), f.host);
    assert.equal(f.drafts.turns(g)[0]!.observation!.state, "completed");
    assert.throws(() => f.drafts.output(g, bytes({ bundle: true }), f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.source(g, 0, Buffer.from("late"), f.host), AutoWaitlistError);
    assert.equal(f.s.store.items.active()!.draft!.deploymentId, g.deploymentId);
  } finally { f.db.close(); }
});

test("native output/freeze/append/finish ordering is CAS-bound and never creates a human content/start approval", async () => {
  const f = await fixture(); try {
    let g = f.drafts.start(f.reserve(), f.host); f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host); f.drafts.anchor(g, 0, fp, f.host); f.drafts.observeTurn(g, 0, observed, bytes({ action: "finish" }), f.host);
    g = f.drafts.output(g, bytes({ own: "bundle" }), f.host);
    assert.throws(() => f.drafts.freeze(g, "d".repeat(64), async () => {}, f.host), AutoWaitlistError);
    let freezes = 0; g = f.drafts.freeze(g, "d".repeat(64), () => { freezes++; }, f.host); assert.equal(freezes, 1);
    g = f.drafts.appendIntent(g, bytes({ own: "append" }), f.host);
    assert.throws(() => f.drafts.finish(g, false, async () => {}, f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.finish(g, false, () => { throw new AutoWaitlistError("AUTO_BUSY"); }, f.host), AutoWaitlistError);
    const ready = f.drafts.finish(g, false, () => {}, f.host), item = f.s.store.items.active()!;
    assert.equal(ready.state, "ready"); assert.equal(item.subjectSha256, "d".repeat(64)); assert.equal(item.draft!.state, "completed"); assert.equal(item.decisionId, null); assert.equal(item.startSha256, null); assert.equal(item.dispatch, null);
  } finally { f.db.close(); }
});

test("expired original budget, changed generation or forged process success cannot produce dependent effects", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host); f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host); f.drafts.anchor(g, 0, fp, f.host);
    assert.throws(() => f.drafts.observeTurn(g, 0, { ...observed, fingerprint: { ...fp, startTimeTicks: "2222" } }, bytes({}), f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.observeTurn(g, 0, { ...observed, exitCode: 1 }, bytes({}), f.host), AutoWaitlistError);
    f.now(g.deadlineAt); assert.throws(() => f.drafts.source(g, 0, Buffer.from("expired"), f.host), AutoWaitlistError);
    assert.throws(() => f.drafts.assertCurrent({ ...g, generation: 2 }, f.host), AutoWaitlistError);
  } finally { f.db.close(); }
});

test("copied deadline/state overrides and expiry during a native source check cannot claim a producer turn", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host);
    assert.throws(() => f.drafts.assertCurrent({ ...g, deadlineAt: "2026-11-14T03:40:00.000Z" }, f.host), AutoWaitlistError);
    f.host.assertCurrent = () => f.now(g.deadlineAt);
    assert.throws(() => f.drafts.claimTurn(g, bytes({ late: true }), f.host), AutoWaitlistError); assert.equal(f.drafts.turns(g).length, 0);
  } finally { f.db.close(); }
});

test("draft event/turn/snapshot history is immutable and corrupted heads fail closed", async () => {
  const f = await fixture(); try {
    const g = f.drafts.start(f.reserve(), f.host); f.drafts.claimTurn(g, bytes({ prompt: "one" }), f.host);
    for (const table of ["auto_draft_events", "auto_draft_turns", "auto_draft_snapshots"]) assert.throws(() => f.db.prepare(`DELETE FROM ${table}`).run(), /append-only|immutable/);
    f.db.prepare("UPDATE auto_draft_generations SET body='{}' WHERE item_id=?").run(g.itemId);
    assert.throws(() => f.drafts.current(g.itemId), AutoWaitlistError);
  } finally { f.db.close(); }
});
