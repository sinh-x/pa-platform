import { readFileSync } from "node:fs";
import type { ProcessFingerprint } from "@pa-platform/pa-core";

export type ProcessObservation =
  | { kind: "present"; fingerprint: ProcessFingerprint; parentPid: number; state: string }
  | { kind: "exited" }
  | { kind: "unverified"; reason: "process-inaccessible" | "process-malformed" | "unsupported-host" };
export type ProcessReader = (pid: number) => ProcessObservation;
export const sameFingerprint = (a: ProcessFingerprint, b: ProcessFingerprint): boolean =>
  a.pid === b.pid && a.bootId === b.bootId && a.startTimeTicks === b.startTimeTicks;

/** Read only stat and boot metadata, never arguments, environment or terminal data. */
export function observeSessionProcess(pid: number, read: (path: string) => string = path => readFileSync(path, "utf8"), platform = process.platform): ProcessObservation {
  if (platform !== "linux") return { kind: "unverified", reason: "unsupported-host" };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unverified", reason: "process-malformed" };
  let stat: string;
  try { stat = read(`/proc/${pid}/stat`); }
  catch (error) {
    // ENOENT alone can mean a hidden process. Only call absence established on
    // a visible procfs mount; otherwise retain uncertainty, never probe with signals.
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      try {
        const mount = read("/proc/mounts").split("\n").find(line => line.split(" ")[1] === "/proc");
        if (mount && mount.split(" ")[2] === "proc" && !/hidepid=(?!0(?:,|\s|$))/.test(mount)) return { kind: "exited" };
      } catch { /* absence not established */ }
    }
    return { kind: "unverified", reason: "process-inaccessible" };
  }
  try {
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const state = fields[0], parentPid = Number(fields[1]), startTimeTicks = fields[19];
    const bootId = read("/proc/sys/kernel/random/boot_id").trim();
    if (close < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid || !state || !/^[A-Za-z]$/.test(state)
      || !Number.isSafeInteger(parentPid) || parentPid < 0 || !startTimeTicks || !/^\d{1,30}$/.test(startTimeTicks)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) return { kind: "unverified", reason: "process-malformed" };
    return { kind: "present", fingerprint: { pid, startTimeTicks, bootId }, parentPid, state };
  } catch { return { kind: "unverified", reason: "process-inaccessible" }; }
}

export type SessionProcess =
  | { state: "verified-open"; pid: number }
  | { state: "identity-mismatch" | "zombie-or-dead" | "exited" | "unverified"; reason: string };
export function classifySessionProcess(anchor: ProcessFingerprint, candidatePid: number | null, observed: ProcessObservation): SessionProcess {
  if (candidatePid !== anchor.pid) return { state: "identity-mismatch", reason: "registry-anchor-mismatch" };
  if (observed.kind === "exited") return { state: "exited", reason: "process-absent" };
  if (observed.kind === "unverified") return { state: "unverified", reason: observed.reason };
  if (!sameFingerprint(anchor, observed.fingerprint)) return { state: "identity-mismatch", reason: "incarnation-changed" };
  if (["Z", "X", "x"].includes(observed.state)) return { state: "zombie-or-dead", reason: "process-not-open" };
  return { state: "verified-open", pid: anchor.pid };
}
