import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb } from "../registry/db.js";
import { RegistryAutoNotifications, autoNotificationText } from "../auto/notifications.js";
import { buildAutoWaitlist, routeAutoTicket } from "../auto/waitlist.js";
import { AutoCoordinator, RegistryAutoJournal } from "../auto/coordination.js";
const snapshot = () => { const at = new Date().toISOString(); return buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [], tickets: [{ id: "PAP-1", project: "pa-platform", title: "Never copy this title into desktop text", priority: "medium", status: "idea", createdAt: at, ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } }] }); };
test("unchanged complete scans coalesce despite new timestamps/versions; changed states request information only", () => {
  const db = getDb(":memory:"); try {
    const notices = new RegistryAutoNotifications(db), first = notices.claim(snapshot(), null, true)!;
    assert.equal(first.delivery, "unknown"); assert.equal(notices.claim(snapshot(), null, true), null);
    const result = notices.result(first, "requested", "none"); assert.equal(result.delivery, "requested"); assert.equal(notices.last()!.delivery, "requested");
    assert.doesNotMatch(autoNotificationText(first), /Never copy|approve|execute/i);
    const next = snapshot(); next.entries[0]!.priority = "high"; assert.ok(notices.claim(next, null, true));
  } finally { db.close(); }
});
test("lost notification reply remains unknown and cannot cause duplicate delivery or a new launch", () => {
  const db = getDb(":memory:"); try {
    const n = new RegistryAutoNotifications(db), s = snapshot(); n.claim(s, null, true);
    assert.equal(n.last()!.delivery, "unknown"); assert.equal(n.claim(s, null, true), null);
  } finally { db.close(); }
});
test("missed intervals cause one wake, not a backlog; clock reversal and pause do not force replay", () => {
  const db = getDb(":memory:"); try {
    const n = new RegistryAutoNotifications(db);
    assert.equal(n.takeWake(1_000_000), true); assert.equal(n.takeWake(1_000_001), false);
    assert.equal(n.takeWake(1_000_000 + 100 * 30 * 60_000), true); assert.equal(n.takeWake(1_000_000 + 100 * 30 * 60_000), false);
    assert.equal(n.takeWake(1), false); assert.equal(n.takeWake(9_000_000_000, () => false), false);
  } finally { db.close(); }
});
test("repeated settled draft observations cannot regress an approved/paused item or grow history", async () => {
  const db = getDb(":memory:"); try {
    const j = new RegistryAutoJournal(db), c = new AutoCoordinator(j, () => {}), e = snapshot().entries[0]!;
    const selected = j.select(e, "/synthetic", () => e, () => {});
    const ready = await c.draft(selected, { execute: async () => ({ state: "draft-ready", settled: true, subjectSha256: "b".repeat(64) }), observe: async () => ({ state: "draft-ready", settled: true, subjectSha256: "b".repeat(64) }) });
    const approved = j.change(ready.itemId, ready.revision, b => ({ ...b, state: "approved-pending-dispatch" }), () => {});
    assert.deepEqual(c.apply(approved, "draft", { state: "draft-ready", settled: true, subjectSha256: "b".repeat(64) }), approved);
    assert.equal(j.item(approved.itemId).revision, approved.revision);
  } finally { db.close(); }
});
test("notification text bounds hostile context and never evaluates commands", () => {
  const text = autoNotificationText({ ticket: "$(touch forbidden)" + "x".repeat(4000), state: "unknown" } as never);
  assert.ok(text.length < 300); assert.doesNotMatch(text, /touch|forbidden/);
  assert.equal(autoNotificationText(new Proxy({}, { get() { throw new Error("hostile getter"); } }) as never), "PPA auto: work needs inspection. Run ppa auto.");
});
