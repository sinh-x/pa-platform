import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessFingerprint, type ProcessFingerprint, type RepositoryMutationLease } from "../deploy/repository-admission.js";
import { getDeployPaths } from "../deploy/paths.js";
import { ProtectedWorkflowStore, workflowDigest, workflowObject, parseSourceVersion, type SourceVersion } from "../deploy/prepared-workflow.js";
import { NativeExecutionEvidence } from "./evidence.js";

export const RECOVERY_EVIDENCE_LIMITS = Object.freeze({ records: 512, bytes: 8 * 1024 * 1024, processes: 16_384, milliseconds: 2_000 });
export type RetainedProcessState = "live" | "dead" | "reused" | "unavailable";
export interface RetainedOperationInspection {
  readonly state: "absent" | "settled" | "unknown" | "unavailable";
  readonly cause: "no-operation" | "native-cleanup-settled" | "native-cleanup-unknown" | "result-missing" | "evidence-invalid";
  readonly operationId?: string;
  readonly evidenceIdentity?: string;
  readonly caller?: RetainedProcessState;
  readonly leader?: RetainedProcessState;
  readonly group?: "present" | "empty" | "unavailable";
  /** Historical group frames do not establish custody of detached descendants. */
  readonly tracking?: "process-group-only";
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly exitCode?: number | null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fingerprint(value: unknown): ProcessFingerprint {
  const row = workflowObject(value, ["pid", "startTimeTicks", "bootId"]);
  if (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || typeof row.startTimeTicks !== "string" || !/^[0-9]{1,24}$/.test(row.startTimeTicks)
    || typeof row.bootId !== "string" || !/^[0-9a-f-]{36}$/.test(row.bootId)) throw new Error("invalid process frame");
  return row as unknown as ProcessFingerprint;
}
/** ESRCH is a factual observation, never a settlement grant. EPERM/read failure
 * is unknown. A different birth is reported as reuse, not silently as death. */
export function inspectRetainedProcess(previous: ProcessFingerprint): RetainedProcessState {
  const current = readProcessFingerprint(previous.pid);
  if (current) return same(current, previous) ? "live" : "reused";
  try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead"; }
  return "unavailable";
}
function inspectGroup(group: number, session: number, deadline: number): "present" | "empty" | "unavailable" {
  try {
    const names = readdirSync("/proc");
    if (names.length > RECOVERY_EVIDENCE_LIMITS.processes) return "unavailable";
    let present = false;
    for (const name of names) {
      if (Date.now() > deadline) return "unavailable";
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).trim().split(/\s+/);
        if (end < 0 || fields.length < 20) return "unavailable";
        if (Number(fields[2]) === group && !["Z", "X"].includes(fields[0]!)) {
          if (Number(fields[3]) !== session) return "unavailable";
          present = true;
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return "unavailable"; }
    }
    return present ? "present" : "empty";
  } catch { return "unavailable"; }
}
function reference(id: string): SourceVersion {
  return parseSourceVersion({ ref: `native-execution-evidence:${id}`, version: "native-execution-evidence/v1", sha256: id });
}
/** Existing protected native evidence only. Never initializes storage, obtains
 * locks, publishes evidence, kills a process, or clears custody. In particular,
 * fresh group emptiness does NOT upgrade an original unknown cleanup result. */
