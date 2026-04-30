import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getBulletinsDir, getRegistryDbPath, getSinhInputsDir, getTicketsDir } from "../../paths.js";
import { readRegistry } from "../../registry/index.js";
import { validateSandboxPath } from "../utils/sandbox.js";
import type { WsEvent } from "./hub.js";

export interface WsBroadcaster {
  broadcast(event: WsEvent): void;
}

export interface FileWatchers {
  cleanup(): void;
}

export interface WatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  ensureDirs?: boolean;
}

interface DebouncedFn<T extends unknown[]> {
  (...args: T): void;
  cancel(): void;
}

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): DebouncedFn<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: T) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
    timer.unref?.();
  };
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

function extractTitle(filepath: string): string {
  try {
    const firstLine = readFileSync(filepath, "utf8").split("\n")[0]?.trim() ?? "";
    if (firstLine.startsWith("# ")) return firstLine.slice(2);
  } catch {
    // File may have moved before the debounce fired.
  }
  return basename(filepath, ".md");
}

function safeWatchPath(path: string, ensureDir: boolean): string | null {
  const resolved = validateSandboxPath(resolve(path));
  if (ensureDir) mkdirSync(resolved, { recursive: true });
  return existsSync(resolved) ? resolved : null;
}

function addWatcher(fsWatchers: FSWatcher[], path: string | null, listener: (event: string, filename: string | Buffer | null) => void): void {
  if (!path) return;
  try {
    const watcher = watch(path, listener);
    watcher.on("error", () => { /* ignore watcher backend errors */ });
    fsWatchers.push(watcher);
  } catch {
    // Watch support varies by filesystem; API polling remains the fallback.
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function startWatchers(broadcaster: WsBroadcaster, opts: WatcherOptions = {}): FileWatchers {
  const debounceMs = opts.debounceMs ?? 100;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const fsWatchers: FSWatcher[] = [];
  const debounced: Array<{ cancel(): void }> = [];
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const ensureDirs = opts.ensureDirs ?? false;

  const inboxDir = safeWatchPath(join(getSinhInputsDir(), "inbox"), ensureDirs);
  let knownInboxFiles = new Set<string>(inboxDir ? readdirSync(inboxDir).filter((file) => file.endsWith(".md")) : []);
  const scanInbox = debounce(() => {
    if (!inboxDir) return;
    const current = new Set(existsSync(inboxDir) ? readdirSync(inboxDir).filter((file) => file.endsWith(".md")) : []);
    for (const file of current) {
      if (!knownInboxFiles.has(file)) broadcaster.broadcast({ type: "new-inbox-item", data: { filename: file, title: extractTitle(join(inboxDir, file)) }, timestamp: timestamp() });
    }
    for (const file of knownInboxFiles) {
      if (!current.has(file)) broadcaster.broadcast({ type: "inbox-item-moved", data: { filename: file, from: "inbox", to: "unknown" }, timestamp: timestamp() });
    }
    knownInboxFiles = current;
  }, debounceMs);
  debounced.push(scanInbox);
  addWatcher(fsWatchers, inboxDir, () => scanInbox());
  addPoller(intervals, scanInbox, pollIntervalMs);

  let lastRegistryCount = readRegistry().length;
  const scanRegistry = debounce(() => {
    const events = readRegistry();
    if (events.length <= lastRegistryCount) return;
    lastRegistryCount = events.length;
    const entry = events.at(-1);
    if (entry) broadcaster.broadcast({ type: "deployment-status-change", data: { ...entry }, timestamp: timestamp() });
  }, debounceMs);
  debounced.push(scanRegistry);
  const registryPath = resolve(getRegistryDbPath());
  const registryDir = safeWatchPath(dirname(registryPath), ensureDirs);
  addWatcher(fsWatchers, registryDir, (_event, filename) => {
    const name = filename?.toString() ?? "";
    if (name === basename(registryPath) || name === `${basename(registryPath)}-wal` || name === `${basename(registryPath)}-shm`) scanRegistry();
  });
  addPoller(intervals, scanRegistry, pollIntervalMs);

  const ticketsDir = safeWatchPath(getTicketsDir(), ensureDirs);
  let knownTickets = snapshotJsonFiles(ticketsDir, (filename) => filename !== "counter.json" && filename !== "audit.jsonl");
  const scanTickets = debounce(() => {
    const current = snapshotJsonFiles(ticketsDir, (filename) => filename !== "counter.json" && filename !== "audit.jsonl");
    for (const [filename, mtimeMs] of current) {
      if (knownTickets.get(filename) !== mtimeMs) broadcaster.broadcast({ type: "ticket-changed", data: { ticketId: basename(filename, ".json") }, timestamp: timestamp() });
    }
    knownTickets = current;
  }, debounceMs);
  debounced.push(scanTickets);
  addWatcher(fsWatchers, ticketsDir, () => scanTickets());
  addPoller(intervals, scanTickets, pollIntervalMs);

  const bulletinsActiveDir = safeWatchPath(join(getBulletinsDir(), "active"), ensureDirs);
  let knownBulletins = snapshotMarkdownFiles(bulletinsActiveDir);
  const scanBulletins = debounce(() => {
    const current = snapshotMarkdownFiles(bulletinsActiveDir);
    for (const [filename, mtimeMs] of current) {
      if (knownBulletins.get(filename) !== mtimeMs) broadcaster.broadcast({ type: "bulletin-update", data: { bulletinId: basename(filename, ".md") }, timestamp: timestamp() });
    }
    for (const filename of knownBulletins.keys()) {
      if (!current.has(filename)) broadcaster.broadcast({ type: "bulletin-update", data: { bulletinId: basename(filename, ".md") }, timestamp: timestamp() });
    }
    knownBulletins = current;
  }, debounceMs);
  debounced.push(scanBulletins);
  addWatcher(fsWatchers, bulletinsActiveDir, () => scanBulletins());
  addPoller(intervals, scanBulletins, pollIntervalMs);

  return {
    cleanup: () => {
      for (const item of debounced) item.cancel();
      for (const interval of intervals) clearInterval(interval);
      for (const watcher of fsWatchers) {
        try { watcher.close(); } catch { /* ignore */ }
      }
    },
  };
}

function addPoller(intervals: Array<ReturnType<typeof setInterval>>, scan: () => void, intervalMs: number): void {
  if (intervalMs <= 0) return;
  const interval = setInterval(scan, intervalMs);
  interval.unref?.();
  intervals.push(interval);
}

function snapshotJsonFiles(dir: string | null, include: (filename: string) => boolean): Map<string, number> {
  return snapshotFiles(dir, (filename) => filename.endsWith(".json") && include(filename));
}

function snapshotMarkdownFiles(dir: string | null): Map<string, number> {
  return snapshotFiles(dir, (filename) => filename.endsWith(".md"));
}

function snapshotFiles(dir: string | null, include: (filename: string) => boolean): Map<string, number> {
  const files = new Map<string, number>();
  if (!dir || !existsSync(dir)) return files;
  for (const filename of readdirSync(dir).filter(include)) {
    try {
      files.set(filename, statSync(join(dir, filename)).mtimeMs);
    } catch {
      // File may have been moved between readdir and stat.
    }
  }
  return files;
}
