import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "@pa-platform/pa-core";

export const MAX_TREEHOUSE_JSON_BYTES = 1024 * 1024;
export const TREEHOUSE_TIMEOUT_MS = 15_000;
const MAX_FIELD = 4_096;

export interface TreehouseLeaseEvidence {
  readonly path: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly leasedAt?: string;
}

export interface TreehouseStatusEntry {
  readonly path: string;
  readonly leased: boolean;
  readonly leaseId?: string;
  readonly leaseHolder?: string;
  readonly leasedAt?: string;
}

export interface TreehouseCommandResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export type TreehouseCommandRunner = (args: readonly string[], cwd: string) => TreehouseCommandResult;

export interface TreehouseClientOptions {
  readonly run?: TreehouseCommandRunner;
  readonly binary?: string;
}

export function deriveTreehouseLeaseHolder(repoKey: string, ticketId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoKey) || !/^[A-Z]+-\d+$/.test(ticketId)) {
    throw treehouseError("deterministic lease holder inputs are malformed", "use the canonical registered repository key and exact ticket ID");
  }
  return `pa:${repoKey}:${ticketId}`;
}

export class TreehouseClient {
  private readonly run: TreehouseCommandRunner;
  constructor(options: TreehouseClientOptions = {}) {
    this.run = options.run ?? defaultRunner(options.binary ?? "treehouse");
  }

  status(canonicalRepoRoot: string): readonly TreehouseStatusEntry[] {
    const value = parseJson(this.invoke(["status", "--json"], canonicalRepoRoot), "status --json");
    if (!isRecord(value) || !Array.isArray(value["worktrees"]) || Object.keys(value).some((key) => key !== "worktrees")) {
      throw treehouseError("status JSON must be one object containing only a worktrees array", "reconcile the pinned Treehouse v2.3.0 executable and retry");
    }
    const entries = value["worktrees"].map((item, index) => parseStatusEntry(item, `worktrees[${index}]`));
    rejectDuplicates(entries);
    return Object.freeze(entries);
  }

  getLease(canonicalRepoRoot: string, holder: string): TreehouseLeaseEvidence {
    requiredField(holder, "lease holder");
    const value = parseJson(this.invoke(["get", "--lease", "--lease-holder", holder, "--json"], canonicalRepoRoot), "get --lease --json");
    const entry = parseLease(value, "lease allocation");
    if (entry.leaseHolder !== holder) throw treehouseError(`Treehouse returned holder ${entry.leaseHolder} instead of ${holder}`, "preserve the acquired lease and reconcile its identity before retrying");
    return Object.freeze(entry);
  }

  acquireOrReuse(canonicalRepoRoot: string, repoKey: string, ticketId: string): TreehouseLeaseEvidence {
    const holder = deriveTreehouseLeaseHolder(repoKey, ticketId);
    const matches = this.status(canonicalRepoRoot).filter((entry) => entry.leased && entry.leaseHolder === holder);
    if (matches.length > 1) throw treehouseError(`found ${matches.length} leases for deterministic holder ${holder}`, "preserve all Treehouse leases and reconcile duplicates interactively");
    if (matches.length === 1) return Object.freeze(asLease(matches[0]!));
    return this.getLease(canonicalRepoRoot, holder);
  }

  authenticatePrepared(canonicalRepoRoot: string, repoKey: string, ticketId: string, physicalCwd: string): TreehouseLeaseEvidence {
    const holder = deriveTreehouseLeaseHolder(repoKey, ticketId);
    const cwd = absolutePath(physicalCwd, "operator-prepared CWD");
    const matches = this.status(canonicalRepoRoot).filter((entry) => entry.leased && entry.leaseHolder === holder);
    if (matches.length !== 1) {
      throw treehouseError(`expected one leased checkout for ${holder}, found ${matches.length}`, "reconcile missing or duplicate Treehouse lease evidence before launch");
    }
    const lease = asLease(matches[0]!);
    if (lease.path !== cwd) throw treehouseError(`prepared CWD ${cwd} does not equal leased path ${lease.path}`, "cd to the exact physical leased checkout; explicit worktree path input is forbidden");
    return Object.freeze(lease);
  }

