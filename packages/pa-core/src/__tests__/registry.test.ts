import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MAX_PI_FOREGROUND_COMPLETION_BYTES, PI_FOREGROUND_COMPLETION_FILE, TicketAssociationError, TicketStore, appendEvaluatorResult, appendRegistryEvent, associateDeploymentTicket, closeDb, computeDeploymentStatuses, getDb, getDeploymentEvents, queryDeploymentStatus, queryEvaluatorResultsByTargetDeployment, readPiForegroundCompletion, reconcileTerminalRegistryEvent, reconcileTerminalRegistryEventIfAbsent, writePiForegroundCompletion } from "../index.js";

interface AssociationFixture {
  root: string;
  canonicalRoot: string;
  otherRoot: string;
  ticketsDir: string;
  writeTicket: (id: string, project?: string) => void;
}

function withAssociationFixture(run: (fixture: AssociationFixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-ticket-association-"));
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousUsage = process.env["PA_AI_USAGE_HOME"];
  const canonicalRoot = "/canonical/pa-platform";
  const otherRoot = "/canonical/other";
  const configDir = join(root, "config");
  const ticketsDir = join(root, "usage", "tickets");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), `repos:\n  pa-platform:\n    path: ${canonicalRoot}\n    prefix: PAP\n  other:\n    path: ${otherRoot}\n    prefix: OTH\n`);
  closeDb();
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  process.env["PA_PLATFORM_CONFIG"] = configDir;
  process.env["PA_AI_USAGE_HOME"] = join(root, "usage");
  const writeTicket = (id: string, project = "pa-platform"): void => {
    writeFileSync(join(ticketsDir, `${id}.json`), JSON.stringify({ id, project, title: id }));
  };
  try {
    for (const id of ["PAP-001", "PAP-002", "PAP-003"]) writeTicket(id);
    writeTicket("OTH-001", "other");
    run({ root, canonicalRoot, otherRoot, ticketsDir, writeTicket });
  } finally {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousUsage;
    rmSync(root, { recursive: true, force: true });
  }
}

function expectAssociationError(fn: () => unknown, code: TicketAssociationError["code"]): TicketAssociationError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TicketAssociationError);
  assert.equal(caught.code, code);
  return caught;
}

