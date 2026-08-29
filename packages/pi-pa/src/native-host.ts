import { constants, accessSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { environmentSecrets, redactDiagnostic } from "./diagnostics.js";

export const PI_REGISTRY_ADDON_ENV = "PA_PI_SQLITE_NATIVE_BINDING";
export const REGISTRY_NATIVE_BINDING_ENV = "PA_SQLITE_NATIVE_BINDING";
export const REQUIRE_PI_REGISTRY_ADDON_ENV = "PA_REQUIRE_PI_SQLITE_NATIVE_BINDING";
const HOST_PROBE_TIMEOUT_MS = 10_000;
const HOST_DIAGNOSTIC_MAX = 2_000;
const WRAPPER_MAX_BYTES = 64 * 1024;

export interface PiNativeHostEvidence {
  nodePath: string;
  node: string;
  modules: string;
  v8: string;
  addonPath: string;
}

export interface PiManagedToolSmokeEvidence {
  nodePath: string;
  node: string;
  modules: string;
  tools: Array<{ name: string; status: "passed" }>;
}

export function piRegistryEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const addonPath = env[PI_REGISTRY_ADDON_ENV]?.trim();
  return addonPath ? { ...env, [REGISTRY_NATIVE_BINDING_ENV]: addonPath } : env;
}

export function configurePiRegistryBinding(env: NodeJS.ProcessEnv = process.env): void {
  const addonPath = env[PI_REGISTRY_ADDON_ENV]?.trim();
  if (addonPath) env[REGISTRY_NATIVE_BINDING_ENV] = addonPath;
}

export function probePiNativeRegistryAddon(
  env: NodeJS.ProcessEnv = process.env,
  secretValues: string[] = [],
): PiNativeHostEvidence | undefined {
  const addonPath = env[PI_REGISTRY_ADDON_ENV]?.trim();
  const required = env[REQUIRE_PI_REGISTRY_ADDON_ENV] === "1";
  if (!addonPath) {
    if (!required) return undefined;
    throw nativeLoadError("Pi registry addon path is not configured", env, secretValues);
  }
  if (!existsSync(addonPath)) throw nativeLoadError(`Pi registry addon is missing: ${addonPath}`, env, secretValues);

  const nodePath = resolveHostOrThrow(env, secretValues);
  const result = runPiHost(nodePath, ["native", addonPath], env);
  if (result.status !== 0) {
    throw nativeLoadError(result.stderr || result.error?.message || result.stdout || "Pi host rejected the registry addon", env, secretValues);
  }
  const evidence = parseJsonLine<Omit<PiNativeHostEvidence, "nodePath">>(result.stdout, "native-load: Pi host returned malformed addon evidence");
  return { nodePath, ...evidence };
}

export function runPiManagedToolSmoke(env: NodeJS.ProcessEnv = process.env): PiManagedToolSmokeEvidence {
  const addonPath = env[PI_REGISTRY_ADDON_ENV]?.trim();
  if (!addonPath) throw nativeLoadError("Pi registry addon path is not configured", env, []);
  if (!existsSync(addonPath)) throw nativeLoadError(`Pi registry addon is missing: ${addonPath}`, env, []);
  const nodePath = resolveHostOrThrow(env, []);
  const result = runPiHost(nodePath, ["tools", addonPath], env);
  if (result.status !== 0) throw nativeLoadError(result.stderr || result.error?.message || result.stdout || "managed tool smoke failed", env, []);
  const evidence = parseJsonLine<Omit<PiManagedToolSmokeEvidence, "nodePath">>(result.stdout, "native-load: Pi host returned malformed tool smoke evidence");
  return { nodePath, ...evidence };
}

export function resolvePiNodeHost(env: NodeJS.ProcessEnv = process.env): string {
  let current = realpathSync(resolveExternalCommand("pi", env));
  for (let depth = 0; depth < 6; depth += 1) {
    const body = readBoundedWrapper(current);
    const targets = [...body.matchAll(/"([^"\n]+\/bin\/(?:node|\.pi-wrapped))"/g)].map((match) => match[1]!);
    const target = targets.at(-1);
    if (!target) break;
    if (target.endsWith("/bin/node")) return realpathSync(target);
    current = realpathSync(target);
  }
  throw new Error(`native-load: Could not resolve the Pi Node host from ${current}`);
}

function resolveHostOrThrow(env: NodeJS.ProcessEnv, secretValues: string[]): string {
  try {
    return resolvePiNodeHost(env);
  } catch (error) {
    throw nativeLoadError(error instanceof Error ? error.message : String(error), env, secretValues);
  }
}

function runPiHost(nodePath: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const scriptPath = fileURLToPath(new URL("pi-host-smoke.js", import.meta.url));
  return spawnSync(nodePath, [scriptPath, ...args], {
    encoding: "utf8",
    env: piRegistryEnvironment(env),
    timeout: HOST_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

function resolveExternalCommand(command: string, env: NodeJS.ProcessEnv): string {
  const candidates = (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, command)).filter(isExecutable);
  return candidates.find((candidate) => !candidate.includes("/node_modules/")) ?? candidates[0] ?? command;
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function readBoundedWrapper(path: string): string {
  const body = readFileSync(path);
  if (body.byteLength > WRAPPER_MAX_BYTES) throw new Error(`native-load: Pi host wrapper exceeds ${WRAPPER_MAX_BYTES} bytes`);
  return body.toString("utf8");
}

function nativeLoadError(message: string, env: NodeJS.ProcessEnv, secretValues: string[]): Error {
  const safe = redactDiagnostic(message, environmentSecrets(env, secretValues));
  const diagnostic = `native-load: ${safe.replace(/^native-load:\s*/, "")}`;
  return new Error(diagnostic.length > HOST_DIAGNOSTIC_MAX ? `${diagnostic.slice(0, HOST_DIAGNOSTIC_MAX - 3)}...` : diagnostic);
}

function parseJsonLine<T>(output: string, failure: string): T {
  try {
    const line = output.trim().split("\n").at(-1);
    if (!line) throw new Error("empty output");
    return JSON.parse(line) as T;
  } catch {
    throw new Error(failure);
  }
}
