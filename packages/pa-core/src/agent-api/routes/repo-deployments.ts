import { basename } from "node:path";
import { Hono } from "hono";
import { loadRepoEntry } from "../../repos.js";
import { computeDeploymentStatuses, readRegistry } from "../../registry/index.js";
import { getTodayDateString, isValidDateString } from "./deployments.js";
import type { DeploymentStatus } from "../../types.js";

const TERMINAL_STATUSES = new Set(["success", "partial", "failed", "crashed", "dead"]);

export function repoDeploymentsRoutes(): Hono {
  const app = new Hono();
  app.get("/api/repos/:key/deployments", (c) => {
    const key = c.req.param("key");
    if (!/^[a-zA-Z0-9-]+$/.test(key)) return c.json({ error: "Invalid repo key", code: "BAD_REQUEST" }, 400);
    const repo = loadRepoEntry(key);
    if (!repo) return c.json({ error: `Repo key not found: ${key}`, code: "NOT_FOUND" }, 404);
    const statusFilter = c.req.query("status") || "all";
    const sinceParam = c.req.query("since");
    if (sinceParam && !isValidDateString(sinceParam)) return c.json({ error: "Invalid 'since' parameter. Expected YYYY-MM-DD format.", code: "BAD_REQUEST" }, 400);
    const since = c.req.query("all") === "true" ? undefined : sinceParam ?? getTodayDateString();
    const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const repoBasename = basename(repo.path);
    let deployments = computeDeploymentStatuses(readRegistry()).filter((deployment) => deployment.repo === key || deployment.repo === repoBasename).map(markDeadRunningDeployment);
    if (statusFilter === "running") deployments = deployments.filter((deployment) => deployment.status === "running");
    else if (statusFilter === "finished") deployments = deployments.filter((deployment) => TERMINAL_STATUSES.has(deployment.status));
    if (since) deployments = deployments.filter((deployment) => deployment.started_at >= since);
    return c.json({ repo: { key: repo.name, path: repo.path, description: repo.description, prefix: repo.prefix }, deployments: deployments.slice(0, limit), total: deployments.length, filter: { status: statusFilter, limit, since } });
  });
  return app;
}

function markDeadRunningDeployment(deployment: DeploymentStatus): DeploymentStatus {
  if (deployment.status !== "running" || !deployment.pid) return deployment;
  try {
    process.kill(deployment.pid, 0);
    return deployment;
  } catch {
    return { ...deployment, status: "dead" };
  }
}
