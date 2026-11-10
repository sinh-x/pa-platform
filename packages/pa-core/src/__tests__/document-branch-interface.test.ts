import assert from "node:assert/strict";
import { test } from "node:test";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

test("branch inspection is a v3 native-only, ticket-authenticated observation with no package or approval prerequisites", async () => {
  const f = documentRuntimeFixture();
  try {
    let calls = 0; f.host.inspectBranch = ticket => { calls++; assert.equal(ticket, "EX-1"); return { code: "BRANCH_VERIFIED", observationOnly: true, launchReady: false }; };
    const request = { action: "branch-inspect", ticket: "EX-1" };
    assert.equal((await f.call(request)).code, "DOCUMENT_UNAVAILABLE"); assert.equal(calls, 0);
    f.host.workspaceProfile = true; assert.equal((await f.call(request)).code, "DOCUMENT_UNAVAILABLE"); assert.equal(calls, 0);
    f.host.confirmationProfile = true;
    const audit = f.store.readAudit().length;
    assert.equal((await f.call(request)).ok, true); assert.equal(calls, 1); assert.equal(f.revision(), 0); assert.equal(f.store.readAudit().length, audit);
    assert.equal((await f.call({ ...request, ticket: "EX-999" })).code, "DOCUMENT_AUTHORITY"); assert.equal(calls, 1);
    for (const extra of [{ branch: "feature/EX-1-forged" }, { baseSha: "a".repeat(40) }, { worktreeRoot: "/tmp/foreign" }, { launch: true }, { approved: true }]) assert.equal((await f.call({ ...request, ...extra })).ok, false);
    assert.equal(calls, 1);
  } finally { f.close(); }
});
