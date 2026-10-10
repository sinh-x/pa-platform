import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_READINESS_MS = 30000;
export const BROWSER_IDLE_MS = 300000;
export const BROWSER_CLEANUP_MS = 10000;
const fail = (): never => { throw new Error("AXI_POLICY_REJECTED"); };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const modulePath = fileURLToPath(import.meta.url);
export interface BrowserContext { id: string; dir: string; lifecyclePid: number; lifecycleStart: string }
export function processIdentity(pid: number): string | undefined {
  try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[19]; } catch { return undefined; }
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) fail();
}
export function browserContext(env: NodeJS.ProcessEnv): BrowserContext {
  const id = env.PA_DEPLOYMENT_ID;
  const dir = env.PA_DEPLOYMENT_DIR;
  const lifecyclePid = Number(env.PA_AXI_LIFECYCLE_PID);
  const lifecycleStart = env.PA_AXI_LIFECYCLE_START;
  if (!id || !/^d-[a-z0-9]+$/.test(id) || !dir || !isAbsolute(dir) || resolve(dir) !== dir || dirname(dir) === dir || dir.split("/").at(-1) !== id || !Number.isSafeInteger(lifecyclePid) || lifecyclePid <= 1 || !lifecycleStart || processIdentity(lifecyclePid) !== lifecycleStart) return fail();
  // Deployment directories predate this feature and need not be mode 0700;
  // browser-owned descendants are strictly private. Never create the deployment.
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || realpathSync(dir) !== dir) return fail();
  return { id, dir, lifecyclePid, lifecycleStart };
}
export function browserLifecycleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PA_AXI_LIFECYCLE_PID: String(process.pid), PA_AXI_LIFECYCLE_START: processIdentity(process.pid) };
}
export function browserArgumentsAllowed(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (Object.keys(env).some((key) => key.startsWith("CHROME_DEVTOOLS_AXI_") || key === "CHROME_DEVTOOLS_MCP_ARGS")) return false;
  const [command, ...values] = args;
  if (!command || values.some((value) => value.startsWith("--") || value.includes("\0"))) return false;
  const counts: Record<string, number> = { start: 0, stop: 0, pages: 0, snapshot: 0, open: 1, newpage: 1, click: 1, fill: 2, press: 1, back: 0, closepage: 1, selectpage: 1 };
  return Object.hasOwn(counts, command) && values.length === counts[command];
}
export function pinnedMcpArguments(mcp: string, chrome: string, profile: string): string[] {
  if (![mcp, chrome, profile].every(isAbsolute)) return fail();
  // Explicit private profile provides isolation. --isolated and --userDataDir
  // are mutually exclusive in pinned MCP; never combine them.
  return [mcp, `--executablePath=${chrome}`, `--userDataDir=${profile}`, "--headless", "--no-usage-statistics", "--chrome-arg=--remote-debugging-address=127.0.0.1", "--chrome-arg=--password-store=basic", "--chrome-arg=--use-mock-keychain"];
}
export interface BrowserOwner extends BrowserContext {
  token: string; pid: number; start: string; port: number;
  node: string; entrypoint: string; mcp: string; chrome: string;
  inode: number; device: number;
}
function statePath(context: BrowserContext): string { return join(context.dir, "axi-browser"); }
function ownerFile(context: BrowserContext): string { return join(statePath(context), "owner.json"); }
function readOwner(context: BrowserContext): BrowserOwner {
  const state = statePath(context);
  privateDirectory(state);
  const fd = openSync(ownerFile(context), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 65536) return fail();
    const value = JSON.parse(readFileSync(fd, "utf8")) as BrowserOwner;
    const directory = lstatSync(state);
    if (value.id !== context.id || value.dir !== context.dir || value.lifecyclePid !== context.lifecyclePid || value.lifecycleStart !== context.lifecycleStart || value.inode !== directory.ino || value.device !== directory.dev || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535 || !value.start || ![value.node, value.entrypoint, value.mcp, value.chrome].every((path) => typeof path === "string" && isAbsolute(path))) return fail();
    return value;
  } finally { closeSync(fd); }
}
function sameProcess(owner: BrowserOwner): boolean {
  if (processIdentity(owner.pid) !== owner.start) return false;
  try { const args = readFileSync(`/proc/${owner.pid}/cmdline`, "utf8").split("\0"); return args.includes(modulePath) && args.includes(ownerFile(owner)); } catch { return false; }
}
/** Verify the listener's kernel socket inode belongs to this exact supervisor,
 * not merely that an unauthenticated foreign /health returns a plausible id. */