test("Pi foreground completion sidecars are atomic, bounded, mode 0600, and strictly validated", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-pi-completion-"));
  const path = join(root, PI_FOREGROUND_COMPLETION_FILE);
  try {
    writePiForegroundCompletion(root, {
      type: "registry_complete",
      deploymentId: "d-stage",
      status: "success",
      timestamp: "2026-08-30T00:00:00.000Z",
      summary: "staged summary",
      logFile: "/tmp/session.md",
      rating: { source: "agent", overall: 4, productivity: 3, quality: 5, efficiency: 4, insight: 4 },
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readPiForegroundCompletion(root), {
      type: "registry_complete",
      deploymentId: "d-stage",
      status: "success",
      timestamp: "2026-08-30T00:00:00.000Z",
      summary: "staged summary",
      logFile: "/tmp/session.md",
      rating: { source: "agent", overall: 4, productivity: 3, quality: 5, efficiency: 4, insight: 4 },
    });

    writeFileSync(path, "{not-json\n", { mode: 0o600 });
    assert.throws(() => readPiForegroundCompletion(root), /malformed or exceeds/);
    writeFileSync(path, "x".repeat(MAX_PI_FOREGROUND_COMPLETION_BYTES + 1), { mode: 0o600 });
    assert.throws(() => readPiForegroundCompletion(root), /malformed or exceeds/);
    assert.ok(readFileSync(path).byteLength > MAX_PI_FOREGROUND_COMPLETION_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticket association atomically attaches, replaces, audits, projects, and preserves start evidence", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    appendRegistryEvent({ deployment_id: "d-associate", team: "requirements", mode: "analyze", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot, primer: "immutable-primer" });
    const immutableStart = getDeploymentEvents("d-associate")[0];

    const attached = associateDeploymentTicket({ deploymentId: "d-associate", ticketId: "PAP-001", expectedTicketId: null, actor: "  operator  ", reason: "  ticket established  ", timestamp: "2026-09-24T00:01:00Z" });
    assert.deepEqual(attached, { deploymentId: "d-associate", previousTicketId: null, requestedTicketId: "PAP-001", currentTicketId: "PAP-001", actor: "operator", reason: "ticket established", writeOccurred: true });
    assert.equal(queryDeploymentStatus("d-associate")?.ticket_id, "PAP-001");
    assert.deepEqual(getDeploymentEvents("d-associate")[0], immutableStart);
    assert.deepEqual(getDeploymentEvents("d-associate")[1], {
      deployment_id: "d-associate",
      team: "requirements",
      event: "ticket-associated",
      timestamp: "2026-09-24T00:01:00.000Z",
      pid: undefined,
      status: null,
      summary: undefined,
      log_file: undefined,
      primer: undefined,
      agents: undefined,
      models: undefined,
      error: undefined,
      exit_code: undefined,
      ticket_id: "PAP-001",
      previous_ticket_id: null,
      actor: "operator",
      reason: "ticket established",
      provider: undefined,
      rating: undefined,
      objective: undefined,
      repo: undefined,
      repo_root: undefined,
      worktree_root: undefined,
      repository_slot: undefined,
      mode: undefined,
      fallback: false,
      resumed_from_deployment_id: undefined,
      note: undefined,
      runtime: null,
      binary: undefined,
      effective_timeout_seconds: undefined,
      rogue_one: false,
      invocation_channel: null,
      parent_deployment_id: undefined,
      builder_authority: undefined,
      treehouse_path: undefined,
      treehouse_lease_id: undefined,
      treehouse_lease_holder: undefined,
      branch_state: undefined,
      branch_base_sha: undefined,
      branch_head_sha: undefined,
      ticket_slot_id: undefined,
      repository_permit: undefined,
    });

    const replaced = associateDeploymentTicket({ deploymentId: "d-associate", ticketId: "PAP-002", expectedTicketId: "PAP-001", actor: "operator", reason: "correct association" });
    assert.deepEqual({ previous: replaced.previousTicketId, requested: replaced.requestedTicketId, current: replaced.currentTicketId, wrote: replaced.writeOccurred }, { previous: "PAP-001", requested: "PAP-002", current: "PAP-002", wrote: true });
    assert.equal(getDeploymentEvents("d-associate").filter((event) => event.event === "ticket-associated").length, 2);
    assert.equal(queryDeploymentStatus("d-associate")?.ticket_id, "PAP-002");

    const unchanged = associateDeploymentTicket({ deploymentId: "d-associate", ticketId: "PAP-002", expectedTicketId: "PAP-002", actor: "operator", reason: "verify idempotence" });
    assert.equal(unchanged.writeOccurred, false);
    assert.equal(getDeploymentEvents("d-associate").length, 3);
    assert.throws(() => appendRegistryEvent({ deployment_id: "d-associate", team: "requirements", event: "ticket-associated", timestamp: "2026-09-24T00:02:00Z", ticket_id: "PAP-003", previous_ticket_id: "PAP-002", actor: "bypass", reason: "bypass" }), /associateDeploymentTicket/);
  });
});

test("ticket association rolls back its audit event when projection persistence fails", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    appendRegistryEvent({ deployment_id: "d-association-rollback", team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot });
    getDb().exec("CREATE TRIGGER reject_ticket_projection BEFORE UPDATE OF ticket_id ON deployments BEGIN SELECT RAISE(ABORT, 'ticket projection failed'); END");
    assert.throws(() => associateDeploymentTicket({ deploymentId: "d-association-rollback", ticketId: "PAP-001", expectedTicketId: null, actor: "operator", reason: "attach" }), /ticket projection failed/);
    assert.equal(getDeploymentEvents("d-association-rollback").length, 1);
    assert.equal(queryDeploymentStatus("d-association-rollback")?.ticket_id, undefined);
  });
});

test("ticket association compare-and-set rejects a stale racing replacement with zero writes", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    appendRegistryEvent({ deployment_id: "d-association-race", team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot, ticket_id: "PAP-001" });
    associateDeploymentTicket({ deploymentId: "d-association-race", ticketId: "PAP-002", expectedTicketId: "PAP-001", actor: "caller-one", reason: "first correction" });
    expectAssociationError(() => associateDeploymentTicket({ deploymentId: "d-association-race", ticketId: "PAP-003", expectedTicketId: "PAP-001", actor: "caller-two", reason: "stale correction" }), "stale-expectation");
    assert.equal(queryDeploymentStatus("d-association-race")?.ticket_id, "PAP-002");
    assert.equal(getDeploymentEvents("d-association-race").filter((event) => event.event === "ticket-associated").length, 1);
  });
});

