import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assessTestWorkflow, classifyTestResult, parseTestAuthorization, parseTestWorkflowEvent, requirementsTestCapability, testWorkflowInvalidation, REQUIREMENTS_TEST_LIMITS, REQUIREMENTS_TEST_WORKFLOW_VERSION, type TestAuthorization, type TestCheck, type TestEventData, type TestProcessResult, type TestResource, type TestWorkflowEvent } from "../deploy/requirements-test-workflow.js";
import { workflowDigest, parsePreparationContract } from "../deploy/prepared-workflow.js";
import { type IdlePreparationReservation } from "../deploy/execution-custody.js";

// All identities/processes/sources here are synthetic MODEL evidence, never installed authority.
const sha = (value: string): string => value.repeat(40);
const digest = (value: string): string => workflowDigest(value);
const source = (name: string) => ({ ref: `synthetic:${name}`, version: "r001", sha256: digest(name) });
const processHolder = (deploymentId = "d-222222", pid = 202) => ({ deploymentId, process: { pid, startTimeTicks: String(pid * 100), bootId: "synthetic-boot" } });
const encode = (value: unknown): string => JSON.stringify(value);
function packet(): TestAuthorization {
  const baseline = { id: "baseline", kind: "baseline", assertion: "Q2", reason: "Q2-preserved", controlFor: null, input: source("valid-input"), command: "node test/oracle.mjs --baseline", cwd: ".", environment: [{ name: "CI", source: source("nonsecret-CI") }], timeoutSeconds: 30, maxOutputBytes: 4096 };
  return parseTestAuthorization(encode({ schemaVersion: REQUIREMENTS_TEST_WORKFLOW_VERSION, kind: "authorization", operationId: digest("operation"), repository: { key: "example", root: "/synthetic/canonical", ticket: "EX-1", baseSha: sha("a"), branch: "feature/EX-1-oracle", selectedHeadSha: sha("a") }, parent: { holder: processHolder("d-111111", 101), runtime: "pi", team: "requirements", mode: "analyze", channel: "foreground", root: "/synthetic/canonical" }, contract: source("contract"), assertions: source("assertions"), pair: { runtimeSha: sha("b"), configSha: sha("c"), qualification: source("pair"), toolsAuditDecision: source("tools-audit-not-sandbox") }, approvalOwner: "sinh", scope: "test-only", productBehavior: "forbidden", paths: [{ path: "test/oracle.mjs", role: "test", existence: "new", beforeSha256: null, actions: ["write", "edit"], rationale: "Q1/Q2 executable recipient assertions" }, { path: "test/harness.mjs", role: "harness", existence: "existing", beforeSha256: digest("old-harness"), actions: ["edit"], rationale: "Explicitly named isolated wrong-output support, not product scaffolding" }], checks: [baseline, { ...baseline, id: "feature", kind: "feature", assertion: "Q1", reason: "Q1-not-retrievable-through-T", command: "node test/oracle.mjs --feature" }, { ...baseline, id: "control", kind: "control", assertion: "Q1", reason: "Q1-not-retrievable-through-T", command: "node test/oracle.mjs --wrong-output", controlFor: "feature", input: source("intact-values-wrong-consumer-output") }], humanOnly: ["recipient-live-observation"], bounds: { startedAt: "2026-10-22T00:00:00.000Z", deadlineAt: "2026-10-22T02:00:00.000Z", runtimeMinutes: 120, consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null }, retryLimit: 3, retriesUsed: 0, elapsedMs: 0, cancellation: "retain", resume: "first-unproven", amendment: null }));
}
function resultFor(check: TestCheck): TestProcessResult {
  const startedElapsedMs = check.kind === "baseline" ? 3000 : check.kind === "feature" ? 3100 : 3200;
  return { checkId: check.id, command: check.command, cwd: check.cwd, environment: check.environment, candidateSha: sha("d"), input: check.input, process: processHolder("d-222222", 303), stdout: source(`stdout-${check.id}`), stderr: source(`stderr-${check.id}`), assertionEvidence: source(`assertion-${check.id}`), exitCode: check.kind === "baseline" ? 0 : 1, signal: null, disposition: "exited", startedElapsedMs, finishedElapsedMs: startedElapsedMs + 100, durationMs: 100, outputBytes: 100, truncated: false, observations: [{ assertion: check.assertion, outcome: check.kind === "baseline" ? "satisfied" : "violated", reason: check.reason }] };
}
function retained(auth: TestAuthorization): TestResource {
  return { repository: auth.repository, worktreeRoot: "/synthetic/ticket", leaseId: "synthetic-lease", leaseHolder: "pa:example:EX-1", reservationId: digest("reservation"), repositoryPermit: 1, lineageId: "one-lineage" };
}
function inventory(auth: TestAuthorization, owner = processHolder()): readonly IdlePreparationReservation[] {
  return [{ schemaVersion: "prepared-reservation/v1", repoKey: auth.repository.key, repoRoot: auth.repository.root, ticket: auth.repository.ticket, operationId: auth.operationId, reservationId: digest("reservation"), repositoryPermit: 1, occupancy: "active", lineageId: "one-lineage", custody: { state: "implement-child", holder: owner, inFlightOperation: null }, receiptId: digest("receipt"), retainedAt: auth.bounds.startedAt }];
}
function append(authText: string, history: readonly string[], data: TestEventData, overrides: Partial<TestWorkflowEvent> = {}): string[] {
  const auth = parseTestAuthorization(authText);
  const previous = history.at(-1);
  const last = previous ? parseTestWorkflowEvent(previous) : null;
  const entry: TestWorkflowEvent = { schemaVersion: REQUIREMENTS_TEST_WORKFLOW_VERSION, kind: "event", operationId: auth.operationId, authorizationSha256: digest(authText), sequence: history.length + 1, previousSha256: digest(previous ?? authText), bounds: last?.bounds ?? auth.bounds, retriesUsed: last?.retriesUsed ?? auth.retriesUsed, elapsedMs: (last?.elapsedMs ?? auth.elapsedMs) + 1000, evidence: source(`native-event-${history.length + 1}`), data, ...overrides };
  return [...history, encode(entry)];
}
function fixture() {
  const auth = packet(); const authText = encode(auth); const resource = retained(auth);
  let history: string[] = [];
  history = append(authText, history, { action: "authorized", owner: "sinh", decision: source("standalone-test-only-approval") });
  history = append(authText, history, { action: "intent-recorded", intentId: digest("test-intent") });
  history = append(authText, history, { action: "test-holder-active", intentId: digest("test-intent"), resource, holder: processHolder(), inventory: inventory(auth), registry: source("test-registry"), launchSnapshot: source("test-launch") });
  history = append(authText, history, { action: "test-settled", holder: processHolder(), settlement: source("actual-process-and-registry-settlement"), git: { baseSha: sha("a"), initialHeadSha: sha("a"), testHeadSha: sha("d"), ancestry: [sha("a")], commits: [{ sha: sha("d"), parentSha: sha("a"), changes: [{ path: "test/oracle.mjs", previousPath: null, beforeSha256: null, afterSha256: digest("oracle-bytes") }] }], files: [{ path: "test/oracle.mjs", sha256: digest("oracle-bytes") }, { path: "test/harness.mjs", sha256: digest("old-harness") }], porcelainV2Base64: "", inventory: source("complete-NUL-safe-history-and-content") }, results: auth.checks.map(resultFor) });
  const oracle = assessTestWorkflow(authText, history).oracle!;
  history = append(authText, history, { action: "oracle-reviewed", oracle, reviewer: "sinh", delegation: null, decision: source("independent-semantic-review"), outcomeRationale: "Q1 must be retrievable through T, not merely present in source", wrongOutputRationale: "Intact values in an inaccessible substitute must be rejected" });
  history = append(authText, history, { action: "final-approved", owner: "sinh", oracle, reviewSha256: digest(history[4]!), pair: { requirements: source("final-requirements"), uat: source("final-uat"), matrix: { ...source("raw-matrix"), ref: source("final-requirements").ref }, matrixApproval: source("matrix-approval"), finalChecks: source("13-checks"), finalCheckCount: 13 }, decision: source("whole-document-exact-approval") });
  history = append(authText, history, { action: "product-intent", resource, initialHeadSha: sha("d"), finalApprovalSha256: digest(history[5]!), intentId: digest("product-intent") });
  const product = processHolder("d-333333", 404);
  history = append(authText, history, { action: "product-consumed", resource, initialHeadSha: sha("d"), intentId: digest("product-intent"), holder: product, previousHolder: processHolder(), inventory: inventory(auth, product), launchSnapshot: source("product-snapshot-before-spawn"), registry: source("product-registry") });
  return { auth, authText, history };
}
type KeyPath = readonly (string | number)[];
function replace(input: unknown, path: KeyPath, value: unknown, remove = false): unknown {
  const clone: unknown = JSON.parse(encode(input));
  let cursor = clone as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  const key = path.at(-1)!;
  if (remove) delete cursor[key]; else cursor[key] = value;
  return clone;
}
function rechain(authText: string, history: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of history) {
    const row = JSON.parse(raw) as Record<string, unknown>;
    result.push(encode({ ...row, sequence: result.length + 1, previousSha256: digest(result.at(-1) ?? authText), authorizationSha256: digest(authText) }));
  }
  return result;
}
function altered(index: number, path: KeyPath, value: unknown, remove = false): { authText: string; history: string[] } {
  const f = fixture(); const history = f.history.slice(0, index + 1);
  history[index] = encode(replace(JSON.parse(history[index]!), path, value, remove));
  return { authText: f.authText, history: rechain(f.authText, history) };
}
function rejectsModel(index: number, path: KeyPath, value: unknown, remove = false): void {
  const f = altered(index, path, value, remove);
  assert.throws(() => assessTestWorkflow(f.authText, f.history), /Condition:.*stopped/);
}

