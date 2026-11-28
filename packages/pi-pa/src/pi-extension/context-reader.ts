import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TicketStore } from "@pa-platform/pa-core";
import type { DeploymentProjection } from "./context-state.js";

export type ContextTicketSummary = NonNullable<ReturnType<typeof TicketStore.readSummary>>;
export interface ContextReadRequest { kind: "deployment" | "ticket"; deploymentId: string; cwd: string; project?: string; ticket?: string }

/** Each owner permits one child and no backlog; timeout/abort kills real work.
 * Keep the slot until close so repeated timeouts cannot accumulate children. */
export class ContextNativeReader {
  private busy = false;
  private cancel?: () => void;
  async read<T = DeploymentProjection | ContextTicketSummary>(request: ContextReadRequest): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    try {
      const source = import.meta.url.endsWith(".ts");
      const script = fileURLToPath(new URL(source ? "./context-read-worker.ts" : "./context-read-worker.js", import.meta.url));
      return await new Promise<T | undefined>(resolve => {
        const child = execFile(process.execPath, [...(source ? ["--import", import.meta.resolve("tsx")] : []), script, JSON.stringify(request)],
          { timeout: 500, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
            if (error) { resolve(undefined); return; }
            try { resolve(JSON.parse(stdout) ?? undefined); } catch { resolve(undefined); }
          });
        this.cancel = () => { child.kill("SIGKILL"); };
        child.once("close", () => { this.busy = false; this.cancel = undefined; });
      });
    } catch { this.busy = false; return undefined; }
  }
  abort(): void { this.cancel?.(); }
}
