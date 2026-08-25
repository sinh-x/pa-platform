import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { meetsMinimum, PI_VERSION_TIMEOUT_MS } from "./adapter.js";

export interface PiSetupOptions { local?: boolean; cwd?: string; configDir?: string; extensionPath?: string; piVersion?: string; confirm?: (message: string) => Promise<boolean> }
export interface PiSetupResult { settingsPath: string; packages: string[]; changed: boolean }
export interface PiStatusResult { settingsPath: string; extensionPath: string; configDir: string; packages: string[]; configured: boolean }
export interface PiRemoveResult { settingsPath: string; packages: string[]; removed: string[]; changed: boolean }

export async function setupPi(options: PiSetupOptions = {}): Promise<PiSetupResult> {
  const paths = resolvePiPaths(options);
  const { cwd, extensionPath, configDir } = paths;
  if (!existsSync(extensionPath)) throw new Error(`Pi PA extension package path is missing: ${extensionPath}`);
  if (!existsSync(configDir)) throw new Error(`PA config package path is missing: ${configDir}`);
  const probe = options.piVersion ? undefined : spawnSync("pi", ["--version"], { encoding: "utf8", timeout: PI_VERSION_TIMEOUT_MS });
  if (probe?.error) {
    if ((probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error(`Pi version probe timed out after ${PI_VERSION_TIMEOUT_MS}ms.`);
    throw new Error(`Pi is unavailable. Install Pi 0.80.8 or later and ensure 'pi' is on PATH.`);
  }
  const version = options.piVersion ?? `${probe?.stdout ?? ""}`.trim();
  if (!meetsMinimum(version)) throw new Error(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`);
  const settingsPath = settingsPathFor(options.local, cwd);
  const existing = readSettings(settingsPath);
  const packages = [...new Set([...(existing.packages ?? []), extensionPath, configDir])];
  const changed = JSON.stringify(existing.packages ?? []) !== JSON.stringify(packages);
  const confirm = options.confirm ?? defaultConfirm;
  if (changed && !(await confirm(`Register pi-pa and PA config packages in ${settingsPath}?`))) return { settingsPath, packages: existing.packages ?? [], changed: false };
  if (changed) { mkdirSync(dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, `${JSON.stringify({ ...existing, packages }, null, 2)}\n`, { mode: 0o600 }); }
  return { settingsPath, packages, changed };
}

export function statusPi(options: Pick<PiSetupOptions, "local" | "cwd" | "configDir" | "extensionPath"> = {}): PiStatusResult {
  const { cwd, extensionPath, configDir } = resolvePiPaths(options);
  const settingsPath = settingsPathFor(options.local, cwd);
  const settings = readSettings(settingsPath);
  const packages = settings.packages ?? [];
  return { settingsPath, extensionPath, configDir, packages, configured: packages.includes(extensionPath) && packages.includes(configDir) };
}

export async function removePi(options: Pick<PiSetupOptions, "local" | "cwd" | "configDir" | "extensionPath" | "confirm"> = {}): Promise<PiRemoveResult> {
  const status = statusPi(options);
  const removable = new Set([status.extensionPath, status.configDir]);
  const packages = status.packages.filter((item) => !removable.has(item));
  const removed = status.packages.filter((item) => removable.has(item));
  if (removed.length === 0) return { settingsPath: status.settingsPath, packages: status.packages, removed, changed: false };
  const confirm = options.confirm ?? defaultConfirm;
  if (!(await confirm(`Remove pi-pa and PA config packages from ${status.settingsPath}?`))) return { settingsPath: status.settingsPath, packages: status.packages, removed: [], changed: false };
  const existing = readSettings(status.settingsPath);
  mkdirSync(dirname(status.settingsPath), { recursive: true });
  writeFileSync(status.settingsPath, `${JSON.stringify({ ...existing, packages }, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath: status.settingsPath, packages, removed, changed: true };
}

function readSettings(path: string): { packages?: string[]; [key: string]: unknown } { if (!existsSync(path)) return {}; const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown; [key: string]: unknown }; if (parsed.packages !== undefined && (!Array.isArray(parsed.packages) || parsed.packages.some((item) => typeof item !== "string"))) throw new Error(`Invalid Pi settings packages in ${path}.`); return parsed as { packages?: string[]; [key: string]: unknown }; }
function resolvePiPaths(options: Pick<PiSetupOptions, "cwd" | "configDir" | "extensionPath">): { cwd: string; extensionPath: string; configDir: string } {
  const cwd = options.cwd ?? process.cwd();
  const extensionPath = resolve(options.extensionPath ?? resolve(dirname(new URL(import.meta.url).pathname), ".."));
  const configDir = resolve(options.configDir ?? process.env["PA_PLATFORM_CONFIG_DIR"] ?? process.env["PA_PLATFORM_HOME"] ?? cwd);
  return { cwd, extensionPath, configDir };
}
function settingsPathFor(local: boolean | undefined, cwd: string): string { return local ? resolve(cwd, ".pi", "settings.json") : resolve(process.env["PI_CODING_AGENT_DIR"] ?? resolve(homedir(), ".pi", "agent"), "settings.json"); }
async function defaultConfirm(message: string): Promise<boolean> {
  process.stderr.write(`${message} [y/N] `);
  const input = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolveAnswer) => input.once("line", (line) => { input.close(); resolveAnswer(/^y(es)?$/i.test(line.trim())); }));
}
