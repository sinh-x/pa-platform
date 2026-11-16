import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { workflowDigest, type ReaderOpeningObservation } from "@pa-platform/pa-core";

/** Explicit operator-approved convenience fallback, NOT the trusted packaged
 * opener. It owns only the bounded desktop-launcher invocation. The user's
 * default browser, its network access and descendant lifecycle are not confined.
 * No caller path/program/argv/environment is accepted by the native request. */
export class SystemDocumentBrowserFallback {
  private readonly launcher: string | undefined;
  constructor(private readonly entry: string) {
    this.launcher = this.resolveLauncher();
  }
  private resolveLauncher(): string | undefined {
    if (process.platform !== "linux" || !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return undefined;
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(path => path.startsWith("/"))) {
      try {
        const path = realpathSync(join(directory, "xdg-open")), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        accessSync(path, constants.X_OK); return path;
      } catch { /* absence is not permission to choose another program */ }
    }
    return undefined;
  }
  available(): boolean { return this.launcher !== undefined; }
  request(deliverySha256: string, operationId: string): ReaderOpeningObservation {
    const evidenceSha256 = workflowDigest(JSON.stringify(["pa-system-browser-fallback/v1", operationId, deliverySha256, this.launcher ?? null]));
    if (!this.launcher) return { state: "unavailable", cleanup: "not-needed", evidenceSha256 };
    // Fixed executable + one native-derived file URI. Never shell:true, an
    // arbitrary URL, a caller program, argument pass-through or a headless probe.
    const result = spawnSync(this.launcher, [pathToFileURL(this.entry).href], {
      env: process.env, stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 4096,
    });
    if (!result.error && result.status === 0) return { state: "open-requested", cleanup: "settled", evidenceSha256 };
    // Even a failing launcher may already have contacted a desktop handler.
    // Preserve the original possible effect; never blindly launch again.
    return { state: "uncertain", cleanup: "unknown", evidenceSha256 };
  }
  reconcile(deliverySha256: string, operationId: string): ReaderOpeningObservation {
    return { state: "uncertain", cleanup: "unknown", evidenceSha256: workflowDigest(JSON.stringify(["pa-system-browser-fallback/v1", operationId, deliverySha256, "external-browser-outcome-unproven"])) };
  }
}
