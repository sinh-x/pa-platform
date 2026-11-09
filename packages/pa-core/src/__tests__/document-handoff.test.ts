import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

test("workspace handoff status distinguishes ticket association, queue, recorded branch evidence and unproven launch without effects", async () => {
  const f = documentRuntimeFixture();
  try {
    f.host.workspaceProfile = true;
    const original = f.host.authenticate;
    f.host.authenticate = () => ({ ...original(), ticket: null });
    const status = async () => (await f.call({ action: "status", ticket: "EX-1" })).result as { handoff: Record<string, unknown> };
    let audit = f.store.readAudit().length;
    assert.deepEqual((await status()).handoff, { association: "caller-unassociated", queue: "not-recorded-pending-implementation", branchEvidence: "absent", branchBridge: "unsupported-ticket-launcher-owner-required", custody: "not-observed", launchReady: false });
    assert.equal(f.store.readAudit().length, audit);
    f.store.update("EX-1", { status: "pending-implementation", assignee: "builder/team-manager" }, "fixture");
    const current = f.store.get("EX-1")!;
    // Native ticket evidence, not Git/current checkout or custody observation.
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
    git(["init", "-b", "develop"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "disposable branch evidence"]);
    f.store.update("EX-1", { add_linked_branch: { repo: "example", branch: "feature/EX-1-fixture" } }, "fixture");
    audit = f.store.readAudit().length;
    const observed = (await status()).handoff;
    assert.equal(observed.queue, "recorded-pending-implementation"); assert.equal(observed.branchEvidence, "recorded-unverified"); assert.equal(observed.launchReady, false);
    for (const action of ["branch-plan", "launch", "approve", "associate-ticket"]) assert.equal((await f.call({ action })).ok, false);
    assert.equal(f.store.readAudit().length, audit); assert.equal(f.store.get("EX-1")!.status, current.status);
  } finally { f.close(); }
});
test("workspace host can observe/reconcile an already-issued exact publication intent without issuing new consent", async () => {
  const f = documentRuntimeFixture();
  try {
    const decisionId = await f.prepare();
    const call = (action: string) => f.call({ action, sha256: f.sha256, decisionId, expectedRevision: f.revision() });
    assert.equal((await call("publish")).ok, true); assert.equal((await call("queue")).ok, true);
    const audit = f.store.readAudit().length, revision = f.revision();
    f.host.workspaceProfile = true; // Separate eligible source-fixture host; no retained launch is upgraded.
    f.host.capture = async () => { throw Error("no new consent requested"); };
    assert.equal(((await call("publish")).result as { reused: boolean }).reused, true);
    assert.equal(((await call("queue")).result as { reused: boolean }).reused, true);
    assert.equal(f.store.readAudit().length, audit); assert.equal(f.revision(), revision);
  } finally { f.close(); }
});