// TS identifiers are stable source-model mappings; installed/native/human closure is in the contract.
test("TS01 AC1/AC12: no JSON, environment-like object or forged caller can activate selection", () => {
  const malicious = new Proxy({}, { get() { throw new Error("must not consult supplied authority"); } });
  for (const input of [undefined, packet(), { active: true, adapter: "pi", authorityRoot: "/tmp/forged", PA_MODE: "analyze" }, malicious]) {
    assert.deepEqual(requirementsTestCapability(input), { enabled: false, legacyUnchanged: true, reason: "unqualified-inactive" });
  }
  assert.throws(() => parsePreparationContract(packet()));
});
test("TS02 AC2: exact strict packet roundtrip, frozen nested records, all required keys and unknown keys reject", () => {
  const auth = packet(); assert.deepEqual(parseTestAuthorization(encode(auth)), auth);
  assert.ok(Object.isFrozen(auth)); assert.ok(Object.isFrozen(auth.paths)); assert.ok(Object.isFrozen(auth.parent.holder.process));
  const walk = (value: unknown, path: KeyPath = []): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((entry, i) => walk(entry, [...path, i])); return; }
    for (const [key, child] of Object.entries(value)) {
      assert.throws(() => parseTestAuthorization(encode(replace(auth, [...path, key], null, true))), `${[...path, key]} missing`);
      walk(child, [...path, key]);
    }
    assert.throws(() => parseTestAuthorization(encode(replace(auth, [...path, "unknown"], true))), `${path} unknown`);
  };
  walk(auth);
});
test("TS03 AC1/AC2: duplicate decoded keys, malformed/legacy/version/UTF8/bounds/prototype input reject", () => {
  const raw = encode(packet());
  const invalid: (string | Uint8Array)[] = ["", "fresh prose", "[]", raw + "{}", raw.replace('"kind":"authorization"', '"kind":"authorization","k\\u0069nd":"authorization"'), raw.replace('"runtime":"pi"', '"runtime":"pi","runtime":"pi"'), raw.replace('"version":"r001"', '"version":"r001","version":"r001"'), raw.replace('"kind":"authorization"', '"kind":"authorization",'), raw.replace("workflow/v1", "workflow/v2"), raw.replace('"kind":"authorization"', '"__proto__":{},"kind":"authorization"'), "\ufeff" + raw, new Uint8Array([0xff]), "\ud800", raw.replace("r001", "\\ud800"), " ".repeat(REQUIREMENTS_TEST_LIMITS.recordBytes + 1)];
  for (const input of invalid) assert.throws(() => parseTestAuthorization(input));
  assert.throws(() => parseTestAuthorization(raw.replace('"kind":"authorization"', '"extra":' + "[".repeat(65) + "0" + "]".repeat(65) + ',"kind":"authorization"')));
});
const packetMutations: readonly [string, KeyPath, unknown][] = [
  ["OPA", ["parent", "runtime"], "opencode"], ["CPA", ["parent", "runtime"], "claude"], ["auto", ["parent", "mode"], "analyze-auto"], ["spike", ["parent", "mode"], "spike"], ["review", ["parent", "mode"], "review"], ["background", ["parent", "channel"], "background"], ["worktree parent", ["parent", "root"], "/synthetic/ticket"], ["product scope", ["scope"], "product"], ["author approval", ["approvalOwner"], "d-222222"], ["short git", ["repository", "baseSha"], "abc"], ["uppercase git", ["repository", "baseSha"], sha("A")], ["short digest", ["assertions", "sha256"], "abc"], ["uppercase digest", ["assertions", "sha256"], "A".repeat(64)], ["wrong branch", ["repository", "branch"], "feature/EX-2-oracle"], ["fresh head drift", ["repository", "selectedHeadSha"], sha("e")], ["path escape", ["paths", 0, "path"], "../product.ts"], ["alias", ["paths", 0, "path"], "test/./oracle.mjs"], ["hidden config", ["paths", 0, "path"], ".git/config"], ["backslash", ["paths", 0, "path"], "test\\oracle.mjs"], ["rename op", ["paths", 0, "actions", 0], "rename"], ["missing harness explanation", ["paths", 1, "rationale"], ""], ["new path edit only", ["paths", 0, "actions"], ["edit"]], ["credential env", ["checks", 0, "environment", 0, "name"], "JWT_SECRET"], ["literal env injection", ["checks", 0, "environment", 0, "source"], { literal: "token" }], ["timeout zero", ["checks", 0, "timeoutSeconds"], 0], ["output zero", ["checks", 0, "maxOutputBytes"], 0], ["output overflow", ["checks", 0, "maxOutputBytes"], 16_777_217], ["deadline mismatch", ["bounds", "deadlineAt"], "2026-10-22T00:00:00.000Z"], ["extended runtime", ["bounds", "runtimeMinutes"], 241], ["retry overflow", ["retryLimit"], 4], ["same wrong output", ["checks", 2, "input"], source("valid-input")], ["ineffective control mapping", ["checks", 2, "controlFor"], "baseline"], ["control wrong assertion", ["checks", 2, "assertion"], "Q2"], ["no control", ["checks"], packet().checks.slice(0, 2)], ["cleanup", ["cancellation"], "cleanup"]
];
for (const [name, path, value] of packetMutations) test(`TS04 AC1/AC2 negative: ${name}`, () => assert.throws(() => parseTestAuthorization(encode(replace(packet(), path, value)))));

