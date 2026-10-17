import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inactiveOperatorProjection, MAX_PROTECTED_WORKFLOW_BYTES, parseActivationProjection, parsePreparationContract, parsePreparedReceipt, preparationIdentity, PreparationJournal, preparedCapability, ProtectedWorkflowStore, requirePreparedCapability, withPreparedWorkflowLocks, workflowDigest, workflowError, WORKFLOW_OUTPUT_LIMITS, type PreparationContract, type PreparedLockScope, type PublicationBoundary, type WorkflowJournalEntry } from "../deploy/prepared-workflow.js";
import { assertReceiptReservationBinding, assertReservationInventory, assertUnresetExecutionBounds, DEFAULT_EXECUTION_BOUNDS, executionBoundStop, parseExecutionBounds, parseExecutionCustody, parseIdlePreparationReservation, PREPARED_LOCK_ORDER, projectReservation } from "../deploy/execution-custody.js";

const sha = "a".repeat(40); const digest = "b".repeat(64); const time = "2026-10-17T00:00:00.000Z";
const source = (ref: string) => ({ ref, version: "r004", sha256: digest });
function contract(): PreparationContract {
  return parsePreparationContract({ schemaVersion: "prepared-workflow/v1", policyVersion: "prepared-autonomy/v1", repoKey: "fixture", repoRoot: "/fixture/canonical", ticket: "PAP-256", branch: "feature/PAP-256-fixture", integrationTarget: "origin/develop", approvalBaseSha: sha,
    requirements: source("requirements:pair.md"), uat: source("uat:pair.md"), promotionEvidence: "promoted:pair", signoffEvidence: "native:signoff", finalChecks: source("checks:final"), finalCheckCount: 13,
    matrix: source("requirements:pair.md"), matrixApprovalEvidence: "native:matrix" });
}
const idle = () => ({ state: "idle", holder: null, inFlightOperation: null });
function receipt() {
  const input = contract();
  return parsePreparedReceipt({ schemaVersion: "prepared-receipt/v1", operationId: preparationIdentity(input), receiptId: digest, state: "ready", contract: input,
    preparationBaseSha: sha, preparedHeadSha: sha, worktreeRoot: "/fixture/worktree", leaseRef: "lease:locator", capacityRef: "capacity:locator", custodyRef: "custody:locator", ticketReread: source("ticket:reread"), observedAt: time, nextOwner: "builder" });
}
function reservation(index = 1) {
  return parseIdlePreparationReservation({ schemaVersion: "prepared-reservation/v1", repoKey: "fixture", repoRoot: "/fixture/canonical", ticket: `PAP-${index}`, operationId: index.toString(16).padStart(64, "0"), reservationId: (index + 10).toString(16).padStart(64, "0"), repositoryPermit: index,
    occupancy: "idle-ready", lineageId: null, custody: idle(), receiptId: digest, retainedAt: time });
}
function bounds() {
  return parseExecutionBounds({ startedAt: time, deadlineAt: "2026-10-17T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null });
}
function locked<T>(action: (scope: PreparedLockScope) => T): T {
  return withPreparedWorkflowLocks({ repository: (run) => run(), worktree: (run) => run() }, action);
}
function fixture(action: (root: string, store: ProtectedWorkflowStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pap256-protected-fixture-"));
  // Only the disposable fixture is an authority root; no PA config/HOME/storage APIs are called.
  try { action(root, new ProtectedWorkflowStore(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function result(operationId: string, previous: unknown, sequence = 1): WorkflowJournalEntry {
  return { schemaVersion: "prepared-journal/v1", operationId, sequence, previousSha256: workflowDigest(JSON.stringify(previous)), action: "reservation", outcome: "observed", evidence: source("result:fixture"), recordedAt: time };
}

test("AC1/TS1 initial: optional policy is effect-free for absent, malformed, mismatched, revoked and forged projections", () => {
  let effects = 0; let getterRead = false;
  const hostile = Object.defineProperty({}, "enabled", { get() { getterRead = true; throw new Error("must not inspect"); } });
  for (const projection of [undefined, null, {}, { enabled: true }, { state: "revoked" }, { policyVersion: "unknown" }, receipt(), hostile]) {
    assert.deepEqual(preparedCapability(projection), { enabled: false, legacyUnchanged: true, reason: "phase-1-inactive" });
    assert.throws(() => { requirePreparedCapability(projection); effects += 1; }, /Condition:/);
  }
  assert.equal(effects, 0); assert.equal(getterRead, false);
  assert.deepEqual(inactiveOperatorProjection(), { schemaVersion: "prepared-activation-status/v1", policyVersion: "prepared-autonomy/v1", state: "inactive", activationAvailable: false });
  // No adapter imports/registration: this test proves local inactivity, not full baseline UAT.
});

test("AC2/TS2 initial: versioned promoted-source contract rejects unknown/missing/malformed fields, not prose authentication", () => {
  const input = contract(); assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.requirements));
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(preparationIdentity(reversed as unknown as PreparationContract), preparationIdentity(input));
  for (const patch of [{ schemaVersion: "v2" }, { policyVersion: "enabled" }, { finalCheckCount: 12 }, { approvalBaseSha: "A".repeat(40) }, { repoRoot: "relative" }, { branch: "feature/PAP-999-wrong" }, { requirements: { ...input.requirements, token: "private" } }, { uat: input.requirements }, { matrix: source("different:source") }, { extra: "no" }]) {
    assert.throws(() => parsePreparationContract({ ...input, ...patch }), /Condition:/);
  }
  const missing = { ...input } as Record<string, unknown>; delete missing["signoffEvidence"];
  assert.throws(() => parsePreparationContract(missing));
  assert.throws(() => parsePreparationContract(Object.create(input)));
  const accessor = { ...input }; Object.defineProperty(accessor, "signoffEvidence", { get() { throw new Error("do not invoke"); } });
  assert.throws(() => parsePreparationContract(accessor), /Condition:/);
  assert.notEqual(preparationIdentity({ ...input, signoffEvidence: "native:new" }), preparationIdentity(input));
  assert.notEqual(preparationIdentity({ ...input, uat: { ...input.uat, sha256: "c".repeat(64) } }), preparationIdentity(input));
  // A well-shaped forged signoff remains untrusted: no resolver/ready operation is delivered here.
  assert.equal(preparedCapability({ ...input, signoffEvidence: "forged:sinh" }).enabled, false);
});

test("AC1/AC20 initial: activation is a non-secret projection, not an enable switch or baseline dependency", () => {
  const projection = { schemaVersion: "prepared-activation-projection/v1", policyVersion: "prepared-autonomy/v1", state: "pending-runtime", runtimeSha: sha, runtimeVersion: "fixture", configSha: sha, verification: source("paired:fixture"), decisionRef: "native:operator" };
  assert.equal(parseActivationProjection(projection).state, "pending-runtime");
  for (const patch of [{ state: "active" }, { token: "PRIVATE-SENTINEL" }, { runtimeSha: "short" }, { decisionRef: "" }]) assert.throws(() => parseActivationProjection({ ...projection, ...patch }));
  assert.equal(preparedCapability(projection).enabled, false);
  assert.doesNotMatch(JSON.stringify(inactiveOperatorProjection()), /PRIVATE-SENTINEL|process|token|\/home/);
});

test("AC6/TS6 initial: receipt binds sources/base/HEAD/custody; mutable public receipt cannot grant authority", () => {
  const value = receipt();
  for (const patch of [{ operationId: "c".repeat(64) }, { preparedHeadSha: "unknown" }, { worktreeRoot: value.contract.repoRoot }, { state: "preparing" }, { protectedToken: "private" }, { contract: { ...value.contract, signoffEvidence: "forged" } }]) assert.throws(() => parsePreparedReceipt({ ...value, ...patch }));
  const bound = parseIdlePreparationReservation({ ...reservation(), ticket: value.contract.ticket, operationId: value.operationId });
  assert.doesNotThrow(() => assertReceiptReservationBinding(value, bound));
  for (const patch of [{ ticket: "PAP-1" }, { repoRoot: "/wrong/canonical" }, { receiptId: "c".repeat(64) }]) assert.throws(() => assertReceiptReservationBinding(value, { ...bound, ...patch }));
  assert.equal(preparedCapability(value).enabled, false);
  assert.equal(preparedCapability({ ...value, state: "consumed" }).enabled, false);
});

test("NFR2: lock composition orders repository -> worktree -> publication, rejects nesting/escaped scopes/async", () => {
  const events: string[] = []; let captured: PreparedLockScope | undefined;
  assert.deepEqual(PREPARED_LOCK_ORDER, ["canonical-repository-capacity", "worktree-admission", "journal-publication"]);
  const owners = { repository: <T>(run: () => T) => { events.push("repository+"); try { return run(); } finally { events.push("repository-"); } }, worktree: <T>(run: () => T) => { events.push("worktree+"); try { return run(); } finally { events.push("worktree-"); } } };
  withPreparedWorkflowLocks(owners, (scope) => { captured = scope; events.push("publication"); assert.throws(() => locked(() => 1)); });
  assert.deepEqual(events, ["repository+", "worktree+", "publication", "worktree-", "repository-"]);
  fixture((_, store) => {
    assert.throws(() => store.publish(captured!, `${digest}.intent.json`, {}));
    assert.throws(() => store.publish({ kind: "prepared-lock-scope" }, `${digest}.intent.json`, {}));
  });
  assert.throws(() => locked(() => Promise.resolve(1)));
  assert.equal(locked(() => 7), 7);
});

test("AC3/TS3 initial: immutable intent is durable/idempotent and precedes journal results; no ready API", () => fixture((root, store) => {
  const journal = new PreparationJournal(store); const input = contract(); const operationId = preparationIdentity(input);
  assert.throws(() => locked((scope) => journal.append(scope, result(operationId, {}))));
  const intent = locked((scope) => journal.intent(scope, input, time));
  assert.deepEqual(journal.readIntent(operationId), intent);
  assert.equal(lstatSync(join(root, `${operationId}.intent.json`)).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(root, `${operationId}.intent.json`)).nlink, 1);
  assert.deepEqual(locked((scope) => journal.intent(scope, input, time)), intent);
  assert.throws(() => locked((scope) => journal.intent(scope, input, "2026-10-17T01:00:00.000Z")));
  const entry = result(operationId, intent);
  locked((scope) => journal.append(scope, entry)); locked((scope) => journal.append(scope, entry));
  assert.deepEqual(journal.readEntry(operationId, 1), entry);
  assert.throws(() => locked((scope) => journal.append(scope, { ...entry, outcome: "uncertain" })));
  assert.throws(() => locked((scope) => journal.append(scope, { ...entry, sequence: 3, action: "branch" })));
  assert.throws(() => locked((scope) => journal.append(scope, { ...entry, action: "allocation" })));
  const second = { ...result(operationId, entry, 2), action: "allocation" as const };
  locked((scope) => journal.append(scope, second));
  assert.equal(readdirSync(root).filter((path) => path.endsWith(".json")).length, 3);
  assert.equal("ready" in journal, false); assert.equal("consume" in journal, false);
}));

for (const boundary of ["file-synced", "linked", "temporary-unlinked", "directory-synced"] as const) {
  test(`AC3/TS3 primitive crash at ${boundary}: preserve state, no false ready or duplicate target`, () => fixture((root, store) => {
    const journal = new PreparationJournal(store); const input = contract(); const operationId = preparationIdentity(input);
    const seen: PublicationBoundary[] = [];
    assert.throws(() => locked((scope) => journal.intent(scope, input, time, (point) => { seen.push(point); if (point === boundary) throw new Error("fixture crash"); })));
    assert.equal(seen.at(-1), boundary);
    const target = join(root, `${operationId}.intent.json`);
    if (boundary === "file-synced") {
      assert.equal(existsSync(target), false);
      assert.equal(readdirSync(root).length, 1); // forensic temporary retained, not discarded
      locked((scope) => journal.intent(scope, input, time));
    } else if (boundary === "linked") {
      assert.equal(lstatSync(target).nlink, 2); // crash alias is uncertain, never auto-repaired
      assert.throws(() => journal.readIntent(operationId));
      assert.throws(() => locked((scope) => journal.intent(scope, input, time)));
    } else {
      assert.equal(lstatSync(target).nlink, 1);
      assert.equal(journal.readIntent(operationId).operationId, operationId);
      locked((scope) => journal.intent(scope, input, time)); // repeat re-fsyncs directory
    }
    assert.equal(readdirSync(root).filter((name) => name === `${operationId}.intent.json`).length, 1);
  }));
}

test("AC5/TS5 initial: failed/uncertain result prevents successor and preserves exact original intent/results", () => {
  for (const outcome of ["failed", "uncertain"] as const) fixture((root, store) => {
    const journal = new PreparationJournal(store); const intent = locked((scope) => journal.intent(scope, contract(), time));
    const entry = { ...result(intent.operationId, intent), outcome };
    locked((scope) => journal.append(scope, entry));
    const before = readFileSync(join(root, `${intent.operationId}.1.json`));
    assert.throws(() => locked((scope) => journal.append(scope, { ...result(intent.operationId, entry, 2), action: "allocation" })));
    assert.deepEqual(readFileSync(join(root, `${intent.operationId}.1.json`)), before);
    assert.equal(readdirSync(root).length, 2);
  });
});

test("NFR2: protected store rejects permissions, symlinks, hard links, directories, traversal and oversized/malformed records", () => fixture((root, store) => {
  const name = `${digest}.intent.json`; const path = join(root, name);
  for (const value of ["../escape", "/tmp/escape", `${digest}.0.json`, `${digest}.intent.json/extra`]) assert.throws(() => locked((scope) => store.publish(scope, value, {})));
  assert.throws(() => locked((scope) => store.publish(scope, name, { huge: "x".repeat(MAX_PROTECTED_WORKFLOW_BYTES) })));
  assert.equal(readdirSync(root).length, 0);
  writeFileSync(path, "{}\n", { mode: 0o644 }); assert.throws(() => store.read(name)); rmSync(path);
  writeFileSync(path, "{}\n", { mode: 0o600 }); linkSync(path, join(root, "alias")); assert.throws(() => store.read(name)); rmSync(join(root, "alias")); rmSync(path);
  symlinkSync("missing", path); assert.throws(() => store.read(name)); assert.throws(() => locked((scope) => store.publish(scope, name, {}))); rmSync(path);
  mkdirSync(path); assert.throws(() => store.read(name)); rmSync(path, { recursive: true });
  writeFileSync(path, Buffer.alloc(MAX_PROTECTED_WORKFLOW_BYTES + 1), { mode: 0o600 }); assert.throws(() => store.read(name)); rmSync(path);
  writeFileSync(path, Buffer.from([0xff]), { mode: 0o600 }); assert.throws(() => store.read(name)); rmSync(path);
  writeFileSync(path, "{broken", { mode: 0o600 }); assert.throws(() => store.read(name)); rmSync(path);
  chmodSync(root, 0o755); assert.throws(() => new ProtectedWorkflowStore(root)); chmodSync(root, 0o700);
  mkdirSync(join(root, "private"), { mode: 0o700 }); symlinkSync(join(root, "private"), join(root, "linked"));
  assert.throws(() => new ProtectedWorkflowStore(join(root, "linked")));
  mkdirSync(join(root, "private", "nested"), { mode: 0o700 });
  assert.throws(() => new ProtectedWorkflowStore(join(root, "linked", "nested")));
}));

test("AC4/AC6 initial: four occupied tickets include idle/uncertain; duplicate/fifth inventory rejects with no allocation", () => {
  const pool = [reservation(1), reservation(2), reservation(3), reservation(4)];
  assert.equal(assertReservationInventory(pool).length, 4);
  const uncertain = parseIdlePreparationReservation({ ...pool[0], occupancy: "uncertain-retained", custody: { state: "uncertain-blocked", holder: null, inFlightOperation: null } });
  assert.equal(assertReservationInventory([uncertain, ...pool.slice(1)]).length, 4);
  let allocations = 0;
  for (const bad of [[...pool, pool[0]], [pool[0], pool[0]], [pool[0], { ...pool[1], repositoryPermit: 1 }], [pool[0], { ...pool[1], repoRoot: "/other/root" }]]) {
    assert.throws(() => { assertReservationInventory(bad); allocations += 1; });
  }
  assert.equal(allocations, 0);
  assert.throws(() => parseIdlePreparationReservation({ ...pool[0], expiresAt: time }));
  assert.throws(() => parseIdlePreparationReservation({ ...pool[0], occupancy: "active" }));
  assert.throws(() => parseIdlePreparationReservation({ ...pool[0], custody: { ...idle(), holder: { deploymentId: "d-000001" } } }));
  // A schema has no process-based release: requester death cannot change the parsed occupancy.
  assert.equal(projectReservation(pool[0]!).occupied, true);
});

test("NFR1/NFR3 schema: exactly one holder and immutable runtime/replacement/review/no-progress bounds", () => {
  const holder = { deploymentId: "d-000001", process: { pid: 1, startTimeTicks: "1234", bootId: "PRIVATE-FINGERPRINT" } };
  const custody = parseExecutionCustody({ state: "implement-child", holder, inFlightOperation: "check:1" });
  assert.equal(custody.state, "implement-child");
  assert.throws(() => parseExecutionCustody({ ...custody, holders: [holder, holder] }));
  assert.throws(() => parseExecutionCustody({ state: "idle", holder, inFlightOperation: null }));
  assert.throws(() => parseExecutionCustody({ state: "implement-child", holder: null, inFlightOperation: null }));
  assert.deepEqual(DEFAULT_EXECUTION_BOUNDS, { runtimeMinutes: 120, noProgressLimit: 3, replacementLimit: 3, reviewCap: 3 });
  const before = { ...bounds(), consecutiveNoProgress: 2, replacementsUsed: 2, reviewsUsed: 2, unresolvedFailureRef: "failure:original" };
  assert.doesNotThrow(() => assertUnresetExecutionBounds(before, { ...before, consecutiveNoProgress: 3 }));
  for (const patch of [{ consecutiveNoProgress: 0 }, { replacementsUsed: 0 }, { reviewsUsed: 0 }, { unresolvedFailureRef: "failure:renamed" }, { reviewCap: 2 }, { deadlineAt: "2026-10-17T03:00:00.000Z" }]) assert.throws(() => assertUnresetExecutionBounds(before, { ...before, ...patch }));
  for (const runtimeMinutes of [59, 241]) assert.throws(() => parseExecutionBounds({ ...bounds(), runtimeMinutes }));
  for (const runtimeMinutes of [60, 240]) assert.equal(parseExecutionBounds({ ...bounds(), runtimeMinutes, deadlineAt: new Date(Date.parse(time) + runtimeMinutes * 60_000).toISOString() }).runtimeMinutes, runtimeMinutes);
  for (const reviewCap of [1, 2, 3]) assert.equal(parseExecutionBounds({ ...bounds(), reviewCap }).reviewCap, reviewCap);
  assert.equal(executionBoundStop(bounds(), time), false);
  for (const value of [{ ...before, consecutiveNoProgress: 3 }, { ...before, replacementsUsed: 3 }, { ...before, reviewsUsed: 3 }]) assert.equal(executionBoundStop(value, time), true);
  assert.equal(executionBoundStop(bounds(), bounds().deadlineAt), true);
  const active = parseIdlePreparationReservation({ ...reservation(), occupancy: "active", lineageId: "lineage:1", custody });
  assert.doesNotMatch(JSON.stringify(projectReservation(active)), /PRIVATE-FINGERPRINT|startTimeTicks|bootId|pid|token/);
});

test("malformed/forged enum objects cannot coerce into receipt, journal or holder authority", () => {
  let invoked = false;
  const forged = { toString() { invoked = true; return "ready"; } };
  assert.throws(() => parsePreparedReceipt({ ...receipt(), state: forged }));
  assert.throws(() => parseExecutionCustody({ state: forged, holder: null, inFlightOperation: null }));
  assert.throws(() => parseIdlePreparationReservation({ ...reservation(), occupancy: forged }));
  assert.equal(invoked, false);
  fixture((_, store) => {
    const journal = new PreparationJournal(store);
    const intent = locked((scope) => journal.intent(scope, contract(), time));
    assert.throws(() => locked((scope) => journal.append(scope, { ...result(intent.operationId, intent), action: forged } as unknown as WorkflowJournalEntry)));
    assert.equal(invoked, false);
  });
});

test("bounded publication accepts exactly 65,536 bytes; forged durable intent and result chain never pass", () => fixture((root, store) => {
  const name = `${digest}.intent.json`; const body = "x".repeat(MAX_PROTECTED_WORKFLOW_BYTES - 3);
  locked((scope) => store.publish(scope, name, body));
  assert.equal(lstatSync(join(root, name)).size, MAX_PROTECTED_WORKFLOW_BYTES);
  assert.equal(store.read(name), body);
  const journal = new PreparationJournal(store); const operationId = preparationIdentity(contract());
  writeFileSync(join(root, `${operationId}.intent.json`), JSON.stringify({ schemaVersion: "prepared-intent/v1", operationId, contract: contract(), createdAt: time, token: "PRIVATE-FORGED" }), { mode: 0o600 });
  assert.throws(() => journal.readIntent(operationId));
  assert.throws(() => locked((scope) => journal.append(scope, result(operationId, {}))));
  assert.doesNotMatch(workflowError().message, /PRIVATE-FORGED/);
}));

test("NFR6/NFR8: bounded five-field diagnostics and exact output limits; no hidden truncation implementation claim", () => {
  const diagnostic = workflowError().message;
  for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(diagnostic.includes(field));
  assert.ok(diagnostic.length <= 2_000); assert.ok(diagnostic.split(/\s+/u).length <= 1_000);
  assert.deepEqual(WORKFLOW_OUTPUT_LIMITS, { markdown: 1_048_576, html: 4_194_304, diff: 10_485_760 });
  // These constants do not assert Phase 4 report/redaction/rendering or human delivery is delivered.
});
