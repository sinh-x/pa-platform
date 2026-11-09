import { randomUUID } from "node:crypto";
import { AdvisoryFiles } from "./files.js";
import { evaluateSafetyPolicy } from "../safety-policy.js";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { workflowDigest, type SourceVersion } from "../deploy/prepared-workflow.js";
import { NativeExecutionEvidence, NativeProcessEvidenceError, nativePublicText, runNativeExecutionProcess, trustedNativeExecutable, type NativeProcessResult } from "./evidence.js";
import { boundOperationOutput, OPERATION_RESULT_VERSION, parseOperationResult, serializeOperationResult, type OperationEvidence, type OperationFinding, type OperationJson, type OperationResult } from "./result.js";

export const ADVISORY_RUNTIME_VERSION = "pa-advisory-runtime/v1" as const;
export const OPERATION_TOOL_DESCRIPTION = "Discover factual PA capabilities or run a bounded check. A failed check is inspectable data: inspect, repair and retry under PAPC policy. Missing optional capability affects only this call. Protected operations remain denied; never bypass a denial. Results do not certify workflow compliance, independent review, CI or human UAT. No supplied outcome, evidence or approval is accepted.";
export type OperationRequest = { action: "capabilities" } | { action: "run"; command: string; timeoutSeconds?: number };
/** Native-only port. Never populated from model JSON, environment grants or a
 * caller-supplied result. Implementations reuse repository and evidence owners. */
export interface AdvisoryOperationHost {
  runtime: "pi" | "opencode";
  cwd: string;
  evidence: NativeExecutionEvidence;
  privateValues: readonly string[];
  begin(operationId: string, command: string): SourceVersion;
  finish(operationId: string, result: SourceVersion, settled: boolean): void;
  /** Native proven read-only diagnostics, never a caller-supplied bypass flag. */
  beginObservation?(operationId: string, command: string): SourceVersion;
  finishObservation?(operationId: string, result: SourceVersion, settled: boolean): void;
}
export function parseOperationRequest(input: string): OperationRequest {
  if (typeof input !== "string" || Buffer.byteLength(input) > 16_384 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) throw new Error("OPERATION_INPUT_INVALID");
  const r = parseReviewEvidenceJson(Buffer.from(input), "operation-request") as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("OPERATION_INPUT_INVALID");
  const keys = Object.keys(r);
  if (r.action === "capabilities" && keys.length === 1) return { action: "capabilities" };
  if (r.action !== "run" || !keys.includes("command") || keys.some(k => !["action", "command", "timeoutSeconds"].includes(k))
    || typeof r.command !== "string" || !r.command.trim() || Buffer.byteLength(r.command) > 8192 || r.command.includes("\0")
    || (r.timeoutSeconds !== undefined && (typeof r.timeoutSeconds !== "number" || !Number.isFinite(r.timeoutSeconds) || r.timeoutSeconds <= 0 || r.timeoutSeconds > 14_400))) throw new Error("OPERATION_INPUT_INVALID");
  if (findSensitiveMatch("content", r.command)) throw new Error("OPERATION_INPUT_SENSITIVE");
  return { action: "run", command: r.command, ...(r.timeoutSeconds !== undefined ? { timeoutSeconds: r.timeoutSeconds as number } : {}) };
}
function finding(code: string, explanation: string, correctionOwner = "agent"): OperationFinding {
  return { code, severity: "major", explanation, correctionOwner, nextAction: "Inspect this operation's facts and correct its input or consult its owner; unrelated safe diagnosis remains available." };
}
function base(id: string, kind: string, source: string, inputSha256: string | null): OperationResult {
  return { schemaVersion: OPERATION_RESULT_VERSION, operationId: id, kind, observedAt: new Date().toISOString(), scope: { source, inputSha256, description: "Native operation observation, not workflow acceptance" },
    completion: "completed", outcome: "unknown", enforcement: "allowed", capability: "available", required: true, findings: [], process: null, evidence: [], output: { text: "", truncated: false, fullEvidenceRef: null }, payload: null };
}
export function operationFailure(code: string, capability: "available" | "unavailable" = "available"): OperationResult {
  return parseOperationResult(serializeOperationResult({ ...base(`op-${randomUUID()}`, "operation.invocation", "runtime:operation", null), completion: "error", capability, findings: [finding(code, "The requested operation could not be invoked. No passing result or protected effect is inferred.", "runtime-owner")] }));
}
export function operationCapabilities(runtime: "pi" | "opencode", managed: boolean): OperationResult {
  const value = { runtimeContract: ADVISORY_RUNTIME_VERSION, resultContract: OPERATION_RESULT_VERSION, runtime,
    capabilities: [{ id: "check.run", cli: true, native: runtime === "pi", available: managed, prerequisite: "authenticated native advisory session and nonconflicting writer" },
      { id: "template", cli: runtime === "pi", native: runtime === "pi", available: runtime === "pi", prerequisite: "exact optional selected template pair" }], policyOwner: "PAPC-074", acceptance: "not-certified" };
  const sha256 = workflowDigest(JSON.stringify(value));
  const r = base(`op-${randomUUID()}`, "capabilities", "runtime:capabilities", null);
  return parseOperationResult(serializeOperationResult({ ...r, outcome: "passed", payload: { kind: "inline", value },
    evidence: [{ owner: "runtime-capabilities", ref: `runtime-capabilities:${sha256}`, version: OPERATION_RESULT_VERSION, sha256, freshness: "current", scope: r.scope.source }] }));
}
function proof(ref: SourceVersion, scope: string): OperationEvidence {
  return { owner: "native-execution-evidence", ...ref, freshness: "current", scope };
}
/** Shared actual executor, no catalogue/phase/package/check-order admission.
 * Evidence and process ownership remain native; failures never set session gates. */
