import type { ProcessFingerprint } from "@pa-platform/pa-core";
import type { HerdrEndpoint, HerdrPane, HerdrSource } from "./session-herdr-source.js";
import { sameFingerprint, type ProcessReader } from "./session-process.js";

export interface SessionLocation extends HerdrPane { session: string }
export type SessionMapping =
  | { state: "mapped" | "qualified"; location: SessionLocation }
  | { state: "ambiguous" | "unmatched" | "unknown"; reason: string };
export interface HerdrCapture { mappings: Map<string, SessionMapping>; complete: boolean; reasons: string[] }
interface Lineage { members: ProcessFingerprint[]; complete: boolean; jobControl: unknown[] }
function lineage(anchor: ProcessFingerprint, read: ProcessReader): Lineage {
  const members: ProcessFingerprint[] = [], seen = new Set<number>(), jobControl: unknown[] = []; let pid = anchor.pid;
  let childTty: number | undefined;
  for (let depth = 0; pid > 0 && depth < 64 && !seen.has(pid); depth++) {
    seen.add(pid); const observation = read(pid);
    if (observation.kind !== "present" || ["Z", "X", "x"].includes(observation.state)
      || (depth === 0 && !sameFingerprint(anchor, observation.fingerprint))) return { members: [], complete: false, jobControl };
    const control = observation.jobControl;
    if (!control) return { members: [], complete: false, jobControl };
    // Do not cross a background job-control boundary or attribute detached work
    // to an interactive ancestor. A separate foreground PTY remains supported.
    if ((control.tty !== 0 && control.group !== control.foregroundGroup) || (childTty === 0 && control.tty !== 0)) return { members, complete: true, jobControl };
    jobControl.push(control); childTty = control.tty;
    members.push(observation.fingerprint); pid = observation.parentPid;
  }
  return { members, complete: pid === 0, jobControl };
}
function sameLineage(a: Lineage, b: Lineage): boolean {
  return JSON.stringify(a.jobControl) === JSON.stringify(b.jobControl) && a.members.length === b.members.length && a.members.every((fp, i) => sameFingerprint(fp, b.members[i]!));
}
const scope = (endpoint: HerdrEndpoint) => JSON.stringify([endpoint.name, endpoint.socketPath, endpoint.identity]);
interface Hit { endpoint: HerdrEndpoint; pane: HerdrPane; foreground: ProcessFingerprint }

/** Read-only, same-window projection. No CWD/title joins, cached matches or activity inference. */
export async function captureHerdrLocations(anchors: Map<string, ProcessFingerprint>, source: HerdrSource, read: ProcessReader, deadline: number, clock = Date.now): Promise<HerdrCapture> {
  const mappings = new Map<string, SessionMapping>(), reasons = new Set<string>();
  if (anchors.size === 0) return { mappings, complete: true, reasons: [] };
  const initial = new Map([...anchors].map(([key, anchor]) => [key, lineage(anchor, read)]));
  if ([...initial.values()].some(chain => !chain.complete)) reasons.add("process-lineage-incomplete");
  let roster;
  try { roster = await source.roster(deadline); } catch { roster = { endpoints: [], complete: false, reasons: ["herdr-roster-unavailable"] }; }
  for (const reason of roster.reasons) reasons.add(reason);
  if (!roster.complete) reasons.add("herdr-coverage-incomplete");
  const hits = new Map<string, Hit[]>();
  let panesObserved = 0;
  for (const endpoint of roster.endpoints) {
    if (clock() >= deadline) { reasons.add("herdr-budget-exhausted"); break; }
    let panes: HerdrPane[];
    try { panes = await source.snapshot(endpoint, deadline); } catch { reasons.add("herdr-snapshot-unavailable"); continue; }
    for (const pane of panes) {
      if (clock() >= deadline || panesObserved++ >= 1024) { reasons.add("herdr-pane-budget-exhausted"); break; }
      let foreground: number[];
      try { foreground = await source.foreground(endpoint, pane.paneId, deadline); } catch { reasons.add("herdr-process-info-unavailable"); continue; }
      for (const pid of new Set(foreground)) {
        // Recycled pane foreground PIDs cannot match an old ancestry sample.
        const observed = read(pid);
        if (observed.kind !== "present" || ["Z", "X", "x"].includes(observed.state)) { reasons.add("herdr-foreground-unverified"); continue; }
        for (const [key, chain] of initial) {
          if (!chain.members.some(fp => sameFingerprint(fp, observed.fingerprint))) continue;
          const list = hits.get(key) ?? [];
          if (!list.some(hit => scope(hit.endpoint) === scope(endpoint) && hit.pane.paneId === pane.paneId)) list.push({ endpoint, pane, foreground: observed.fingerprint });
          hits.set(key, list);
        }
      }
    }
  }
  // Every reported match needs a second topology/foreground/lineage read. A
  // competing first observation that cannot settle withholds the location.
  const stable = new Map<string, Hit[]>(), unsettled = new Set<string>();
  const snapshots = new Map<string, HerdrPane[]>();
  for (const [key, list] of hits) {
    for (const hit of list) {
      if (clock() >= deadline) { unsettled.add(key); reasons.add("herdr-recheck-budget-exhausted"); continue; }
      try {
        const endpointKey = scope(hit.endpoint);
        let panes = snapshots.get(endpointKey);
        if (!panes) { panes = await source.snapshot(hit.endpoint, deadline); snapshots.set(endpointKey, panes); }
        const pane = panes.find(value => value.paneId === hit.pane.paneId);
        if (!pane || JSON.stringify(pane) !== JSON.stringify(hit.pane)) throw new Error();
        const pids = await source.foreground(hit.endpoint, pane.paneId, deadline);
        const observed = read(hit.foreground.pid), chain = lineage(anchors.get(key)!, read);
        if (!pids.includes(hit.foreground.pid) || observed.kind !== "present" || !sameFingerprint(observed.fingerprint, hit.foreground)
          || ["Z", "X", "x"].includes(observed.state) || !sameLineage(initial.get(key)!, chain)) throw new Error();
        stable.set(key, [...(stable.get(key) ?? []), hit]);
      } catch { unsettled.add(key); reasons.add("herdr-match-changed-or-unavailable"); }
    }
  }
  // Roster churn prevents claiming uniqueness across previously inspected owners.
  try {
    const final = await source.roster(deadline);
    for (const reason of final.reasons) reasons.add(reason);
    if (!final.complete || JSON.stringify(roster.endpoints.map(scope).sort()) !== JSON.stringify(final.endpoints.map(scope).sort())) reasons.add("herdr-roster-changed-or-incomplete");
    const finalScopes = new Set(final.endpoints.map(scope));
    for (const [key, list] of stable) if (list.some(hit => !finalScopes.has(scope(hit.endpoint)))) unsettled.add(key);
  } catch { reasons.add("herdr-roster-unavailable"); }
  for (const [key] of anchors) {
    const list = stable.get(key) ?? [];
    if (unsettled.has(key)) mappings.set(key, { state: "unknown", reason: "location-changed-or-unverified" });
    else if (list.length > 1) mappings.set(key, { state: "ambiguous", reason: "multiple-scoped-process-matches" });
    else if (list.length === 1) {
      const hit = list[0]!;
      mappings.set(key, { state: reasons.size ? "qualified" : "mapped", location: { session: hit.endpoint.name, ...hit.pane } });
    } else mappings.set(key, reasons.size ? { state: "unknown", reason: "herdr-coverage-incomplete" } : { state: "unmatched", reason: "no-foreground-ancestry-match" });
  }
  return { mappings, complete: reasons.size === 0, reasons: [...reasons].sort() };
}
