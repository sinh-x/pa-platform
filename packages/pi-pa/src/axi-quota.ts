import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
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
    const stamp = profileStamp(fd);
    const bytes = readBoundedProfile(fd);
    if (bytes.length !== stat.size || profileStamp(fd) !== stamp) return rejected();
    return parseQuotaConsent(profileJson(bytes), deploymentId);
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
/** Optional local evidence is consulted only for one empty, non-stale,
 * authentication-denied profile-only row, never for successful quota. */
export function sanitizeQuotaResult(raw: string, provider: QuotaProvider, expiredProfile?: () => boolean): SafeQuota[] {
  const invalid: SafeQuota[] = [{ provider, status: "unknown", reason: "invalid-response", windows: [] }];
  try {
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) return invalid;
    const root = profileJson(Buffer.from(raw, "utf8"));
    if ((root.schemaVersion !== 5 && root.schemaVersion !== 6) || !Array.isArray(root.providers) || !root.providers.length || root.providers.length > 32) return invalid;
    const singleProvider = root.providers.length === 1;
    return root.providers.map((entry: unknown): SafeQuota => {
      const row = record(entry);
      if (row.provider !== provider || !Array.isArray(row.windows) || row.windows.length > 64) return rejected();
      const state = record(row.state);
      let status: QuotaStatus = "unknown";
      let reason: SafeQuota["reason"] = "unavailable";
      if (row.notSetUp === true) { status = "not-configured"; reason = "profile-not-configured"; }
      else if (state.status === "fresh" && state.stale === false && row.windows.length > 0) { status = "fresh"; reason = "quota-read"; }
      else if (state.reason === "credentials_expired" || state.authStatus === "expired_refreshable") { status = "expired"; reason = "credentials-expired"; }
      else if (state.stale === true || state.status === "stale") { status = "stale"; reason = "stale-reading"; }
      else if (state.status === "rate_limited") { status = "rate-limited"; reason = "rate-limited"; }
      else if (state.status === "error") { status = "error"; reason = "provider-error"; }
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
      if (status === "unknown" && singleProvider && state.status === "auth_required" && state.stale === false && row.windows.length === 0 && expiredProfile?.() === true) {
        status = "expired"; reason = "credentials-expired";
      }
      return { provider, status, reason, windows, ...(timestamp(root.generatedAt) ? { generatedAt: timestamp(root.generatedAt) } : {}), ...(timestamp(state.refreshedAt) ? { refreshedAt: timestamp(state.refreshedAt) } : {}) };
    });
  } catch { return invalid; }
}
/** Strict bounded JSON: duplicate keys, excessive nesting and invalid UTF-8
 * are ambiguous evidence, even where upstream's permissive parser accepts them. */
function readBoundedProfile(fd: number): Uint8Array {
  const buffer = Buffer.alloc(65537);
  let size = 0;
  while (size < buffer.length) {
    const read = readSync(fd, buffer, size, buffer.length - size, size);
    if (!read) break;
    size += read;
  }
  if (size > 65536) return rejected();
  return buffer.subarray(0, size);
}
function profileJson(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stack: (Set<string> | null)[] = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      if (stack.length >= 32) return rejected();
      stack.push(token === "{" ? new Set<string>() : null);
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && /^\s*:/.test(text.slice(match.index + token.length))) {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) return rejected();
      keys.add(key);
    }
  }
  return record(JSON.parse(text) as unknown);
}
function tokenField(value: Record<string, unknown>, snake: string, camel: string): string | undefined {
  if (Object.hasOwn(value, snake) && Object.hasOwn(value, camel)) return undefined;
  const token = value[snake] ?? value[camel];
  return typeof token === "string" && token.length > 0 && token.length <= 16384 && !/\s/.test(token) ? token : undefined;
}
function expiryNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined;
}
/** Advisory metadata in the exact quota-axi 0.1.56 profile formats. No ID-token
 * expiry, refresh token, arbitrary field, JWT signature lookup or discovery.
 * This proves stored expiry + an upstream denial, not why the vendor denied it. */
