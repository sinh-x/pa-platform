import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, TicketStore, resolveTrustedTicketMutationContext, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { executePiTicketStatus, runTicketStatusCommand } from "../ticket-status.js";

test("PAP-316 only authenticated selected finite ticket-status receives effective privilege; generic writers do not", () => {
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
    const binding = { schemaVersion: "pa-mode-capability-binding/v2", configRoot: config, configRevision: "a".repeat(40), resourcePath: "teams/analyst.yaml", resourceSha256: "b".repeat(64),
      profile: "pa-document-policy/v1", policy: { version: "pa-mode-capabilities/v1", allow: ["ticket.status"] }, repoKey: "example",
      identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }, resources: [{ path: "teams/analyst.yaml", sha256: "b".repeat(64) }] };
    const directory = ensureDeployDir("d-316301");
    emitStartedEvent({ deploymentId: "d-316301", team: "analyst", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, ticketId: "EX-001", note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
    emitPidEvent({ deploymentId: "d-316301", team: "analyst", pid: process.pid }); recordPiProcessIdentity("d-316301", directory, process.pid);
    Object.assign(process.env, { PA_DEPLOYMENT_ID: "d-316301", PA_DEPLOYMENT_DIR: directory, PA_TEAM: "analyst", PA_MODE: "analyze", PA_TICKET_ID: "EX-001", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    process.chdir(repo);
    let help = "";
    assert.equal(runTicketStatusCommand(["--help"], { stdout: text => { help += text; }, stderr: () => assert.fail("help must not fail") }), 0);
    assert.match(help, /natively bound analyst\/analyze/);
    const generic = resolveTrustedTicketMutationContext(); assert.equal(generic.privileged, false);
    assert.throws(() => new TicketStore(undefined, generic).update("EX-001", { status: "done" }), /status transitions/);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "finite-status" } };
    const request = { schemaVersion: "pa-ticket-status/v1", action: "inspect", project: "example", ticket: "EX-001" };
    const inspected = executePiTicketStatus(JSON.stringify(request), context);
    const set = { ...request, action: "set", requestId: "finite-only", expectedVersion: inspected.version, status: "requirement-review" };
    assert.equal(executePiTicketStatus(JSON.stringify(set), context).status, "requirement-review");
    assert.equal(store.get("EX-001")!.assignee, "sinh"); assert.equal(resolveTrustedTicketMutationContext().privileged, false);
    process.env.PA_TEAM = "requirements";
    assert.throws(() => executePiTicketStatus(JSON.stringify(request), context), /TICKET_STATUS_SESSION/);
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