test("TS05 AC3/AC7/AC9/AC10: complete ordered model computes oracle readiness, never runtime authority/product PASS", () => {
  const f = fixture();
  const stages = ["unrequested", "authorized", "intent-recorded", "test-holder-active", "test-settled", "oracle-reviewed", "final-approved", "product-intent", "product-consumed"];
  for (let i = 0; i <= f.history.length; i++) {
    const state = assessTestWorkflow(f.authText, f.history.slice(0, i));
    assert.equal(state.state, stages[i]); assert.equal(state.runtimeAuthorized, false); assert.equal(state.productPass, false);
    assert.equal(state.firstUnprovenAction, stages[i + 1] ?? "none");
  }
  const settled = parseTestWorkflowEvent(f.history[3]!).data;
  assert.equal(settled.action, "test-settled");
  if (settled.action !== "test-settled") return;
  assert.deepEqual(settled.results.map((result, i) => classifyTestResult(f.auth.checks[i]!, result)), ["baseline-pass", "intended-assertion-red", "wrong-output-rejected"]);
});
test("TS06 AC7: broken harness, arbitrary nonzero, missing/ineffective control, unknown, timeout/truncation never count as RED", () => {
  const check = packet().checks[1]!; const raw = resultFor(check);
  const mutations: readonly [KeyPath, unknown][] = [[["exitCode"], 0], [["exitCode"], null], [["disposition"], "unknown"], [["disposition"], "timeout"], [["disposition"], "cancelled"], [["disposition"], "not-run"], [["signal"], "SIGKILL"], [["truncated"], true], [["durationMs"], 30_001], [["outputBytes"], 4097], [["command"], "node unapproved.mjs"], [["cwd"], "other"], [["input"], source("wrong-input")], [["observations", 0, "reason"], "arbitrary nonzero"], [["observations", 0, "outcome"], "runner-error"], [["observations", 0, "outcome"], "import-error"], [["observations", 0, "outcome"], "prerequisite-error"], [["observations", 0, "outcome"], "unknown"]];
  for (const [path, value] of mutations) assert.equal(classifyTestResult(check, replace(raw, path, value) as TestProcessResult), "blocked", String(path));
  rejectsModel(3, ["data", "results"], [resultFor(packet().checks[0]!), resultFor(check)]);
  rejectsModel(3, ["data", "results", 2, "exitCode"], 0);
  rejectsModel(3, ["data", "results", 1, "candidateSha"], sha("e"));
  rejectsModel(3, ["data", "results", 1, "process", "deploymentId"], "d-999999");
  rejectsModel(3, ["data", "results", 1, "passed"], true);
  rejectsModel(3, ["data", "results", 1, "stdout"], null);
  rejectsModel(3, ["data", "results", 1, "startedElapsedMs"], 1000);
  rejectsModel(3, ["data", "results", 1, "finishedElapsedMs"], 5000);
  rejectsModel(3, ["data", "results"], packet().checks.map(resultFor).reverse());
});
test("TS07 AC3/AC4: shared-owner inventory and exact sole holder/resource, no fifth or duplicate lineage", () => {
  for (const [path, value] of [
    [["data", "intentId"], digest("other-intent")], [["data", "resource", "worktreeRoot"], "/synthetic/canonical"], [["data", "resource", "repository", "baseSha"], sha("e")], [["data", "resource", "repository", "branch"], "feature/EX-1-other"], [["data", "resource", "leaseHolder"], "other"], [["data", "resource", "repositoryPermit"], 5], [["data", "holder"], packet().parent.holder], [["data", "inventory", 0, "custody", "holder"], processHolder("d-444444")], [["data", "inventory", 0, "custody", "state"], "uncertain-blocked"], [["data", "inventory", 0, "custody", "inFlightOperation"], "unsettled"], [["data", "inventory", 0, "operationId"], digest("other")], [["data", "inventory", 0, "reservationId"], digest("other")], [["data", "inventory", 0, "lineageId"], "other"], [["data", "inventory", 0, "occupancy"], "settled-retained"]
  ] as readonly [KeyPath, unknown][]) rejectsModel(2, path, value);
  const recycledParent = processHolder("d-111111", 999);
  const parentAlias = altered(2, ["data", "holder"], recycledParent);
  parentAlias.history[2] = encode(replace(JSON.parse(parentAlias.history[2]!), ["data", "inventory", 0, "custody", "holder"], recycledParent));
  assert.throws(() => assessTestWorkflow(parentAlias.authText, rechain(parentAlias.authText, parentAlias.history)), "parent deployment cannot become test child via another fingerprint");
  const base = inventory(packet())[0]!;
  const rows = [base, ...[2, 3, 4].map((n) => ({ ...base, ticket: `EX-${n}`, operationId: digest(`op-${n}`), reservationId: digest(`res-${n}`), repositoryPermit: n, occupancy: "settled-retained", lineageId: `lineage-${n}`, custody: { state: "idle", holder: null, inFlightOperation: null } }))];
  const four = altered(2, ["data", "inventory"], rows); assert.equal(assessTestWorkflow(four.authText, four.history).state, "test-holder-active");
  rejectsModel(2, ["data", "inventory"], [...rows, { ...rows[3], ticket: "EX-5", repositoryPermit: 5 }]);
  rejectsModel(2, ["data", "inventory"], [base, base]);
  rejectsModel(2, ["data", "inventory"], [base, { ...rows[1], lineageId: base.lineageId }]);
});
test("TS08 AC9: service sequence/hash order, not author dates; duplicate/reordered/missing/forged history rejects", () => {
  const f = fixture();
  for (let i = 0; i < f.history.length; i++) {
    if (i < f.history.length - 1) assert.throws(() => assessTestWorkflow(f.authText, f.history.filter((_, n) => n !== i)));
    const wrongSequence = f.history.slice(0, i + 1);
    wrongSequence[i] = encode(replace(JSON.parse(wrongSequence[i]!), ["sequence"], 42));
    assert.throws(() => assessTestWorkflow(f.authText, wrongSequence));
    rejectsModel(i, ["operationId"], digest("other-operation"));
    rejectsModel(i, ["agentTimestamp"], "2020-01-01T00:00:00.000Z");
  }
  const reversed = [f.history[1]!, f.history[0]!]; assert.throws(() => assessTestWorkflow(f.authText, rechain(f.authText, reversed)));
  assert.throws(() => assessTestWorkflow(f.authText, [...f.history.slice(0, 2), f.history[1]!]));
  rejectsModel(3, ["elapsedMs"], 1);
  rejectsModel(3, ["data", "git", "commits", 0, "parentSha"], sha("e"));
  rejectsModel(3, ["data", "git", "ancestry"], [sha("e")]);
  rejectsModel(3, ["data", "git", "files", 0, "sha256"], digest("not-committed-content"));
  rejectsModel(3, ["data", "git", "commits", 0, "changes", 0, "path"], "src/product.ts");
  rejectsModel(3, ["data", "git", "commits", 0, "changes", 0, "previousPath"], "src/renamed-product.ts");
  rejectsModel(3, ["data", "git", "porcelainV2Base64"], Buffer.from("? src/untracked.ts\0").toString("base64"));
  rejectsModel(3, ["data", "git", "porcelainV2Base64"], "not-base64");
});
test("TS09 AC8/AC9: independent semantic review and exact full oracle/final approval bindings", () => {
  rejectsModel(4, ["data", "reviewer"], "d-222222"); rejectsModel(4, ["data", "reviewer"], "d-111111"); rejectsModel(4, ["data", "reviewer"], "named-reviewer");
  const delegated = altered(4, ["data", "reviewer"], "named-reviewer");
  delegated.history[4] = encode(replace(JSON.parse(delegated.history[4]!), ["data", "delegation"], source("sinh-named-reviewer")));
  assert.equal(assessTestWorkflow(delegated.authText, rechain(delegated.authText, delegated.history)).state, "oracle-reviewed");
  for (const index of [4, 5]) for (const [path, value] of [
    [["authorizationSha256"], digest("other")], [["contract", "sha256"], digest("other")], [["assertions", "version"], "r002"], [["testHeadSha"], sha("e")], [["files", 0, "path"], "test/other.mjs"], [["files", 0, "sha256"], digest("other")], [["resultsSha256"], digest("other")], [["gitSha256"], digest("other")]
  ] as readonly [KeyPath, unknown][]) rejectsModel(index, ["data", "oracle", ...path], value);
  rejectsModel(4, ["data", "wrongOutputRationale"], ""); rejectsModel(4, ["data", "humanUatPassed"], true);
  rejectsModel(5, ["data", "reviewSha256"], digest("other-review")); rejectsModel(5, ["data", "owner"], "test-author");
  rejectsModel(5, ["data", "pair", "finalCheckCount"], 12); rejectsModel(5, ["data", "pair", "matrixApproval"], null);
});
test("TS10 AC10: continuation is exact retained transfer at approved test HEAD, never reacquisition/fallback", () => {
  for (const index of [6, 7]) {
    rejectsModel(index, ["data", "initialHeadSha"], sha("a"));
    rejectsModel(index, ["data", "resource", "worktreeRoot"], "/synthetic/reacquired");
    rejectsModel(index, ["data", "resource", "reservationId"], digest("new-reservation"));
    rejectsModel(index, ["data", "resource", "lineageId"], "new-lineage");
    rejectsModel(index, ["data", "resource", "leaseId"], "new-lease");
    rejectsModel(index, ["data", "resource"], null);
    rejectsModel(index, ["data", "legacyFallback"], true);
  }
  rejectsModel(6, ["data", "finalApprovalSha256"], digest("stale-final"));
  rejectsModel(7, ["data", "holder"], processHolder());
  rejectsModel(7, ["data", "holder"], processHolder("d-222222", 999));
  rejectsModel(7, ["data", "holder"], processHolder("d-111111", 999));
  rejectsModel(7, ["data", "previousHolder"], processHolder("d-444444"));
  rejectsModel(7, ["data", "inventory", 0, "custody", "holder"], processHolder());
  for (const recycled of [processHolder("d-222222", 999), processHolder("d-111111", 999)]) {
    const alias = altered(7, ["data", "holder"], recycled);
    alias.history[7] = encode(replace(JSON.parse(alias.history[7]!), ["data", "inventory", 0, "custody", "holder"], recycled));
    assert.throws(() => assessTestWorkflow(alias.authText, rechain(alias.authText, alias.history)), "new fingerprint cannot recycle author/parent deployment identity");
  }
});
test("TS11 AC11: every interruption retains prefix/resource/counters; unknown/cancelled/failed are barriers", () => {
  const f = fixture();
  for (let point = 1; point < f.history.length; point++) {
    const prefix = f.history.slice(0, point); const before = assessTestWorkflow(f.authText, prefix);
    for (const disposition of ["known-absent", "unknown", "cancelled", "failed"] as const) {
      const interrupted = append(f.authText, prefix, { action: "interrupted", disposition, evidence: source(`original-${disposition}-${point}`) });
      const blocked = assessTestWorkflow(f.authText, interrupted);
      assert.equal(blocked.state, "blocked"); assert.equal(blocked.firstUnprovenAction, before.firstUnprovenAction); assert.deepEqual(blocked.resource, before.resource); assert.deepEqual(blocked.bounds, before.bounds);
      assert.deepEqual(interrupted.slice(0, point), prefix);
      const retry = append(f.authText, interrupted, { action: "retry", interruptionSha256: digest(interrupted.at(-1)!), owner: "sinh", decision: source("operator-manual-retry") }, { retriesUsed: 1 });
      if (disposition !== "known-absent") assert.throws(() => assessTestWorkflow(f.authText, retry));
      else {
        const resumed = assessTestWorkflow(f.authText, retry); assert.equal(resumed.retriesUsed, 1); assert.equal(resumed.firstUnprovenAction, before.firstUnprovenAction); assert.deepEqual(resumed.resource, before.resource);
        const next = parseTestWorkflowEvent(f.history[point]!).data;
        assert.equal(assessTestWorkflow(f.authText, append(f.authText, retry, next)).state, next.action);
      }
    }
  }
});
test("TS12 AC11: accounting/deadlines survive resume and third no-progress/replacement/review exhaustion blocks", () => {
  const f = fixture();
  rejectsModel(2, ["elapsedMs"], 7_200_000);
  rejectsModel(2, ["bounds", "replacementsUsed"], 3);
  rejectsModel(2, ["bounds", "reviewsUsed"], 3);
  let history = f.history.slice(0, 2);
  for (let used = 1; used <= 3; used++) {
    history = append(f.authText, history, { action: "interrupted", disposition: "known-absent", evidence: source(`failure-${used}`) });
    history = append(f.authText, history, { action: "retry", interruptionSha256: digest(history.at(-1)!), owner: "sinh", decision: source(`retry-${used}`) }, { retriesUsed: used });
    assert.equal(assessTestWorkflow(f.authText, history).retriesUsed, used);
  }
  const interrupted = append(f.authText, history, { action: "interrupted", disposition: "known-absent", evidence: source("fourth") });
  const fourth = append(f.authText, interrupted, { action: "retry", interruptionSha256: digest(interrupted.at(-1)!), owner: "sinh", decision: source("fourth-retry") }, { retriesUsed: 4 });
  assert.throws(() => assessTestWorkflow(f.authText, fourth));
  const last = parseTestWorkflowEvent(history.at(-1)!);
  assert.throws(() => assessTestWorkflow(f.authText, append(f.authText, history, parseTestWorkflowEvent(f.history[2]!).data, { retriesUsed: 0 })));
  assert.throws(() => assessTestWorkflow(f.authText, append(f.authText, history, parseTestWorkflowEvent(f.history[2]!).data, { bounds: { ...last.bounds, startedAt: "2026-10-22T01:00:00.000Z", deadlineAt: "2026-10-22T03:00:00.000Z" } })));
  const failed = append(f.authText, f.history.slice(0, 2), { action: "interrupted", disposition: "failed", evidence: source("original-failure") }, { bounds: { ...f.auth.bounds, consecutiveNoProgress: 3, unresolvedFailureRef: "synthetic:original-failure" } });
  assert.equal(assessTestWorkflow(f.authText, failed).state, "blocked");
  const wrongFailure = append(f.authText, f.history.slice(0, 2), { action: "interrupted", disposition: "failed", evidence: source("unrelated-failure") }, { bounds: { ...f.auth.bounds, consecutiveNoProgress: 1, unresolvedFailureRef: "synthetic:original-failure" } });
  assert.throws(() => assessTestWorkflow(f.authText, wrongFailure), "original failure must bind its actual retained evidence");
  const reset = append(f.authText, failed, { action: "retry", interruptionSha256: digest(failed.at(-1)!), owner: "sinh", decision: source("reset") }, { bounds: f.auth.bounds, retriesUsed: 1 });
  assert.throws(() => assessTestWorkflow(f.authText, reset));
});
test("TS13 AC9/AC11: material amendment explicitly retains source/tuple/oracle history and invalidates downstream evidence", () => {
  const f = fixture(); const reviewed = assessTestWorkflow(f.authText, f.history.slice(0, 5));
  assert.deepEqual(testWorkflowInvalidation(f.authText, f.authText), []);
  assert.throws(() => testWorkflowInvalidation(f.authText, encode({ ...f.auth, assertions: source("new-assertions") })));
  const next = { ...f.auth, elapsedMs: reviewed.elapsedMs, operationId: digest("new-version-operation"), assertions: source("new-assertions"), paths: f.auth.paths.map((path) => ({ ...path, existence: "existing", beforeSha256: reviewed.oracle!.files.find((file) => file.path === path.path)!.sha256 })), repository: { ...f.auth.repository, selectedHeadSha: sha("d") }, amendment: { previousAuthorizationSha256: digest(f.authText), contract: f.auth.contract, assertions: f.auth.assertions, repository: f.auth.repository, testHeadSha: sha("d"), tests: reviewed.oracle!.files, changedPaths: ["test/oracle.mjs"], approval: source("exact-retained-amendment") } };
  assert.deepEqual(testWorkflowInvalidation(f.authText, encode(next), f.history.slice(0, 5)), ["authorization", "results", "oracle-review", "final-approval", "continuation"]);
  assert.throws(() => testWorkflowInvalidation(f.authText, encode({ ...next, elapsedMs: 0 }), f.history.slice(0, 5)), "amendment cannot reset elapsed accounting");
  assert.throws(() => testWorkflowInvalidation(f.authText, encode(next)), "material amendment needs retained settled history");
  assert.throws(() => assessTestWorkflow(encode(next), f.history));
  assert.throws(() => testWorkflowInvalidation(f.authText, encode(replace(next, ["amendment", "previousAuthorizationSha256"], digest("forged-history"))), f.history.slice(0, 5)));
  assert.throws(() => parseTestAuthorization(encode(replace(next, ["amendment", "changedPaths"], ["src/product.ts"]))));
  assert.equal(assessTestWorkflow(f.authText, f.history).state, "product-consumed", "earlier immutable model still replays");
});
test("TS14 AC12/AC13/NFR6: diagnostics redact synthetic canaries, five fields <=2000 JS units, no production injection exports", () => {
  const canary = "synthetic-canary-" + "private-value-".repeat(200);
  for (const raw of [encode(replace(packet(), ["authorityRoot"], canary)), encode(replace(packet(), ["checks", 0, "command"], canary + "\n"))]) {
    assert.throws(() => parseTestAuthorization(raw), (error: unknown) => {
      assert.ok(error instanceof Error); assert.ok(error.message.length <= 2000); assert.ok(!error.message.includes(canary));
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.ok(error.message.includes(label));
      return true;
    });
  }
  const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.ok(!/export \* from .*requirements-test-workflow/.test(index), "no wholesale authority/constructor exports");
  assert.ok(!/export.*(?:NativeAuthority|NativeService).*requirements-test/.test(index), "native authority injection is not a public core export");
});
test("TS15 AC13: complete source/native/installed/semantic/human mapping is explicit, no fake AC5/6 pass stubs", () => {
  const doc = readFileSync(new URL("../../../../docs/contracts/requirements-test-workflow-v1.md", import.meta.url), "utf8");
  for (let ac = 1; ac <= 13; ac++) assert.match(doc, new RegExp(`\\| AC${ac} \\|`));
  for (let ts = 1; ts <= 15; ts++) assert.ok(doc.includes(`TS${String(ts).padStart(2, "0")}`));
  assert.match(doc, /AC5 \| deferred/); assert.match(doc, /AC6 \| deferred/);
  assert.match(doc, /source-model is not installed proof/); assert.match(doc, /not an OS sandbox/);
});
