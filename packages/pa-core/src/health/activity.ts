import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDeploymentsDir } from "../paths.js";
import type { ActivityAnalysis, HealthActivityEvent } from "./types.js";

// Ported from PA health/activity.ts at frozen PA source on 2026-04-26.

const ERROR_LOOP_THRESHOLD = 3;

export function parseActivityLog(deployId: string, deploymentsDir = getDeploymentsDir()): ActivityAnalysis {
  const activityPath = resolve(deploymentsDir, deployId, "activity.jsonl");
  const result: ActivityAnalysis = { deployId, totalCalls: 0, failures: 0, errorRate: 0, errorLoops: [] };
  if (!existsSync(activityPath)) return result;
  const events = readFileSync(activityPath, "utf-8").split("\n").filter(Boolean).flatMap((line): HealthActivityEvent[] => {
    try {
      return [JSON.parse(line) as HealthActivityEvent];
    } catch {
      return [];
    }
  });
  result.totalCalls = events.filter((event) => ["tool_call", "tool_success", "tool_failure"].includes(event.event)).length;
  result.failures = events.filter((event) => event.event === "tool_failure").length;
  result.errorRate = result.totalCalls > 0 ? result.failures / result.totalCalls : 0;
  result.errorLoops = detectErrorLoops(events);
  return result;
}

export function detectErrorLoops(events: HealthActivityEvent[]): ActivityAnalysis["errorLoops"] {
  const loops: ActivityAnalysis["errorLoops"] = [];
  const byAgent = new Map<string, HealthActivityEvent[]>();
  for (const event of events.filter((item) => ["tool_call", "tool_success", "tool_failure"].includes(item.event))) {
    byAgent.set(event.agent, [...(byAgent.get(event.agent) ?? []), event]);
  }
  for (const [agent, agentEvents] of byAgent) {
    let consecutiveCount = 0;
    let firstTs = "";
    for (const event of agentEvents) {
      if (event.event !== "tool_failure") {
        consecutiveCount = 0;
        firstTs = "";
        continue;
      }
      if (consecutiveCount === 0) firstTs = event.ts;
      consecutiveCount++;
      if (consecutiveCount >= ERROR_LOOP_THRESHOLD) {
        loops.push({ agent, consecutiveCount, firstTs });
        consecutiveCount = 0;
        firstTs = "";
      }
    }
  }
  return loops;
}
