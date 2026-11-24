import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { sessionDisplayText } from "./session-inventory.js";

export interface HerdrEndpoint { name: string; socketPath: string; identity: string }
export interface HerdrPane {
  workspaceId: string; workspaceLabel: string | null; tabId: string; tabLabel: string | null; paneId: string; terminalId: string;
}
export interface HerdrRoster { endpoints: HerdrEndpoint[]; complete: boolean; reasons: string[] }
export interface HerdrSource {
  roster: (deadline: number) => Promise<HerdrRoster>;
  snapshot: (endpoint: HerdrEndpoint, deadline: number) => Promise<HerdrPane[]>;
  foreground: (endpoint: HerdrEndpoint, paneId: string, deadline: number) => Promise<number[]>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("herdr-malformed");
  return value as Record<string, unknown>;
};
const array = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error("herdr-over-limit"); return value;
};
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/.test(value)) throw new Error("herdr-malformed"); return value;
};
function socketIdentity(path: string): string {
  if (!isAbsolute(path) || path.length > 4096 || /[\x00-\x1f]/.test(path)) throw new Error("herdr-unavailable");
  const info = lstatSync(path);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("herdr-unavailable");
  return `${info.dev}:${info.ino}:${info.ctimeMs}`;
}
/** Finite existing-socket request. Connecting cannot create/attach/start a HerdR session. */
export function readHerdrSocket(endpoint: HerdrEndpoint, method: "session.snapshot" | "pane.process_info", params: Record<string, string>, deadline: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined, settled = false, body = Buffer.alloc(0);
    const finish = (value?: unknown, failed = false) => {
      if (settled) return; settled = true; clearTimeout(timer); socket?.destroy();
      if (failed) reject(new Error("herdr-unavailable")); else resolve(value);
    };
    const timer = setTimeout(() => finish(undefined, true), Math.max(1, Math.min(350, deadline - Date.now())));
    try {
      if (Date.now() >= deadline || socketIdentity(endpoint.socketPath) !== endpoint.identity) { finish(undefined, true); return; }
      const requestId = `ppa-sessions:${randomUUID()}`;
      socket = connect(endpoint.socketPath);
      socket.once("connect", () => socket!.write(`${JSON.stringify({ id: requestId, method, params })}\n`));
      socket.on("error", () => finish(undefined, true)); socket.on("end", () => finish(undefined, true));
      socket.on("data", chunk => {
        if (settled) return;
        if (body.length + chunk.length > (method === "session.snapshot" ? 2 * 1024 * 1024 : 128 * 1024)) { finish(undefined, true); return; }
        body = Buffer.concat([body, chunk]); const end = body.indexOf(10); if (end < 0) return;
        try {
          const response = object(JSON.parse(body.subarray(0, end).toString("utf8")));
          if (response.id !== requestId || response.error || socketIdentity(endpoint.socketPath) !== endpoint.identity) throw new Error();
          finish(response.result);
        } catch { finish(undefined, true); }
      });
    } catch { finish(undefined, true); }
  });
}
export function parseHerdrSnapshot(value: unknown): HerdrPane[] {
  const snapshot = object(object(value).snapshot);
  if (snapshot.protocol !== 22) throw new Error("herdr-protocol-unsupported");
  const workspaces = new Map<string, string | null>(), tabs = new Map<string, { workspace: string; label: string | null }>();
  for (const raw of array(snapshot.workspaces, 256)) {
    const row = object(raw), key = id(row.workspace_id); if (workspaces.has(key)) throw new Error("herdr-malformed");
    workspaces.set(key, sessionDisplayText(row.label));
  }
  for (const raw of array(snapshot.tabs, 1024)) {
    const row = object(raw), key = id(row.tab_id), workspace = id(row.workspace_id);
    if (tabs.has(key) || !workspaces.has(workspace)) throw new Error("herdr-malformed");
    tabs.set(key, { workspace, label: sessionDisplayText(row.label) });
  }
  const seen = new Set<string>();
  return array(snapshot.panes, 1024).map(raw => {
    const row = object(raw), paneId = id(row.pane_id), workspaceId = id(row.workspace_id), tabId = id(row.tab_id), tab = tabs.get(tabId);
    if (seen.has(paneId) || !tab || tab.workspace !== workspaceId) throw new Error("herdr-malformed"); seen.add(paneId);
    return { workspaceId, workspaceLabel: workspaces.get(workspaceId)!, tabId, tabLabel: tab.label, paneId, terminalId: id(row.terminal_id) };
  });
}
export function parseHerdrForeground(value: unknown, paneId: string): number[] {
  const info = object(object(value).process_info);
  if (info.pane_id !== paneId || !Number.isSafeInteger(info.shell_pid) || Number(info.shell_pid) <= 0) throw new Error("herdr-malformed");
  return array(info.foreground_processes, 128).map(raw => {
    const pid = object(raw).pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new Error("herdr-malformed"); return Number(pid);
  }).filter(pid => pid !== info.shell_pid); // A foreground shell is not attribution for its background jobs.
}
export function herdrStoppedEntryUncertain(row: Record<string, unknown>): boolean {
  return row.running === false && row.connection_error !== undefined && row.connection_error !== null;
}
export function defaultHerdrSource(): HerdrSource {
  return {
    roster: deadline => new Promise(resolve => {
      if (Date.now() >= deadline) { resolve({ endpoints: [], complete: false, reasons: ["herdr-budget-exhausted"] }); return; }
      execFile("herdr", ["session", "list", "--json"], { timeout: Math.max(1, Math.min(1000, deadline - Date.now())), maxBuffer: 512 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) { resolve({ endpoints: [], complete: false, reasons: ["herdr-roster-unavailable"] }); return; }
        try {
          const endpoints: HerdrEndpoint[] = [], seen = new Set<string>(); let complete = true;
          for (const raw of array(object(JSON.parse(stdout)).sessions, 64)) {
            const row = object(raw);
            if (typeof row.running !== "boolean") throw new Error();
            if (!row.running) {
              if (herdrStoppedEntryUncertain(row)) complete = false;
              continue;
            }
            if (typeof row.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.name) || seen.has(row.name)) throw new Error();
            seen.add(row.name);
            try {
              if (typeof row.socket_path !== "string") throw new Error();
              endpoints.push({ name: row.name, socketPath: row.socket_path, identity: socketIdentity(row.socket_path) });
            } catch { complete = false; }
          }
          resolve({ endpoints, complete, reasons: complete ? [] : ["herdr-socket-unavailable"] });
        } catch { resolve({ endpoints: [], complete: false, reasons: ["herdr-roster-malformed-or-over-limit"] }); }
      });
    }),
    snapshot: async (endpoint, deadline) => parseHerdrSnapshot(await readHerdrSocket(endpoint, "session.snapshot", {}, deadline)),
    foreground: async (endpoint, paneId, deadline) => parseHerdrForeground(await readHerdrSocket(endpoint, "pane.process_info", { pane_id: paneId }, deadline), paneId),
  };
}
