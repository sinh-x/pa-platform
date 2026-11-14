import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflowDigest, type DocumentPackage } from "@pa-platform/pa-core";
import { autoDraftRead, parseAutoDraftReply } from "../auto-draft.js";
import { captureAutoFullReview, nativeAutoTerminal, type AutoTerminal } from "../auto-terminal.js";

test("draft protocol is closed, bounded and contains no arbitrary shell or grant fields", () => {
  assert.deepEqual(parseAutoDraftReply(Buffer.from('{"action":"read","path":"src/a.ts"}')), { action: "read", path: "src/a.ts" });
  for (const value of [{ action: "bash", command: "echo nope" }, { action: "read", path: "x", approved: true }, { action: "finish", brief: "", requirements: "a", uat: "b", questions: [] }]) assert.throws(() => parseAutoDraftReply(Buffer.from(JSON.stringify(value))));
  assert.throws(() => parseAutoDraftReply(Buffer.from('{"action":"read","action":"finish","path":"x"}')));
});
test("native investigation reads only bounded canonical source and refuses traversal, aliases and sensitive paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-draft-read-"));
  try {
    writeFileSync(join(root, "source.ts"), "export const synthetic = true;\n"); mkdirSync(join(root, ".git")); writeFileSync(join(root, ".env"), "synthetic");
    symlinkSync(join(root, "source.ts"), join(root, "alias.ts"));
    assert.match(autoDraftRead(root, { action: "read", path: "source.ts" }), /synthetic/);
    assert.doesNotMatch(autoDraftRead(root, { action: "list", path: "." }), /\.git|\.env|alias/);
    for (const path of ["../outside", ".git/config", ".env", "alias.ts"]) assert.throws(() => autoDraftRead(root, { action: "read", path }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function reviewFixture() {
  const docs = ["Synthetic brief", "# Requirements\n- FR-1 scope", "# UAT\n- TS-1 not run"].map(s => Buffer.from(s));
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "synthetic", revision: 1, repository: { key: "pa-platform", root: "/synthetic" }, ticket: "PAP-1", predecessor: null,
    members: (["brief", "requirements", "uat"] as const).map((role, i) => ({ id: role, role, description: "Synthetic", mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/drafts/d-aaaaaa/${role}.md`, bytes: docs[i]!.length, sha256: workflowDigest(docs[i]!) })), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  const startIntent = { schemaVersion: "synthetic", provider: "configured-fixture", deadlineAt: "2026-11-13T18:00:00.000Z" };
  return { subject, subjectSha256: workflowDigest(JSON.stringify(subject)), documents: docs, startIntent, startSha256: workflowDigest(JSON.stringify(startIntent)), documentScope: "publish-and-queue" as const };
}
test("full native review displays every complete member and both scopes with one decision", async () => {
  const review = reviewFixture(), displayed: string[] = []; let prompts = 0, authentication = 0;
  const terminal: AutoTerminal = { authenticate: () => { authentication++; }, display: s => displayed.push(s), choose: async () => { prompts++; return 0; } };
  const capture = await captureAutoFullReview(review, terminal);
  assert.equal(capture.outcome, "approved"); assert.equal(prompts, 1); assert.ok(authentication >= 2);
  for (const doc of review.documents) assert.ok(displayed.some(s => s.includes(doc.toString())));
  assert.ok(displayed.some(s => s.includes(review.startSha256))); assert.equal(workflowDigest(capture.evidence), capture.evidenceSha256);
});
test("cancel, reject and request-changes never become approval; stale identity after prompt rejects", async () => {
  for (const [selection, expected] of [[-1, "cancelled"], [1, "rejected"], [2, "changes-requested"]] as const) {
    const terminal: AutoTerminal = { authenticate() {}, display() {}, choose: async () => selection };
    assert.equal((await captureAutoFullReview(reviewFixture(), terminal)).outcome, expected);
  }
  let calls = 0;
  await assert.rejects(() => captureAutoFullReview(reviewFixture(), { authenticate() { if (++calls > 1) throw new Error("identity drift"); }, display() {}, choose: async () => 0 }));
});
test("real terminal denies managed/headless review instead of accepting caller outcomes", () => {
  assert.throws(() => nativeAutoTerminal().authenticate());
});