test("ticket association trims bounded audit text and rejects invalid limits without writes", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    appendRegistryEvent({ deployment_id: "d-association-limits", team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot });
    for (const [actor, reason, code] of [
      ["   ", "valid", "invalid-actor"],
      ["a".repeat(129), "valid", "invalid-actor"],
      ["valid", "   ", "invalid-reason"],
      ["valid", "r".repeat(1_001), "invalid-reason"],
    ] as const) {
      expectAssociationError(() => associateDeploymentTicket({ deploymentId: "d-association-limits", ticketId: "PAP-001", expectedTicketId: null, actor, reason }), code);
    }
    assert.equal(getDeploymentEvents("d-association-limits").length, 1);
    const result = associateDeploymentTicket({ deploymentId: "d-association-limits", ticketId: "PAP-001", expectedTicketId: null, actor: ` ${"a".repeat(128)} `, reason: ` ${"r".repeat(1_000)} ` });
    assert.equal(result.actor.length, 128);
    assert.equal(result.reason.length, 1_000);
  });
});

test("ticket association and ticket store reject non-canonical paths, unsafe aliases, symlinks, and loaded ID mismatches without writes", () => {
  withAssociationFixture(({ root, canonicalRoot, ticketsDir }) => {
    const store = new TicketStore(ticketsDir);
    const malformedOutsidePath = join(root, "usage", "outside.json");
    writeFileSync(malformedOutsidePath, "{outside-malformed-json");
    const outsideTicketPath = join(root, "outside-ticket.json");
    writeFileSync(outsideTicketPath, JSON.stringify({ id: "PAP-904", project: "pa-platform", title: "Outside" }));
    symlinkSync(outsideTicketPath, join(ticketsDir, "PAP-904.json"));
    writeFileSync(join(ticketsDir, "PAP-900.json"), JSON.stringify({ _alias: true, movedTo: "../outside" }));
    writeFileSync(join(ticketsDir, "PAP-901.json"), JSON.stringify({ id: "PAP-001", project: "pa-platform", title: "Mismatched" }));
    writeFileSync(join(ticketsDir, "PAP-902.json"), JSON.stringify({ _alias: true, movedTo: "PAP-001" }));
    writeFileSync(join(ticketsDir, "PAP-903.json"), JSON.stringify({ _alias: true, movedTo: "PAP-903" }));

    for (const id of ["../outside", "..\\outside", "/absolute/outside", "PAP/001", "PAP-1.json", "%2e%2e%2foutside", "..%2Foutside", "%252e%252e%252foutside"]) {
      assert.equal(store.get(id), undefined, id);
    }
    assert.equal(store.get("PAP-900"), undefined, "non-canonical alias target is rejected before lookup");
    assert.equal(store.get("PAP-901"), undefined, "loaded ticket ID must match its canonical filename");
    assert.equal(store.get("PAP-903"), undefined, "alias cycles are rejected");
    assert.equal(store.get("PAP-904"), undefined, "ticket symlinks are not followed");
    assert.equal(store.get("PAP-902")?.id, "PAP-001", "canonical aliases remain supported");

    const deploymentId = "d-association-paths";
    appendRegistryEvent({ deployment_id: deploymentId, team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot });
    const invalidTargets = [
      "", " PAP-001", "PAP-001 ", "pap-001", "../outside", "..\\outside", "/absolute/outside", "PAP/001",
      "PAP-../001", "PAP-1.json", "%2e%2e%2foutside", "..%2Foutside", "%252e%252e%252foutside", "A".repeat(65),
    ];
    for (const ticketId of invalidTargets) {
      const error = expectAssociationError(() => associateDeploymentTicket({ deploymentId, ticketId, expectedTicketId: null, actor: "operator", reason: "reject unsafe target" }), "invalid-ticket-id");
      assert.doesNotMatch(error.message, /outside-malformed-json|Unexpected token|absolute\/outside/);
      assert.equal(getDeploymentEvents(deploymentId).length, 1, ticketId);
      assert.equal(queryDeploymentStatus(deploymentId)?.ticket_id, undefined, ticketId);
    }
    for (const ticketId of ["PAP-900", "PAP-901", "PAP-903", "PAP-904"]) {
      expectAssociationError(() => associateDeploymentTicket({ deploymentId, ticketId, expectedTicketId: null, actor: "operator", reason: "reject invalid store entry" }), "ticket-not-found");
      assert.equal(getDeploymentEvents(deploymentId).length, 1, ticketId);
      assert.equal(queryDeploymentStatus(deploymentId)?.ticket_id, undefined, ticketId);
    }
    for (const expectedTicketId of ["../outside", "%2e%2e%2foutside", "PAP/001", " PAP-001"] as const) {
      expectAssociationError(() => associateDeploymentTicket({ deploymentId, ticketId: "PAP-001", expectedTicketId, actor: "operator", reason: "reject unsafe expectation" }), "invalid-ticket-id");
      assert.equal(getDeploymentEvents(deploymentId).length, 1, expectedTicketId);
      assert.equal(queryDeploymentStatus(deploymentId)?.ticket_id, undefined, expectedTicketId);
    }

    const validAlias = associateDeploymentTicket({ deploymentId, ticketId: "PAP-902", expectedTicketId: null, actor: "operator", reason: "preserve canonical alias" });
    assert.equal(validAlias.currentTicketId, "PAP-902");
    assert.equal(getDeploymentEvents(deploymentId).filter((event) => event.event === "ticket-associated").length, 1);
    assert.equal(queryDeploymentStatus(deploymentId)?.ticket_id, "PAP-902");
  });
});

