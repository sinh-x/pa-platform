import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AutoCoordinator, AutoWaitlistStore, AutoWaitlistError, RegistryAutoJournal, RegistryAutoNotifications,
  autoNotificationText, autoWaitlistDiagnostic, getDb, openReadonlyRegistryDatabase, RegistryReadError,
  type AutoNotice, type AutoWaitlistView,
} from "@pa-platform/pa-core";
import { selectedPiAutoPair } from "./auto-contract.js";
import { runPiAutoScanWorker } from "./auto-scan-client.js";
import { autoDraftOwner } from "./auto-draft.js";
import { piAutoImplementationOwner } from "./auto-runtime.js";
import type { AutoTerminal } from "./auto-terminal.js";

export function renderAutoUserUnits(executable = process.execPath, cli = fileURLToPath(new URL("./cli.js", import.meta.url))): { service: string; timer: string } {
  const quote = (s: string) => {
    if (!s.startsWith("/") || /[\u0000-\u001f\u007f]/.test(s)) throw new AutoWaitlistError("AUTO_INPUT");
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`;
  };
  return {
    service: `[Unit]\nDescription=PPA read-only auto waitlist refresh\n\n[Service]\nType=oneshot\nExecStart=${quote(executable)} ${quote(cli)} auto tick --json\nTimeoutStartSec=150\nUMask=0077\nNoNewPrivileges=yes\n`,
    timer: "[Unit]\nDescription=PPA auto waitlist every 30 minutes (opt-in)\n\n[Timer]\nOnStartupSec=1min\nOnUnitInactiveSec=30min\nAccuracySec=1min\nPersistent=false\nUnit=ppa-auto.service\n\n[Install]\nWantedBy=timers.target\n",
  };
}
export type AutoNoticeSender = (notice: AutoNotice) => { delivery: "requested" | "unavailable"; reason: AutoNotice["reason"] };
/** Freedesktop informational request only. No shell, actions, secrets/objectives,
 * remote approval, fabricated session or claim that an operator saw delivery. */
export const sendAutoDesktopNotice: AutoNoticeSender = notice => {
  const runtime = `/run/user/${process.getuid?.()}`;
  if (process.env.XDG_RUNTIME_DIR !== runtime || !process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith(`unix:path=${runtime}/bus`)) return { delivery: "unavailable", reason: "desktop-unavailable" };
  const r = spawnSync("notify-send", ["--app-name=PPA auto", "--expire-time=10000", "--", "PPA auto", autoNotificationText(notice)], { timeout: 3000, maxBuffer: 4096, stdio: ["ignore", "ignore", "pipe"] });
  if (r.error || r.status !== 0) return { delivery: "unavailable", reason: r.error && "code" in r.error && r.error.code === "ENOENT" ? "notifier-unavailable" : "request-failed" };
  return { delivery: "requested", reason: "none" };
};
export function publishAutoNotice(journal: RegistryAutoJournal, view: AutoWaitlistView, send: AutoNoticeSender = sendAutoDesktopNotice): AutoNotice | null {
  const c = journal.control(); if (c.paused || !c.scansEnabled) return null;
  const notifications = new RegistryAutoNotifications(journal.db), notice = notifications.claim(view.state?.snapshot ?? null, journal.active(), view.freshness === "fresh");
  if (!notice) return null;
  let result: ReturnType<AutoNoticeSender>;
  try { result = send(notice); } catch { result = { delivery: "unavailable", reason: "request-failed" }; }
  return notifications.result(notice, result.delivery, result.reason);
}
export interface AutoTickResult { schemaVersion: "pa-auto-background/v1"; outcome: "disabled" | "coalesced" | "refreshed" | "stale"; notification: AutoNotice | null; executionRequested: false }
/** Timer wakes never choose work, grant approval, publish/queue or start agents.
 * They coalesce intervals, scan read-only sources and reconcile factual results.
 * No installation, user-service call or activation is performed by this module. */
export async function runAutoTick(send: AutoNoticeSender = sendAutoDesktopNotice): Promise<AutoTickResult> {
  let enabled = false;
  try {
    const db = openReadonlyRegistryDatabase(true);
    try { const c = new RegistryAutoJournal(db).control(); enabled = c.scansEnabled && !c.paused; } finally { db.close(); }
  } catch (error) {
    if (!(error instanceof RegistryReadError) || error.reason !== "registry-missing") throw new AutoWaitlistError("AUTO_SOURCE");
    return { schemaVersion: "pa-auto-background/v1", outcome: "disabled", notification: null, executionRequested: false };
  }
  if (!enabled) return { schemaVersion: "pa-auto-background/v1", outcome: "disabled", notification: null, executionRequested: false };
  selectedPiAutoPair().assertCurrent();
  const journal = new RegistryAutoJournal(getDb()), notifications = new RegistryAutoNotifications(journal.db);
  if (!notifications.takeWake(Date.now(), () => { const c = journal.control(); return c.scansEnabled && !c.paused; })) return { schemaVersion: "pa-auto-background/v1", outcome: "coalesced", notification: null, executionRequested: false };
  const view = new AutoWaitlistStore().scan(runPiAutoScanWorker), item = journal.active();
  if (item) {
    const observer: AutoTerminal = { authenticate() {
      const current = journal.active(); if (!current || current.itemId !== item.itemId) throw new AutoWaitlistError("AUTO_BUSY");
    }, display() {}, choose: async () => { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); } };
    const coordinator = new AutoCoordinator(journal, () => observer.authenticate());
    if (item.dispatch) {
      const owner = piAutoImplementationOwner(journal, observer);
      coordinator.apply(item, "dispatch", await owner.observe(item, item.dispatch));
    } else if (item.draft) {
      const owner = autoDraftOwner(journal, () => observer.authenticate());
      coordinator.apply(item, "draft", await owner.observe(item, item.draft));
    }
  }
  return { schemaVersion: "pa-auto-background/v1", outcome: view.freshness === "fresh" ? "refreshed" : "stale", notification: publishAutoNotice(journal, view, send), executionRequested: false };
}
export async function runAutoBackgroundCommand(args: string[], io: { stdout(s: string): void; stderr(s: string): void }): Promise<number> {
  const json = args.includes("--json");
  try {
    if (args.length > 2 || args.length === 2 && args[1] !== "--json" || !["tick", "units"].includes(args[0] ?? "")) throw new AutoWaitlistError("AUTO_INPUT");
    if (args[0] === "units") {
      const units = renderAutoUserUnits();
      io.stdout(json ? JSON.stringify({ schemaVersion: "pa-auto-background/v1", units, installed: false, enabled: false }) : `User units rendered only; nothing installed or enabled. Manual activation remains separate.\n--- ppa-auto.service ---\n${units.service}\n--- ppa-auto.timer ---\n${units.timer}`); return 0;
    }
    const result = await runAutoTick();
    io.stdout(json ? JSON.stringify(result) : `Auto timer: ${result.outcome}. No selection, approval or execution was requested.${result.notification ? ` Desktop request: ${result.notification.delivery}; actual viewing is unproven. Run ppa auto.` : ""}`);
    return result.outcome === "stale" ? 1 : 0;
  } catch {
    if (json) io.stdout(JSON.stringify({ schemaVersion: "pa-auto-background/v1", ok: false, code: "AUTO_UNAVAILABLE", executionRequested: false }));
    else io.stderr(autoWaitlistDiagnostic("AUTO_UNAVAILABLE")); return 1;
  }
}
