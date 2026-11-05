import type { RegistryEvent } from "../types.js";
import { queryReadonlyDeploymentEvents } from "../registry/index.js";
import { ADVISORY_RUNTIME_VERSION } from "./service.js";

/** Native start dispatch only, never a model argument or ambient mode flag.
 * Unmarked/ambiguous/retained starts cannot inherit the new semantics. */
export function advisoryStartFromEvents(events: readonly RegistryEvent[]): RegistryEvent | null {
  const starts = events.filter(event => event.event === "started");
  const start = starts[0];
  if (starts.length !== 1 || !start || start.note !== ADVISORY_RUNTIME_VERSION || start.resumed_from_deployment_id || start.parent_deployment_id || start.rogue_one
    || !["pi", "opencode"].includes(start.runtime ?? "") || start.binary !== (start.runtime === "pi" ? "ppa" : "opa")
    || !start.repo || !start.repo_root || !start.worktree_root || start.repo !== start.worktree_root) return null;
  return start;
}
export function readAdvisoryStart(deploymentId: string): RegistryEvent | null {
  if (!/^d-[0-9a-f]{6}$/.test(deploymentId)) return null;
  return advisoryStartFromEvents(queryReadonlyDeploymentEvents(deploymentId));
}
