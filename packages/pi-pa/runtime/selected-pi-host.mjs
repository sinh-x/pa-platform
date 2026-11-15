// Fixed production host. selection.mjs is generated into this same immutable
// build; no runtime root, callback, grant, environment or alternate host input.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { selection } from "./selection.mjs";

const bindingCauses = new WeakMap();
const requireFact = (value, cause = "BINDING") => {
  if (!value) {
    const error = new Error("selected host binding unavailable");
    bindingCauses.set(error, cause); throw error;
  }
};
const same = (a, b, directory) => (directory
  ? ["dev", "ino", "uid", "gid", "mode"]
  : ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
  .every(key => a[key] === b[key]);
function incarnation(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ");
  requireFact(/^\d+$/.test(fields[19] ?? "") && /^\d+$/.test(fields[1] ?? ""));
  return { parent: Number(fields[1]), birth: fields[19] };
}

async function run() {
  const pins = [], owners = new Set(), lifecycles = new Set();
  let active = false;
  const release = () => {
    active = false;
    let failed = false;
    for (const owner of owners) { try { owner.revoke(); } catch { failed = true; } }
    owners.clear();
    for (const pin of pins.splice(0).reverse()) { try { fs.closeSync(pin.fd); } catch { failed = true; } }
    requireFact(!failed, "PIN_CLEANUP");
  };
  const onExit = () => { try { release(); } catch { /* no unpublished content survives process exit */ } };
  try {
    requireFact(process.platform === "linux" && process.execArgv.length === 0);
    requireFact(process.argv[1] === selection.bootstrapFile && import.meta.url === pathToFileURL(selection.bootstrapFile).href);
    requireFact(process.versions.node === selection.nodeVersion && !process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR);
    requireFact(process.env.PA_SQLITE_NATIVE_BINDING === selection.addonFile && process.env.PA_PI_SQLITE_NATIVE_BINDING === selection.addonFile);
    const own = incarnation("self"), pid = process.pid, parent = own.parent, parentBirth = incarnation(parent).birth;
    requireFact(parent > 1);
    const node = fs.realpathSync(selection.nodeFile);
    const pin = (path, directory = false) => {
      requireFact(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/|$)/.test(path));
      const root = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const first = { fd: root, path: "/", directory: true, before: undefined };
      pins.push(first); first.before = fs.fstatSync(root, { bigint: true });
      requireFact(first.before.isDirectory() && first.before.uid === 0n && (first.before.mode & 0o022n) === 0n);
      let previous = root, current = "";
      const parts = path.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index++) {
        const isDirectory = index < parts.length - 1 || directory;
        const fd = fs.openSync(`/proc/self/fd/${previous}/${parts[index]}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (isDirectory ? fs.constants.O_DIRECTORY : 0));
        const entry = { fd, path: current += `/${parts[index]}`, directory: isDirectory, before: undefined };
        pins.push(entry); entry.before = fs.fstatSync(fd, { bigint: true });
        requireFact(entry.before.uid === 0n && entry.before.nlink > 0n && (isDirectory ? entry.before.isDirectory() : entry.before.isFile()));
        if (entry.path === "/nix/store") requireFact((entry.before.mode & 0o022n) === 0n || (entry.before.mode & 0o1000n) !== 0n && (entry.before.mode & 0o002n) === 0n);
        else requireFact((entry.before.mode & (index >= 2 ? 0o222n : 0o022n)) === 0n);
        previous = fd;
      }
    };
    for (const path of [selection.bootstrapFile, selection.selectionFile, selection.entryFile, selection.hostModule,
      selection.extensionModule, selection.sourceModule, selection.publicationModule, selection.addonFile, node]) pin(path);
    pin(selection.packageRoot, true);
    const assertStable = () => {
      const now = incarnation("self");
      requireFact(pid === process.pid && now.birth === own.birth && now.parent === parent && incarnation(parent).birth === parentBirth, "PROCESS_INCARNATION");
      requireFact(fs.realpathSync(`/proc/${parent}/exe`) === selection.entryFile && fs.statSync(`/proc/${parent}`).uid === process.getuid(), "NATIVE_PARENT");
      const command = fs.readFileSync(`/proc/${parent}/cmdline`).toString("utf8").split("\0").filter(Boolean);
      requireFact(command[0] === selection.entryFile, "NATIVE_ARGUMENTS");
      const forwarded = command[1] === "--pa-managed-child" ? command.slice(2) : command.slice(1);
      const child = fs.readFileSync("/proc/self/cmdline").toString("utf8").split("\0").filter(Boolean);
      requireFact(JSON.stringify(child) === JSON.stringify([selection.nodeFile, selection.bootstrapFile, ...forwarded]), "RUNTIME_ARGUMENTS");
      requireFact(fs.realpathSync("/proc/self/exe") === node && !process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR, "RUNTIME_EXECUTABLE");
      for (const entry of pins) requireFact(same(entry.before, fs.fstatSync(entry.fd, { bigint: true }), entry.directory)
        && same(entry.before, fs.lstatSync(entry.path, { bigint: true }), entry.directory)
        && fs.realpathSync(`/proc/self/fd/${entry.fd}`) === entry.path, "IMMUTABLE_CODE");
    };
    assertStable();
    const host = await import(pathToFileURL(selection.hostModule).href);
    requireFact(host.VERSION === selection.piVersion && host.PA_READ_PUBLICATION_VERSION === "pa-read-publication/v1"
      && typeof host.main === "function" && typeof host.createReadToolDefinition === "function"
      && fs.realpathSync(host.getPackageDir()) === selection.packageRoot);
    const args = process.argv.slice(2);
    const probe = args.length === 1 && ["--version", "--help"].includes(args[0]);
    const launchArgs = [];
    let extensionCount = 0;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--extension" || args[index] === "-e") {
        requireFact(args[++index] === selection.extensionModule && ++extensionCount === 1);
      } else launchArgs.push(args[index]);
    }
    requireFact(probe || extensionCount === 1 && args.filter(arg => arg === "--no-extensions").length === 1);
    active = true; process.once("exit", onExit);
    const binding = Object.freeze({ packageRoot: selection.packageRoot, assertStable() {
      requireFact(active, "LIFETIME"); assertStable();
      requireFact(fs.realpathSync(host.getPackageDir()) === selection.packageRoot, "EXECUTING_PACKAGE");
    } });
    process.env.AI_AGENT = "pi"; process.env.PI_CODING_AGENT = "true";
    if (selection.piToolsPath) process.env.PATH = `${selection.piToolsPath}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
    if (probe) { await host.main(launchArgs); return; }
    const extension = await import(pathToFileURL(selection.extensionModule).href);
    const source = await import(pathToFileURL(selection.sourceModule).href);
    const publication = await import(pathToFileURL(selection.publicationModule).href);
    const inScope = path => path === `${selection.packageRoot}/README.md` || path.startsWith(`${selection.packageRoot}/docs/`) || path.startsWith(`${selection.packageRoot}/examples/`);
    let factoryFailure;
    const factory = pi => {
      try {
        binding.assertStable();
        const lifecycle = extension.createPiSessionLifecycle(); lifecycles.add(lifecycle);
        const owner = new publication.ReadPublicationOwner(); owners.add(owner);
        lifecycle.addShutdownStep(() => owner.revoke());
        const read = owner.createTool(host.createReadToolDefinition, (path, patterns, signal) => {
          binding.assertStable();
          return inScope(path) ? source.acquireSelectedPiDocument(path, binding, patterns, signal) : source.acquireLocalSourceFile(path, patterns, signal);
        });
        extension.registerPiSessionModules(pi, lifecycle, extension.PI_PA_MODULES, read);
      } catch (error) { factoryFailure = error; throw error; }
    };
    const publish = event => publication.publishReadEvent(owners, event, binding.assertStable);
    // The exact imported public main owns setup, dispatch, all session runtimes
    // and UI modes. Its build-patched synchronous sink calls this private owner
    // after awaited transforms and before output/persistence, never via JSON.
    binding.assertStable();
    try { await host.main(launchArgs, { extensionFactories: [factory], paReadPublication: publish }); }
    catch (error) { throw factoryFailure ?? error; }
  } finally {
    active = false;
    let cleanupFailed = false;
    for (const lifecycle of lifecycles) { try { await lifecycle.shutdown({ reason: "exit" }); } catch { cleanupFailed = true; } }
    lifecycles.clear();
    try { release(); } catch { cleanupFailed = true; }
    process.removeListener("exit", onExit);
    requireFact(!cleanupFailed, "LIFECYCLE_CLEANUP");
  }
}

try { await run(); }
catch (error) {
  const cause = bindingCauses.get(error) ?? "RUNTIME_SETUP";
  process.stderr.write(`Pi runtime unavailable through the selected host.\nCondition: The selected runtime could not complete startup or execution.\nSource: Fixed native Pi host binding (SELECTED_HOST_BINDING).\nReason: Current process, immutable build, host API, reader registration or lifetime evidence was unavailable or inconsistent (${cause}).\nCorrection: Ask the runtime owner to inspect this existing launch and selected build. Impact: none. Actor: agent or operator. New approval: not required to ask. Prerequisite: preserve the original deployment and process evidence; do not copy denied content.\nResume Action: Retry only after the owner corrects the actual binding. Reconcile any existing operation before requesting another launch.\n`);
  process.exitCode = 1;
}
