// Isolated, eligible npm/TUI host. All installer and execve attempts are spies;
// only the packaged inventory helper can run, against a synthetic local SDK.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { FakeComposedHost, createHostContext } from "./pi-composed-host.ts";

const [bundle, mode] = process.argv.slice(2);
assert.ok(["ordinary", "managed", "off-only", "managed-root-only", "missing-helper"].includes(mode));
const root = mkdtempSync(join(tmpdir(), "pi-pa-updater-spy-"));
const packageDir = join(root, "lib/node_modules/pi");
const agentDir = join(root, "agent");
const entry = join(packageDir, "cli.mjs");
const inventoryScript = join(dirname(bundle), "inventory.mjs");
const calls = { inventorySubprocesses: 0, updaterInstallSubprocesses: 0, versionProbes: 0, automaticRestarts: 0 };
const actualSpawn = childProcess.spawn;
let version = "0.99.2";
const writeSdk = () => writeFileSync(join(packageDir, "index.mjs"), `
export const VERSION = ${JSON.stringify(version)};
export const CONFIG_DIR_NAME = ".pi";
export class SettingsManager { static create() { return new this(); } drainErrors() { return []; } }
export class DefaultPackageManager { listConfiguredPackages() { return []; } }
`);
mkdirSync(packageDir, { recursive: true });
mkdirSync(join(agentDir, "proper-updater-ready"), { recursive: true });
writeFileSync(join(agentDir, "proper-updater-ready/pi-00000000-0000-4000-8000-000000000000"), "");
writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module", bin: { pi: "cli.mjs" }, exports: { ".": { import: "./index.mjs" } } }));
writeFileSync(entry, "// Synthetic launcher: never executed as an installer.\n");
writeSdk();
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PACKAGE_DIR = packageDir;
for (const name of ["PROPER_UPDATER_OFF", "PI_MANAGED_INSTALL_ROOT", "PI_OFFLINE", "PROPER_UPDATER_RESTART", "PROPER_UPDATER_RESULT"]) delete process.env[name];
if (mode === "managed" || mode === "off-only") process.env.PROPER_UPDATER_OFF = "1";
if (mode === "managed" || mode === "managed-root-only") process.env.PI_MANAGED_INSTALL_ROOT = root;
process.argv = [process.execPath, entry];
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process, "execve", { value: (_command, args) => {
  calls.automaticRestarts += 1;
  assert.equal(args[0], process.execPath);
  assert.ok(args.includes(entry));
}, configurable: true });
function completed(stdout, code = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => { child.stdout.end(stdout); child.stderr.end(); child.emit("close", code); });
  return child;
}
childProcess.spawn = (command, args, options) => {
  assert.equal(command, process.execPath);
  assert.equal(options.cwd, root);
  if (args[0] === inventoryScript) {
    calls.inventorySubprocesses += 1;
    assert.deepEqual(args.slice(1), [packageDir, agentDir, root, "true"]);
    assert.equal(existsSync(inventoryScript), mode !== "missing-helper", "selected helper is executable beside the bundle; negative fixture removes it");
    // This child reads only a synthetic SDK/config directory, never user packages.
    return actualSpawn(command, args, options);
  }
  assert.equal(args[0], entry, "unexpected subprocess refused");
  if (args[1] === "update") {
    calls.updaterInstallSubprocesses += 1;
    assert.deepEqual(args.slice(1), ["update", "--self", "--no-approve"]);
    version = "0.99.3";
    writeSdk();
    return completed("Updated pi from 0.99.2 to 0.99.3\n");
  }
  assert.deepEqual(args.slice(1), ["--version"]);
  calls.versionProbes += 1;
  return completed(`${version}\n`);
};
syncBuiltinESMExports();
try {
  const { default: register } = await import(pathToFileURL(bundle).href);
  const host = new FakeComposedHost();
  const context = createHostContext("tui", root);
  register(host.runtime);
  await host.dispatch("session_start", { type: "session_start", reason: "startup" }, context);
  await host.dispatch("session_start", { type: "session_start", reason: "reload" }, context);
  await host.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  // Invoke any upstream restart listener with execve replaced, never real exit/restart.
  process.emit("exit", 0);
  if (mode === "ordinary") {
    assert.deepEqual(calls, { inventorySubprocesses: 2, updaterInstallSubprocesses: 1, versionProbes: 1, automaticRestarts: 1 });
    assert.equal(context.shutdownCalls, 1);
  } else if (mode === "missing-helper") {
    assert.deepEqual(calls, { inventorySubprocesses: 1, updaterInstallSubprocesses: 0, versionProbes: 0, automaticRestarts: 0 });
    assert.ok(context.ui.notifications.some(([message]) => message.includes("Could not inspect installed packages")));
  } else {
    assert.deepEqual(calls, { inventorySubprocesses: 0, updaterInstallSubprocesses: 0, versionProbes: 0, automaticRestarts: 0 });
    assert.equal(context.shutdownCalls, 0);
  }
  assert.equal(context.ui.widgets.get("proper-updater"), undefined, "UI cleanup is separate evidence");
  assert.equal(context.ui.terminalInputHandlers.size, 0);
  assert.equal(existsSync(join(agentDir, "proper-updater.lock")), false);
  process.stdout.write(JSON.stringify({ mode, ...calls }) + "\n");
} finally {
  childProcess.spawn = actualSpawn;
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
