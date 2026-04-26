import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { getHealthConfigPath } from "../paths.js";
import type { CategoryResult, HealthCategory, HealthConfig } from "./types.js";

// Ported from PA health/score.ts at frozen PA source on 2026-04-26; config path follows pa-platform config root.

export const DEFAULT_WEIGHTS: Record<HealthCategory, number> = { deployments: 20, agents: 20, tickets: 20, compliance: 20, schedules: 10, infrastructure: 10 };
export const DEFAULT_THRESHOLDS = { healthy: 80, warning: 60 };

export function loadHealthConfig(configPath = getHealthConfigPath()): HealthConfig {
  if (!existsSync(configPath)) return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
  try {
    const raw = yaml.load(readFileSync(configPath, "utf-8")) as { weights?: Partial<Record<HealthCategory, number>>; thresholds?: Partial<typeof DEFAULT_THRESHOLDS> } | undefined;
    return { weights: { ...DEFAULT_WEIGHTS, ...(raw?.weights ?? {}) }, thresholds: { ...DEFAULT_THRESHOLDS, ...(raw?.thresholds ?? {}) } };
  } catch {
    return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
  }
}

export function computeOverallScore(categories: CategoryResult[], weights: Partial<Record<HealthCategory, number>>): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const category of categories) {
    const weight = weights[category.name] ?? DEFAULT_WEIGHTS[category.name] ?? 0;
    if (weight <= 0) continue;
    totalWeight += weight;
    weightedSum += category.score * weight;
  }
  return totalWeight === 0 ? 100 : Math.round(weightedSum / totalWeight);
}

export function getScoreLabel(score: number, thresholds: { healthy: number; warning: number }): "healthy" | "warning" | "unhealthy" {
  if (score >= thresholds.healthy) return "healthy";
  if (score >= thresholds.warning) return "warning";
  return "unhealthy";
}

export function scoreFindings(findings: Array<{ severity: "pass" | "warn" | "fail" }>): number {
  const fails = findings.filter((finding) => finding.severity === "fail").length;
  const warns = findings.filter((finding) => finding.severity === "warn").length;
  return Math.max(0, Math.min(100, 100 - fails * 15 - warns * 5));
}