test("ticket association rejects missing deployment, identity, unregistered, unknown, cross-project, and terminal targets atomically", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    expectAssociationError(() => associateDeploymentTicket({ deploymentId: "d-missing", ticketId: "PAP-001", expectedTicketId: null, actor: "operator", reason: "attach" }), "deployment-not-found");
    assert.equal(getDeploymentEvents("d-missing").length, 0);
    const cases = [
      { id: "d-no-identity", start: {}, ticket: "PAP-001", code: "repository-identity-missing" },
      { id: "d-unregistered", start: { repo_root: "/canonical/unregistered" }, ticket: "PAP-001", code: "repository-unregistered" },
      { id: "d-unknown-ticket", start: { repo_root: canonicalRoot }, ticket: "PAP-999", code: "ticket-not-found" },
      { id: "d-cross-project", start: { repo_root: canonicalRoot }, ticket: "OTH-001", code: "ticket-project-mismatch" },
    ] as const;
    for (const entry of cases) {
      appendRegistryEvent({ deployment_id: entry.id, team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", ...entry.start });
      const error = expectAssociationError(() => associateDeploymentTicket({ deploymentId: entry.id, ticketId: entry.ticket, expectedTicketId: null, actor: "operator", reason: "attach" }), entry.code);
      assert.ok(error.message.length <= 2_000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.match(error.message, new RegExp(label));
      assert.equal(getDeploymentEvents(entry.id).length, 1);
      assert.equal(queryDeploymentStatus(entry.id)?.ticket_id, undefined);
    }

    appendRegistryEvent({ deployment_id: "d-terminal-association", team: "requirements", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot });
    appendRegistryEvent({ deployment_id: "d-terminal-association", team: "requirements", event: "completed", timestamp: "2026-09-24T00:01:00Z", status: "success" });
    expectAssociationError(() => associateDeploymentTicket({ deploymentId: "d-terminal-association", ticketId: "PAP-001", expectedTicketId: null, actor: "operator", reason: "late attach" }), "deployment-not-running");
    assert.equal(getDeploymentEvents("d-terminal-association").length, 2);
    assert.equal(queryDeploymentStatus("d-terminal-association")?.ticket_id, undefined);
  });
});

