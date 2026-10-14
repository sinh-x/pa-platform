import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Native stripped-TypeScript source tests have no inherited loader in the
// supervisor's positive environment. Installed modules resolve ONLY .js;
// there is no missing-file/source fallback in installed execution.
const { browserToolRequest, withBrowserRouting } = await import(new URL(import.meta.url.endsWith(".ts") ? "./axi-browser-routing.ts" : "./axi-browser-routing.js", import.meta.url).href) as typeof import("./axi-browser-routing.js");

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
export function browserContext(env: NodeJS.ProcessEnv, requireLive = true): BrowserContext {
  const id = env.PA_DEPLOYMENT_ID;
  const dir = env.PA_DEPLOYMENT_DIR;
  const lifecyclePid = Number(env.PA_AXI_LIFECYCLE_PID);
  const lifecycleStart = env.PA_AXI_LIFECYCLE_START;
  if (!id || !/^d-[a-z0-9]+$/.test(id) || !dir || !isAbsolute(dir) || resolve(dir) !== dir || dirname(dir) === dir || dir.split("/").at(-1) !== id || !Number.isSafeInteger(lifecyclePid) || lifecyclePid <= 1 || !lifecycleStart || !/^\d+$/.test(lifecycleStart) || (requireLive && processIdentity(lifecyclePid) !== lifecycleStart)) return fail();
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
  return [mcp, `--executablePath=${chrome}`, `--userDataDir=${profile}`, "--headless", "--no-usage-statistics", "--chrome-arg=--remote-debugging-pipe", "--chrome-arg=--password-store=basic", "--chrome-arg=--use-mock-keychain"];
}
export interface BrowserOwner extends BrowserContext {
  token: string; pid: number; start: string; port: number;
  node: string; entrypoint: string; mcp: string; chrome: string;
  inode: number; device: number;
  descendants?: ProcessIdentity[];
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
    if (!value || typeof value !== "object") return fail();
    const directory = lstatSync(state);
    if (value.id !== context.id || value.dir !== context.dir || value.lifecyclePid !== context.lifecyclePid || value.lifecycleStart !== context.lifecycleStart || value.inode !== directory.ino || value.device !== directory.dev || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535 || !/^\d+$/.test(value.start) || ![value.node, value.entrypoint, value.mcp, value.chrome].every((path) => typeof path === "string" && isAbsolute(path))) return fail();
    return value;
  } finally { closeSync(fd); }
}
function writeOwner(owner: BrowserOwner): void {
  const previous = readOwner(owner);
  if (previous.token !== owner.token || previous.pid !== owner.pid || previous.start !== owner.start) fail();
  const temporary = join(statePath(owner), `owner-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  renameSync(temporary, ownerFile(owner));
}
function sameProcess(owner: BrowserOwner): boolean {
  if (processIdentity(owner.pid) !== owner.start) return false;
  try { const args = readFileSync(`/proc/${owner.pid}/cmdline`, "utf8").split("\0"); return args.includes(modulePath) && args.includes(ownerFile(owner)); } catch { return false; }
}
/** Verify the listener's kernel socket inode belongs to this exact supervisor,
 * not merely that an unauthenticated foreign /health returns a plausible id. */
export function ownsListener(owner: Pick<BrowserOwner, "pid" | "port">): boolean {
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
  // Every Pi launch awaits cleanup, including default-disabled launches. Only
  // absent state is a no-op: selection flags must never bypass ownership checks
  // on existing state. Probe without acquiring browser-only lifecycle/binding
  // requirements, then validate the full context before any read or mutation.
  try { lstatSync(join(env.PA_DEPLOYMENT_DIR, "axi-browser")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const context = browserContext(env, false);
  const owner = readOwner(context);
  if (!sameProcess(owner)) {
    // An absent supervisor may have been killed abruptly. Only a recorded live
    // descendant can anchor its still-reserved Linux session; a reused leader
    // or witness rejects without signals or state removal.
    if (processIdentity(owner.pid) !== undefined) return fail();
    await cleanupBrowserSession(owner, owner.descendants ?? []);
    removeOwnedState(owner);
    return;
  }
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
  const context = browserContext(process.env, false);
  if (configPath !== ownerFile(context)) return fail();
  const owner = readOwner(context);
  if (owner.pid !== process.pid || owner.start !== processIdentity(process.pid)) return fail();
  const witnesses: ProcessIdentity[] = [];
  let completion: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    // One shared bounded attempt across startup failure, signals and the final
    // lifetime guard. A failed cleanup must not restart another 10-second bound.
    completion ??= (async () => {
      const current = readOwner(owner);
      if (current.token !== owner.token || current.pid !== owner.pid || current.start !== owner.start) return fail();
      await cleanupBrowserSession(owner, witnesses);
      removeOwnedState(owner);
    })();
    return completion;
  };
  try {
    if (processIdentity(owner.lifecyclePid) === owner.lifecycleStart) await launchBridge(owner, witnesses, cleanup);
  } finally { await cleanup(); }
}
/** Puppeteer defaults to detached Chrome. The approved managed launcher must
 * override that spawn seam, or Chrome escapes the owned daemon session. Guard
 * upstream cleanup too: it may not issue group signals or signal stale children.
 * This preload is fixed generated code, not an operator NODE_OPTIONS surface. */
export function managedProcessPreload(): string {
  const source = `import {createRequire,syncBuiltinESMExports} from 'node:module'; const require=createRequire(process.cwd()+'/managed.cjs'); const cp=require('node:child_process'); const fs=require('node:fs'); const identity=pid=>{try{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19]}catch{return undefined}}; const owned=new Map([[process.pid,identity(process.pid)]]); const spawn=cp.spawn; cp.spawn=(command,args,options)=>{if(!Array.isArray(args)){options=args;args=[]} const child=spawn(command,args,{...options,detached:false}); const start=identity(child.pid); if(start)owned.set(child.pid,start); return child}; syncBuiltinESMExports(); const kill=process.kill.bind(process); process.kill=(pid,signal)=>{if(pid<=0||!owned.has(pid)||identity(pid)!==owned.get(pid)){const e=new Error('AXI_POLICY_REJECTED');e.code='ESRCH';throw e}return kill(pid,signal)};`;
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
export function managedMcpShim(node: string, mcp: string, chrome: string, profile: string): string {
  if (!isAbsolute(node)) return fail();
  // Exact chrome-devtools-axi 0.1.38 transport order; retain strict equality.
  const expected = [`--userDataDir=${profile}`, "--headless", "--chrome-arg=--use-mock-keychain", "--chrome-arg=--password-store=basic"];
  // AXI 0.1.38 cannot forward executablePath. The approved shim validates its
  // upstream argv, then replaces it with fixed pinned MCP/Chrome policy argv.
  // The pinned SDK stdio transport retains only its generic default keys.
  // Reconstruct mandatory private/telemetry settings here, never copy its env.
  const state = dirname(profile);
  const env = { HOME: join(state, "home"), XDG_CONFIG_HOME: join(state, "home", "config"), XDG_CACHE_HOME: join(state, "home", "cache"), TMPDIR: join(state, "tmp"), PATH: dirname(node), LANG: "C.UTF-8", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
  return `const {spawn}=require('node:child_process'); const expected=${JSON.stringify(expected)}; if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected)) process.exit(1); const child=spawn(${JSON.stringify(node)},${JSON.stringify(["--import", managedProcessPreload(), ...pinnedMcpArguments(mcp, chrome, profile)])},{env:${JSON.stringify(env)},stdio:['inherit','inherit','ignore']}); child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code??1));`;
}
async function launchBridge(owner: BrowserOwner, witnesses: ProcessIdentity[], cleanup: () => Promise<void>): Promise<void> {
  const state = statePath(owner);
  const env = bridgeEnvironment(owner);
  writeFileSync(join(state, "mcp.cjs"), managedMcpShim(owner.node, owner.mcp, owner.chrome, join(state, "profile")), { mode: 0o600, flag: "wx" });
  const bridge = join(dirname(owner.entrypoint), "chrome-devtools-axi-bridge.js");
  // Start the pinned bridge ourselves, not the upstream CLI's detached
  // auto-restart/weak-PID lifecycle. It binds only 127.0.0.1.
  // Keep every bridge/MCP/Chrome child in the daemon's private Linux session.
  // The fixed preload also denies upstream exit-time group signals and stale
  // direct-child PIDs; the daemon handles verified descendant cleanup instead.
  const child = spawn(owner.node, ["--import", managedProcessPreload(), bridge], { env, cwd: state, stdio: "ignore" });
  await superviseBridge(owner, child, witnesses, cleanup);
}

export interface ProcessIdentity { pid: number; start: string; session: number; uid: number; zombie: boolean }
export function inspectProcess(pid: number): ProcessIdentity | undefined {
  try {
    const path = `/proc/${pid}`;
    const text = readFileSync(`${path}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { pid, start: fields[19]!, session: Number(fields[3]), uid: lstatSync(path).uid, zombie: fields[0] === "Z" };
  } catch { return undefined; }
}
export interface BrowserProcessEffects {
  list: () => ProcessIdentity[];
  inspect: (pid: number) => ProcessIdentity | undefined;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const processEffects: BrowserProcessEffects = {
  list: () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => { const row = inspectProcess(Number(name)); return row ? [row] : []; }),
  inspect: inspectProcess, signal: (pid, signal) => { process.kill(pid, signal); }, now: () => performance.now(), sleep,
};
function sameIdentity(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return !!a && a.pid === b.pid && a.start === b.start && a.session === b.session && a.uid === b.uid;
}
/** Linux session IDs remain reserved while any member exists. A live exact
 * leader or recorded descendant is required before discovering session members.
 * An unrelated process cannot join this detached session. Signal only individual
 * reverified identities, never a PID file blindly or a process group. */
