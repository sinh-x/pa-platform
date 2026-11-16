import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBoundedFiveFieldDiagnostic, readProcessFingerprint, type ProcessFingerprint } from "@pa-platform/pa-core";

export interface SelectedPiLaunch {
  readonly schemaVersion: 1;
  readonly entryFile: string;
  readonly nodeFile: string;
  readonly packageRoot: string;
  readonly addonFile: string;
  readonly environmentNames: readonly string[];
}

const headline = "Pi launch could not be safely verified.\n";
const launchError = (): Error => new Error(headline + formatBoundedFiveFieldDiagnostic({
  condition: "the requested Pi session cannot be admitted through the selected host",
  source: "immutable native build and process admission",
  reason: "the build record, startup environment or stopped native child does not meet the selected launch contract",
  correction: "ask the runtime owner to inspect this launch and selected build. Impact: none. Actor: agent or operator. New approval: not required to ask. Prerequisite: preserve original process and deployment evidence",
  resumeAction: "retry only after the binding is corrected and any uncertain operation reconciled; admission runs again, without fallback to another Pi",
}, 2000 - headline.length));
const storePath = (path: unknown): path is string => typeof path === "string" && /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/[^/]+)*$/.test(path)
  && !path.split("/").some(part => part === "." || part === "..") && !path.includes("\0");
const startupName = (name: string): boolean => /^(?:NODE_|LD_|DYLD_|OPENSSL_)/.test(name)
  || ["GCONV_PATH", "GLIBC_TUNABLES", "MALLOC_TRACE", "PI_PACKAGE_DIR", "PA_PI_START_NODE_OPTIONS", "PA_PI_PARENT_LEASE_TOKEN"].includes(name);

/** Pure record grammar, NOT build custody. The only production resolver below
 * reads a fixed sibling of its own immutable installed module; callers cannot
 * select a record path through config, argv, environment or a model tool. */
export function parseSelectedPiLaunch(value: unknown, share: string): SelectedPiLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw launchError();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "addonFile,entryFile,environmentNames,nodeFile,packageRoot,schemaVersion"
    || row.schemaVersion !== 1 || !share.endsWith("/share/pa-platform") || !storePath(share)
    || row.entryFile !== `${share.slice(0, -"/share/pa-platform".length)}/bin/.ppa-selected-pi`
    || row.addonFile !== `${share}/native-addons/pi-node-24/better_sqlite3.node`
    || !storePath(row.nodeFile) || !row.nodeFile.endsWith("/bin/node")
    || !storePath(row.packageRoot) || !row.packageRoot.endsWith("/lib/node_modules/pi-monorepo")
    || !Array.isArray(row.environmentNames) || row.environmentNames.length > 128 || row.environmentNames.length < 1
    || new Set(row.environmentNames).size !== row.environmentNames.length
    || row.environmentNames.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || startupName(name))) throw launchError();
  return Object.freeze({ schemaVersion: 1, entryFile: row.entryFile, nodeFile: row.nodeFile, packageRoot: row.packageRoot,
    addonFile: row.addonFile, environmentNames: Object.freeze([...row.environmentNames]) }) as SelectedPiLaunch;
}

function immutablePath(path: string): void {
  if (!storePath(path) || realpathSync(path) !== path) throw launchError();
  const parts = path.split("/").filter(Boolean);
  let current = "";
  const root = lstatSync("/");
  if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0) throw launchError();
  for (let index = 0; index < parts.length; index++) {
    const stat = lstatSync(current += `/${parts[index]}`);
    const directory = index < parts.length - 1;
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink === 0 || (directory ? !stat.isDirectory() : !stat.isFile())) throw launchError();
    if (current === "/nix/store") {
      if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && (stat.mode & 0o002) === 0)) throw launchError();
    } else if ((stat.mode & (index >= 2 ? 0o222 : 0o022)) !== 0) throw launchError();
  }
}

