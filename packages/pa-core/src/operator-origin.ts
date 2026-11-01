import { existsSync, readFileSync } from "node:fs";
import { getRegistryDbPath } from "./paths.js";
import { processIsWithinFingerprintLineage, readProcessFingerprint } from "./deploy/repository-admission.js";
import { queryReadonlyDeploymentStatuses } from "./registry/index.js";

/** Managed-agent boundary, not authentication of an arbitrary OS-user adversary.
 * No secret-bearing process environment is read and no command line is echoed.
 * Known managed origin rejects even if a child clears its PA environment.
 */
export function assertUnmanagedOperator(): void {
  const deny = (): never => { throw new Error("Operator-only repository administration is unavailable in a managed agent context"); };
  for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_ROGUE_ONE", "OPENCODE_SESSION_ID", "PI_SESSION_ID"]) if (process.env[key]) deny();
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 128; depth++) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`);
      if (argv.length > 65536) deny();
      const args = argv.toString("utf8").split("\0");
      if (args.slice(0, 3).some(arg => /(?:^|\/)(?:\.?pi(?:-wrapped)?|opencode)$|(?:pi-monorepo|@mariozechner\/pi-coding-agent|@earendil-works\/pi-coding-agent)\//.test(arg))) deny();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(fields[1]); if (!Number.isSafeInteger(parent) || parent < 0 || parent === pid) deny(); pid = parent;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
  if (pid > 1) deny();
  if (existsSync(getRegistryDbPath())) {
    for (const row of queryReadonlyDeploymentStatuses()) {
      if (!["running", "dead", "unknown"].includes(row.status) || !row.pid) continue;
      const fp = readProcessFingerprint(row.pid);
      if (fp && processIsWithinFingerprintLineage(process.pid, fp)) deny();
    }
  }
}
