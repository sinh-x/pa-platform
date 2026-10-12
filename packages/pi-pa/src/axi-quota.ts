import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export type QuotaProvider = "codex" | "claude";
export interface QuotaConsent { version: 1; deploymentId: string; providers: { id: QuotaProvider; profilePath: string }[] }
const rejected = (): never => { throw new Error("AXI_POLICY_REJECTED"); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return rejected();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) rejected();
}
export function parseQuotaConsent(value: unknown, deploymentId: string): QuotaConsent {
  const root = record(value);
  exactKeys(root, ["version", "deploymentId", "providers"]);
  if (!/^d-[a-z0-9]+$/.test(deploymentId) || root.version !== 1 || root.deploymentId !== deploymentId || !Array.isArray(root.providers) || root.providers.length > 2) return rejected();
  const seen = new Set<string>();
  const providers = root.providers.map((entry: unknown): QuotaConsent["providers"][number] => {
    const provider = record(entry);
    exactKeys(provider, ["id", "profilePath"]);
    if ((provider.id !== "codex" && provider.id !== "claude") || seen.has(provider.id) || typeof provider.profilePath !== "string" || !isAbsolute(provider.profilePath) || /[\0\r\n]/.test(provider.profilePath)) return rejected();
    seen.add(provider.id);
    return { id: provider.id, profilePath: provider.profilePath };
  });
  return { version: 1, deploymentId, providers };
}
/** The only pre-consent read is this bounded operator-owned file. Open with
 * O_NOFOLLOW and compare inode/device to defeat a symlink/replacement race. */
export function validConsentFile(stat: { isFile: () => boolean; uid: number; mode: number; size: number }, uid = process.getuid?.()): boolean {
  return stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.size <= 65536;
}
export function readQuotaConsent(path: string, deploymentId: string): QuotaConsent {
  if (!isAbsolute(path)) return rejected();
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (before.isSymbolicLink() || stat.ino !== before.ino || stat.dev !== before.dev || !validConsentFile(stat)) return rejected();
    return parseQuotaConsent(JSON.parse(readFileSync(fd, "utf8")) as unknown, deploymentId);
  } finally { closeSync(fd); }
}

export function quotaEnvironmentAllowed(env: NodeJS.ProcessEnv): boolean {
  return !Object.keys(env).some((key) => key.startsWith("QUOTA_AXI_") || /^(OPENAI|ANTHROPIC|CODEX|CLAUDE).*(BASE_URL|ENDPOINT|API_URL)$/.test(key));
}
export function quotaReadArguments(args: readonly string[]): boolean {
  return args.length === 0 || (args.length === 1 && ["quota", "--json"].includes(args[0]!)) || (args.length === 2 && args[0] === "quota" && args[1] === "--json");
}
/** Positive environment allowlist, not an ever-growing credential denylist.
 * No host HOME, PATH, proxy, NODE_OPTIONS, discovery, endpoint or API key leaks. */
