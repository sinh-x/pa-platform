import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutoWaitlistError, parseAutoWaitlistSnapshot, type AutoWaitlistSnapshot } from "@pa-platform/pa-core";
/** Fixed maximum wall boundary; a native producer may supply a STRICTER
 * remaining deadline. No CLI/env value can raise the original scanner cap. */
export function runPiAutoScanWorker(timeoutMs = 120_000): AutoWaitlistSnapshot {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new AutoWaitlistError("AUTO_INPUT");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./auto-scan-worker.js", import.meta.url))], {
    timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new AutoWaitlistError(result.error && "code" in result.error && result.error.code === "ETIMEDOUT" ? "AUTO_LIMIT" : "AUTO_SOURCE");
  return parseAutoWaitlistSnapshot(result.stdout);
}