function ownsListener(owner: BrowserOwner): boolean {
  try {
    const sockets = new Set(readdirSync(`/proc/${owner.pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${owner.pid}/fd/${fd}`); } catch { return ""; } }));
    return readFileSync("/proc/net/tcp", "utf8").split("\n").some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1] === `0100007F:${owner.port.toString(16).toUpperCase().padStart(4, "0")}` && fields[3] === "0A" && sockets.has(`socket:[${fields[9]}]`);
    });
  } catch { return false; }
}
async function httpJson(port: number, path: string, body?: unknown, timeout = 2000): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path, method: payload ? "POST" : "GET", timeout, headers: { ...(!payload ? { "x-chrome-devtools-axi-ambient": "1" } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString(); if (text.length > 1024 * 1024) req.destroy(new Error("bounded-response")); });
      res.on("end", () => { try { if (res.statusCode !== 200) return reject(new Error("bridge-response")); const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) return reject(new Error("bridge-response")); done(value as Record<string, unknown>); } catch { reject(new Error("bridge-response")); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("bridge-timeout")));
    req.end(payload);
  });
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") return fail();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}
export interface BrowserSupervisionEffects {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lifecycleAlive: () => boolean;
  bridgeAlive: () => boolean;
  cleanup: () => Promise<void>;
}
/** A deployment-end guard, independent of upstream idle shutdown. Test clocks
 * are injected only here, never exposed as managed environment overrides. */
export async function superviseBrowserLifetime(effects: BrowserSupervisionEffects): Promise<void> {
  try { while (effects.lifecycleAlive() && effects.bridgeAlive()) await effects.sleep(100); }
  finally { await effects.cleanup(); }
}
export async function cleanupManagedBrowser(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.PA_DEPLOYMENT_ID || !env.PA_DEPLOYMENT_DIR) return;
  const context = browserContext(env);
  try { lstatSync(statePath(context)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const owner = readOwner(context);
  if (!sameProcess(owner)) return fail(); // Never trust a PID file or kill a reused PID.
  process.kill(owner.pid, "SIGTERM");
  const deadline = performance.now() + BROWSER_CLEANUP_MS;
  while (performance.now() < deadline) {
    try { lstatSync(statePath(context)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await sleep(25);
  }
  return fail();
}
function bridgeEnvironment(owner: BrowserOwner): NodeJS.ProcessEnv {
  const state = statePath(owner);
  return {
    HOME: join(state, "home"), XDG_CONFIG_HOME: join(state, "home", "config"), XDG_CACHE_HOME: join(state, "home", "cache"), TMPDIR: join(state, "tmp"), PATH: dirname(owner.node), LANG: "C.UTF-8",
    CHROME_DEVTOOLS_AXI_MCP_PATH: join(state, "mcp.cjs"), CHROME_DEVTOOLS_AXI_SESSION: owner.id,
    CHROME_DEVTOOLS_AXI_PORT: String(owner.port), CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(state, "profile"), CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: String(BROWSER_IDLE_MS), CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS: String(BROWSER_READINESS_MS),
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
  };
}
async function daemon(configPath: string): Promise<void> {
  // Daemon starts with only deployment/lifecycle identity; it never reads a
  // caller-selected arbitrary config outside that exact deployment directory.
  const context = browserContext(process.env);
  if (configPath !== ownerFile(context)) return fail();
  const owner = readOwner(context);
  if (owner.pid !== process.pid || owner.start !== processIdentity(process.pid)) return fail();
  const state = statePath(owner);
  const env = bridgeEnvironment(owner);
  const expected = [`--userDataDir=${join(state, "profile")}`, "--headless", "--chrome-arg=--password-store=basic", "--chrome-arg=--use-mock-keychain"];
  // AXI 0.1.38 cannot forward executablePath. The approved shim validates its
  // upstream argv, then replaces it with fixed pinned MCP/Chrome policy argv.
  const source = `const {spawn}=require('node:child_process'); const expected=${JSON.stringify(expected)}; if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected)) process.exit(1); const child=spawn(${JSON.stringify(owner.node)},${JSON.stringify(pinnedMcpArguments(owner.mcp, owner.chrome, join(state, "profile")))},{env:process.env,stdio:['inherit','inherit','ignore']}); child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code??1));`;
  writeFileSync(join(state, "mcp.cjs"), source, { mode: 0o600, flag: "wx" });
  const bridge = join(dirname(owner.entrypoint), "chrome-devtools-axi-bridge.js");
  // Start the pinned bridge ourselves, not the upstream CLI's detached
  // auto-restart/weak-PID lifecycle. It binds only 127.0.0.1.
  const child = spawn(owner.node, [bridge], { env, cwd: state, stdio: "ignore", detached: true });
  await superviseBridge(owner, child, owner.port);
}

async function superviseBridge(owner: BrowserOwner, child: ChildProcess, port: number): Promise<void> {
  if (!child.pid) return fail();
  const pid = child.pid; const start = processIdentity(pid); let closed = false; let stopping = false;
  child.once("exit", () => { closed = true; }); child.once("error", () => { closed = true; });
  // Proxying only our internal /health and /call is unnecessary: use the owned
  // bridge port directly, proven by recorded child identity and kernel inode.
  const updated = { ...owner, port, bridgePid: pid, bridgeStart: start };
  writeFileSync(ownerFile(owner), JSON.stringify(updated), { mode: 0o600 });
  const cleanup = async (): Promise<void> => {
    if (stopping) return; stopping = true;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const current = processIdentity(pid);
      // Missing identity is not permission to signal a potentially reused group.
      if (!start || current !== start) return fail();
      try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (signal === "SIGTERM") await sleep(300);
    }
    const current = readOwner(owner);
    if (current.token !== owner.token || !sameProcess(current)) return fail();
    rmSync(statePath(owner), { recursive: true });
  };
  process.removeAllListeners("SIGTERM"); process.removeAllListeners("SIGINT"); process.removeAllListeners("SIGHUP");
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void cleanup().then(() => process.exit(0), () => process.exit(1)); });
  await superviseBrowserLifetime({ now: () => performance.now(), sleep, lifecycleAlive: () => processIdentity(owner.lifecyclePid) === owner.lifecycleStart, bridgeAlive: () => !closed && !stopping, cleanup });
}

