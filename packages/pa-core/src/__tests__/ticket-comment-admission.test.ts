import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../registry/index.js";
import { emitStartedEvent } from "../deploy/events.js";
import { getTicketsDir } from "../paths.js";
import { TicketStore, resolveTrustedTicketMutationContext } from "../tickets/store.js";
import { ticketAdminService } from "../tickets/admin-service.js";
import { TicketCommentError } from "../tickets/comment-admission.js";
import { statusVersion } from "../tickets/status-intent.js";
import { workflowCommentCompatible } from "../workflows/ticket-owner.js";
import type { WorkflowState } from "../workflows/service.js";

function fixture(run: (store: TicketStore, call: (request: unknown) => Record<string, unknown>, root: string) => void) {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap345-comment-")); closeDb();
  try {
    for (const key of Object.keys(process.env)) if (/^PA_/.test(key)) delete process.env[key];
    const config = join(root, "config"); mkdirSync(config);
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${root}\n  prefix: EX\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root, PA_REGISTRY_DB: join(root, "registry.db"), NO_COLOR: "1" });
    emitStartedEvent({ deploymentId: "d-345000", team: "coordinator", mode: "coordinate", runtime: "pi" });
    const caller = { deploymentId: "d-345000", team: "coordinator", mode: "coordinate", repoKey: "example", identitySha256: "a".repeat(64) };
    const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
    run(store, request => ticketAdminService(JSON.stringify(request), { store, authenticate: () => caller }), root);
  } finally { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}
const create = { action: "create", project: "example", requestId: "target", fields: { title: "Recovery target" } };
const append = { action: "comment", project: "example", id: "EX-001", content: "Coordination only" };
const snapshot = () => readdirSync(getTicketsDir()).filter(name => name.endsWith(".json") || name.endsWith(".jsonl"))
  .sort().map(name => [name, readFileSync(join(getTicketsDir(), name), "utf8")]);

test("comment preserves all exact status/planning/create intent bytes at both interruption points", () => {
  for (const kind of ["status", "planning", "create"] as const) for (const stop of ["intent", "ticket"] as const) fixture((store, call) => {
    if (kind !== "create") call(create);
    const identity = { scope: "b".repeat(64), requestId: `original-${kind}` }, version = kind === "create" ? "" : statusVersion(store.get("EX-001")!);
    const input = { project: "example", title: "Recovery target", summary: "", description: "", status: "idea" as const, priority: "medium" as const,
      type: "task" as const, estimate: "M" as const, assignee: "sinh", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] };
    const finish = (interrupt: boolean) => {
      const hooks = { assertCurrent() {}, afterPersist(stage: string) { if (interrupt && stage === stop) throw Error("Synthetic interruption"); } };
      if (kind === "status") return store.setStatusWithIntent("EX-001", version, "requirement-review", "coordinator/coordinate", identity, hooks);
      if (kind === "planning") return store.patchPlanningWithIntent("EX-001", version, { summary: "Planned" }, "coordinator/coordinate", identity, hooks);
      return store.createWithIntent(input, "coordinator/coordinate", identity, hooks);
    };
    assert.throws(() => finish(true), /Synthetic interruption/);
    if (kind === "create" && stop === "intent") {
      // Target is not materialized yet, so semantic validation is the correct refusal.
      assert.throws(() => call(append), /TICKET_ADMIN_INPUT/);
    } else {
      const before = snapshot();
      assert.throws(() => call(append), /TICKET_COMMENT_PENDING/);
      assert.deepEqual(snapshot(), before, "refusal cannot rewrite ticket, audit or original intent");
    }
    assert.equal(finish(false).reused, true);
    const intents = snapshot().filter(([name]) => name!.startsWith(".ticket-"));
    call(append);
    assert.equal(store.get("EX-001")!.comments.length, 1);
    assert.deepEqual(snapshot().filter(([name]) => name!.startsWith(".ticket-")), intents);
  });
});

test("unreadable/corrupt relevant audit and intent evidence refuse comments, not custody prose", () => {
  for (const evidence of ["audit", "status", "registry"] as const) fixture((_store, call, root) => {
    call(create);
    if (evidence === "registry") { closeDb(); writeFileSync(join(root, "registry.db"), "Not a database"); }
    else writeFileSync(join(getTicketsDir(), evidence === "audit" ? "audit.jsonl" : `.ticket-status-${"f".repeat(64)}.json`), "{torn");
    const before = snapshot();
    assert.throws(() => call(append), /TICKET_COMMENT_UNPROVEN/);
    assert.deepEqual(snapshot(), before);
  });
});

test("unrelated incomplete intents do not block append; stale status CAS is not silently refreshed", () => fixture((store, call) => {
  call(create); call({ ...create, requestId: "other" });
  const identity = { scope: "b".repeat(64), requestId: "other-status" };
  assert.throws(() => store.setStatusWithIntent("EX-002", statusVersion(store.get("EX-002")!), "requirement-review", "coordinator/coordinate", identity,
    { assertCurrent() {}, afterPersist(stage) { if (stage === "intent") throw Error("Other interrupted"); } }), /Other interrupted/);
  const version = statusVersion(store.get("EX-001")!);
  call(append); call(append);
  assert.equal(store.get("EX-001")!.comments.length, 2, "identical legitimate text is not deduplicated");
  const before = snapshot();
  assert.throws(() => call({ action: "set-status", project: "example", id: "EX-001", requestId: "stale-status", expectedVersion: version, status: "requirement-review" }), /TICKET_STATUS_STALE/);
  assert.deepEqual(snapshot(), before);
}));

test("workflow compatibility is closed over known owner/operation/version, not pending alone", () => {
  for (const [owner, id] of [["tickets", "publication.pair"], ["tickets", "ticket.queue"], ["execution", "source.local"], ["validation", "check.matrix"], ["operator", "decision.package"]]) {
    const state = { pending: [{ stepId: "one", owner }], definition: { steps: [{ id: "one", owner, operation: { id, version: "v1" } }] } } as unknown as WorkflowState;
    assert.equal(workflowCommentCompatible(state), true);
    for (const operation of [{ id: "unknown", version: "v1" }, { id, version: "v2" }]) {
      assert.equal(workflowCommentCompatible({ ...state, definition: { ...state.definition, steps: [{ ...state.definition.steps[0]!, operation }] } } as WorkflowState), false);
    }
  }
});

test("typed comment diagnostics are bounded, plain and do not disclose arbitrary private evidence", () => {
  for (const code of ["TICKET_COMMENT_PENDING", "TICKET_COMMENT_UNPROVEN", "TICKET_COMMENT_UNCERTAIN"] as const) {
    const error = new TicketCommentError(code);
    assert.ok(error.message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(error.message.split(`${label}:`).length, 2);
    assert.doesNotMatch(error.message, /administrative status request|\u001b/);
    assert.match(error.message, code === "TICKET_COMMENT_UNCERTAIN" ? /outcome unknown/ : /did not start/);
  }
});
