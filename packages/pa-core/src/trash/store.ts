import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getTrashDir } from "../paths.js";
import type { TrashEntry, TrashFileType, TrashStatus } from "./types.js";

// Ported from PA trash/store.ts at frozen PA source on 2026-04-26; locking is delegated to adapter/CLI call sites for now.

export class TrashStore {
  private readonly filesDir: string;
  private readonly counterPath: string;
  private readonly manifestPath: string;

  constructor(baseDir = getTrashDir()) {
    this.filesDir = resolve(baseDir, "files");
    this.counterPath = resolve(baseDir, "counter.json");
    this.manifestPath = resolve(baseDir, "manifest.jsonl");
    mkdirSync(this.filesDir, { recursive: true });
  }

  move(opts: { path: string; reason: string; actor: string; fileType?: TrashFileType }): TrashEntry {
    const originalPath = resolve(opts.path);
    if (!existsSync(originalPath)) throw new Error(`File not found: ${originalPath}`);
    const id = this.allocateId();
    const trashedAt = new Date().toISOString();
    const subDir = `${trashedAt.slice(0, 10)}-${id.split("-")[1]}`;
    const fileName = basename(originalPath);
    const trashPath = `${subDir}/${fileName}`;
    const targetDir = resolve(this.filesDir, subDir);
    const targetPath = resolve(targetDir, fileName);
    mkdirSync(targetDir, { recursive: true });
    movePath(originalPath, targetPath);
    const entry: TrashEntry = { id, trashedAt, actor: opts.actor, reason: opts.reason, originalPath, fileType: opts.fileType ?? "other", trashPath, status: "trashed" };
    this.writeManifest([...this.readManifest(), entry]);
    return entry;
  }

  list(filters: { status?: TrashStatus; fileType?: TrashFileType; search?: string } = {}): TrashEntry[] {
    return this.readManifest().filter((entry) => {
      if (filters.status && entry.status !== filters.status) return false;
      if (filters.fileType && entry.fileType !== filters.fileType) return false;
      if (filters.search) {
        const query = filters.search.toLowerCase();
        return `${entry.id} ${entry.originalPath} ${entry.reason} ${entry.actor}`.toLowerCase().includes(query);
      }
      return true;
    });
  }

  get(id: string): TrashEntry | undefined {
    return this.readManifest().find((entry) => entry.id === id);
  }

  restore(id: string, opts: { force?: boolean; actor?: string } = {}): TrashEntry {
    const entries = this.readManifest();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`Trash entry not found: ${id}`);
    const entry = entries[index];
    if (entry.status !== "trashed") throw new Error(`Cannot restore: ${id} has status "${entry.status}"`);
    const trashFilePath = resolve(this.filesDir, entry.trashPath);
    if (!existsSync(trashFilePath)) throw new Error(`Trashed file missing from disk: ${entry.trashPath}`);
    if (existsSync(entry.originalPath) && !opts.force) throw new Error(`Original path already exists: ${entry.originalPath}. Use force to overwrite.`);
    mkdirSync(dirname(entry.originalPath), { recursive: true });
    movePath(trashFilePath, entry.originalPath, opts.force);
    entries[index] = { ...entry, status: "restored", restoredAt: new Date().toISOString() };
    this.writeManifest(entries);
    return entries[index];
  }

  purge(opts: { days?: number; dryRun?: boolean; actor?: string } = {}): TrashEntry[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (opts.days ?? 30));
    const entries = this.readManifest();
    const toPurge = entries.filter((entry) => entry.status === "trashed" && new Date(entry.trashedAt) <= cutoff);
    if (opts.dryRun || toPurge.length === 0) return toPurge;
    const purgedAt = new Date().toISOString();
    for (const entry of toPurge) {
      const trashFilePath = resolve(this.filesDir, entry.trashPath);
      if (existsSync(trashFilePath)) rmSync(trashFilePath, { recursive: true, force: true });
      const index = entries.findIndex((candidate) => candidate.id === entry.id);
      if (index !== -1) entries[index] = { ...entries[index], status: "purged", purgedAt };
    }
    this.writeManifest(entries);
    return toPurge;
  }

  private allocateId(): string {
    const counter = existsSync(this.counterPath) ? (JSON.parse(readFileSync(this.counterPath, "utf-8")) as { next?: number }) : {};
    const next = counter.next ?? 1;
    writeFileSync(this.counterPath, JSON.stringify({ next: next + 1 }, null, 2));
    return `T-${String(next).padStart(3, "0")}`;
  }

  private readManifest(): TrashEntry[] {
    if (!existsSync(this.manifestPath)) return [];
    return readFileSync(this.manifestPath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TrashEntry);
  }

  private writeManifest(entries: TrashEntry[]): void {
    writeFileSync(this.manifestPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : ""));
  }
}

function movePath(source: string, target: string, overwrite = false): void {
  if (overwrite && existsSync(target)) rmSync(target, { recursive: true, force: true });
  const isDir = statSync(source).isDirectory();
  try {
    renameSync(source, target);
  } catch {
    if (isDir) {
      cpSync(source, target, { recursive: true });
      rmSync(source, { recursive: true, force: true });
    } else {
      copyFileSync(source, target);
      unlinkSync(source);
    }
  }
}