export async function runBrowserCommand(input: { node: string; entrypoint: string; mcp: string; chrome: string; args: readonly string[]; env: NodeJS.ProcessEnv }): Promise<string> {
  if (!browserArgumentsAllowed(input.args, input.env) || ![input.node, input.entrypoint, input.mcp, input.chrome].every(isAbsolute)) return fail();
  const context = browserContext(input.env);
  if (input.args[0] === "stop") { await cleanupManagedBrowser(input.env); return "browser stopped\n"; }
  let owner: BrowserOwner;
  try { lstatSync(statePath(context)); owner = readOwner(context); if (!sameProcess(owner)) return fail(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = statePath(context);
    mkdirSync(state, { mode: 0o700 });
    for (const name of ["home", "tmp", "profile"]) mkdirSync(join(state, name), { mode: 0o700 });
    const stat = lstatSync(state);
    const port = await unusedPort();
    // Gate daemon startup until its immutable ownership record has been written.
    const child = spawn(input.node, [modulePath, "supervise", ownerFile(context)], { env: { PA_DEPLOYMENT_ID: context.id, PA_DEPLOYMENT_DIR: context.dir, PA_AXI_LIFECYCLE_PID: String(context.lifecyclePid), PA_AXI_LIFECYCLE_START: context.lifecycleStart }, stdio: "ignore", detached: true });
    if (!child.pid) return fail();
    owner = { ...context, token: randomUUID(), pid: child.pid, start: processIdentity(child.pid) ?? "", port, node: input.node, entrypoint: input.entrypoint, mcp: input.mcp, chrome: input.chrome, inode: stat.ino, device: stat.dev };
    writeFileSync(ownerFile(context), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    child.unref();
  }
  const deadline = performance.now() + BROWSER_READINESS_MS;
  let ready = false;
  while (performance.now() < deadline) {
    owner = readOwner(context);
    if (!sameProcess(owner)) break;
    const bridgeOwner = owner as BrowserOwner & { bridgePid?: number; bridgeStart?: string };
    if (bridgeOwner.bridgePid && bridgeOwner.bridgeStart && processIdentity(bridgeOwner.bridgePid) === bridgeOwner.bridgeStart && ownsListener({ ...owner, pid: bridgeOwner.bridgePid })) {
      try { const health = await httpJson(owner.port, "/health?deep=1", undefined, Math.max(1, Math.min(2000, deadline - performance.now()))); if (health.status === "ok" && health.session === context.id) { ready = true; break; } } catch { /* bounded startup */ }
    }
    await sleep(25);
  }
  if (!ready) { await cleanupManagedBrowser(input.env); return fail(); }
  if (input.args[0] === "start") return "browser ready\n";
  const [command, a, b] = input.args;
  const calls: Record<string, { name: string; args: Record<string, unknown> }> = {
    pages: { name: "list_pages", args: {} }, snapshot: { name: "take_snapshot", args: {} },
    open: { name: "navigate_page", args: { type: "url", url: a } }, newpage: { name: "new_page", args: { url: a } },
    click: { name: "click", args: { uid: a?.replace(/^@/, "") } }, fill: { name: "fill", args: { uid: a?.replace(/^@/, ""), value: b } },
    press: { name: "press_key", args: { key: a } }, back: { name: "navigate_page", args: { type: "back" } },
    closepage: { name: "close_page", args: { pageId: Number(a) } }, selectpage: { name: "select_page", args: { pageId: Number(a) } },
  };
  try {
    const result = await httpJson(owner.port, "/call", calls[command!], 30000);
    if (typeof result.result !== "string" || result.error) return fail();
    return `${result.result}\n`;
  } catch { await cleanupManagedBrowser(input.env); return fail(); }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    if (process.argv[2] === "supervise") {
      // Parent writes the record immediately after spawn. No package/network or
      // credential access occurs while waiting for this private ownership file.
      for (let i = 0; i < 100; i++) { try { lstatSync(process.argv[3]!); break; } catch { await sleep(10); } }
      await daemon(process.argv[3]!);
    } else if (process.argv[2] === "command") {
      const [, , , node, entrypoint, mcp, chrome, ...args] = process.argv;
      if (!node || !entrypoint || !mcp || !chrome) fail();
      process.stdout.write(await runBrowserCommand({ node: node!, entrypoint: entrypoint!, mcp: mcp!, chrome: chrome!, args, env: process.env }));
    } else fail();
  } catch { process.stderr.write("AXI_POLICY_REJECTED\n"); process.exitCode = 1; }
}