test("ticket association permits builder attachment but rejects replacement for every protected evidence category", () => {
  withAssociationFixture(({ canonicalRoot }) => {
    appendRegistryEvent({ deployment_id: "d-builder-attach", team: "builder", mode: "implement", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot });
    assert.equal(associateDeploymentTicket({ deploymentId: "d-builder-attach", ticketId: "PAP-001", expectedTicketId: null, actor: "operator", reason: "late ticket" }).writeOccurred, true);
    const attachedReplacementError = expectAssociationError(() => associateDeploymentTicket({ deploymentId: "d-builder-attach", ticketId: "PAP-002", expectedTicketId: "PAP-001", actor: "operator", reason: "replace" }), "protected-builder-replacement");
    assert.ok(attachedReplacementError.message.length <= 2_000);

    const cases: Array<{ name: string; team?: string; mode?: string; column?: string; value?: string | number }> = [
      { name: "builder-orchestrator", team: "builder", mode: "orchestrator" },
      { name: "builder-implement", team: "builder", mode: "implement" },
      { name: "repository-slot", column: "repository_slot", value: "implement" },
      { name: "builder-authority", column: "builder_authority", value: "orchestrator" },
      { name: "treehouse-path", column: "treehouse_path", value: "/treehouse/worktree" },
      { name: "treehouse-lease", column: "treehouse_lease_id", value: "lease-1" },
      { name: "ticket-slot", column: "ticket_slot_id", value: "pa:pa-platform:PAP-001" },
      { name: "repository-permit", column: "repository_permit", value: 1 },
      { name: "parent-lineage", column: "parent_deployment_id", value: "d-parent" },
    ];
    for (const [index, entry] of cases.entries()) {
      const deploymentId = `d-protected-${index}`;
      appendRegistryEvent({ deployment_id: deploymentId, team: entry.team ?? "requirements", mode: entry.mode ?? "analyze", event: "started", timestamp: "2026-09-24T00:00:00Z", repo_root: canonicalRoot, ticket_id: "PAP-001" });
      if (entry.column) getDb().prepare(`UPDATE registry_events SET ${entry.column} = ? WHERE deployment_id = ? AND event = 'started'`).run(entry.value, deploymentId);
      const error = expectAssociationError(() => associateDeploymentTicket({ deploymentId, ticketId: "PAP-002", expectedTicketId: "PAP-001", actor: "operator", reason: `replace ${entry.name}` }), "protected-builder-replacement");
      assert.ok(error.message.length <= 2_000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.match(error.message, new RegExp(label));
      assert.equal(getDeploymentEvents(deploymentId).length, 1);
      assert.equal(queryDeploymentStatus(deploymentId)?.ticket_id, "PAP-001");
    }
  });
});

test("registry appends WAL-backed events and materializes deployment status", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", mode: "implement", event: "started", timestamp: "2026-04-26T10:00:00Z", agents: ["team-manager"], runtime: "opencode", binary: "opa", effective_timeout_seconds: 1200, repo: "/worktree", repo_root: "/primary", worktree_root: "/worktree", repository_slot: "implement", parent_deployment_id: "d-a1b2c3", builder_authority: "parented-implement", treehouse_path: "/worktree", treehouse_lease_id: "lease-1", treehouse_lease_holder: "pa:registered:PAP-1", branch_state: "materialized", branch_base_sha: "a".repeat(40), branch_head_sha: "b".repeat(40), ticket_slot_id: "pa:registered:PAP-1", repository_permit: 2 });
    appendRegistryEvent({ deployment_id: "d-test", team: "builder", event: "completed", timestamp: "2026-04-26T10:01:00Z", status: "success", summary: "ok", branch_state: "materialized", branch_base_sha: "a".repeat(40), branch_head_sha: "c".repeat(40) });
    const events = getDeploymentEvents("d-test");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.effective_timeout_seconds, 1200);
    const status = queryDeploymentStatus("d-test");
    assert.equal(status?.status, "success");
    assert.equal(status?.runtime, "opencode");
    assert.equal(status?.effective_timeout_seconds, 1200);
    assert.equal(status?.mode, "implement");
    assert.deepEqual({ repo: status?.repo, repoRoot: status?.repo_root, worktreeRoot: status?.worktree_root, slot: status?.repository_slot }, { repo: "/worktree", repoRoot: "/primary", worktreeRoot: "/worktree", slot: "implement" });
    assert.deepEqual({ parent: status?.parent_deployment_id, authority: status?.builder_authority, path: status?.treehouse_path, lease: status?.treehouse_lease_id, holder: status?.treehouse_lease_holder, state: status?.branch_state, base: status?.branch_base_sha, head: status?.branch_head_sha, ticketSlot: status?.ticket_slot_id, permit: status?.repository_permit }, { parent: "d-a1b2c3", authority: "parented-implement", path: "/worktree", lease: "lease-1", holder: "pa:registered:PAP-1", state: "materialized", base: "a".repeat(40), head: "c".repeat(40), ticketSlot: "pa:registered:PAP-1", permit: 2 });
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry persists rogue-one audit evidence without credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-rogue-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-rogue", team: "rogue-one", mode: "rogue-one", event: "started", timestamp: "2026-09-13T10:00:00Z", rogue_one: true, invocation_channel: "agent-api" });
    const event = getDeploymentEvents("d-rogue")[0];
    const status = queryDeploymentStatus("d-rogue");
    assert.equal(event?.rogue_one, true);
    assert.equal(event?.invocation_channel, "agent-api");
    assert.equal(status?.rogue_one, true);
    assert.equal(status?.invocation_channel, "agent-api");
    assert.deepEqual(Object.keys(event ?? {}).filter((key) => /credential|identity|authorization/i.test(key)), []);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry materializes effective timeout metadata from started events", () => {
  const statuses = computeDeploymentStatuses([
    { deployment_id: "d-timeout", team: "builder", event: "started", timestamp: "2026-04-26T10:00:00Z", effective_timeout_seconds: 1800 },
  ]);
  assert.equal(statuses[0]?.status, "running");
  assert.equal(statuses[0]?.effective_timeout_seconds, 1800);
});

