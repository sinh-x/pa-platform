import type { DeploymentInvocationChannel } from "../types.js";
import type { DeployRequest } from "./control.js";

export type { DeploymentInvocationChannel } from "../types.js";

export const ROGUE_ONE_TEAM = "rogue-one";
export const ROGUE_ONE_MODE = "rogue-one";
export const ROGUE_ONE_ENV = "PA_ROGUE_ONE";

/** Exact resolved team identity is the only rogue-one activation signal. */
export function isRogueOneTeam(team: string): boolean {
  return team === ROGUE_ONE_TEAM;
}

/** Kept for adapter compatibility: valid configured selection is no longer ignored. */
export function rogueOneModeWarning(_team: string, _suppliedMode: string | undefined): string | undefined {
  return undefined;
}

/** Normalize adapter-facing evidence without introducing a user-facing flag. */
export function normalizeRogueOneDeployRequest(request: DeployRequest): DeployRequest {
  return request;
}

export function rogueOneAuditNotice(channel: DeploymentInvocationChannel): string {
  return `ROGUE-ONE ACTIVE: exact team selection intentionally bypasses PA ticket, Git-status, repository-lease, workflow-approval, and final-review admission. Canonical repository identity, sensitive-input validation, runtime/provider validation, adapter safety hooks, host/tool constraints, activity logging, and registry lifecycle remain active. Invocation channel: ${channel}. This evidence does not assert direct human approval.`;
}
