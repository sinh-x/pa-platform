import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";
import { appendRegistryEvent } from "../registry/index.js";
import { MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityBinding, parseModeCapabilityPolicy } from "../mode-capabilities.js";
import { planNativeHandoffTicket, nativeHandoffTicketVersion, type NativeHandoffPlanningHost } from "../documents/handoff-planning.js";
import { verifyLocalReviewOrigin } from "../documents/local-review.js";
import { assertLocalHandoffCaller } from "../documents/handoff-preflight.js";
import { handoffBranchIntentSha, type LocalHandoffReviewSubject } from "../documents/handoff-contract.js";
import { digest } from "../workflows/contracts.js";

test("PAP-316 public origin, effective plan attribution and same-version continuation remain separate authenticated facts", () => {
  const f = documentRuntimeFixture();
  try {
    process.env.PA_REGISTRY_DB = f.db.name;
    process.env.PA_AI_USAGE_HOME = f.root;
    execFileSync("git", ["init", "-b", "develop"], { cwd: f.repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable local develop"], { cwd: f.repo, stdio: "pipe" });
    const policy = parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["document.handoff", "document.local-review", "document.package"] });
    const binding = parseModeCapabilityBinding({ schemaVersion: "pa-mode-capability-binding/v2", configRoot: f.config, configRevision: "a".repeat(40), resourcePath: "teams/analyst.yaml", resourceSha256: "b".repeat(64),
      profile: "pa-document-policy/v1", policy, repoKey: "example", identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" },
      resources: [{ path: "teams/analyst.yaml", sha256: "b".repeat(64) }] });
    const raw = JSON.stringify(binding), started = { deployment_id: "d-316201", event: "started" as const, team: "analyst", mode: "analyze", runtime: "pi" as const, binary: "ppa" as const,
      timestamp: "2026-11-17T00:00:00Z", repo_root: f.repo, repo: f.repo, worktree_root: f.repo, ticket_id: "EX-1", note: MODE_CAPABILITY_SESSION, mode_capability_binding: raw };
    appendRegistryEvent(started);
    f.store.update("EX-1", { title: "Stable disposable identity fixture" });
    const caller = { deploymentId: started.deployment_id, sessionId: "disposable-origin", repoKey: "example", repoRoot: f.repo, ticket: "EX-1", selectionSha256: digest(raw), identitySha256: "a".repeat(64) };
    const host: NativeHandoffPlanningHost = { authenticate: () => caller, assertAvailable() {} };
    const planned = planNativeHandoffTicket(f.store, host, JSON.stringify({ schemaVersion: "pa-handoff-request/v1", action: "plan", ticket: "EX-1", requestId: "identity-plan", expectedTicketVersion: nativeHandoffTicketVersion(f.store.get("EX-1")!), branch: "feature/EX-1-identity" }), f.db);
    const subject: LocalHandoffReviewSubject = { schemaVersion: "pa-handoff-review/v2", documentSubjectSha256: f.sha256, branchIntentSha256: handoffBranchIntentSha(planned.intent), deliverySha256: "c".repeat(64),
      callerIdentitySha256: caller.identitySha256, selectionSha256: caller.selectionSha256, effects: { publish: true, branchRef: true, queue: true },
      origin: { deploymentId: caller.deploymentId, sessionId: caller.sessionId, planIdentity: planned.identity } };
    verifyLocalReviewOrigin(f.db, f.store, subject, planned.intent);
    assert.equal(f.store.inspectHandoffWithIntent(planned.identity)!.record.actor, "requirements/analyze");
    // Only disposable fixture rows are corrupted to prove crossed identities fail.
    f.db.prepare("UPDATE registry_events SET team='requirements' WHERE deployment_id=? AND event='started'").run(caller.deploymentId);
    assert.throws(() => verifyLocalReviewOrigin(f.db, f.store, subject, planned.intent), /DOCUMENT_AUTHORITY/);
    f.db.prepare("UPDATE registry_events SET team='analyst' WHERE deployment_id=? AND event='started'").run(caller.deploymentId);
    assert.throws(() => assertLocalHandoffCaller(f.db, subject, planned.intent, { ...caller, deploymentId: "d-316202", sessionId: "continuation" }), /DOCUMENT_/);
    // Linux PIDs are bounded well below this value. The owner independently
    // verifies ESRCH; completion prose alone is not proof of process death.
    appendRegistryEvent({ deployment_id: caller.deploymentId, event: "pid", timestamp: "2026-11-17T00:01:00Z", team: "analyst", pid: 2147483000 });
    appendRegistryEvent({ deployment_id: caller.deploymentId, event: "completed", timestamp: "2026-11-17T00:02:00Z", team: "analyst", status: "success", summary: "Disposable source origin ended" });
    appendRegistryEvent({ ...started, deployment_id: "d-316202" });
    const continuation = { ...caller, deploymentId: "d-316202", sessionId: "continuation", identitySha256: "d".repeat(64) };
    assert.doesNotThrow(() => assertLocalHandoffCaller(f.db, subject, planned.intent, continuation));
    const historical = JSON.stringify(createModeCapabilityBinding("a".repeat(40), Buffer.from("retained requirements"), policy));
    f.db.prepare("UPDATE registry_events SET team='requirements',mode_capability_binding=? WHERE deployment_id=? AND event='started'").run(historical, continuation.deploymentId);
    f.db.prepare("UPDATE deployments SET team='requirements',mode_capability_binding=? WHERE deployment_id=?").run(historical, continuation.deploymentId);
    assert.throws(() => assertLocalHandoffCaller(f.db, subject, planned.intent, { ...continuation, selectionSha256: digest(historical) }), /DOCUMENT_AUTHORITY/);
    verifyLocalReviewOrigin(f.db, f.store, subject, planned.intent);
  } finally { f.close(); }
});