export async function executeAdvisoryFile(host: AdvisoryOperationHost, kind: "write" | "edit", input: Record<string, unknown>, invoke: (files: AdvisoryFiles) => Promise<unknown>, signal?: AbortSignal): Promise<OperationResult> {
  const id = `op-${randomUUID()}`, source = `checkout:${host.cwd}`, r = base(id, kind, source, workflowDigest(JSON.stringify(input)));
  if (signal?.aborted) return { ...r, completion: "cancelled", outcome: "skipped", findings: [finding("OPERATION_CANCELLED", "Cancellation observed before the file operation.")] };
  const files = new AdvisoryFiles(host.cwd);
  try { files.assertPath(String(input.path ?? input.filePath ?? "")); }
  catch { return { ...r, enforcement: "denied", outcome: "skipped", findings: [finding("OPERATION_PATH_DENIED", "Protected, traversing or out-of-checkout path denied.", "security-owner")] }; }
  let intent: SourceVersion;
  try { intent = host.begin(id, JSON.stringify({ kind, path: input.path ?? input.filePath, inputSha256: r.scope.inputSha256 })); }
  catch { return { ...r, enforcement: "denied", outcome: "skipped", findings: [finding("OPERATION_WRITER_CONFLICT", "Conflicting or uncertain writer; independent diagnosis remains available.", "repository-owner")] }; }
  let value: unknown, failure = false;
  try { value = await invoke(files); } catch { failure = true; value = { error: "Native file invocation failed; no passing observation is inferred." }; }
  try {
  const bytes = Buffer.from(JSON.stringify(value));
  const sink = host.evidence.sink(workflowDigest(`${id}:file-result`), "stdout");
  const complete = sink.write(bytes); const nativeValue = sink.close();
  if (!complete) failure = true;
  const ref = host.evidence.publish("advisory-process-result", { operationId: id, intent, kind, nativeValue, outputLimitExceeded: !complete, settled: !files.uncertain });
  const evidence = proof(ref, source);
  let settled = !files.uncertain;
  try { host.finish(id, ref, settled); } catch { settled = false; }
  return parseOperationResult(serializeOperationResult({ ...r, observedAt: new Date().toISOString(), completion: signal?.aborted ? "cancelled" : failure || !settled ? "error" : "completed", outcome: signal?.aborted || failure || !settled ? "unknown" : "passed",
    findings: signal?.aborted || failure || !settled ? [finding(signal?.aborted ? "OPERATION_CANCELLED" : "OPERATION_FILE_UNPROVEN", "Native file invocation or settlement failed; original evidence remains retained.")] : [], evidence: [evidence],
    output: boundOperationOutput(nativePublicText(failure ? "File invocation failed; inspect retained native evidence." : `${kind} completed.`, host.privateValues), evidence), payload: { kind: "reference", evidence } }));
  } catch {
    const retained = proof(intent, source);
    return { ...r, completion: signal?.aborted ? "cancelled" : "error", outcome: "unknown", evidence: [retained], payload: { kind: "reference", evidence: retained }, findings: [finding("OPERATION_RESULT_UNPROVEN", "Preserve this exact file operation; its result publication or settlement is unproven.", "repository-owner")] };
  }
}

