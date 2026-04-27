import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDeploymentDir } from "../paths.js";
import { queryDeploymentStatuses } from "../registry/index.js";
import { TicketStore } from "../tickets/index.js";
import { parseTimestamp } from "../time.js";
import { parseActivityLog } from "./activity.js";
import { scoreFindings } from "./score.js";
import type { CategoryResult, HealthCategory, HealthFinding, HealthWindow } from "./types.js";

// Ported from PA health/checks.ts at frozen PA source on 2026-04-26; external shell/systemd checks are kept optional for pa-core portability.

export function makeFinding(severity: HealthFinding["severity"], category: HealthCategory, message: string, details?: string): HealthFinding {
  return { severity, category, message, details };
}

export function checkDeployments(window: HealthWindow): CategoryResult {
  const category: HealthCategory = "deployments";
  const deployments = deploymentsInWindow(window);
  const findings: HealthFinding[] = [];
  if (deployments.length === 0) {
    findings.push(makeFinding("pass", category, "No deployments in the analysis window"));
    return categoryResult(category, findings, { total: 0 });
  }
  const successCount = deployments.filter((deployment) => deployment.status === "success" || deployment.status === "partial").length;
  const failCount = deployments.filter((deployment) => deployment.status === "failed").length;
  const crashCount = deployments.filter((deployment) => deployment.status === "crashed").length;
  const runningDead = deployments.filter((deployment) => deployment.status === "running" && deployment.pid && !isProcessAlive(deployment.pid));
  const successRate = (successCount / deployments.length) * 100;
  findings.push(makeFinding("pass", category, `Deployments analyzed: ${deployments.length}`, `Success: ${successCount}, Failed: ${failCount}, Crashed: ${crashCount}`));
  if (successRate >= 80) findings.push(makeFinding("pass", category, `Success rate: ${successRate.toFixed(1)}%`));
  else if (successRate >= 60) findings.push(makeFinding("warn", category, `Success rate below healthy threshold: ${successRate.toFixed(1)}%`));
  else findings.push(makeFinding("fail", category, `Success rate critically low: ${successRate.toFixed(1)}%`));
  for (const deployment of runningDead) findings.push(makeFinding("fail", category, `Orphaned deployment: ${deployment.deploy_id}`, `PID ${deployment.pid} is not alive`));
  if (runningDead.length === 0) findings.push(makeFinding("pass", category, "No orphaned deployments"));
  return categoryResult(category, findings, { total: deployments.length, successCount, failCount, crashCount, orphanCount: runningDead.length, successRate });
}

export function checkAgents(window: HealthWindow): CategoryResult {
  const category: HealthCategory = "agents";
  const deployments = deploymentsInWindow(window);
  const findings: HealthFinding[] = [];
  let totalToolCalls = 0;
  let totalFailures = 0;
  let deploymentsWithErrorLoops = 0;
  for (const deployment of deployments) {
    const activity = parseActivityLog(deployment.deploy_id);
    totalToolCalls += activity.totalCalls;
    totalFailures += activity.failures;
    if (activity.errorLoops.length > 0) {
      deploymentsWithErrorLoops++;
      findings.push(makeFinding("fail", category, `Deployment ${deployment.deploy_id}: ${activity.errorLoops.length} error loop(s) detected`));
    }
  }
  if (deployments.length === 0) findings.push(makeFinding("pass", category, "No deployments to analyze agent behavior"));
  else if (totalToolCalls === 0) findings.push(makeFinding("pass", category, "No activity logs found for analysis"));
  else {
    const errorRate = totalFailures / totalToolCalls;
    if (errorRate > 0.1) findings.push(makeFinding("fail", category, `High tool failure rate: ${(errorRate * 100).toFixed(1)}%`));
    else if (errorRate > 0.05) findings.push(makeFinding("warn", category, `Elevated tool failure rate: ${(errorRate * 100).toFixed(1)}%`));
    else findings.push(makeFinding("pass", category, `Tool failure rate: ${(errorRate * 100).toFixed(1)}%`));
    if (deploymentsWithErrorLoops === 0) findings.push(makeFinding("pass", category, "No error loops detected"));
  }
  return categoryResult(category, findings, { deploymentsAnalyzed: deployments.length, totalToolCalls, totalFailures, deploymentsWithErrorLoops });
}

