import { findSensitiveMatch, getDeploymentDir, loadReposYaml, readSessionCandidates, type ProcessFingerprint, type SessionCandidate } from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";
import { classifySessionProcess, observeSessionProcess, sameFingerprint, type ProcessReader, type SessionProcess } from "./session-process.js";

export interface SessionFilters { deployment?: string; ticket?: string; repo?: string }
export interface SessionRow {
  deploymentId: string; ticket: string | null; team: string | null; mode: string | null; repository: string | null;
  startedAt: string | null; registryStatus: string | null; candidatePid: number | null; process: SessionProcess;
}
export interface InventoryHost {
  candidates: () => { candidates: SessionCandidate[]; complete: boolean };
  repositories: () => Record<string, { path: string }>;
  anchor: (id: string) => ProcessFingerprint;
  process: ProcessReader;
  clock: () => number;
}
export function defaultInventoryHost(): InventoryHost {
  return { candidates: readSessionCandidates, repositories: loadReposYaml,
    anchor: id => readPiProcessIdentity(id, getDeploymentDir(id)), process: observeSessionProcess, clock: Date.now };
}
/** No arbitrary text is rendered without control stripping, bounds and content screening. */
export function sessionDisplayText(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 256) return null;
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
  try { return findSensitiveMatch("content", plain) ? "[withheld]" : plain; } catch { return "[withheld]"; }
}
export interface ProcessCapture {
  rows: SessionRow[]; complete: boolean; reasons: string[];
  /** Private anchors never enter public snapshots. */
  anchors: Map<string, ProcessFingerprint>;
}
export function captureSessionProcesses(filters: SessionFilters, host: InventoryHost, deadline: number): ProcessCapture {
  const source = host.candidates();
  const reasons = source.complete ? [] : ["registry-candidate-limit"];
  let repositories: Record<string, { path: string }> = {};
  try { repositories = host.repositories(); } catch { reasons.push("repository-keys-unavailable"); }
  const rows: SessionRow[] = [], anchors = new Map<string, ProcessFingerprint>();
  for (const candidate of source.candidates) {
    const keyMatches = Object.entries(repositories).filter(([, entry]) => entry.path === candidate.repositoryRoot).map(([key]) => key);
    const repository = keyMatches.length === 1 ? keyMatches[0]! : null;
    if ((filters.deployment && candidate.deploymentId !== filters.deployment) || (filters.ticket && candidate.ticket !== filters.ticket)
      || (filters.repo && repository !== filters.repo)) continue;
    if (host.clock() >= deadline) { reasons.push("process-budget-exhausted"); break; }
    // Validate before using an owner-derived ID in a filesystem path.
    if (!/^d-[a-f0-9]{6}$/.test(candidate.deploymentId)) { reasons.push("invalid-deployment-metadata"); continue; }
    const candidatePid = Number.isSafeInteger(candidate.candidatePid) && Number(candidate.candidatePid) > 0 ? candidate.candidatePid : null;
    let process: SessionProcess;
    try {
      const anchor = host.anchor(candidate.deploymentId);
      process = classifySessionProcess(anchor, candidatePid, host.process(anchor.pid));
      if (process.state === "verified-open") anchors.set(candidate.deploymentId, anchor);
    } catch { process = { state: "unverified", reason: "launch-evidence-unavailable" }; }
    rows.push({ deploymentId: candidate.deploymentId, ticket: sessionDisplayText(candidate.ticket), team: sessionDisplayText(candidate.team),
      mode: sessionDisplayText(candidate.mode), repository: sessionDisplayText(repository),
      startedAt: typeof candidate.startedAt === "string" && Number.isFinite(Date.parse(candidate.startedAt)) ? new Date(candidate.startedAt).toISOString() : null,
      registryStatus: sessionDisplayText(candidate.registryStatus), candidatePid, process });
  }
  return { rows, anchors, complete: reasons.length === 0, reasons: [...new Set(reasons)] };
}
/** Re-read both launch evidence and current incarnation after optional topology collection. */
export function recheckSessionProcesses(capture: ProcessCapture, host: InventoryHost): void {
  for (const row of capture.rows) {
    const anchor = capture.anchors.get(row.deploymentId);
    if (!anchor) continue;
    try {
      const current = host.anchor(row.deploymentId);
      row.process = sameFingerprint(anchor, current) ? classifySessionProcess(anchor, row.candidatePid, host.process(anchor.pid))
        : { state: "unverified", reason: "launch-evidence-changed" };
    } catch { row.process = { state: "unverified", reason: "launch-evidence-unavailable" }; }
    if (row.process.state !== "verified-open") capture.anchors.delete(row.deploymentId);
  }
}
