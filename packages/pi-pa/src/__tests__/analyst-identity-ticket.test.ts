import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, TicketStore, resolveTrustedTicketMutationContext, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, READONLY_DOCUMENT_SESSION, parseModeCapabilityBinding } from "@pa-platform/pa-core";
import { recordPiProcessIdentity, recordPiReadonlyRoleProcessIdentity } from "../process-identity.js";
import { executePiTicketStatus, runTicketStatusCommand } from "../ticket-status.js";

for (const generic of [false, true]) test(`${generic ? "PAP-318 v3 public builder spelling" : "PAP-316 v2"}: only authenticated finite ticket-status receives effective privilege`, () => {
  const publicTeam = generic ? "builder" : "analyst", publicMode = generic ? "report" : "analyze";
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap316-native-ticket-")); closeDb();
  const repo = join(root, "repo"), config = join(root, "config");
  try {
    mkdirSync(repo); mkdirSync(config); mkdirSync(join(root, "usage"));
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "registry.db") });
    const store = new TicketStore();
    // Existing-only disposable ticket, not a generic public creation grant.
    writeFileSync(join(root, "usage/tickets/EX-001.json"), JSON.stringify({ id: "EX-001", project: "example", title: "Finite privilege fixture", status: "idea", assignee: "sinh", createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" }));
    const binding = { schemaVersion: generic ? "pa-mode-capability-binding/v3" : "pa-mode-capability-binding/v2", configRoot: config, configRevision: "a".repeat(40), resourcePath: `teams/${publicTeam}.yaml`, resourceSha256: "b".repeat(64),
      profile: generic ? "pa-readonly-document/v1" : "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: ["ticket.status"] }, repoKey: "example",
      identity: { publicTeam, publicMode, effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }, resources: [{ path: `teams/${publicTeam}.yaml`, sha256: "b".repeat(64) }] };
    const directory = ensureDeployDir("d-316301");
    emitStartedEvent({ deploymentId: "d-316301", team: publicTeam, mode: publicMode, runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, ticketId: "EX-001", note: generic ? READONLY_DOCUMENT_SESSION : MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(generic ? parseModeCapabilityBinding(binding) : binding) });
    emitPidEvent({ deploymentId: "d-316301", team: publicTeam, pid: process.pid }); recordPiProcessIdentity("d-316301", directory, process.pid);
    Object.assign(process.env, { PA_DEPLOYMENT_ID: "d-316301", PA_DEPLOYMENT_DIR: directory, PA_TEAM: publicTeam, PA_MODE: publicMode, PA_TICKET_ID: "EX-001", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    process.chdir(repo);
    let help = "";
    assert.equal(runTicketStatusCommand(["--help"], { stdout: text => { help += text; }, stderr: () => assert.fail("help must not fail") }), 0);
    assert.match(help, /natively bound analyst\/analyze/);
    const genericContext = resolveTrustedTicketMutationContext(); assert.equal(genericContext.privileged, false);
    assert.throws(() => new TicketStore(undefined, genericContext).update("EX-001", { status: "done" }), /status transitions/);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "finite-status" } };
    const request = { schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: "EX-001" };
    const inspected = executePiTicketStatus(JSON.stringify(request), context);
    const set = { ...request, action: "set", requestId: "finite-only", expectedVersion: inspected.version, status: "requirement-review" };
    assert.equal(executePiTicketStatus(JSON.stringify(set), context).status, "requirement-review");
    assert.equal(store.get("EX-001")!.assignee, "sinh"); assert.equal(resolveTrustedTicketMutationContext().privileged, false);
    getDb().prepare("UPDATE registry_events SET note=? WHERE deployment_id=? AND event='started'").run(generic ? MODE_CAPABILITY_SESSION : READONLY_DOCUMENT_SESSION, "d-316301");
    assert.throws(() => executePiTicketStatus(JSON.stringify(request), context), /TICKET_STATUS_SESSION/, "a binding cannot be relabeled as another session version");
    getDb().prepare("UPDATE registry_events SET note=? WHERE deployment_id=? AND event='started'").run(generic ? READONLY_DOCUMENT_SESSION : MODE_CAPABILITY_SESSION, "d-316301");
    if (generic) {
      getDb().prepare("UPDATE registry_events SET mode_capability_binding=? WHERE deployment_id=? AND event='started'").run("private-synthetic-invalid", "d-316301");
      assert.throws(() => recordPiReadonlyRoleProcessIdentity(process.env, "d-316301", directory, process.pid), error => {
        assert.ok(error instanceof Error); assert.match(error.message, /CAPABILITY_BINDING/); assert.doesNotMatch(error.message, /private-synthetic-invalid/); return true;
      });
      getDb().prepare("UPDATE registry_events SET mode_capability_binding=? WHERE deployment_id=? AND event='started'").run(JSON.stringify(parseModeCapabilityBinding(binding)), "d-316301");
    }
    process.env.PA_TEAM = "requirements";
    assert.throws(() => executePiTicketStatus(JSON.stringify(request), context), /TICKET_STATUS_SESSION/);
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
