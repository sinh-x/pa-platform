import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { getDeploymentEvents, documentPackageSha } from "@pa-platform/pa-core";
import { delegatedDraftFixture } from "./auto-delegated-draft-fixture.js";
import { PiDelegatedDraftOwner } from "../auto-delegated-draft.js";
import { readAutoShortlistStatus } from "../auto-shortlist-cli.js";

// These composed producer/admission callbacks are SIMULATED. Actual provider,
// native human policy adoption and installed pairing remain separate gates.
test("new bounded producer freezes one full useful unsigned package and appends only its own nonprimary evidence", async () => {
  const f = await delegatedDraftFixture(); try {
    const before = f.tickets.get(f.ticket.id)!, source = readFileSync(join(f.repo, "README.md")), ready = await f.owner().run(f.item);
    assert.equal(ready.state, "ready"); assert.equal(f.count(), 1); assert.ok(ready.subjectSha256);
    const subject = f.documents.subject(ready.subjectSha256!); assert.equal(documentPackageSha(subject), ready.subjectSha256); assert.equal(subject.members.length, 4);
    for (const member of subject.members) assert.deepEqual(readFileSync(join(f.usage, member.source)), f.documents.snapshot(member.sha256));
    const ticket = f.tickets.get(f.ticket.id)!; assert.equal(ticket.doc_refs.length, 3); assert.ok(ticket.doc_refs.every(ref => !ref.primary)); assert.equal(ticket.comments.length, 1);
    assert.equal(ticket.status, before.status); assert.equal(ticket.assignee, before.assignee); assert.equal(ticket.description, before.description); assert.equal(ticket.linkedBranches.length, 0); assert.equal(ticket.linkedCommits.length, 0);
    assert.match(ticket.comments[0]!.content, /UNAPPROVED/); assert.deepEqual(readFileSync(join(f.repo, "README.md")), source);
    assert.equal(f.journal.active()!.decisionId, null); assert.equal(f.journal.active()!.startSha256, null); assert.equal(f.journal.active()!.dispatch, null);
    assert.equal(getDeploymentEvents(ready.deploymentId).filter(e => e.event === "started").length, 1); assert.equal(getDeploymentEvents(ready.deploymentId).filter(e => e.event === "completed").length, 1);
    assert.deepEqual(f.tickets.pendingAutoDraftAppends(f.ticket.id), []);
    const status = readAutoShortlistStatus(); assert.equal((status.draftGeneration as { operationId: string }).operationId, ready.operationId); assert.equal(status.authorityGranted, false); assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test("material questions retain complete own draft evidence and hold implementation without forging approval", async () => {
  const f = await delegatedDraftFixture(); try {
    const g = await f.owner({ output: () => f.reply(["A material product question remains."]) }).run(f.item);
    assert.equal(g.state, "questions"); assert.equal(f.journal.active()!.state, "blocked"); assert.equal(f.journal.active()!.reason, "question"); assert.equal(f.journal.active()!.dispatch, null);
    const member = f.documents.subject(g.subjectSha256!).members.find(m => m.id === "questions")!;
    assert.deepEqual(JSON.parse(f.documents.snapshot(member.sha256).toString()).questions, ["A material product question remains."]);
  } finally { f.close(); }
});

test("source investigation is bounded and its original known result is reused without another model call", async () => {
  const f = await delegatedDraftFixture(); try {
    const owner = f.owner({ output: () => f.count() === 1 ? Buffer.from(JSON.stringify({ action: "read", path: "README.md" })) : f.reply() });
    const g = await owner.run(f.item); assert.equal(g.state, "ready"); assert.equal(f.count(), 2);
    assert.match(f.drafts.blob(f.drafts.turns(g)[0]!.sourceSha256!).toString(), /Synthetic source/);
    const audit = f.tickets.readAudit().length;
    const repeated = await f.owner().run(f.journal.active()!); assert.equal(repeated.operationId, g.operationId); assert.equal(f.count(), 2); assert.equal(f.tickets.readAudit().length, audit);
  } finally { f.close(); }
});

test("unknown process cleanup retains original generation/turn/slot and cannot respawn after PID/reply absence", async () => {
  const f = await delegatedDraftFixture(); try {
    const g = await f.owner({ unknown: true }).run(f.item); assert.equal(g.state, "uncertain"); const revision = g.revision;
    const repeated = await f.owner().run(f.journal.active()!); assert.equal(repeated.operationId, g.operationId); assert.equal(repeated.revision, revision); assert.equal(f.count(), 1);
    assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0); assert.equal(f.journal.active()!.itemId, f.item.itemId);
    assert.equal(getDeploymentEvents(g.deploymentId).some(e => e.event === "completed"), false);
  } finally { f.close(); }
});

test("revocation after an in-flight response preserves historical bytes but fences freeze/attachment/continuation", async () => {
  const f = await delegatedDraftFixture(); try {
    await assert.rejects(f.owner({ output: () => { f.revoke(); return f.reply(); } }).run(f.item));
    const g = f.drafts.current(f.item.itemId)!; assert.equal(f.count(), 1); assert.equal(f.drafts.turns(g).at(-1)!.observation!.state, "completed");
    assert.equal(g.bundleSha256, null); assert.equal(g.subjectSha256, null); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0);
    await assert.rejects(f.owner().run(f.journal.active()!)); assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test("observed repository drift holds and preserves foreign work without reset/discard or fake cleanup", async () => {
  const f = await delegatedDraftFixture(); try {
    await assert.rejects(f.owner({ output: () => { f.put(join(f.repo, "README.md"), "Foreign work must remain.\n"); return f.reply(); } }).run(f.item));
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "Foreign work must remain.\n"); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0); assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test("original output/artifact/freeze/append/finish response-loss stages reconcile without duplicate model, package, comment or audit", async () => {
  for (const stop of ["output", "artifact", "freeze", "append", "finish"] as const) {
    const f = await delegatedDraftFixture(); try {
      let tripped = false;
      await assert.rejects(f.owner({ afterStage(stage) { if (!tripped && stage === stop) { tripped = true; throw new Error("original response lost"); } } }).run(f.item), /original response lost/);
      const original = f.drafts.current(f.item.itemId)!;
      const g = await f.owner().run(f.journal.active()!); assert.equal(g.state, "ready"); assert.equal(g.operationId, original.operationId); assert.equal(g.deploymentId, original.deploymentId); assert.equal(f.count(), 1);
      assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 3); assert.equal(f.tickets.get(f.ticket.id)!.comments.length, 1); assert.equal(f.tickets.readAudit().length, 2);
      assert.equal(f.documents.events("pa-platform", f.ticket.id).filter(e => e.data.kind === "frozen").length, 1);
    } finally { f.close(); }
  }
});

test("authority is required before reservation and model output cannot import actors, status, primary refs or approvals", async () => {
  const f = await delegatedDraftFixture(); try {
    assert.throws(() => new PiDelegatedDraftOwner(f.journal, undefined as any));
    const g = await f.owner({ output: () => Buffer.from(JSON.stringify({ action: "finish", approved: true, actor: "sinh", brief: "bad", requirements: "bad", uat: "bad", questions: [] })) }).run(f.item);
    assert.equal(g.state, "blocked"); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0); assert.equal(f.journal.active()!.decisionId, null); assert.equal(f.journal.active()!.dispatch, null);
    const summary = getDeploymentEvents(g.deploymentId).find(e => e.event === "completed")!.summary!;
    assert.ok(summary.length <= 2000); for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(summary.split(label).length, 2);
    assert.doesNotMatch(summary, /approved.*true|actor.*sinh|\u001b/i);
  } finally { f.close(); }
});

test("a matrix without FR/NFR/AC/TS-to-UAT shape cannot be declared ready by nonempty placeholder documents", async () => {
  const f = await delegatedDraftFixture(); try {
    const g = await f.owner({ output: () => { const reply = JSON.parse(f.reply().toString()); reply.requirements = reply.requirements.replace("- NFR-1 preserve unrelated work", ""); return Buffer.from(JSON.stringify(reply)); } }).run(f.item);
    assert.equal(g.state, "blocked"); assert.equal(g.subjectSha256, null); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0);
  } finally { f.close(); }
});

test("previously dirty source content drift is detected even when Git status paths are unchanged", async () => {
  const f = await delegatedDraftFixture(); try {
    f.put(join(f.repo, "README.md"), "Existing foreign dirt A.\n");
    await assert.rejects(f.owner({ output: () => {
      if (f.count() === 1) return Buffer.from(JSON.stringify({ action: "read", path: "README.md" }));
      f.put(join(f.repo, "README.md"), "Existing foreign dirt B.\n"); return f.reply();
    } }).run(f.item));
    assert.equal(f.count(), 2); assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "Existing foreign dirt B.\n"); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0);
  } finally { f.close(); }
});

