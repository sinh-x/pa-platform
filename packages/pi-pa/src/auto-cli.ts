import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AutoWaitlistError, AutoWaitlistStore, autoWaitlistDiagnostic, autoWaitlistPage, formatAutoWaitlist, parseAutoWaitlistSnapshot,
  type AutoSection, type AutoWaitlistSnapshot, type AutoWaitlistView,
} from "@pa-platform/pa-core";

export const AUTO_USAGE = `Pi-only: ppa auto [scan|list|status] [--json] [--section candidates|excluded|all] [--page N]
  auto / scan  Refresh registered PAP/PAPC observations; save only coordination data outside repositories.
  list         Read the last complete snapshot without initialization or refresh (100 entries/page).
  status       Read snapshot freshness and service availability without initialization or refresh.
  --help       Show this help. No selection, approval, worker, timer or notification is enabled in P1.
Opening auto refreshes observations. Failed scans retain a visibly stale complete list.
A recommendation never starts work. Noninteractive input and flags cannot grant approval.`;
export interface AutoCliIo { stdout(text: string): void; stderr(text: string): void }
export interface AutoCliHost {
  read(): AutoWaitlistView;
  scan(produce: () => AutoWaitlistSnapshot): AutoWaitlistView;
  produce(): AutoWaitlistSnapshot;
}
function defaultHost(): AutoCliHost {
  const store = new AutoWaitlistStore();
  return { read: () => store.read(), scan: produce => store.scan(produce), produce: () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./auto-scan-worker.js", import.meta.url))], {
      timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) throw new AutoWaitlistError(result.error && "code" in result.error && result.error.code === "ETIMEDOUT" ? "AUTO_LIMIT" : "AUTO_SOURCE");
    return parseAutoWaitlistSnapshot(result.stdout);
  } };
}
export function runAutoCommand(args: string[], io: AutoCliIo, host?: AutoCliHost): number {
  const json = args.includes("--json");
  try {
    if (args.length === 1 && args[0] === "--help") { io.stdout(AUTO_USAGE); return 0; }
    if (args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 65_536) throw new AutoWaitlistError("AUTO_INPUT");
    let action = "open", page = 1, section: AutoSection = "candidates";
    const rest = [...args];
    if (rest[0] && !rest[0].startsWith("--")) {
      action = rest.shift()!;
      if (!["scan", "list", "status"].includes(action)) throw new AutoWaitlistError("AUTO_INPUT");
    }
    const seen = new Set<string>();
    while (rest.length) {
      const flag = rest.shift()!;
      if (seen.has(flag) || !["--json", "--section", "--page"].includes(flag)) throw new AutoWaitlistError("AUTO_INPUT");
      seen.add(flag);
      if (flag === "--json") continue;
      const value = rest.shift();
      if (flag === "--section") {
        if (!value || !["candidates", "excluded", "all"].includes(value)) throw new AutoWaitlistError("AUTO_INPUT");
        section = value as AutoSection;
      } else {
        if (!value || !/^[1-9]\d{0,5}$/.test(value)) throw new AutoWaitlistError("AUTO_INPUT");
        page = Number(value);
      }
    }
    if (action === "status" && (seen.has("--page") || seen.has("--section"))) throw new AutoWaitlistError("AUTO_INPUT");
    const owner = host ?? defaultHost();
    const view = action === "open" || action === "scan" ? owner.scan(owner.produce) : owner.read();
    const failed = (action === "open" || action === "scan") && (view.scan !== "idle" || view.state?.lastAttempt.outcome !== "completed");
    const code = failed ? view.scan !== "idle" ? "AUTO_BUSY" : view.state?.lastAttempt.code ?? "AUTO_SOURCE" : undefined;
    if (json) io.stdout(JSON.stringify({ schemaVersion: "pa-auto-result/v1", ok: !failed, action,
      ...(code ? { code } : {}), freshness: view.freshness, scan: view.scan,
      observedAt: view.state?.snapshot?.observedAt ?? null, snapshotVersion: view.state?.snapshot?.version ?? null,
      lastAttempt: view.state?.lastAttempt ?? null,
      service: { availability: "inspection-only", selectionEnabled: false, executionAdmitted: false },
      ...(action === "status" ? {} : { recommendation: view.state?.snapshot?.recommendation ?? null,
        projects: view.state?.snapshot?.projects ?? [], ...autoWaitlistPage(view, page, section) }) }));
    else {
      if (action === "status") io.stdout(`PPA auto is inspection-only; no automated item, timer or worker is managed by this phase.\nSnapshot: ${view.freshness}. Observed: ${view.state?.snapshot?.observedAt ?? "no complete snapshot"}.\nScan: ${view.scan}. Last attempt: ${view.state?.lastAttempt.outcome ?? "not recorded"}.\nUse ppa auto list to inspect retained entries or ppa auto scan to refresh observations.`);
      else io.stdout(formatAutoWaitlist(view, page, section));
      if (code) io.stderr(autoWaitlistDiagnostic(code));
    }
    return failed ? 1 : 0;
  } catch (error) {
    // Only our finite typed code crosses this boundary. No exception prose,
    // untrusted getters, objectives, filesystem paths or SQLite errors are shown.
    let code: AutoWaitlistError["code"] = "AUTO_STORE";
    try {
      const descriptor = error instanceof AutoWaitlistError ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
      if (descriptor && "value" in descriptor && ["AUTO_SOURCE", "AUTO_LIMIT", "AUTO_STORE", "AUTO_INPUT", "AUTO_BUSY", "AUTO_UNAVAILABLE"].includes(descriptor.value)) code = descriptor.value;
    } catch { /* Hostile exception objects are not public causes. */ }
    if (json) io.stdout(JSON.stringify({ schemaVersion: "pa-auto-result/v1", ok: false, code, executionAdmitted: false }));
    else io.stderr(autoWaitlistDiagnostic(code));
    return 1;
  }
}
