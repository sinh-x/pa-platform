import test from "node:test";
import assert from "node:assert/strict";
import { boundOperationOutput, MAX_OPERATION_RESULT_BYTES, MAX_OPERATION_TEXT_BYTES, MAX_OPERATION_TEXT_LINES, OPERATION_RESULT_VERSION,
  operationExitCode, operationNativeIsError, OperationResultError, parseOperationResult, serializeOperationResult, type OperationEvidence, type OperationResult } from "../operations/result.js";

const proof: OperationEvidence = { owner: "fixture", ref: "fixture:result", version: "v1", sha256: "a".repeat(64), freshness: "current", scope: "fixture:check" };
const finding = { code: "CHECK_FAILED", severity: "major" as const, explanation: "Actual test failure", correctionOwner: "agent", nextAction: "Inspect and repair the fixture; preserve this observation." };
function result(overrides: Partial<OperationResult> = {}): OperationResult {
  return { schemaVersion: OPERATION_RESULT_VERSION, operationId: "fixture:1", kind: "check.run", observedAt: "2026-11-05T00:00:00.000Z",
    scope: { source: "fixture:check", inputSha256: "b".repeat(64), description: "Disposable fixture" }, completion: "completed", outcome: "passed", enforcement: "allowed", capability: "available", required: true,
    findings: [], process: { exitCode: 0, signal: null, timedOut: false, aborted: false, cleanup: "settled" }, evidence: [proof], output: { text: "ok", truncated: false, fullEvidenceRef: null }, payload: { kind: "inline", value: { tests: 1 } }, ...overrides };
}
function rejected(value: unknown, code?: string): void {
  assert.throws(() => serializeOperationResult(value as OperationResult), (e: unknown) => e instanceof OperationResultError && (!code || e.code === code));
}
test("orthogonal completion/outcome/capability/enforcement and approved CLI/native mappings", () => {
  const cases: [Partial<OperationResult>, number, boolean][] = [
    [{}, 0, false], [{ outcome: "warning" }, 0, false], [{ outcome: "failed", process: { ...result().process!, exitCode: 17 } }, 1, false],
    [{ outcome: "unknown", completion: "error" }, 2, true], [{ outcome: "skipped", capability: "unavailable", process: null }, 2, false],
    [{ outcome: "unknown" }, 2, false], [{ outcome: "skipped" }, 2, false],
    [{ outcome: "unknown", required: false }, 0, false], [{ outcome: "skipped", required: false }, 0, false],
    [{ outcome: "skipped", enforcement: "denied", process: null }, 3, false],
    [{ outcome: "unknown", completion: "timed-out", process: { exitCode: null, signal: "SIGTERM", timedOut: true, aborted: false, cleanup: "settled" } }, 124, false],
    [{ outcome: "unknown", completion: "cancelled", process: { exitCode: null, signal: "SIGKILL", timedOut: true, aborted: true, cleanup: "unknown" } }, 130, false],
    [{ outcome: "unknown", completion: "cancelled", enforcement: "denied", process: null }, 3, false],
    [{ outcome: "failed", process: { ...result().process!, exitCode: null, signal: "SIGTERM" } }, 2, false],
  ];
  for (const [change, exit, nativeError] of cases) {
    const r = result({ findings: [finding], ...change });
    const parsed = parseOperationResult(serializeOperationResult(r));
    assert.equal(operationExitCode(parsed), exit); assert.equal(operationNativeIsError(parsed), nativeError);
    assert.deepEqual(parsed.process, r.process); assert.equal(parsed.outcome, r.outcome);
    assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.evidence));
  }
});
test("incomplete, denied, unavailable, child-failed, stale or unproven observations cannot pass", () => {
  for (const changes of [
    { enforcement: "denied" }, { capability: "unavailable" }, { completion: "error" }, { completion: "cancelled" }, { completion: "timed-out" },
    { process: { ...result().process!, exitCode: 1 } }, { process: { ...result().process!, exitCode: null } },
    { process: { ...result().process!, cleanup: "unknown" } }, { evidence: [] },
    { evidence: [{ ...proof, freshness: "stale" }] }, { evidence: [{ ...proof, freshness: "unverified" }] }, { evidence: [{ ...proof, scope: "different" }] },
  ]) rejected(result({ findings: [finding], ...changes } as Partial<OperationResult>), "OPERATION_RESULT_INVARIANT");
  rejected(result({ outcome: "skipped" }), "OPERATION_RESULT_INVARIANT");
  rejected(result({ evidence: [{ ...proof, sha256: null }] }), "OPERATION_RESULT_INVARIANT");
});
test("unknown facts stay null; read may expose stale context without certifying it", () => {
  const r = result({ process: null, outcome: "warning", findings: [finding], evidence: [{ ...proof, sha256: null, version: null, freshness: "unverified" }] });
  assert.deepEqual(JSON.parse(serializeOperationResult(parseOperationResult(serializeOperationResult(r)))), r);
  rejected(result({ process: { ...result().process!, signal: "SIGTERM" } }), "OPERATION_RESULT_INVARIANT");
  rejected(result({ process: { ...result().process!, timedOut: true } }), "OPERATION_RESULT_INVARIANT");
});
test("strict bounded JSON rejects decoded duplicate keys, invalid UTF-8, nesting and unknown authority fields", () => {
  const encoded = serializeOperationResult(result());
  for (const raw of ["", "{}{}", "[]", "\ufeff" + encoded, encoded.replace('"operationId":', '"operationId":"x","operation\\u0049d":'),
    encoded.slice(0, -1) + ',"approved":true}', '{"nested":' + "[".repeat(66) + "0" + "]".repeat(66) + "}"]) {
    assert.throws(() => parseOperationResult(raw), OperationResultError);
  }
  assert.throws(() => parseOperationResult(Buffer.from([0xc0, 0xaf])), OperationResultError);
  assert.throws(() => parseOperationResult(encoded + " ".repeat(MAX_OPERATION_RESULT_BYTES)), OperationResultError);
  rejected({ ...result(), humanApproval: "forged" });
  rejected({ ...result(), payload: { kind: "inline", value: { amount: Infinity } } });
  rejected({ ...result(), required: undefined });
  const accessor = { ...result() }; Object.defineProperty(accessor, "output", { get() { throw new Error("must not execute getter"); }, enumerable: true });
  rejected(accessor);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  rejected({ ...result(), payload: { kind: "inline", value: cyclic } });
});
test("UTF-8, text/line/JSON bounds and owner reference preserve complete valid envelopes", () => {
  for (const raw of ["x".repeat(MAX_OPERATION_TEXT_BYTES), "🙂漢\n".repeat(5000), '"\\\n'.repeat(20000)]) {
    const output = boundOperationOutput(raw, proof);
    const parsed = parseOperationResult(serializeOperationResult(result({ output })));
    assert.equal(parsed.output.text, output.text);
    assert.ok(Buffer.byteLength(output.text) <= MAX_OPERATION_TEXT_BYTES);
    assert.ok(output.text.split("\n").length <= MAX_OPERATION_TEXT_LINES);
    assert.ok(Buffer.byteLength(serializeOperationResult(parsed)) <= MAX_OPERATION_RESULT_BYTES);
    assert.ok(!output.text.includes("\ufffd"));
    if (output.truncated) assert.deepEqual(output.fullEvidenceRef, proof);
  }
  assert.equal(boundOperationOutput("x".repeat(MAX_OPERATION_TEXT_BYTES - 2), null).truncated, false);
  assert.equal(boundOperationOutput("\n".repeat(MAX_OPERATION_TEXT_LINES - 1), null).truncated, false);
  assert.throws(() => boundOperationOutput("x".repeat(MAX_OPERATION_TEXT_BYTES + 1), null), OperationResultError);
  assert.throws(() => boundOperationOutput("\ud800", null), OperationResultError);
  rejected(result({ output: { text: "prefix", truncated: true, fullEvidenceRef: null } }), "OPERATION_OUTPUT_REFERENCE_REQUIRED");
  rejected(result({ output: { text: "x".repeat(MAX_OPERATION_TEXT_BYTES + 1), truncated: false, fullEvidenceRef: null } }));
  rejected(result({ payload: { kind: "inline", value: "x".repeat(MAX_OPERATION_RESULT_BYTES) } }), "OPERATION_RESULT_SIZE");
  assert.deepEqual(parseOperationResult(serializeOperationResult(result({ payload: { kind: "reference", evidence: proof } }))).payload, { kind: "reference", evidence: proof });
});
test("known secrets reject without echo, including escaped JSON and inline payloads", () => {
  const secret = "sk-" + "fixtureSecretValue1234567890";
  for (const value of [result({ output: { text: secret, truncated: false, fullEvidenceRef: null } }), result({ payload: { kind: "inline", value: { private: secret } } })]) {
    assert.throws(() => serializeOperationResult(value), (e: unknown) => e instanceof OperationResultError && e.code === "OPERATION_RESULT_SENSITIVE" && !e.message.includes(secret));
  }
  const encoded = serializeOperationResult(result()).replace('"text":"ok"', '"text":"\\u0073k-fixtureSecretValue1234567890"');
  assert.throws(() => parseOperationResult(encoded), OperationResultError);
});
test("observations are immutable data, not grants; later results cannot rewrite original failures", () => {
  const failed = parseOperationResult(serializeOperationResult(result({ outcome: "failed", findings: [finding], process: { ...result().process!, exitCode: 9 } })));
  const before = serializeOperationResult(failed);
  const passed = parseOperationResult(serializeOperationResult(result({ operationId: "fixture:2" })));
  assert.equal(operationExitCode(failed), 1); assert.equal(operationExitCode(passed), 0);
  assert.equal(serializeOperationResult(failed), before);
  assert.throws(() => { failed.process!.exitCode = 0; }, TypeError);
  assert.ok(!("permissions" in passed)); assert.ok(!("approved" in passed));
});