test("terminal reconciliation atomically replaces success with failure and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-reconcile-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-reconcile", team: "builder", event: "started", timestamp: "2026-08-28T00:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-reconcile", team: "builder", event: "completed", timestamp: "2026-08-28T00:01:00Z", status: "success", summary: "agent success", exit_code: 0 });
    const failure = { deployment_id: "d-reconcile", team: "builder", event: "completed", timestamp: "2026-08-28T00:02:00Z", status: "failed", summary: "adapter exit 17", exit_code: 17 } as const;

    assert.equal(reconcileTerminalRegistryEvent(failure).retainedExisting, false);
    assert.equal(reconcileTerminalRegistryEvent(failure).retainedExisting, true);
    const terminal = getDeploymentEvents("d-reconcile").filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(terminal.map((event) => [event.status, event.summary, event.exit_code]), [["failed", "adapter exit 17", 17]]);
    assert.equal(queryDeploymentStatus("d-reconcile")?.status, "failed");
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("status-only terminal reconciliation retains every previously committed terminal result", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-status-only-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-status-only", team: "builder", event: "started", timestamp: "2026-08-28T00:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-status-only", team: "builder", event: "completed", timestamp: "2026-08-28T00:01:00Z", status: "success", summary: "supervisor success", exit_code: 0 });
    const result = reconcileTerminalRegistryEventIfAbsent({ deployment_id: "d-status-only", team: "builder", event: "crashed", timestamp: "2026-08-28T00:02:00Z", error: "synthetic status crash", exit_code: -1 });
    assert.equal(result.retainedExisting, true);
    assert.equal(result.event.status, "success");
    const terminal = getDeploymentEvents("d-status-only").filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(terminal.map((event) => [event.event, event.status, event.summary]), [["completed", "success", "supervisor success"]]);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal reconciliation rolls back history when projection persistence fails", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-atomic-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-atomic", team: "builder", event: "started", timestamp: "2026-08-28T00:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-atomic", team: "builder", event: "completed", timestamp: "2026-08-28T00:01:00Z", status: "success", summary: "agent success", exit_code: 0 });
    getDb().exec("CREATE TRIGGER reject_terminal_projection BEFORE UPDATE ON deployments WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'projection failed'); END");

    assert.throws(() => reconcileTerminalRegistryEvent({ deployment_id: "d-atomic", team: "builder", event: "completed", timestamp: "2026-08-28T00:02:00Z", status: "failed", summary: "adapter failure", exit_code: 1 }), /projection failed/);
    const terminal = getDeploymentEvents("d-atomic").filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(terminal.map((event) => [event.status, event.summary]), [["success", "agent success"]]);
    assert.equal(queryDeploymentStatus("d-atomic")?.status, "success");
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal reconciliation collapses conflicting history to the failed representation", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-conflict-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-conflict", team: "builder", event: "started", timestamp: "2026-08-28T00:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-conflict", team: "builder", event: "completed", timestamp: "2026-08-28T00:01:00Z", status: "success", summary: "agent success", exit_code: 0 });
    appendRegistryEvent({ deployment_id: "d-conflict", team: "builder", event: "crashed", timestamp: "2026-08-28T00:02:00Z", error: "agent crash", exit_code: 1 });

    reconcileTerminalRegistryEvent({ deployment_id: "d-conflict", team: "builder", event: "completed", timestamp: "2026-08-28T00:03:00Z", status: "success", summary: "adapter success", exit_code: 0 });
    const terminal = getDeploymentEvents("d-conflict").filter((event) => event.event === "completed" || event.event === "crashed");
    assert.deepEqual(terminal.map((event) => [event.event, event.error, event.exit_code]), [["crashed", "agent crash", 1]]);
    assert.equal(queryDeploymentStatus("d-conflict")?.status, "crashed");
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry schema-v13 migration expands the production event constraint without losing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-legacy-"));
  const dbPath = join(root, "registry.db");
  const canonicalRoot = "/canonical/pa-platform";
  const configDir = join(root, "config");
  const ticketsDir = join(root, "usage", "tickets");
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousUsage = process.env["PA_AI_USAGE_HOME"];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), `repos:\n  pa-platform:\n    path: ${canonicalRoot}\n    prefix: PAP\n`);
  writeFileSync(join(ticketsDir, "PAP-001.json"), JSON.stringify({ id: "PAP-001", project: "pa-platform", title: "Legacy association" }));

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO _meta (key, value) VALUES ('schema_version', '13');
    CREATE TABLE registry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      team TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('started', 'pid', 'completed', 'crashed', 'amended', 'updated')),
      timestamp TEXT NOT NULL,
      pid INTEGER,
      status TEXT,
      summary TEXT,
      log_file TEXT,
      primer TEXT,
      agents TEXT,
      models TEXT,
      error TEXT,
      exit_code INTEGER,
      ticket_id TEXT,
      provider TEXT,
      rating TEXT,
      objective TEXT,
      repo TEXT,
      repo_root TEXT,
      worktree_root TEXT,
      repository_slot TEXT,
      parent_deployment_id TEXT,
      builder_authority TEXT,
      treehouse_path TEXT,
      treehouse_lease_id TEXT,
      treehouse_lease_holder TEXT,
      branch_state TEXT,
      branch_base_sha TEXT,
      branch_head_sha TEXT,
      ticket_slot_id TEXT,
      repository_permit INTEGER,
      mode TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      note TEXT,
      runtime TEXT,
      binary TEXT,
      effective_timeout_seconds INTEGER,
      rogue_one INTEGER DEFAULT 0,
      invocation_channel TEXT
    );
    CREATE INDEX idx_events_deployment_id ON registry_events(deployment_id);
    CREATE INDEX idx_events_timestamp ON registry_events(timestamp);
    CREATE INDEX idx_events_team_timestamp ON registry_events(team, timestamp);
    CREATE TABLE deployments (
      deployment_id TEXT PRIMARY KEY,
      team TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT,
      completed_at TEXT,
      pid INTEGER,
      summary TEXT,
      log_file TEXT,
      primer TEXT,
      agents TEXT,
      models TEXT,
      ticket_id TEXT,
      objective TEXT,
      repo TEXT,
      repo_root TEXT,
      worktree_root TEXT,
      repository_slot TEXT,
      parent_deployment_id TEXT,
      builder_authority TEXT,
      treehouse_path TEXT,
      treehouse_lease_id TEXT,
      treehouse_lease_holder TEXT,
      branch_state TEXT,
      branch_base_sha TEXT,
      branch_head_sha TEXT,
      ticket_slot_id TEXT,
      repository_permit INTEGER,
      mode TEXT,
      provider TEXT,
      error TEXT,
      exit_code INTEGER,
      rating TEXT,
      fallback INTEGER DEFAULT 0,
      resumed_from_deployment_id TEXT,
      runtime TEXT,
      binary TEXT,
      effective_timeout_seconds INTEGER,
      rogue_one INTEGER DEFAULT 0,
      invocation_channel TEXT
    );
    INSERT INTO registry_events (id, deployment_id, team, event, timestamp, summary, primer, objective, repo_root, mode, runtime, binary)
    VALUES (7, 'd-legacy', 'requirements', 'started', '2026-04-26T10:00:00Z', 'legacy start', 'immutable primer', 'legacy objective', '${canonicalRoot}', 'analyze', 'opencode', 'opa');
    INSERT INTO registry_events (id, deployment_id, team, event, timestamp, summary, note)
    VALUES (11, 'd-legacy', 'requirements', 'updated', '2026-04-26T10:01:00Z', 'legacy update', 'preserved note');
    INSERT INTO deployments (deployment_id, team, status, started_at, summary, primer, objective, repo_root, mode, runtime, binary)
    VALUES ('d-legacy', 'requirements', 'running', '2026-04-26T10:00:00Z', 'legacy projection', 'immutable primer', 'legacy objective', '${canonicalRoot}', 'analyze', 'opencode', 'opa');
  `);
  legacyDb.close();

  closeDb();
  process.env["PA_REGISTRY_DB"] = dbPath;
  process.env["PA_PLATFORM_CONFIG"] = configDir;
  process.env["PA_AI_USAGE_HOME"] = join(root, "usage");
  try {
    const db = getDb();
    const eventColumns = db.prepare("PRAGMA table_info(registry_events)").all() as Array<{ name: string }>;
    const deploymentColumns = db.prepare("PRAGMA table_info(deployments)").all() as Array<{ name: string }>;
    assert.deepEqual(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get(), { value: "14" });
    for (const column of ["previous_ticket_id", "actor", "reason"]) assert.equal(eventColumns.some((entry) => entry.name === column), true);
    for (const column of ["parent_deployment_id", "builder_authority", "treehouse_path", "treehouse_lease_id", "treehouse_lease_holder", "branch_state", "branch_base_sha", "branch_head_sha", "ticket_slot_id", "repository_permit"]) {
      assert.equal(eventColumns.some((entry) => entry.name === column), true);
      assert.equal(deploymentColumns.some((entry) => entry.name === column), true);
    }
    const eventTableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registry_events'").get() as { sql: string }).sql;
    assert.doesNotMatch(eventTableSql, /CHECK\s*\(\s*event\s+IN/i);
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'registry_events' ORDER BY name").all(),
      [{ name: "idx_events_deployment_id" }, { name: "idx_events_team_timestamp" }, { name: "idx_events_timestamp" }],
    );
    assert.deepEqual(
      db.prepare("SELECT id, event, timestamp, summary, primer, note FROM registry_events WHERE deployment_id = 'd-legacy' ORDER BY id").all(),
      [
        { id: 7, event: "started", timestamp: "2026-04-26T10:00:00Z", summary: "legacy start", primer: "immutable primer", note: null },
        { id: 11, event: "updated", timestamp: "2026-04-26T10:01:00Z", summary: "legacy update", primer: null, note: "preserved note" },
      ],
    );

    const result = associateDeploymentTicket({
      deploymentId: "d-legacy",
      ticketId: "PAP-001",
      expectedTicketId: null,
      actor: "migration-test",
      reason: "prove constrained schema migration",
      timestamp: "2026-04-26T10:02:00Z",
    });
    assert.deepEqual(result, {
      deploymentId: "d-legacy",
      previousTicketId: null,
      requestedTicketId: "PAP-001",
      currentTicketId: "PAP-001",
      actor: "migration-test",
      reason: "prove constrained schema migration",
      writeOccurred: true,
    });
    assert.deepEqual(
      db.prepare("SELECT id, event, timestamp, previous_ticket_id, ticket_id, actor, reason FROM registry_events WHERE deployment_id = 'd-legacy' AND event = 'ticket-associated'").all(),
      [{ id: 12, event: "ticket-associated", timestamp: "2026-04-26T10:02:00.000Z", previous_ticket_id: null, ticket_id: "PAP-001", actor: "migration-test", reason: "prove constrained schema migration" }],
    );
    const status = queryDeploymentStatus("d-legacy");
    assert.equal(status?.ticket_id, "PAP-001");
    assert.equal(status?.status, "running");
    assert.equal(status?.summary, "legacy projection");
    assert.equal(status?.primer, "immutable primer");
    assert.equal(status?.runtime, "opencode");
    assert.equal(getDeploymentEvents("d-legacy").length, 3);
  } finally {
    closeDb();
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousUsage;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry stores evaluator ratings linked to deployments", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-registry-evaluator-"));
  const previous = process.env["PA_REGISTRY_DB"];
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-target", team: "builder", event: "started", timestamp: "2026-05-10T09:00:00Z" });
    appendRegistryEvent({ deployment_id: "d-eval", team: "builder", event: "started", timestamp: "2026-05-10T09:05:00Z" });
    appendEvaluatorResult({
      target_deployment_id: "d-target",
      evaluator_deployment_id: "d-eval",
      summary: "Evaluator pass complete",
      report_path: "agent-teams/builder/artifacts/2026-05-10-evaluator-report.md",
      evidence_refs: ["deployments/d-target/primer.md", "sessions/2026/05/agent-team/2026-05-10-d-target-builder.md"],
      findings: "All findings include evidence links.",
      rating: {
        source: "system",
        overall: 4,
        metrics: {
          productivity: 4,
          quality: 4,
          human_agency: 5,
        },
      },
      created_at: "2026-05-10T09:06:00Z",
    });

    const db = getDb();
    const fks = db.prepare("PRAGMA foreign_key_list(evaluator_ratings)").all() as Array<{ table: string; from: string; to: string }>;
    assert.equal(fks.some((entry) => entry.table === "deployments" && entry.from === "target_deployment_id" && entry.to === "deployment_id"), true);
    assert.equal(fks.some((entry) => entry.table === "deployments" && entry.from === "evaluator_deployment_id" && entry.to === "deployment_id"), true);

    const results = queryEvaluatorResultsByTargetDeployment("d-target");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.evaluator_deployment_id, "d-eval");
    assert.equal(results[0]?.rating.metrics.human_agency, 5);
    assert.equal(results[0]?.evidence_refs.length, 2);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