export function resolveSelectedPiLaunch(): SelectedPiLaunch | undefined {
  const own = fileURLToPath(import.meta.url), record = join(dirname(own), "selected-pi-launch.json");
  if (!existsSync(record)) return undefined;
  try {
    const suffix = "/share/pa-platform/packages/pi-pa/dist/selected-pi-launch.js";
    if (!own.endsWith(suffix) || realpathSync(own) !== own) throw launchError();
    immutablePath(own); immutablePath(record);
    const fd = openSync(record, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > 16384n) throw launchError();
      bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true }), live = lstatSync(record, { bigint: true });
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const)
        if (before[key] !== after[key] || before[key] !== live[key]) throw launchError();
      if (BigInt(bytes.length) !== before.size) throw launchError();
    } finally { closeSync(fd); }
    const share = own.slice(0, -"/packages/pi-pa/dist/selected-pi-launch.js".length);
    const selected = parseSelectedPiLaunch(JSON.parse(bytes.toString("utf8")), share);
    for (const path of [selected.entryFile, selected.nodeFile, selected.addonFile]) immutablePath(path);
    return selected;
  } catch { throw launchError(); }
}

/** Explicit finite child environment. The native entry independently enforces
 * the same build-selected names and fixed addon. Startup code hooks reject,
 * rather than being silently removed and mistaken for compatible execution. */
export function selectedPiEnvironment(selected: SelectedPiLaunch, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (Object.keys(env).some(startupName)) throw launchError();
  const output: NodeJS.ProcessEnv = {};
  for (const name of selected.environmentNames) if (env[name] !== undefined) output[name] = env[name];
  for (const name of ["PA_SQLITE_NATIVE_BINDING", "PA_PI_SQLITE_NATIVE_BINDING"]) {
    if (output[name] !== undefined && output[name] !== selected.addonFile) throw launchError();
    output[name] = selected.addonFile;
  }
  output.PA_REQUIRE_PI_SQLITE_NATIVE_BINDING = "1";
  return output;
}

interface NativeChildObservation { readonly pid: number; readonly fingerprint: ProcessFingerprint; release(): void }

/** A selected native child stops BEFORE Node executes. Admit its exact PID and
 * birth, not the supervisor's PID. Its later exec retains that incarnation, so
 * exact-PID setup owners and existing lineage owners keep their contracts. */
export async function awaitSelectedPiChild(selected: SelectedPiLaunch, supervisorPid: number): Promise<NativeChildObservation> {
  const parent = readProcessFingerprint(supervisorPid);
  if (!parent) throw launchError();
  const started = performance.now();
  while (performance.now() - started < 4000) {
    try {
      if (JSON.stringify(readProcessFingerprint(supervisorPid)) !== JSON.stringify(parent)
        || realpathSync(`/proc/${supervisorPid}/exe`) !== selected.entryFile) throw launchError();
      const children = readFileSync(`/proc/${supervisorPid}/task/${supervisorPid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      if (children.length > 1) throw launchError();
      if (children.length === 1 && /^[1-9][0-9]*$/.test(children[0]!)) {
        const pid = Number(children[0]), fingerprint = readProcessFingerprint(pid);
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        if (fields[0] === "T" && Number(fields[1]) === supervisorPid && fingerprint
          && realpathSync(`/proc/${pid}/exe`) === selected.entryFile) {
          let released = false;
          return { pid, fingerprint, release() {
            if (released || JSON.stringify(readProcessFingerprint(pid)) !== JSON.stringify(fingerprint)
              || JSON.stringify(readProcessFingerprint(supervisorPid)) !== JSON.stringify(parent)
              || realpathSync(`/proc/${pid}/exe`) !== selected.entryFile) throw launchError();
            process.kill(pid, "SIGCONT"); released = true;
          } };
        }
      }
    } catch { if (!readProcessFingerprint(supervisorPid)) throw launchError(); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw launchError();
}
