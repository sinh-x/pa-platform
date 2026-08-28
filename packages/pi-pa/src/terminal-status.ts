import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PI_TERMINAL_STATUS_FILE = "pi-terminal-status.json";

export interface PiTerminalStatus {
  type: "agent_end";
  stopReason: string;
  error?: string;
  timestamp: string;
}

export function piTerminalStatusPath(deployDir: string): string {
  return resolve(deployDir, PI_TERMINAL_STATUS_FILE);
}

export function clearPiTerminalStatus(deployDir: string): void {
  const path = piTerminalStatusPath(deployDir);
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writePiTerminalStatus(deployDir: string, status: PiTerminalStatus): void {
  mkdirSync(deployDir, { recursive: true });
  const path = piTerminalStatusPath(deployDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function ensurePiTerminalStatus(deployDir: string, status: PiTerminalStatus): boolean {
  mkdirSync(deployDir, { recursive: true });
  const path = piTerminalStatusPath(deployDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

export function readPiTerminalStatus(deployDir: string): PiTerminalStatus | undefined {
  const path = piTerminalStatusPath(deployDir);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PiTerminalStatus>;
  if (value.type !== "agent_end" || typeof value.stopReason !== "string" || typeof value.timestamp !== "string") {
    throw new Error("Pi terminal status side channel is malformed");
  }
  return { type: "agent_end", stopReason: value.stopReason, timestamp: value.timestamp, ...(typeof value.error === "string" ? { error: value.error } : {}) };
}
