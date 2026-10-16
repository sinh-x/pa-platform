import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewEvidenceJson, readProcessFingerprint, readReviewEvidenceFile, type ProcessFingerprint } from "@pa-platform/pa-core";

export const PI_PROCESS_IDENTITY_FILE = "pi-process-identity.json";
const MAX_IDENTITY_BYTES = 4096;
interface PiProcessIdentity {
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly processFingerprint: ProcessFingerprint;
}

/** Launch-time observation only, not ownership or a capability. Never called by helpers. */
export function recordPiProcessIdentity(deploymentId: string, deploymentDirectory: string, pid: number): boolean {
  const processFingerprint = readProcessFingerprint(pid);
  // Non-Linux hosts and already-exited children cannot supply an incarnation anchor.
  // Do not manufacture one: their linked helpers will reject the absent evidence.
  if (!processFingerprint) return false;
  const path = join(deploymentDirectory, PI_PROCESS_IDENTITY_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const value: PiProcessIdentity = { schemaVersion: 1, deploymentId, processFingerprint };
  const body = `${JSON.stringify(value)}\n`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (JSON.stringify(readPiProcessIdentity(deploymentId, deploymentDirectory)) !== JSON.stringify(processFingerprint)) {
      throw new Error("Pi launch process identity readback mismatch");
    }
    return true;
  } finally {
    try { unlinkSync(temporary); } catch { /* already published or never created */ }
  }
}

/** Existing-only, bounded private evidence. No fallback to a freshly sampled PID. */
export function readPiProcessIdentity(deploymentId: string, deploymentDirectory: string): ProcessFingerprint {
  const path = join(deploymentDirectory, PI_PROCESS_IDENTITY_FILE);
  const stat = lstatSync(path);
  if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Pi launch process identity is not private current-user evidence");
  }
  const bytes = readReviewEvidenceFile(path, MAX_IDENTITY_BYTES, "Pi launch process identity");
  const after = lstatSync(path);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.uid !== stat.uid
    || after.nlink !== stat.nlink || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
    throw new Error("Pi launch process identity changed during protected read");
  }
  const value = parseReviewEvidenceJson(bytes, "Pi launch process identity");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi launch process identity is malformed");
  const row = value as Record<string, unknown>;
  const fp = row["processFingerprint"];
  if (Object.keys(row).sort().join(",") !== "deploymentId,processFingerprint,schemaVersion"
    || row["schemaVersion"] !== 1 || row["deploymentId"] !== deploymentId || !fp || typeof fp !== "object" || Array.isArray(fp)) {
    throw new Error("Pi launch process identity binding is malformed");
  }
  const fingerprint = fp as Record<string, unknown>;
  if (Object.keys(fingerprint).sort().join(",") !== "bootId,pid,startTimeTicks"
    || !Number.isSafeInteger(fingerprint["pid"]) || Number(fingerprint["pid"]) <= 0
    || typeof fingerprint["startTimeTicks"] !== "string" || !/^[0-9]{1,30}$/.test(fingerprint["startTimeTicks"])
    || typeof fingerprint["bootId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fingerprint["bootId"])) {
    throw new Error("Pi launch process fingerprint is malformed");
  }
  return Object.freeze({ pid: Number(fingerprint["pid"]), startTimeTicks: fingerprint["startTimeTicks"], bootId: fingerprint["bootId"] });
}

/** Bind the registry's Pi-child incarnation separately from launcher/supervisor custody. */
export function recordPiReadonlyRoleProcessIdentity(env: NodeJS.ProcessEnv, deploymentId: string, deploymentDirectory: string, pid: number): void {
  if ((env["PA_TEAM"] === "builder" && ["orchestrator", "implement", "worker"].includes(env["PA_MODE"] ?? ""))
    || (env["PA_TEAM"] === "requirements" && env["PA_MODE"] === "review-auto")) {
    recordPiProcessIdentity(deploymentId, deploymentDirectory, pid);
  }
}