export function checkTickets(window: HealthWindow, store = new TicketStore()): CategoryResult {
  const category: HealthCategory = "tickets";
  const findings: HealthFinding[] = [];
  const tickets = store.list();
  const handoffStatuses = new Set(["pending-approval", "review-uat"]);
  const now = Date.now();
  const windowStart = parseTimestamp(window.since).getTime();
  let staleCount = 0;
  let missingDocRefCount = 0;
  for (const ticket of tickets) {
    const updatedAt = parseTimestamp(ticket.updatedAt).getTime();
    if (updatedAt >= windowStart && now - updatedAt > 7 * 86400000 && !["done", "rejected", "cancelled"].includes(ticket.status)) {
      staleCount++;
      findings.push(makeFinding("fail", category, `Stale ticket: ${ticket.id}`));
    }
    if (handoffStatuses.has(ticket.status) && (ticket.doc_refs.length === 0 || ticket.tags.includes("needs-doc-ref"))) {
      missingDocRefCount++;
      findings.push(makeFinding("fail", category, `Handoff ticket missing doc_refs: ${ticket.id}`));
    }
  }
  findings.push(makeFinding("pass", category, `Tickets analyzed: ${tickets.length}`));
  if (staleCount === 0) findings.push(makeFinding("pass", category, "No stale tickets"));
  if (missingDocRefCount === 0) findings.push(makeFinding("pass", category, "All handoff tickets have doc_refs"));
  return categoryResult(category, findings, { total: tickets.length, staleCount, missingDocRefCount });
}

export function checkCompliance(window: HealthWindow): CategoryResult {
  const category: HealthCategory = "compliance";
  const findings: HealthFinding[] = [];
  const deployments = deploymentsInWindow(window);
  let missingSessionLogs = 0;
  let missingRating = 0;
  for (const deployment of deployments) {
    if (deployment.log_file && !existsSync(resolveLogPath(deployment.log_file))) missingSessionLogs++;
    if (!deployment.log_file) missingSessionLogs++;
    if ((deployment.status === "success" || deployment.status === "partial") && !deployment.fallback) {
      // Registry query returns materialized rows; rating is currently not in DeploymentStatus, so this remains a conservative warning only when future data adds it.
    }
  }
  if (deployments.length === 0) findings.push(makeFinding("pass", category, "No deployments to check compliance"));
  else findings.push(makeFinding("pass", category, `Compliance checked: ${deployments.length} deployment(s)`));
  if (missingSessionLogs === 0) findings.push(makeFinding("pass", category, "All session logs accessible"));
  else findings.push(makeFinding("fail", category, `${missingSessionLogs} deployment(s) missing session logs`));
  return categoryResult(category, findings, { missingSessionLogs, missingRating });
}

export function checkSchedules(): CategoryResult {
  const category: HealthCategory = "schedules";
  return categoryResult(category, [makeFinding("warn", category, "Schedule health requires adapter/host integration")]);
}

export function checkInfrastructure(window: HealthWindow): CategoryResult {
  const category: HealthCategory = "infrastructure";
  const findings: HealthFinding[] = [];
  const deployments = deploymentsInWindow(window);
  let missingWorkspace = 0;
  let missingLogFile = 0;
  for (const deployment of deployments) {
    if (deployment.status === "running" && !existsSync(getDeploymentDir(deployment.deploy_id))) missingWorkspace++;
    if (deployment.log_file && !existsSync(resolveLogPath(deployment.log_file))) missingLogFile++;
  }
  if (deployments.length === 0) findings.push(makeFinding("pass", category, "No deployments to check infrastructure"));
  else findings.push(makeFinding("pass", category, `Infrastructure checked: ${deployments.length} deployment(s)`));
  if (missingWorkspace === 0 && missingLogFile === 0) findings.push(makeFinding("pass", category, "All infrastructure references valid"));
  else findings.push(makeFinding("fail", category, "Infrastructure references missing", `Workspaces: ${missingWorkspace}, logs: ${missingLogFile}`));
  return categoryResult(category, findings, { missingWorkspace, missingLogFile });
}

function categoryResult(name: HealthCategory, findings: HealthFinding[], stats?: Record<string, number | string | boolean>): CategoryResult {
  return { name, score: scoreFindings(findings), findings, stats };
}

function deploymentsInWindow(window: HealthWindow) {
  return queryDeploymentStatuses().filter((deployment) => deployment.started_at >= window.since && deployment.started_at <= window.until);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveLogPath(logFile: string): string {
  if (logFile.startsWith("~/")) return resolve(process.env["HOME"] ?? "", logFile.slice(2));
  return resolve(logFile);
}
