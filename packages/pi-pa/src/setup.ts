import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { meetsMinimum } from "./adapter.js";

export interface PiSetupOptions { local?: boolean; cwd?: string; configDir?: string; extensionPath?: string; piVersion?: string; confirm?: (message: string) => Promise<boolean> }
export interface PiSetupResult { settingsPath: string; packages: string[]; changed: boolean }

export async function setupPi(options: PiSetupOptions = {}): Promise<PiSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const extensionPath = resolve(options.extensionPath ?? resolve(dirname(new URL(import.meta.url).pathname), ".."));
  const configDir = resolve(options.configDir ?? process.env["PA_PLATFORM_CONFIG_DIR"] ?? process.env["PA_PLATFORM_HOME"] ?? cwd);
  if (!existsSync(extensionPath)) throw new Error(`Pi PA extension package path is missing: ${extensionPath}`);
  if (!existsSync(configDir)) throw new Error(`PA config package path is missing: ${configDir}`);
  const probe = options.piVersion ? undefined : spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 2000 });
  if (probe?.error) throw new Error(`Pi is unavailable. Install Pi 0.80.8 or later and ensure 'pi' is on PATH.`);
  const version = options.piVersion ?? `${probe?.stdout ?? ""}`.trim();
  if (!meetsMinimum(version)) throw new Error(`Pi version must be 0.80.8 or later; detected '${version || "unknown"}'.`);
  const settingsPath = options.local ? resolve(cwd, ".pi", "settings.json") : resolve(process.env["PI_CODING_AGENT_DIR"] ?? resolve(homedir(), ".pi", "agent"), "settings.json");
  const existing = readSettings(settingsPath);
  const packages = [...new Set([...(existing.packages ?? []), extensionPath, configDir])];
  const changed = JSON.stringify(existing.packages ?? []) !== JSON.stringify(packages);
  const confirm = options.confirm ?? defaultConfirm;
  if (changed && !(await confirm(`Register pi-pa and PA config packages in ${settingsPath}?`))) return { settingsPath, packages: existing.packages ?? [], changed: false };
  if (changed) { mkdirSync(dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, `${JSON.stringify({ ...existing, packages }, null, 2)}\n`, { mode: 0o600 }); }
  return { settingsPath, packages, changed };
}

function readSettings(path: string): { packages?: string[]; [key: string]: unknown } { if (!existsSync(path)) return {}; const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown; [key: string]: unknown }; if (parsed.packages !== undefined && (!Array.isArray(parsed.packages) || parsed.packages.some((item) => typeof item !== "string"))) throw new Error(`Invalid Pi settings packages in ${path}.`); return parsed as { packages?: string[]; [key: string]: unknown }; }
async function defaultConfirm(message: string): Promise<boolean> {
  process.stderr.write(`${message} [y/N] `);
  const input = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolveAnswer) => input.once("line", (line) => { input.close(); resolveAnswer(/^y(es)?$/i.test(line.trim())); }));
}
