import { readSessionObjectivePreviews, type SessionObjectivePreview } from "@pa-platform/pa-core";
import type { SessionSnapshot } from "./session-capture.js";

/** Additional screened metadata is versioned separately; inventory v1 is unchanged. */
export interface SessionDashboardSnapshot {
  schemaVersion: "ppa-session-dashboard/v1";
  inventory: SessionSnapshot;
  objectives: {
    capture: { startedAt: string; endedAt: string };
    byDeployment: Record<string, SessionObjectivePreview>;
  };
}
export function addDashboardObjectives(inventory: SessionSnapshot, read: typeof readSessionObjectivePreviews = readSessionObjectivePreviews): SessionDashboardSnapshot {
  const ids = inventory.rows.map(row => row.deploymentId), startedAt = new Date().toISOString();
  let observed: Record<string, SessionObjectivePreview> = {};
  try { observed = read(ids); } catch { /* Objective failure never erases independently captured process facts. */ }
  const byDeployment = Object.fromEntries(ids.map(id => [id, observed[id] ?? { state: "unavailable", reason: "metadata-unavailable" }]));
  return { schemaVersion: "ppa-session-dashboard/v1", inventory,
    objectives: { capture: { startedAt, endedAt: new Date().toISOString() }, byDeployment } };
}
