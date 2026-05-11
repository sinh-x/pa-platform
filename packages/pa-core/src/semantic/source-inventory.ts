import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getAgentTeamsDir, getAiUsageDir, getDeploymentsDir, getRegistryDbPath, getSessionsDir, getSinhInputsDir, getTicketsDir } from "../paths.js";

export type SemanticSourceType =
  | "ticket"
  | "ticket-comment"
  | "doc-ref"
  | "artifact"
  | "session-log"
  | "registry-event"
  | "deployment"
  | "reflection"
  | "sinh-input";

export interface SemanticSourceIdentity {
  type: SemanticSourceType;
  locator: string;
}

export interface SemanticSourceMetadata {
  id: string;
  type: SemanticSourceType;
  locator: string;
  link: string;
  reflection_first: boolean;
  section: "reflections" | "system";
}

export interface SemanticSourceRoot {
  id: string;
  purpose: string;
  absolute_path: string;
}

const APPROVED_ROOTS: SemanticSourceRoot[] = [
  { id: "tickets", purpose: "ticket definitions and comments", absolute_path: getTicketsDir() },
  { id: "agent-artifacts", purpose: "team artifacts and doc_refs", absolute_path: getAgentTeamsDir() },
  { id: "sessions", purpose: "session logs", absolute_path: getSessionsDir() },
  { id: "deployments", purpose: "deployment metadata and activity", absolute_path: getDeploymentsDir() },
  { id: "registry-db", purpose: "registry database", absolute_path: getRegistryDbPath() },
  { id: "sinh-reflections", purpose: "explicitly scoped Sinh reflections", absolute_path: resolve(getSinhInputsDir(), "for-review") },
  { id: "sinh-inputs", purpose: "explicitly scoped Sinh personal inputs", absolute_path: getSinhInputsDir() },
];

export function listApprovedSemanticSourceRoots(): SemanticSourceRoot[] {
  return APPROVED_ROOTS.map((root) => ({ ...root }));
}

export function createSemanticSourceId(identity: SemanticSourceIdentity): string {
  const canonical = `${identity.type}:${identity.locator.trim().toLowerCase()}`;
  const digest = createHash("sha1").update(canonical).digest("hex").slice(0, 16);
  return `src_${digest}`;
}

export function buildSemanticSourceMetadata(input: { type: SemanticSourceType; locator: string; link: string; authoredBy?: string }): SemanticSourceMetadata {
  const reflectionFirst = input.type === "reflection" || input.type === "sinh-input" || (input.authoredBy?.toLowerCase() ?? "") === "sinh";
  return {
    id: createSemanticSourceId({ type: input.type, locator: input.locator }),
    type: input.type,
    locator: input.locator,
    link: input.link,
    reflection_first: reflectionFirst,
    section: reflectionFirst ? "reflections" : "system",
  };
}

export function isApprovedSemanticPath(path: string): boolean {
  const normalized = resolve(path);
  if (normalized.startsWith(`${resolve(process.env["HOME"] ?? "")}/.ssh`)) return false;
  if (normalized.includes("/.gnupg/")) return false;
  if (normalized.includes("/.aws/")) return false;
  if (normalized.includes("/.config/opencode/")) return false;
  return APPROVED_ROOTS.some((root) => {
    const approved = resolve(root.absolute_path);
    return normalized === approved || normalized.startsWith(`${approved}/`);
  }) || normalized.startsWith(`${resolve(getAiUsageDir())}/agent-teams/`);
}