  private invoke(args: readonly string[], cwd: string): Buffer {
    const root = absolutePath(canonicalRepoRoot(cwd), "canonical repository root");
    const result = this.run(args, root);
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? (result.stderr.toString("utf8").trim() || `exit ${result.status ?? "unknown"}`);
      throw treehouseError(`treehouse ${args.join(" ")} failed: ${bounded(detail, 600)}`, "verify Treehouse v2.3.0 and preserve any lease created before retrying");
    }
    if (result.stdout.length === 0) throw treehouseError(`treehouse ${args.join(" ")} returned empty stdout`, "require bounded machine-readable JSON output");
    if (result.stdout.length > MAX_TREEHOUSE_JSON_BYTES) throw treehouseError(`treehouse JSON exceeded ${MAX_TREEHOUSE_JSON_BYTES} bytes`, "reduce/reconcile pool evidence before retrying");
    return result.stdout;
  }
}

function parseStatusEntry(value: unknown, label: string): TreehouseStatusEntry {
  if (!isRecord(value)) throw treehouseError(`${label} is not an object`, "repair malformed Treehouse status evidence");
  const allowed = new Set(["name", "path", "status", "processes", "leased", "lease_id", "lease_holder", "leased_at", "flavor", "owner_pid", "owner_started_at", "pending_process", "pending_thread", "locked", "destroying", "blocked", "caught", "checked_at"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw treehouseError(`${label} contains an unexpected field`, "use the pinned Treehouse v2.3.0 JSON contract");
  for (const field of ["name", "status", "flavor", "owner_started_at", "pending_process", "pending_thread", "checked_at"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw treehouseError(`${label}.${field} has an unexpected type`, "repair malformed Treehouse status evidence");
  }
  for (const field of ["leased", "locked", "destroying", "blocked", "caught"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") throw treehouseError(`${label}.${field} has an unexpected type`, "repair malformed Treehouse status evidence");
  }
  if (value["owner_pid"] !== undefined && (!Number.isInteger(value["owner_pid"]) || Number(value["owner_pid"]) <= 0)) throw treehouseError(`${label}.owner_pid is malformed`, "repair malformed Treehouse status evidence");
  if (value["processes"] !== undefined && !Array.isArray(value["processes"])) throw treehouseError(`${label}.processes has an unexpected type`, "repair malformed Treehouse status evidence");
  const path = absolutePath(requiredField(value["path"], `${label}.path`), `${label}.path`);
  const leaseId = optionalField(value["lease_id"], `${label}.lease_id`);
  const leaseHolder = optionalField(value["lease_holder"], `${label}.lease_holder`);
  const leasedAt = optionalTimestamp(value["leased_at"], `${label}.leased_at`);
  const leaseFlag = value["leased"];
  const hasLeaseMetadata = leaseId !== undefined || leaseHolder !== undefined || leasedAt !== undefined;
  if (leaseFlag === false && hasLeaseMetadata) {
    throw treehouseError(`${label} declares leased=false while retaining lease metadata`, "clear the stale lease fields or restore a truthful active lease before launch");
  }
  const leased = leaseFlag === true || (leaseFlag === undefined && hasLeaseMetadata);
  if (leased && (!leaseId || !leaseHolder)) {
    throw treehouseError(`${label} has incomplete lease identity; leased entries require both lease_id and lease_holder`, "reconcile the Treehouse lease before launch");
  }
  return Object.freeze({ path, leased, ...(leaseId ? { leaseId } : {}), ...(leaseHolder ? { leaseHolder } : {}), ...(leasedAt ? { leasedAt } : {}) });
}

function parseLease(value: unknown, label: string): TreehouseLeaseEvidence {
  if (!isRecord(value)) throw treehouseError(`${label} JSON is not an object`, "require the pinned Treehouse lease JSON schema");
  const allowed = new Set(["name", "path", "status", "leased", "lease_id", "lease_holder", "leased_at", "flavor"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw treehouseError(`${label} contains an unexpected field`, "use the pinned Treehouse v2.3.0 JSON contract");
  for (const field of ["name", "status", "flavor"] as const) if (value[field] !== undefined && typeof value[field] !== "string") throw treehouseError(`${label}.${field} has an unexpected type`, "repair malformed Treehouse allocation evidence");
  if (value["leased"] !== undefined && value["leased"] !== true) throw treehouseError(`${label}.leased must be true`, "preserve and reconcile the allocation");
  const leasedAt = optionalTimestamp(value["leased_at"], `${label}.leased_at`);
  return {
    path: absolutePath(requiredField(value["path"], `${label}.path`), `${label}.path`),
    leaseId: requiredField(value["lease_id"], `${label}.lease_id`),
    leaseHolder: requiredField(value["lease_holder"], `${label}.lease_holder`),
    ...(leasedAt ? { leasedAt } : {}),
  };
}

function asLease(entry: TreehouseStatusEntry): TreehouseLeaseEvidence {
  if (!entry.leased || !entry.leaseId || !entry.leaseHolder) throw treehouseError("matching status entry lacks complete lease identity", "reconcile Treehouse status before launch");
  return { path: entry.path, leaseId: entry.leaseId, leaseHolder: entry.leaseHolder, ...(entry.leasedAt ? { leasedAt: entry.leasedAt } : {}) };
}

function rejectDuplicates(entries: readonly TreehouseStatusEntry[]): void {
  const paths = new Set<string>();
  const leaseIds = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw treehouseError(`status JSON repeats path ${entry.path}`, "reconcile duplicate Treehouse evidence");
    paths.add(entry.path);
    if (entry.leaseId) {
      if (leaseIds.has(entry.leaseId)) throw treehouseError(`status JSON repeats lease ID ${entry.leaseId}`, "reconcile duplicate Treehouse evidence");
      leaseIds.add(entry.leaseId);
    }
  }
}

function parseJson(bytes: Buffer, command: string): unknown {
  if (bytes.includes(0)) throw treehouseError(`${command} JSON contains NUL bytes`, "reject truncated or mixed machine output");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw treehouseError(`${command} stdout is not one valid UTF-8 JSON value`, "ignore human stderr and require complete machine-readable stdout"); }
}

function defaultRunner(binary: string): TreehouseCommandRunner {
  return (args, cwd) => {
    const result = spawnSync(binary, [...args], { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_TREEHOUSE_JSON_BYTES + 1, timeout: TREEHOUSE_TIMEOUT_MS, killSignal: "SIGKILL" });
    return { status: result.status, stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)), stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)), ...(result.error ? { error: result.error } : {}) };
  };
}

