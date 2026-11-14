import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../registry/db.js";
import { AutoDelegationPolicyService } from "../documents/auto-policy.js";
import { parseAutoDelegationPolicy, parseAutoDelegationDefinition } from "../documents/auto-policy-contract.js";
import { AutoWaitlistError } from "../auto/waitlist.js";
import { autoPolicyFixture } from "./auto-policy-fixture.js";
import { digest } from "../workflows/contracts.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
// Native capture, identity and current-facts callbacks below are SIMULATED.
// These are source owner tests, NOT operator adoption/qualification/UAT.
test("exact global native adoption is distinct from per-ticket receipts, selection, activation and execution", async () => {
  const f = autoPolicyFixture(); try {
    assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
    const adopted = await f.service.adopt(f.host), status = f.service.status(f.host.domain);
    assert.equal(adopted.phase, "issued"); assert.equal(f.captures(), 1); assert.equal(status.issuedAdoption!.decisionId, adopted.decisionId);
    assert.equal(status.executionAdmitted, false); assert.equal(status.activationRequested, false);
    assert.equal(f.service.authorize(f.host).reference.decisionId, adopted.decisionId);
    assert.equal((await f.service.adopt(f.host)).decisionId, adopted.decisionId); assert.equal(f.captures(), 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM document_events").get().n, 0); assert.equal(f.db.prepare("SELECT count(*) AS n FROM auto_items").get().n, 0);
  } finally { f.db.close(); }
});
test("Cancel grants nothing and caller/model approval, old schemas and unsupported bounds cannot be parsed as policy", async () => {
  const f = autoPolicyFixture(); try {
    f.cancel(); const result = await f.service.adopt(f.host); assert.equal(result.outcome, "cancelled"); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
    for (const patch of [{ approved: true }, { schemaVersion: "pa-auto-start/v1" }, { cpuQuota: 50 }, { limits: { ...f.policy.limits, sourceRequests: 33 } }, { expiresAt: "2026-11-16T10:00:00.000Z" }, { excludedEffects: [] }, { guardrails: { ...f.policy.guardrails, repositoryProtection: "os-sandbox" } }]) assert.throws(() => parseAutoDelegationPolicy(bytes({ ...f.policy, ...patch })), AutoWaitlistError);
    assert.throws(() => parseAutoDelegationPolicy(Buffer.from('{"schemaVersion":"x","schemaVersion":"y"}')), AutoWaitlistError);
    const def = { schemaVersion: "pa-auto-delegation-definition/v1", lifetimeSeconds: 86400, repositories: f.policy.repositories.map(r => ({ key: r.key, sourceScope: r.sourceScope, checkIds: ["fixture-check"] })) };
    assert.equal(parseAutoDelegationDefinition(bytes(def)).lifetimeSeconds, 86400);
    for (const patch of [{ enabled: true }, { lifetimeSeconds: 86401 }, { repositories: [def.repositories[0]] }]) assert.throws(() => parseAutoDelegationDefinition(bytes({ ...def, ...patch })), AutoWaitlistError);
  } finally { f.db.close(); }
});
test("expiry, monotonic original budget, boot changes, stale reference and current-source denial fence use without deleting history", async () => {
  for (const change of ["utc", "monotonic", "boot", "source", "reference"] as const) {
    const f = autoPolicyFixture(); try {
      await f.service.adopt(f.host); const reference = f.service.authorize(f.host).reference;
      if (change === "utc") f.time(f.policy.expiresAt);
      if (change === "monotonic") f.time("2026-11-14T10:20:00.000Z", "4600000000000");
      if (change === "boot") f.boot(); if (change === "source") f.drift(); if (change === "reference") reference.policySha256 = "0".repeat(64);
      assert.throws(() => f.service.authorize(f.host, reference), AutoWaitlistError); assert.equal(f.service.status(f.host.domain).revision, 3);
    } finally { f.db.close(); }
  }
});
test("lost original permission capture cannot be reprompted, including after native caller restart", async () => {
  const f = autoPolicyFixture(); try {
    const service = new AutoDelegationPolicyService(f.documents, stage => { if (stage === "requested") throw new Error("lost before native capture"); });
    await assert.rejects(service.adopt(f.host), /lost before/); f.actor();
    await assert.rejects(f.service.adopt(f.host), AutoWaitlistError); assert.equal(f.captures(), 0); assert.equal(f.service.status(f.host.domain).pendingReviews.length, 1);
  } finally { f.db.close(); }
});
test("capture/observation/issued reply loss reconciles SAME original decision without another prompt or budget reset", async () => {
  for (const stop of ["captured", "observed", "issued"] as const) {
    const f = autoPolicyFixture(); try {
      const service = new AutoDelegationPolicyService(f.documents, stage => { if (stage === stop) throw new Error("original reply lost"); });
      await assert.rejects(service.adopt(f.host), /original reply lost/); const original = f.documents.autoPolicyEvents(f.host.domain)[0]!.data;
      f.actor(); const issued = await f.service.adopt(f.host); assert.equal(issued.decisionId, original.decisionId); assert.equal(f.captures(), 1);
      assert.equal(f.service.authorize(f.host).policy.expiresAt, f.policy.expiresAt); assert.equal(f.service.status(f.host.domain).revision, 3);
    } finally { f.db.close(); }
  }
});
test("mutable scope denial after human capture preserves bytes and observed evidence without issuing a grant", async () => {
  const f = autoPolicyFixture(); try {
    const capture = f.host.capture; f.host.capture = async (...args) => { const raw = await capture(...args); f.drift(); return raw; };
    await assert.rejects(f.service.adopt(f.host), AutoWaitlistError);
    const status = f.service.status(f.host.domain); assert.equal(status.issuedAdoption, null); assert.equal(status.pendingReviews[0]!.phase, "observed");
    assert.ok(f.documents.autoPolicyCapture(f.host.domain, status.pendingReviews[0]!.reviewId)); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
  } finally { f.db.close(); }
});
test("revocation remains possible after expiry/source drift; Cancel retains the original valid policy", async () => {
  const f = autoPolicyFixture(); try {
    const adopted = await f.service.adopt(f.host); f.cancel(); assert.equal((await f.service.revoke(f.host)).outcome, "cancelled"); assert.equal(f.service.authorize(f.host).reference.decisionId, adopted.decisionId);
    f.host.capture = async r => bytes({ schemaVersion: "pa-auto-policy-native-review/v1", method: "ppa-auto-policy-foreground", reviewId: r.reviewId, decisionId: r.decisionId, operation: r.operation, policySha256: r.policySha256, target: r.target, principal: f.policy.domain.principal, interactionId: `interaction-${randomUUID()}`, outcome: "approved", boundary: "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation" });
    f.drift(); f.time(f.policy.expiresAt); const revoked = await f.service.revoke(f.host); assert.equal(revoked.target, adopted.decisionId);
    assert.equal((await f.service.revoke(f.host)).decisionId, revoked.decisionId); assert.equal(f.service.status(f.host.domain).issuedAdoption, null); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
  } finally { f.db.close(); }
});
test("explicit withdrawal fences a late original native capture but retains all original evidence", async () => {
  const f = autoPolicyFixture(); try {
    let release!: (raw: Uint8Array) => void, request: any; const old = f.host.capture;
    f.host.capture = async r => { request = r; return new Promise(resolve => { release = resolve; }); };
    const original = f.service.adopt(f.host); assert.ok(request); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
    const late = await old(request, f.policy); f.host.capture = old;
    const withdrawn = await f.service.withdraw(f.host); assert.equal(withdrawn.target, request.reviewId); assert.equal(f.service.status(f.host.domain).pendingReviews.length, 0);
    release(late); await assert.rejects(original, AutoWaitlistError);
    assert.ok(f.documents.autoPolicyCapture(f.host.domain, request.reviewId)); assert.equal(f.service.status(f.host.domain).issuedAdoption, null);
    await assert.rejects(f.service.adopt(f.host)); // no same-subject/ID reactivation
    f.policy.policyId = `policy-${randomUUID()}`;
    const next = await f.service.adopt(f.host); assert.notEqual(next.decisionId, request.decisionId);
  } finally { f.db.close(); }
});
test("invalid raw/async/foreign-principal captures refuse and callback mutation cannot rewrite original policy", async () => {
  for (const fault of ["raw", "async", "principal", "mutation"] as const) {
    const f = autoPolicyFixture(); try {
      if (fault === "raw") f.host.capture = async () => bytes({ approved: true, actor: "sinh", schemaVersion: "pa-auto-start/v1" });
      if (fault === "async") f.host.assertCurrent = (async () => {}) as any;
      if (fault === "principal") { const capture = f.host.capture; f.host.capture = async (...a) => bytes({ ...JSON.parse(Buffer.from(await capture(...a)).toString()), principal: "local-uid:43" }); }
      if (fault === "mutation") f.host.assertCurrent = policy => { policy.expiresAt = "2099-01-01T00:00:00.000Z"; };
      if (fault === "mutation") { await f.service.adopt(f.host); assert.equal(f.service.authorize(f.host).policy.expiresAt, f.policy.expiresAt); }
      else { await assert.rejects(f.service.adopt(f.host)); assert.throws(() => f.service.authorize(f.host)); }
    } finally { f.db.close(); }
  }
});
test("pending native revocation immediately holds eligibility and explicit withdrawal restores only the still-valid original policy", async () => {
  const f = autoPolicyFixture(); try {
    const adopted = await f.service.adopt(f.host);
    const held = new AutoDelegationPolicyService(f.documents, stage => { if (stage === "requested") throw new Error("revocation reply unknown"); });
    await assert.rejects(held.revoke(f.host)); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
    f.cancel(); assert.equal((await f.service.withdraw(f.host)).outcome, "cancelled"); assert.throws(() => f.service.authorize(f.host), AutoWaitlistError);
    const old = f.host.capture;
    f.host.capture = async (...a) => bytes({ ...JSON.parse(Buffer.from(await old(...a)).toString()), outcome: "approved" });
    await f.service.withdraw(f.host); assert.equal(f.service.authorize(f.host).reference.decisionId, adopted.decisionId);
  } finally { f.db.close(); }
});
test("two real policy owner fixture processes racing one scope capture once and preserve one original issuance", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-policy-race-")), path = join(root, "registry.db"), f = autoPolicyFixture(getDb(path));
  try {
    const policyPath = join(root, "policy.json"); writeFileSync(policyPath, bytes(f.policy));
    const run = () => new Promise<{ code: number | null; body: { captures: number } }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import=tsx", new URL("./fixtures/auto-policy-worker.mts", import.meta.url).pathname, path, policyPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", error = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { error += b; }); child.on("error", reject);
      child.on("close", code => { try { assert.ok(code === 0 || code === 2, error); resolve({ code, body: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    const results = await Promise.all([run(), run()]); assert.ok(results.some(r => r.code === 0)); assert.equal(results.reduce((n, r) => n + r.body.captures, 0), 1);
    assert.equal(f.documents.autoPolicyEvents(f.host.domain).length, 3); assert.ok(f.service.authorize(f.host).reference.decisionId);
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("policy/capture history is immutable and a forged issued-only row cannot pass native lineage checks", async () => {
  const f = autoPolicyFixture(); try {
    await f.service.adopt(f.host);
    for (const table of ["document_auto_policy_events", "document_auto_policy_captures"]) assert.throws(() => f.db.prepare(`DELETE FROM ${table}`).run(), /immutable|append-only/);
    assert.throws(() => f.service.authorize({ ...f.host, domain: "0".repeat(64) }), AutoWaitlistError);
    const prior = f.documents.autoPolicyEvents(f.host.domain).at(-1)!;
    const forged = { ...prior, revision: 4, predecessor: digest(JSON.stringify(prior)), data: { ...prior.data, reviewId: `review-${randomUUID()}`, decisionId: `decision-${randomUUID()}` } }, body = JSON.stringify(forged);
    f.db.prepare("INSERT INTO document_auto_policy_events(domain,revision,review_id,phase,predecessor,sha256,body) VALUES(?,?,?,?,?,?,?)").run(f.host.domain, 4, forged.data.reviewId, "issued", forged.predecessor, digest(body), body);
    assert.throws(() => f.service.authorize(f.host));
  } finally { f.db.close(); }
});