export function inspectRetainedAdvisoryOperation(lease: RepositoryMutationLease): RetainedOperationInspection {
  if (!lease.advisoryOperation) return Object.freeze({ state: "absent", cause: "no-operation" });
  const operation = lease.advisoryOperation;
  try {
    if (!/^op-[0-9a-f-]{36}$/.test(operation.id) || lease.deploymentDirectory !== getDeployPaths(lease.deploymentId).deployDir) throw new Error("invalid operation identity");
    const match = /^native-execution-evidence:([0-9a-f]{64})$/.exec(operation.intentRef);
    if (!match) throw new Error("invalid intent");
    const root = join(lease.deploymentDirectory, "operation-evidence");
    const store = new ProtectedWorkflowStore(root);
    const evidence = new NativeExecutionEvidence(store, root, { repository: () => { throw new Error("inspection cannot lock"); }, worktree: () => { throw new Error("inspection cannot lock"); } });
    const intentRef = reference(match[1]!);
    const intent = workflowObject(evidence.read(intentRef, "advisory-operation-intent"), ["operationId", "command", "deploymentId", "cwd"]);
    if (intent.operationId !== operation.id || intent.deploymentId !== lease.deploymentId || intent.cwd !== (lease.worktreeRoot ?? lease.canonicalRepoRoot)
      || typeof intent.command !== "string" || workflowDigest(intent.command) !== operation.inputSha256) throw new Error("intent conflict");
    const deadline = Date.now() + RECOVERY_EVIDENCE_LIMITS.milliseconds;
    const names = store.records();
    if (names.length > RECOVERY_EVIDENCE_LIMITS.records) throw new Error("record limit");
    const digest = createHash("sha256").update(JSON.stringify(intentRef));
    let size = 0;
    const results: Record<string, unknown>[] = [];
    for (const name of names) {
      if (Date.now() > deadline) throw new Error("inspection deadline");
      const stat = lstatSync(join(root, name)); size += stat.size;
      if (size > RECOVERY_EVIDENCE_LIMITS.bytes) throw new Error("evidence limit");
      const record = workflowObject(store.read(name), ["schemaVersion", "kind", "payload"]);
      if (!/^[0-9a-f]{64}\.intent\.json$/.test(name) || record.schemaVersion !== "native-execution-evidence/v1"
        || workflowDigest(JSON.stringify(record)) !== name.slice(0, 64)) throw new Error("invalid evidence");
      digest.update(name).update(`${stat.dev}:${stat.ino}:${stat.ctimeMs}:`).update(JSON.stringify(record));
      if (record.kind === "advisory-process-result") {
        const payload = record.payload as Record<string, unknown> | null;
        if (payload && payload.operationId === operation.id) results.push(payload);
      }
    }
    const base = { operationId: operation.id, evidenceIdentity: digest.digest("hex"), caller: inspectRetainedProcess(fingerprint(operation.caller)) };
    if (!results.length) return Object.freeze({ ...base, state: "unknown", cause: "result-missing" });
    if (results.length !== 1) throw new Error("ambiguous result");
    const result = workflowObject(results[0], ["operationId", "intent", "command", "process"]);
    if (!same(result.intent, intentRef) || result.command !== intent.command) throw new Error("result conflict");
    const process = workflowObject(result.process, ["frame", "stdout", "stderr", "exitCode", "signal", "timedOut", "aborted", "outputLimitExceeded", "groupSettled"]);
    if (typeof process.groupSettled !== "boolean" || typeof process.timedOut !== "boolean" || typeof process.aborted !== "boolean"
      || typeof process.outputLimitExceeded !== "boolean" || (process.exitCode !== null && (!Number.isSafeInteger(process.exitCode) || Number(process.exitCode) < 0))
      || (process.signal !== null && (typeof process.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(process.signal)))) throw new Error("invalid result facts");
    const frame = workflowObject(evidence.read(parseSourceVersion(process.frame), "process-frame"), ["intent", "process", "groupId", "sessionId", "executable", "command", "cwd", "program", "environment"]);
    const leader = fingerprint(frame.process);
    if (!same(frame.intent, intentRef) || frame.command !== intent.command || frame.cwd !== intent.cwd || frame.groupId !== leader.pid || frame.sessionId !== leader.pid) throw new Error("frame conflict");
    return Object.freeze({ ...base, state: process.groupSettled ? "settled" : "unknown", cause: process.groupSettled ? "native-cleanup-settled" : "native-cleanup-unknown",
      leader: inspectRetainedProcess(leader), group: inspectGroup(leader.pid, leader.pid, deadline), tracking: "process-group-only", timedOut: process.timedOut, aborted: process.aborted, exitCode: process.exitCode as number | null });
  } catch { return Object.freeze({ state: "unavailable", cause: "evidence-invalid" }); }
}
