import { captureSessionProcesses, defaultInventoryHost, recheckSessionProcesses, sessionDisplayText, type InventoryHost, type SessionFilters, type SessionRow } from "./session-inventory.js";
import { captureHerdrLocations, type SessionMapping } from "./session-herdr.js";
import { defaultHerdrSource, type HerdrSource } from "./session-herdr-source.js";
export interface SessionSnapshot {
  schemaVersion: "ppa-sessions/v1";
  capture: { startedAt: string; endedAt: string };
  scope: "local-linux-ppa-pi-existing-launch-evidence";
  filters: SessionFilters & { all: boolean };
  coverage: { complete: boolean; reasons: string[]; candidatesObserved: number; diagnosticsOmitted: number };
  rows: Array<SessionRow & { herdr: SessionMapping }>;
}
/** Shared factual projection for the CLI and future separately authorized readers.
 * Fresh per call, no persistence, registry reconciliation or launcher backfill. */
export async function captureSessions(filters: SessionFilters & { all?: boolean }, host: InventoryHost = defaultInventoryHost(), herdr: HerdrSource = defaultHerdrSource()): Promise<SessionSnapshot> {
  const started = host.clock();
  const processes = captureSessionProcesses(filters, host, started + 3000);
  const topology = await captureHerdrLocations(processes.anchors, herdr, host.process, started + 8000, host.clock);
  recheckSessionProcesses(processes, host, started + 10_000);
  const rows: SessionSnapshot["rows"] = [];
  let diagnosticsOmitted = 0;
  for (const row of processes.rows) {
    if (!filters.all && row.process.state !== "verified-open") { diagnosticsOmitted++; continue; }
    let mapping: SessionMapping = row.process.state === "verified-open" ? topology.mappings.get(row.deploymentId) ?? { state: "unknown", reason: "location-unverified" }
      : { state: "unknown", reason: "process-not-verified-open" };
    if ("location" in mapping) {
      // Keep protected socket identities and raw labels out of every public format.
      const location = Object.fromEntries(Object.entries(mapping.location).map(([key, value]) => [key, sessionDisplayText(value)]));
      if (["session", "workspaceId", "tabId", "paneId", "terminalId"].some(key => !location[key] || location[key] === "[withheld]")) mapping = { state: "unknown", reason: "location-metadata-withheld" };
      else mapping = { ...mapping, location: location as unknown as typeof mapping.location };
    }
    rows.push({ ...row, herdr: mapping });
  }
  return { schemaVersion: "ppa-sessions/v1", capture: { startedAt: new Date(started).toISOString(), endedAt: new Date(host.clock()).toISOString() },
    scope: "local-linux-ppa-pi-existing-launch-evidence", filters: { ...filters, all: filters.all ?? false },
    coverage: { complete: processes.complete && topology.complete, reasons: [...new Set([...processes.reasons, ...topology.reasons])].sort(), candidatesObserved: processes.rows.length, diagnosticsOmitted }, rows };
}