export function quotaProviderEnvironment(provider: QuotaConsent["providers"][number], deploymentDir: string): NodeJS.ProcessEnv {
  const home = join(deploymentDir, "axi-quota-empty-home");
  return {
    HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
    PATH: "", LANG: "C.UTF-8", NO_COLOR: "1", TERM: "dumb",
    [provider.id === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: provider.profilePath,
  };
}
export type QuotaStatus = "fresh" | "stale" | "expired" | "not-configured" | "unknown" | "rate-limited" | "error";
export interface SafeQuota {
  provider: QuotaProvider;
  status: QuotaStatus;
  reason: "quota-read" | "stale-reading" | "credentials-expired" | "profile-not-configured" | "unavailable" | "rate-limited" | "provider-error" | "invalid-response";
  refreshedAt?: string;
  generatedAt?: string;
  windows: SafeQuotaWindow[];
}
export interface SafeQuotaWindow {
  kind: "session" | "weekly" | "monthly" | "model" | "credits" | "unknown";
  percentUsed?: number; percentRemaining?: number; spentUsd?: number; limitUsd?: number; windowSeconds?: number;
  startsAt?: string; resetsAt?: string;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
export function sanitizeQuotaResult(raw: string, provider: QuotaProvider): SafeQuota[] {
  const invalid: SafeQuota[] = [{ provider, status: "unknown", reason: "invalid-response", windows: [] }];
  try {
    const root = record(JSON.parse(raw) as unknown);
    if ((root.schemaVersion !== 5 && root.schemaVersion !== 6) || !Array.isArray(root.providers) || !root.providers.length || root.providers.length > 32) return invalid;
    return root.providers.map((entry: unknown): SafeQuota => {
      const row = record(entry);
      if (row.provider !== provider || !Array.isArray(row.windows) || row.windows.length > 64) return rejected();
      const state = record(row.state);
      let status: QuotaStatus = "unknown";
      let reason: SafeQuota["reason"] = "unavailable";
      if (row.notSetUp === true) { status = "not-configured"; reason = "profile-not-configured"; }
      else if (state.reason === "credentials_expired" || state.authStatus === "expired_refreshable") { status = "expired"; reason = "credentials-expired"; }
      else if (state.stale === true || state.status === "stale") { status = "stale"; reason = "stale-reading"; }
      else if (state.status === "rate_limited") { status = "rate-limited"; reason = "rate-limited"; }
      else if (state.status === "error") { status = "error"; reason = "provider-error"; }
      else if (state.status === "fresh" && state.stale === false && row.windows.length > 0) { status = "fresh"; reason = "quota-read"; }
      const windows = row.windows.map((entry: unknown): SafeQuotaWindow => {
        const window = record(entry);
        const kind = ["session", "weekly", "monthly", "model", "credits"].includes(String(window.kind)) ? window.kind as SafeQuotaWindow["kind"] : "unknown";
        const safe: SafeQuotaWindow = { kind };
        for (const key of ["percentUsed", "percentRemaining", "spentUsd", "limitUsd", "windowSeconds"] as const) {
          const value = window[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!key.startsWith("percent") || value <= 100)) safe[key] = value;
        }
        for (const key of ["startsAt", "resetsAt"] as const) { const value = timestamp(window[key]); if (value) safe[key] = value; }
        return safe;
      });
      // An empty/identity-only window is not evidence of fresh availability.
      if (status === "fresh" && !windows.some((window) => window.percentUsed !== undefined || window.percentRemaining !== undefined || window.spentUsd !== undefined)) { status = "unknown"; reason = "unavailable"; }
      return { provider, status, reason, windows, ...(timestamp(root.generatedAt) ? { generatedAt: timestamp(root.generatedAt) } : {}), ...(timestamp(state.refreshedAt) ? { refreshedAt: timestamp(state.refreshedAt) } : {}) };
    });
  } catch { return invalid; }
}
export interface QuotaEffects {
  consent: typeof readQuotaConsent;
  run: (node: string, args: string[], env: NodeJS.ProcessEnv) => { stdout: string; failed: boolean };
}
const production: QuotaEffects = {
  consent: readQuotaConsent,
  run: (node, args, env) => {
    const result = spawnSync(node, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    // Nonzero upstream status can still carry valid expired/unconfigured data.
    return { stdout: result.stdout || "", failed: Boolean(result.error || result.signal) };
  },
};
export function runManagedQuota(input: { node: string; entrypoint: string; args: readonly string[]; env: NodeJS.ProcessEnv }, effects: QuotaEffects = production): SafeQuota[] {
  if (!quotaReadArguments(input.args)) return rejected();
  const { PA_AXI_QUOTA_CONSENT: path, PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir } = input.env;
  if (!path) throw new Error("AXI_QUOTA_CONSENT_REQUIRED");
  if (!id || !dir || !isAbsolute(dir) || resolve(dir) !== dir || basename(dir) !== id || !isAbsolute(input.node) || !isAbsolute(input.entrypoint) || !quotaEnvironmentAllowed(input.env)) return rejected();
  const consent = effects.consent(path, id);
  // Revalidate injected effects too; no profile operation before all consent is valid.
  const validated = parseQuotaConsent(consent, id);
  return validated.providers.flatMap((provider) => {
    try {
      const result = effects.run(input.node, [input.entrypoint, "quota", "--provider", provider.id, "--profile-only", "--no-credential-refresh", "--json"], quotaProviderEnvironment(provider, dir));
      if (result.failed) return [{ provider: provider.id, status: "unknown" as const, reason: "provider-error" as const, windows: [] }];
      return sanitizeQuotaResult(result.stdout, provider.id);
    } catch { return [{ provider: provider.id, status: "unknown" as const, reason: "provider-error" as const, windows: [] }]; }
  });
}