function requiredField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD || value.includes("\0")) throw treehouseError(`${label} is missing or malformed`, "repair Treehouse JSON evidence before retrying");
  return value;
}
function optionalField(value: unknown, label: string): string | undefined { return value === undefined || value === null ? undefined : requiredField(value, label); }
function optionalTimestamp(value: unknown, label: string): string | undefined {
  const field = optionalField(value, label);
  if (field !== undefined && !Number.isFinite(Date.parse(field))) throw treehouseError(`${label} is not a valid timestamp`, "repair Treehouse JSON evidence before retrying");
  return field;
}
function absolutePath(value: string, label: string): string { if (!isAbsolute(value) || resolve(value) !== value) throw treehouseError(`${label} must be an absolute normalized path`, "use the exact physical Treehouse path"); return value; }
function canonicalRepoRoot(value: string): string { return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function bounded(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 3)}...`; }
function treehouseError(reason: string, resume: string): Error {
  const message = `Condition: Treehouse ticket checkout admission. Source: bounded Treehouse v2.3.0 JSON subprocess boundary. Reason: ${reason}. Correction: preserve all Treehouse leases and branches; do not return, prune, destroy, or force. Resume Action: ${resume}.`;
  return new Error(bounded(message, MAX_REPOSITORY_DIAGNOSTIC_CHARS));
}