function openProfile(provider: QuotaConsent["providers"][number]): number | undefined {
  const fds: number[] = [];
  try {
    const path = provider.profilePath;
    if (path.length > 4096 || resolve(path) !== path) return rejected();
    const parts = path.split("/").filter(Boolean);
    if (!parts.length || parts.length > 128) return rejected();
    let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fds.push(fd);
    for (const part of parts) {
      fd = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fds.push(fd);
      const stat = fstatSync(fd);
      // Root-owned sticky /tmp is safe to traverse; hold each directory fd so
      // ancestor replacement cannot redirect the subsequent bounded read.
      if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid?.()) || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000)))) return rejected();
    }
    if (fstatSync(fd).uid !== process.getuid?.()) return rejected();
    const file = `/proc/self/fd/${fd}/${provider.id === "codex" ? "auth.json" : ".credentials.json"}`;
    let before: Stats;
    try { before = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (before.isSymbolicLink() || !validConsentFile(before) || before.nlink !== 1) return rejected();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fds.push(fd);
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || !validConsentFile(stat) || stat.nlink !== 1) return rejected();
    fds.pop(); // Transfer only the validated file descriptor to the caller.
    return fd;
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
function profileStamp(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
export function readQuotaProfileExpired(provider: QuotaConsent["providers"][number], now = Date.now(), expectedStamp?: string): boolean {
  let fd: number | undefined;
  try {
    if (!Number.isFinite(now)) return false;
    fd = openProfile(provider);
    if (fd === undefined) return false;
    const stamp = profileStamp(fd);
    if (expectedStamp !== undefined && stamp !== expectedStamp) return false;
    const stat = fstatSync(fd);
    const bytes = readBoundedProfile(fd);
    if (bytes.length !== stat.size || profileStamp(fd) !== stamp) return false;
    const current = openProfile(provider);
    if (current === undefined) return false;
    try { if (profileStamp(current) !== stamp) return false; } finally { closeSync(current); }
    const root = profileJson(bytes);
    if (provider.id === "codex") {
      const token = tokenField(record(root.tokens), "access_token", "accessToken");
      const parts = token?.split(".");
      if (!parts || parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, "base64url").toString("base64url") !== part)) return false;
      profileJson(Buffer.from(parts[0]!, "base64url"));
      const payload = Buffer.from(parts[1]!, "base64url");
      if (payload.toString("base64url") !== parts[1]) return false;
      const exp = expiryNumber(profileJson(payload).exp);
      return exp !== undefined && exp <= Math.floor(now / 1000);
    }
    const oauth = Object.hasOwn(root, "claudeAiOauth") ? record(root.claudeAiOauth) : root;
    if (!tokenField(oauth, "access_token", "accessToken")) return false;
    let expiresAt = expiryNumber(oauth.expiresAt);
    if (expiresAt === undefined && typeof oauth.expiresAt === "string") {
      const parsed = timestamp(oauth.expiresAt);
      // Date.parse normalizes impossible days/hours; that is not explicit,
      // unambiguous expiry evidence. Permit only the matching UTC calendar time.
      const canonical = oauth.expiresAt.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
      if (parsed === canonical) expiresAt = Date.parse(parsed);
    }
    return expiresAt !== undefined && expiresAt > 0 && expiresAt <= now;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export interface QuotaEffects {
  consent: typeof readQuotaConsent;
  expiredProfile?: typeof readQuotaProfileExpired;
  run: (node: string, args: string[], env: NodeJS.ProcessEnv) => { stdout: string; failed: boolean; profileStamp?: string };
}
const production: QuotaEffects = {
  consent: readQuotaConsent,
  run: (node, args, env) => {
    const provider = { id: args[3] as QuotaProvider, profilePath: (env.CODEX_HOME ?? env.CLAUDE_CONFIG_DIR)! };
    // Metadata-only safety gate after WHOLE consent validation, before upstream
    // can read an unsafe file. Missing files remain upstream not-configured.
    const fd = openProfile(provider);
    try {
      const stamp = fd === undefined ? undefined : profileStamp(fd);
      const result = spawnSync(node, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      // Nonzero upstream status can still carry valid expired/unconfigured data.
      return { stdout: result.stdout || "", failed: Boolean(result.error || result.signal),
        ...(fd !== undefined && profileStamp(fd) === stamp ? { profileStamp: stamp } : {}) };
    } finally { if (fd !== undefined) closeSync(fd); }
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
      return sanitizeQuotaResult(result.stdout, provider.id, () => {
        if (effects === production && result.profileStamp === undefined) return false;
        return (effects.expiredProfile ?? readQuotaProfileExpired)(provider, Date.now(), result.profileStamp);
      });
    } catch { return [{ provider: provider.id, status: "unknown" as const, reason: "provider-error" as const, windows: [] }]; }
  });
}