export function ownedSessionProcesses(owner: Pick<BrowserOwner, "pid" | "start">, witnesses: ProcessIdentity[], effects: BrowserProcessEffects = processEffects): ProcessIdentity[] {
  const leader = effects.inspect(owner.pid);
  if (leader && (leader.start !== owner.start || leader.session !== owner.pid || leader.uid !== process.getuid?.())) return fail();
  const anchored = !!leader || witnesses.some((row) => row.session === owner.pid && sameIdentity(effects.inspect(row.pid), row));
  const members = effects.list().filter((row) => row.session === owner.pid && row.pid !== owner.pid && !row.zombie);
  if (!anchored && members.length) return fail();
  if (members.some((row) => row.uid !== process.getuid?.() || BigInt(row.start) < BigInt(owner.start))) return fail();
  return members;
}
export async function cleanupBrowserSession(owner: Pick<BrowserOwner, "pid" | "start">, witnesses: ProcessIdentity[], effects: BrowserProcessEffects = processEffects): Promise<void> {
  const deadline = effects.now() + BROWSER_CLEANUP_MS - 500;
  const known = [...witnesses];
  const started = effects.now();
  while (effects.now() < deadline) {
    const members = ownedSessionProcesses(owner, known, effects);
    if (!members.length) return;
    known.push(...members);
    const signal = effects.now() - started < 300 ? "SIGTERM" : "SIGKILL";
    for (const row of members) {
      if (!sameIdentity(effects.inspect(row.pid), row)) continue;
      try { effects.signal(row.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await effects.sleep(25);
  }
  return fail();
}
function removeOwnedState(owner: BrowserOwner): void {
  const current = readOwner(owner);
  if (current.token !== owner.token || current.pid !== owner.pid || current.start !== owner.start) return fail();
  rmSync(statePath(owner), { recursive: true });
}
async function superviseBridge(owner: BrowserOwner, child: ChildProcess, witnesses: ProcessIdentity[], ownedCleanup: () => Promise<void>): Promise<void> {
  let closed = !child.pid; let stopping = false;
  child.once("exit", () => { closed = true; }); child.once("error", () => { closed = true; });
  const pid = child.pid;
  const start = pid ? processIdentity(pid) : undefined;
  witnesses.push(...ownedSessionProcesses(owner, []));
  const updated = { ...owner, bridgePid: pid, bridgeStart: start, descendants: witnesses };
  writeOwner(updated);
  const cleanup = (): Promise<void> => { stopping = true; return ownedCleanup(); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void cleanup().then(() => process.exit(0), () => process.exit(1)); });
  await superviseBrowserLifetime({ now: () => performance.now(), sleep: async (ms) => {
    witnesses.splice(0, witnesses.length, ...ownedSessionProcesses(owner, witnesses));
    if (!stopping) writeOwner({ ...updated, descendants: witnesses });
    await sleep(ms);
  }, lifecycleAlive: () => processIdentity(owner.lifecyclePid) === owner.lifecycleStart, bridgeAlive: () => !closed && !stopping, cleanup });
}

export async function runBrowserCommand(input: { node: string; entrypoint: string; mcp: string; chrome: string; args: readonly string[]; env: NodeJS.ProcessEnv }): Promise<string> {
  if (!browserArgumentsAllowed(input.args, input.env) || ![input.node, input.entrypoint, input.mcp, input.chrome].every(isAbsolute)) return fail();
  const context = browserContext(input.env);
  const deadline = performance.now() + BROWSER_READINESS_MS;
  if (input.args[0] === "stop") { await cleanupManagedBrowser(input.env); return "browser stopped\n"; }
  let owner: BrowserOwner;
  try { lstatSync(statePath(context)); owner = readOwner(context); if (!sameProcess(owner)) return fail(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = statePath(context);
    mkdirSync(state, { mode: 0o700 });
    const stat = lstatSync(state);
    let child: ChildProcess | undefined;
    let start: string | undefined;
    try {
      for (const name of ["home", "tmp", "profile"]) mkdirSync(join(state, name), { mode: 0o700 });
      const port = await unusedPort();
      // The daemon cannot spawn descendants before atomic owner publication.
      child = spawn(input.node, [modulePath, "supervise", ownerFile(context)], { env: { PA_DEPLOYMENT_ID: context.id, PA_DEPLOYMENT_DIR: context.dir, PA_AXI_LIFECYCLE_PID: String(context.lifecyclePid), PA_AXI_LIFECYCLE_START: context.lifecycleStart }, stdio: "ignore", detached: true });
      child.on("error", () => { /* startup fails via missing identity, never uncaught */ });
      if (!child.pid) return fail();
      start = processIdentity(child.pid);
      if (!start) return fail();
      owner = { ...context, token: randomUUID(), pid: child.pid, start, port, node: input.node, entrypoint: input.entrypoint, mcp: input.mcp, chrome: input.chrome, inode: stat.ino, device: stat.dev };
      const temporary = join(state, `owner-${owner.token}.tmp`);
      writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
      renameSync(temporary, ownerFile(context));
      child.unref();
    } catch {
      if (child?.pid && start && processIdentity(child.pid) === start) process.kill(child.pid, "SIGTERM");
      // We won exclusive mkdir and have not published an owner: remove only
      // that exact still-private directory, not a replacement/collision.
      privateDirectory(state);
      const current = lstatSync(state);
      if (current.ino !== stat.ino || current.dev !== stat.dev) return fail();
      rmSync(state, { recursive: true });
      return fail();
    }
  }
  if (owner.node !== input.node || owner.entrypoint !== input.entrypoint || owner.mcp !== input.mcp || owner.chrome !== input.chrome) return fail();
  const cancel = (): void => { void cleanupManagedBrowser(input.env).then(() => process.exit(1), () => process.exit(1)); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, cancel);
  try { return await readyBrowserCommand(owner, context, input, deadline); }
  finally { for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeListener(signal, cancel); }
}
async function readyBrowserCommand(owner: BrowserOwner, context: BrowserContext, input: Parameters<typeof runBrowserCommand>[0], deadline: number): Promise<string> {
  let ready = false;
  let reconnected = false;
  while (performance.now() < deadline) {
    owner = readOwner(context);
    if (!sameProcess(owner)) break;
    const bridgeOwner = owner as BrowserOwner & { bridgePid?: number; bridgeStart?: string };
    if (bridgeOwner.bridgePid && bridgeOwner.bridgeStart && processIdentity(bridgeOwner.bridgePid) === bridgeOwner.bridgeStart && ownsListener({ ...owner, pid: bridgeOwner.bridgePid })) {
      try { const health = await httpJson(owner.port, "/health?deep=1", undefined, Math.max(1, Math.min(2000, deadline - performance.now()))); if (health.status === "ok" && health.session === context.id) { reconnected = health.pageIdentityChanged === true; ready = true; break; } } catch { /* bounded startup */ }
    }
    await sleep(25);
  }
  if (!ready) { await cleanupManagedBrowser(input.env); return fail(); }
  if (input.args[0] === "start") {
    if (reconnected) await withBrowserRouting(owner, async (routing) => { routing.clear(); });
    return "browser ready\n";
  }
  return withBrowserRouting(owner, async (routing) => {
    if (reconnected) routing.clear();
    const selected = routing.selected();
    // Missing selection or a concurrent command fails without retargeting or
    // stopping another operation. No page ID is inferred from list_pages.
    const call = browserToolRequest(input.args, selected, reconnected || routing.lost());
    try {
      const result = await httpJson(owner.port, "/call", call, 30000);
      if (typeof result.result !== "string" || result.error) { routing.clear(); return fail(); }
      if (call.name === "new_page") {
        // Reuse ONLY the integrity-pinned pure new-page parser. Do not invoke
        // upstream client auto-restart, discovery, or selected-page file hooks.
        const parser = await import(join(dirname(owner.entrypoint), "../src/selected-page.js")) as { createdPageIdFromNewPageDump: (text: string, url: string) => number | null };
        const pageId = parser.createdPageIdFromNewPageDump(result.result, String(call.args.url));
        if (pageId !== null && Number.isSafeInteger(pageId) && pageId >= 0) routing.select(pageId);
        else routing.clear(); // Redirect/ambiguous output needs explicit selectpage.
      } else if (call.name === "select_page") routing.select(call.args.pageId as number);
      else if (call.name === "close_page" && call.args.pageId === selected) routing.clear();
      return `${result.result}\n`;
    } catch { await cleanupManagedBrowser(input.env); return fail(); }
  });
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
