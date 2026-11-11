import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { PublicWebError, WEB_LIMITS } from "./types.js";

/** Only fixed trusted workers use this seam; never exported as a model tool. */
export async function runWebProcess(executable: string, args: string[], signal: AbortSignal, options: {
  input?: Buffer; outputBytes: number;
}): Promise<{ stdout: Buffer; status: number }> {
  if (!isAbsolute(executable)) throw new PublicWebError("WEB_POLICY");
  if (signal.aborted) throw new PublicWebError("WEB_CANCELLED");
  const child = spawn(executable, args, { shell: false, cwd: "/", env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"] });
  return await new Promise((resolve, reject) => {
    let failure: PublicWebError | undefined, settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); if (cleanupTimer) clearTimeout(cleanupTimer); signal.removeEventListener("abort", abort); };
    const stop = (error: PublicWebError) => {
      if (failure || settled) return;
      failure = error; child.stdin?.destroy(); child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 100);
      cleanupTimer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        // Do not claim death/reaping. Keep stream drains/error listeners and block
        // this native session via WEB_CLEANUP even if a later close is observed.
        child.kill("SIGKILL"); reject(new PublicWebError("WEB_CLEANUP"));
      }, WEB_LIMITS.cleanupMs);
    };
    const abort = () => stop(new PublicWebError("WEB_CANCELLED"));
    const deadline = setTimeout(() => stop(new PublicWebError("WEB_TIMEOUT")), WEB_LIMITS.requestMs);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => stop(new PublicWebError("WEB_POLICY")));
    child.stdin?.on("error", () => stop(new PublicWebError("WEB_NETWORK")));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > options.outputBytes) stop(new PublicWebError("WEB_LIMIT")); else chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length; // Never return raw curl/Python diagnostics.
      if (stderrBytes > 16 * 1024) stop(new PublicWebError("WEB_LIMIT"));
    });
    child.once("close", (code, termination) => {
      if (settled) return;
      settled = true; cleanup();
      if (failure) reject(failure);
      else if (termination || code === null) reject(new PublicWebError("WEB_NETWORK"));
      else resolve({ stdout: Buffer.concat(chunks, bytes), status: code });
    });
    if (signal.aborted) abort();
    // end(buffer) uses the owned writable's backpressure queue. The input is
    // already bounded, so no unbounded producer or independent pipe can survive.
    child.stdin?.end(options.input);
  });
}