test("unsupported, disabled, dirty or nonprivate delegated pairing never allocates a generation or launches a provider", async () => {
  const f = await delegatedDraftFixture(); try {
    const path = join(f.cfg, "contracts/auto-delegated-v1.json"), original = JSON.parse(readFileSync(path, "utf8"));
    for (const mutation of [{ enabled: false }, { cpuQuota: 50 }, { draftMode: "analyze" }, { policySource: "../outside.json" }, { schemaVersion: "pa-auto-pair/v1" }]) {
      f.put(path, JSON.stringify({ ...original, ...mutation })); execFileSync("git", ["-C", f.cfg, "add", "."]); execFileSync("git", ["-C", f.cfg, "commit", "-m", "Unsupported synthetic proposal"], { stdio: "ignore" });
      await assert.rejects(f.owner().run(f.item)); assert.equal(f.drafts.current(f.item.itemId), null); assert.equal(f.count(), 0);
    }
    f.put(path, JSON.stringify(original)); await assert.rejects(f.owner().run(f.item)); assert.equal(f.count(), 0);
  } finally { f.close(); }
});

test("source request ceiling preserves all originals and refuses a 33rd native read instead of an incomplete success", async () => {
  const f = await delegatedDraftFixture(); try {
    const g = await f.owner({ output: () => Buffer.from(JSON.stringify({ action: "read", path: "README.md" })) }).run(f.item);
    assert.equal(g.state, "blocked"); assert.equal(f.count(), 33); assert.equal(f.drafts.turns(g).filter(t => t.sourceSha256).length, 32);
    assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0); assert.equal(f.journal.active()!.dispatch, null);
  } finally { f.close(); }
});

test("changed human ticket during preparation is not overwritten or silently rebound for append", async () => {
  const f = await delegatedDraftFixture(); try {
    const old = f.version();
    await assert.rejects(f.owner({ output: () => { const response = f.reply(); f.tickets.comment(f.ticket.id, "sinh", "New human evidence."); return response; } }).run(f.item));
    assert.notEqual(f.version(), old); assert.equal(f.tickets.get(f.ticket.id)!.comments[0]!.content, "New human evidence."); assert.equal(f.tickets.get(f.ticket.id)!.doc_refs.length, 0); assert.equal(f.count(), 1);
  } finally { f.close(); }
});