export async function executeOperation(rawRequest: string, runtime: "pi" | "opencode", host: AdvisoryOperationHost | null, signal?: AbortSignal): Promise<OperationResult> {
  let request: OperationRequest;
  try { request = parseOperationRequest(rawRequest); } catch { return operationFailure("OPERATION_INPUT_INVALID"); }
  if (request.action === "capabilities") return operationCapabilities(runtime, host !== null);
  if (!host || host.runtime !== runtime) return operationFailure("OPERATION_SESSION_UNAVAILABLE", "unavailable");
  const id = `op-${randomUUID()}`, source = `checkout:${host.cwd}`, r = base(id, "check.run", source, workflowDigest(request.command));
  const decision = evaluateSafetyPolicy({ kind: "shell", value: request.command }, { cwd: host.cwd, trashExecutable: runtime === "pi" ? "ppa" : "opa" });
  if (!decision.allowed) return parseOperationResult(serializeOperationResult({ ...r, enforcement: "denied", outcome: "skipped", findings: [finding(`SAFETY_${decision.code.replaceAll("-", "_").toUpperCase()}`, "Protected operation denied before execution.", "security-owner")] }));
  if (signal?.aborted) return parseOperationResult(serializeOperationResult({ ...r, completion: "cancelled", outcome: "skipped", findings: [finding("OPERATION_CANCELLED", "Cancellation observed before execution.")] }));
  // This is a security effect classification, not a command catalogue: all
  // other safe commands still use ordinary local writer admission.
  const diagnostic = host.beginObservation && host.finishObservation && ["pwd", "git status", "git status --short"].includes(request.command.trim());
  const program = diagnostic ? request.command.trim() === "pwd"
    ? { executable: trustedNativeExecutable("bash"), argv: ["--noprofile", "--norc", "-c", "pwd"], environment: {} }
    : { executable: trustedNativeExecutable("git"), argv: ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "status", "--ignore-submodules=all", ...(request.command.trim().endsWith("--short") ? ["--short"] : [])], environment: {} }
    : undefined;
  if (diagnostic) r.kind = "diagnostic.run";
  let intent: SourceVersion;
  try { intent = diagnostic ? host.beginObservation!(id, request.command) : host.begin(id, request.command); }
  catch { return parseOperationResult(serializeOperationResult({ ...r, enforcement: "denied", outcome: "skipped", findings: [finding("OPERATION_WRITER_CONFLICT", "Native writer identity or conflicting effect is unresolved.", "repository-owner")] })); }
  let process: NativeProcessResult;
  try {
    process = await runNativeExecutionProcess({ evidence: host.evidence, intent, command: request.command, cwd: host.cwd, timeoutSeconds: request.timeoutSeconds ?? 1200, signal, ...(program ? { program } : {}) });
  } catch (error) {
    const retained = error instanceof NativeProcessEvidenceError ? proof(error.evidence, source) : proof(intent, source);
    return parseOperationResult(serializeOperationResult({ ...r, observedAt: new Date().toISOString(), completion: "error", outcome: "unknown", evidence: [retained], payload: { kind: "reference", evidence: retained },
      findings: [finding("OPERATION_PROCESS_UNPROVEN", "Native process completion is unproven; preserve this exact operation and its conflicting custody.", "process-owner")] }));
  } // begin remains unresolved; never duplicate an uncertain effect
  try {
  const completion = process.aborted ? "cancelled" : process.timedOut ? "timed-out" : "completed";
  const incomplete = completion !== "completed" || !process.groupSettled || process.outputLimitExceeded || process.exitCode === null;
  const outcome = incomplete ? "unknown" : process.exitCode === 0 ? "passed" : "failed";
  const resultRef = host.evidence.publish("advisory-process-result", { operationId: id, intent, command: request.command, process });
  const evidence = proof(resultRef, source);
  const output = incomplete ? "[Incomplete output retained privately with native process facts.]"
    : nativePublicText(host.evidence.blob(process.stdout).toString("utf8") + host.evidence.blob(process.stderr).toString("utf8"), host.privateValues);
  const facts: OperationJson = { frame: { ...process.frame }, stdout: { ...process.stdout }, stderr: { ...process.stderr }, outputLimitExceeded: process.outputLimitExceeded };
  const result: OperationResult = { ...r, observedAt: new Date().toISOString(), completion, outcome,
    findings: outcome === "passed" ? [] : [finding(incomplete ? "OPERATION_INCOMPLETE" : "CHECK_FAILED", incomplete ? "Actual execution was interrupted, limited or cleanup is unproven." : "The check completed with a nonzero child exit; inspect and repair under PAPC policy.")],
    process: { exitCode: process.exitCode, signal: process.signal, timedOut: process.timedOut, aborted: process.aborted, cleanup: process.groupSettled ? "settled" : "unknown" },
    evidence: [evidence], output: boundOperationOutput(output, evidence), payload: { kind: "inline", value: facts } };
  try { if (diagnostic) host.finishObservation!(id, resultRef, process.groupSettled); else host.finish(id, resultRef, process.groupSettled); }
  catch { return { ...result, completion: "error", outcome: "unknown", findings: [finding("OPERATION_SETTLEMENT_UNPROVEN", "Process evidence is retained; conflicting effects require native reconciliation.", "repository-owner")] }; }
  return parseOperationResult(serializeOperationResult(result));
  } catch {
    const retained = proof(intent, source);
    return { ...r, observedAt: new Date().toISOString(), completion: process.aborted ? "cancelled" : process.timedOut ? "timed-out" : "error", outcome: "unknown",
      process: { exitCode: process.exitCode, signal: process.signal, timedOut: process.timedOut, aborted: process.aborted, cleanup: process.groupSettled ? "settled" : "unknown" },
      evidence: [retained], payload: { kind: "reference", evidence: retained }, findings: [finding("OPERATION_RESULT_UNPROVEN", "Actual process facts are retained; result publication or settlement is unproven for this exact operation.", "process-owner")] };
  }
}
