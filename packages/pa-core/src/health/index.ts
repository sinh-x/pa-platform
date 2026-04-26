import { getDb } from "../registry/index.js";
import { checkAgents, checkCompliance, checkDeployments, checkInfrastructure, checkSchedules, checkTickets } from "./checks.js";
import { computeOverallScore, getScoreLabel, loadHealthConfig } from "./score.js";
import type { CategoryResult, HealthCategory, HealthReport, HealthSnapshot, HealthWindow } from "./types.js";

export * from "./activity.js";
export * from "./checks.js";
export * from "./score.js";
export type * from "./types.js";

export function parseHealthWindow(opts: { since?: string; days?: number } = {}): HealthWindow {
  const until = new Date();
  const start = opts.since ? new Date(opts.since) : new Date(until);
  if (opts.since && Number.isNaN(start.getTime())) throw new Error(`Invalid date: ${opts.since}`);
  if (!opts.since) start.setDate(start.getDate() - (opts.days && opts.days > 0 ? opts.days : 1));
  return { since: start.toISOString(), until: until.toISOString() };
}

export function generateHealthReport(opts: { category?: HealthCategory; window?: HealthWindow; days?: number; since?: string } = {}): HealthReport {
  const config = loadHealthConfig();
  const window = opts.window ?? parseHealthWindow({ days: opts.days, since: opts.since });
  const categories = opts.category ? [runCategory(opts.category, window)] : [checkDeployments(window), checkAgents(window), checkTickets(window), checkCompliance(window), checkSchedules(), checkInfrastructure(window)];
  const overallScore = computeOverallScore(categories, config.weights);
  return { overallScore, scoreLabel: getScoreLabel(overallScore, config.thresholds), categories, window, generatedAt: new Date().toISOString() };
}

export function saveHealthSnapshot(report: HealthReport): void {
  const categories = JSON.stringify(report.categories.map((category) => ({ name: category.name, score: category.score, findingsCount: category.findings.length })));
  const findingsSummary = JSON.stringify({ pass: countFindings(report.categories, "pass"), warn: countFindings(report.categories, "warn"), fail: countFindings(report.categories, "fail") });
  getDb().prepare("INSERT INTO health_snapshots (timestamp, overall_score, window_since, window_until, categories, findings_summary) VALUES (?, ?, ?, ?, ?, ?)").run(report.generatedAt, report.overallScore, report.window.since, report.window.until, categories, findingsSummary);
}

export function listHealthSnapshots(limit = 10): HealthSnapshot[] {
  return (getDb().prepare("SELECT * FROM health_snapshots ORDER BY timestamp DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((row) => ({ id: Number(row["id"]), timestamp: String(row["timestamp"]), overallScore: Number(row["overall_score"]), windowSince: String(row["window_since"]), windowUntil: String(row["window_until"]), categories: JSON.parse(String(row["categories"])) as HealthSnapshot["categories"] }));
}

export function formatPrimerHealthSummary(report: HealthReport): string {
  return `PA Health: ${report.overallScore}/100 [${report.scoreLabel}] ${report.categories.map((category) => `${category.name}: ${category.score}`).join(", ")}`;
}

function runCategory(category: HealthCategory, window: HealthWindow): CategoryResult {
  if (category === "deployments") return checkDeployments(window);
  if (category === "agents") return checkAgents(window);
  if (category === "tickets") return checkTickets(window);
  if (category === "compliance") return checkCompliance(window);
  if (category === "schedules") return checkSchedules();
  return checkInfrastructure(window);
}

function countFindings(categories: CategoryResult[], severity: "pass" | "warn" | "fail"): number {
  return categories.reduce((sum, category) => sum + category.findings.filter((finding) => finding.severity === severity).length, 0);
}
