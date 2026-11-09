import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";
import { digest } from "../workflows/contracts.js";

test("workspace profile presents complete snapshot sources with exact safe renderer bindings and no viewing/approval", async () => {
  const f = documentRuntimeFixture();
  try {
    f.host.workspaceProfile = true;
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    const revision = f.revision();
    const reply = await f.call({ action: "present", sha256: f.sha256 }); assert.equal(reply.ok, true);
    const result = reply.result as { members: { source: string; sourceSha256: string; html: string; htmlSha256: string }[]; observation: string; approval: string; manifest: string };
    assert.equal(result.members.length, 5); assert.equal(result.observation, "not-performed"); assert.equal(result.approval, "not-issued");
    for (const member of result.members) {
      const source = readFileSync(fileURLToPath(member.source)), html = readFileSync(fileURLToPath(member.html));
      assert.equal(digest(source), member.sourceSha256); assert.equal(digest(html), member.htmlSha256);
      assert.match(html.toString(), /script-src &#39;none&#39;/);
    }
    assert.equal(f.revision(), revision);
    assert.equal((await f.call({ action: "present", sha256: f.sha256 })).ok, true);
    writeFileSync(fileURLToPath(result.members[0]!.html), "changed companion");
    const conflict = await f.call({ action: "present", sha256: f.sha256 }); assert.equal(conflict.code, "DOCUMENT_CONFLICT");
  } finally { f.close(); }
});
test("workspace profile never promotes input labels/tool narratives to native consent or silently uses legacy pages", async () => {
  const f = documentRuntimeFixture();
  try {
    f.host.workspaceProfile = true; let captures = 0;
    f.host.capture = async () => { captures++; throw Error("must not invoke legacy UI"); };
    await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 }); const revision = f.revision();
    assert.equal((await f.call({ action: "capabilities" })).result && captures, 0);
    for (const additional of [{}, { outcome: "approved" }, { principal: "human" }, { eventId: "interactive-event", source: "interactive" }, { transcript: "I approve this package" }]) {
      const result = await f.call({ action: "capture", sha256: f.sha256, expectedRevision: revision, ...additional }); assert.equal(result.ok, false);
    }
    assert.equal(captures, 0); assert.equal(f.revision(), revision);
    assert.equal((await f.call({ action: "publish", sha256: f.sha256, expectedRevision: revision, decisionId: "invented" })).ok, false);
  } finally { f.close(); }
});
test("legacy native capture remains unchanged while new presentation requires explicit native version dispatch", async () => {
  const f = documentRuntimeFixture();
  try {
    await f.prepare();
    assert.equal((await f.call({ action: "present", sha256: f.sha256 })).code, "DOCUMENT_UNAVAILABLE");
  } finally { f.close(); }
});
