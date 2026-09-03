import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OWNERSHIP_FILE_NAME = "background-supervisor.json";
const MAX_OWNERSHIP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_POLL_MS = 25;

export interface BackgroundOwnershipConfig {
  ownershipToken: string;
  ownershipPath: string;
}

export interface BackgroundOwnershipEvidence {
  schemaVersion: 1;
  deploymentId: string;
  ownershipToken: string;
  supervisorPid: number;
  state: "active" | "failed";
  ready: boolean;
  updatedAt: string;
  childPid?: number;
  error?: string;
}

export interface BackgroundOwnershipWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createBackgroundOwnershipConfig(deploymentDir: string): BackgroundOwnershipConfig {
  return { ownershipToken: randomUUID(), ownershipPath: resolve(deploymentDir, OWNERSHIP_FILE_NAME) };
}

export function publishBackgroundOwnership(path: string, evidence: BackgroundOwnershipEvidence): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function waitForBackgroundOwnership(
  expected: BackgroundOwnershipConfig & { deploymentId: string; supervisorPid: number },
  options: BackgroundOwnershipWaitOptions = {},
): Promise<BackgroundOwnershipEvidence> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  const deadline = now() + Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (now() <= deadline) {
    const evidence = readBackgroundOwnership(expected.ownershipPath);
    if (evidence && evidence.deploymentId === expected.deploymentId && evidence.ownershipToken === expected.ownershipToken && evidence.supervisorPid === expected.supervisorPid) {
      if (evidence.state === "active" && evidence.ready) return evidence;
      if (evidence.state === "failed") throw new Error(`runner-readiness: ${evidence.error ?? "background supervisor failed before readiness"}`);
    }
    await sleep(Math.max(1, options.pollMs ?? DEFAULT_POLL_MS));
  }
  throw new Error(`runner-readiness: background supervisor did not acknowledge authenticated ownership within ${Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms`);
}

export function readBackgroundOwnership(path: string): BackgroundOwnershipEvidence | undefined {
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path, "utf8");
  if (Buffer.byteLength(body) > MAX_OWNERSHIP_BYTES) throw new Error("runner-readiness: background ownership evidence is oversized");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("runner-readiness: background ownership evidence is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runner-readiness: background ownership evidence is malformed");
  const row = value as Partial<BackgroundOwnershipEvidence>;
  if (row.schemaVersion !== 1 || typeof row.deploymentId !== "string" || typeof row.ownershipToken !== "string" || !Number.isInteger(row.supervisorPid) || Number(row.supervisorPid) <= 0 || (row.state !== "active" && row.state !== "failed") || typeof row.ready !== "boolean" || typeof row.updatedAt !== "string") throw new Error("runner-readiness: background ownership evidence is malformed");
  return row as BackgroundOwnershipEvidence;
}

export function removeOwnedBackgroundConfig(path: string, ownershipToken: string): void {
  if (!existsSync(path)) return;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value["ownershipToken"] === ownershipToken) unlinkSync(path);
  } catch {
    // Preserve an unparseable file for diagnosis rather than deleting unknown data.
  }
}

export async function terminateBackgroundSupervisor(pid: number, sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds))): Promise<void> {
  signalProcessTree(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) await sleep(25);
  if (processAlive(pid)) {
    signalProcessTree(pid, "SIGKILL");
    for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) await sleep(25);
  }
  if (processAlive(pid)) throw new Error(`runner-shutdown: background supervisor ${pid} remained live after termination`);
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already exited */ } }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
