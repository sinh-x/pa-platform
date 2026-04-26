import { execSync } from "node:child_process";
import { Hono } from "hono";

export interface TimerEntry {
  unit: string;
  team: string;
  next_in: string;
}

export function parseTimersOutput(output: string): TimerEntry[] {
  const timers: TimerEntry[] = [];
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    const timerIdx = parts.findIndex((part) => part.endsWith(".timer"));
    if (timerIdx < 0) continue;
    const unit = parts[timerIdx]!;
    timers.push({ unit, team: unit.replace(/^pa-/, "").replace(/\.timer$/, ""), next_in: parts.length > 4 ? parts[4] ?? "" : "" });
  }
  return timers;
}

export function timersRoutes(): Hono {
  const app = new Hono();
  app.get("/api/timers", (c) => {
    try {
      const output = execSync("systemctl --user list-timers --no-pager", { encoding: "utf-8", timeout: 10000 });
      return c.json({ timers: parseTimersOutput(output), raw: output.trim() });
    } catch (error) {
      return c.json({ error: `Failed to list timers: ${error instanceof Error ? error.message : String(error)}`, code: "INTERNAL_ERROR" }, 500);
    }
  });
  return app;
}
