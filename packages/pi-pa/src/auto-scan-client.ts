import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutoWaitlistError, parseAutoWaitlistSnapshot, type AutoWaitlistSnapshot } from "@pa-platform/pa-core";
/** Same fixed hard wall boundary for CLI opening, explicit scan and timer. */
export function runPiAutoScanWorker(): AutoWaitlistSnapshot {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./auto-scan-worker.js", import.meta.url))], {
    timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new AutoWaitlistError(result.error && "code" in result.error && result.error.code === "ETIMEDOUT" ? "AUTO_LIMIT" : "AUTO_SOURCE");
  return parseAutoWaitlistSnapshot(result.stdout);
}
