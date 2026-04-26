import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Ported from PA paths.ts at frozen PA source on 2026-04-26; pa-platform owns future changes.

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function getPlatformHomeDir(): string {
  const fromEnv = process.env["PA_PLATFORM_HOME"];
  if (fromEnv) return expandHome(fromEnv);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function getConfigDir(): string {
  return expandHome(process.env["PA_PLATFORM_CONFIG"] ?? "~/.config/sinh-x/pa-platform");
}

export function getUserConfigPath(): string {
  return resolve(getConfigDir(), "config.yaml");
}

export function getHealthConfigPath(): string {
  return resolve(getConfigDir(), "health.yaml");
}

export function getDataDir(): string {
  return expandHome(process.env["PA_PLATFORM_DATA"] ?? "~/.local/share/pa-platform");
}

export function getTeamsDir(): string {
  return expandHome(process.env["PA_PLATFORM_TEAMS"] ?? resolve(getPlatformHomeDir(), "teams"));
}

export function getSkillsDir(): string {
  return expandHome(process.env["PA_PLATFORM_SKILLS"] ?? resolve(getPlatformHomeDir(), "skills/global"));
}

export function getPrimersDir(): string {
  return resolve(getDataDir(), "primers");
}

export function getLogsDir(): string {
  return resolve(getDataDir(), "logs");
}

export function getAiUsageDir(): string {
  return expandHome(process.env["PA_AI_USAGE_HOME"] ?? "~/Documents/ai-usage");
}

export function getAgentTeamsDir(): string {
  return resolve(getAiUsageDir(), "agent-teams");
}

export function getSinhInputsDir(): string {
  return resolve(getAiUsageDir(), "sinh-inputs");
}

export function getDailyDir(): string {
  return resolve(getAiUsageDir(), "daily");
}

export function getSessionsDir(): string {
  return resolve(getAiUsageDir(), "sessions");
}

export function getKnowledgeBaseDir(): string {
  return resolve(getAiUsageDir(), "knowledge-base");
}

export function getRepoHealthDir(): string {
  return resolve(getKnowledgeBaseDir(), "repo-health");
}

export function getRepoHealthDbPath(): string {
  return resolve(getKnowledgeBaseDir(), "repo-health.db");
}

export function getDeploymentsDir(): string {
  return resolve(getAiUsageDir(), "deployments");
}

export function getTicketsDir(): string {
  return resolve(getAiUsageDir(), "tickets");
}

export function getBulletinsDir(): string {
  return resolve(getAiUsageDir(), "bulletins");
}

export function getTrashDir(): string {
  return resolve(getAiUsageDir(), "trash");
}

export function getSignalDir(): string {
  return resolve(getAiUsageDir(), "signal");
}

export function getQueueDir(): string {
  return resolve(getAiUsageDir(), "queue");
}

export function getRegistryDbPath(): string {
  return expandHome(process.env["PA_REGISTRY_DB"] ?? resolve(getDeploymentsDir(), "registry.db"));
}

export function getDeploymentDir(deploymentId: string): string {
  return resolve(getDeploymentsDir(), deploymentId);
}
