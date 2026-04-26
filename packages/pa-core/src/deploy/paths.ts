import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDeploymentDir, getPrimersDir, getSessionsDir } from "../paths.js";

export interface DeployPaths {
  deployDir: string;
  primerPath: string;
  sessionPath: string;
  activityLogPath: string;
}

/**
 * Get all paths associated with a deployment.
 */
export function getDeployPaths(deploymentId: string): DeployPaths {
  const deployDir = getDeploymentDir(deploymentId);
  const primerPath = join(getPrimersDir(), `${deploymentId}-primer.md`);
  const sessionPath = join(getSessionsDir(), `${deploymentId}-session.md`);
  const activityLogPath = join(deployDir, "activity.jsonl");
  return { deployDir, primerPath, sessionPath, activityLogPath };
}

/**
 * Ensure the deployment directory exists.
 */
export function ensureDeployDir(deploymentId: string): string {
  const deployDir = getDeploymentDir(deploymentId);
  if (!existsSync(deployDir)) {
    mkdirSync(deployDir, { recursive: true });
  }
  return deployDir;
}

/**
 * Write a primer file for a deployment.
 */
export function writePrimerFile(deploymentId: string, content: string): string {
  const primerPath = getDeployPaths(deploymentId).primerPath;
  const primersDir = getPrimersDir();
  if (!existsSync(primersDir)) {
    mkdirSync(primersDir, { recursive: true });
  }
  writeFileSync(primerPath, content, "utf-8");
  return primerPath;
}

/**
 * Read a primer file for a deployment.
 */
export function readPrimerFile(deploymentId: string): string | undefined {
  const primerPath = getDeployPaths(deploymentId).primerPath;
  if (!existsSync(primerPath)) return undefined;
  return readFileSync(primerPath, "utf-8");
}
