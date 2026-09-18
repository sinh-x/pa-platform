import { isAbsolute, resolve } from "node:path";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";

export const MAX_DEPLOYMENT_CORRELATION_PATH_CHARS = 4_096;
export const MAX_DEPLOYMENT_CORRELATION_ID_CHARS = 256;
export const DEPLOYMENT_ID_PATTERN = /^d-[0-9a-f]{6}$/;
const TREEHOUSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const HOLDER_PATTERN = /^pa:([A-Za-z0-9][A-Za-z0-9._-]*):([A-Z][A-Z0-9]*-\d+)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface DeploymentCorrelationEvidence {
  parentDeploymentId?: string;
  builderAuthority?: "orchestrator" | "parented-implement" | "standalone-implement";
  treehousePath?: string;
  treehouseLeaseId?: string;
  treehouseLeaseHolder?: string;
  branchState?: "planned" | "materialized";
  branchBaseSha?: string;
  branchHeadSha?: string;
  ticketSlotId?: string;
  repositoryPermit?: 1 | 2 | 3 | 4;
}

export interface DeploymentCorrelationValidationContext {
  ticketId?: unknown;
  worktreeRoot?: unknown;
  requireWorktreeMatch?: boolean;
}

export class DeploymentCorrelationValidationError extends Error {}

/**
 * Strictly validates optional deployment/Treehouse correlation evidence. An
 * entirely omitted object remains valid for pre-Treehouse registry rows.
 */
export function validateDeploymentCorrelationEvidence(
  input: Record<string, unknown>,
  context: DeploymentCorrelationValidationContext = {},
): DeploymentCorrelationEvidence {
  const parentDeploymentId = optionalDeploymentId(input["parentDeploymentId"], "parentDeploymentId");
  const builderAuthority = optionalEnum(input["builderAuthority"], ["orchestrator", "parented-implement", "standalone-implement"] as const, "builderAuthority");
  const treehousePath = optionalCanonicalPath(input["treehousePath"], "treehousePath");
  const treehouseLeaseId = optionalCanonicalId(input["treehouseLeaseId"], "treehouseLeaseId");
  const treehouseLeaseHolder = optionalHolder(input["treehouseLeaseHolder"], "treehouseLeaseHolder");
  const branchState = optionalEnum(input["branchState"], ["planned", "materialized"] as const, "branchState");
  const branchBaseSha = optionalSha(input["branchBaseSha"], "branchBaseSha");
  const branchHeadSha = optionalSha(input["branchHeadSha"], "branchHeadSha");
  const ticketSlotId = optionalHolder(input["ticketSlotId"], "ticketSlotId");
  const repositoryPermit = optionalPermit(input["repositoryPermit"]);

  if (!branchState && (branchBaseSha || branchHeadSha)) fail("branch SHA evidence requires branchState");
  if (branchState === "planned" && (branchBaseSha || branchHeadSha)) fail("planned branch evidence cannot contain base/head SHAs");
  if (branchState === "materialized" && !branchHeadSha) fail("materialized branch evidence requires an exact branchHeadSha");

  const hasBinding = [parentDeploymentId, builderAuthority, treehousePath, treehouseLeaseId, treehouseLeaseHolder, ticketSlotId, repositoryPermit]
    .some((value) => value !== undefined);
  if (hasBinding) {
    if (!builderAuthority || !treehousePath || !treehouseLeaseId || !treehouseLeaseHolder || !ticketSlotId || !repositoryPermit) {
      fail("Treehouse binding requires authority, canonical path, lease ID/holder, ticket slot, and repository permit together");
    }
    if (branchState !== "materialized" || !branchHeadSha) fail("Treehouse binding requires materialized branch head evidence");
    if (treehouseLeaseHolder !== ticketSlotId) fail("Treehouse lease holder and ticket slot ID must match exactly");
    if ((builderAuthority === "parented-implement") !== Boolean(parentDeploymentId)) {
      fail("parentDeploymentId is required only for parented-implement authority");
    }
    const ticketId = context.ticketId;
    if (ticketId !== undefined) {
      if (typeof ticketId !== "string" || !TICKET_ID_PATTERN.test(ticketId)) fail("ticketId is not canonical");
      if (!treehouseLeaseHolder.endsWith(`:${ticketId}`)) fail("Treehouse holder/slot does not match ticketId");
    }
    if (context.requireWorktreeMatch) {
      const worktreeRoot = requiredCanonicalPath(context.worktreeRoot, "worktreeRoot");
      if (treehousePath !== worktreeRoot) fail("Treehouse path and worktreeRoot must match exactly");
    }
  }

  return {
    ...(parentDeploymentId ? { parentDeploymentId } : {}),
    ...(builderAuthority ? { builderAuthority } : {}),
    ...(treehousePath ? { treehousePath } : {}),
    ...(treehouseLeaseId ? { treehouseLeaseId } : {}),
    ...(treehouseLeaseHolder ? { treehouseLeaseHolder } : {}),
    ...(branchState ? { branchState } : {}),
    ...(branchBaseSha ? { branchBaseSha } : {}),
    ...(branchHeadSha ? { branchHeadSha } : {}),
    ...(ticketSlotId ? { ticketSlotId } : {}),
    ...(repositoryPermit ? { repositoryPermit } : {}),
  };
}

export function validateCanonicalDeploymentId(value: unknown, field = "deploymentId"): string {
  if (typeof value !== "string" || !DEPLOYMENT_ID_PATTERN.test(value)) fail(`${field} must match d- followed by six lowercase hexadecimal characters`);
  return value;
}

function optionalDeploymentId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : validateCanonicalDeploymentId(value, field);
}

function optionalCanonicalPath(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredCanonicalPath(value, field);
}

function requiredCanonicalPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DEPLOYMENT_CORRELATION_PATH_CHARS || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    fail(`${field} must be a normalized absolute path of at most ${MAX_DEPLOYMENT_CORRELATION_PATH_CHARS} characters`);
  }
  return value;
}

function optionalCanonicalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DEPLOYMENT_CORRELATION_ID_CHARS || !TREEHOUSE_ID_PATTERN.test(value)) {
    fail(`${field} must be a canonical bounded identifier`);
  }
  return value;
}

function optionalHolder(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_DEPLOYMENT_CORRELATION_ID_CHARS || !HOLDER_PATTERN.test(value)) {
    fail(`${field} must match pa:<repository-key>:<ticket-id>`);
  }
  return value;
}

function optionalSha(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail(`${field} must be exactly 40 lowercase hexadecimal characters`);
  return value;
}

function optionalPermit(value: unknown): 1 | 2 | 3 | 4 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4) fail("repositoryPermit must be one of 1, 2, 3, or 4");
  return value;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${field} has an unsupported value`);
  return value as T[number];
}

function fail(reason: string): never {
  const message = `Condition: deployment correlation validation. Source: bounded Agent API and registry event evidence. Reason: ${reason}. Correction: send canonical, bounded, mutually consistent optional correlation fields. Resume Action: retry with the authenticated deployment identity or operator principal.`;
  throw new DeploymentCorrelationValidationError(message.slice(0, MAX_REPOSITORY_DIAGNOSTIC_CHARS));
}
