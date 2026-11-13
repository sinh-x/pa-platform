// NON-DEFAULT, fixed-operation inert qualification. No argument/root/record,
// callback setter, public grant or normal agent launch API is exported.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { selection } from "./selection.mjs";
import { acquireLocalSourceFile, acquireSelectedPiDocument, SourceContentSecurityError } from "./local-source-core.ts";
import { bindLocalReadTool } from "../src/pi-extension/bound-local-read.ts";
import { filterLocalToolResult, localContentFailure } from "../src/pi-extension/local-content-security.ts";

const fail = () => { throw new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE"); };
const requireFact = value => { if (!value) fail(); };
const same = (a, b, directory = false) => (directory
  ? ["dev", "ino", "uid", "gid", "mode"] : ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
  .every(key => a[key] === b[key]);
function incarnation(pid) {
  const body = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = body.slice(body.lastIndexOf(") ") + 2).split(" ");
  requireFact(/^\d+$/.test(fields[19] ?? "") && /^\d+$/.test(fields[1] ?? ""));
  return { parent: Number(fields[1]), birth: fields[19] };
}

let phase = "startup";
async function qualify() {
  const pins = [], leases = new Set(), results = new WeakMap();
  const lifetime = new AbortController();
  let active = false, host;
  const release = () => {
    active = false; lifetime.abort();
    let failed = false;
    for (const source of leases) { try { source.close(); } catch { failed = true; } }
    leases.clear();
    for (const pin of pins.splice(0).reverse()) { try { fs.closeSync(pin.fd); } catch { failed = true; } }
    if (failed) fail();
  };
  const onExit = () => { try { release(); } catch { /* no success on process death */ } };
  try {
    requireFact(process.platform === "linux" && process.argv.length === 2 && process.execArgv.length === 0);
    requireFact(process.argv[1] === selection.bootstrapFile && import.meta.url === pathToFileURL(selection.bootstrapFile).href);
    requireFact(process.versions.node === selection.nodeVersion && !process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR);
    const allowedEnvironment = new Set(["HOME", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME", "TMPDIR", "NO_COLOR", "TERM"]);
    requireFact(Object.keys(process.env).every(key => allowedEnvironment.has(key)));
    const own = incarnation("self"), pid = process.pid, parent = own.parent, parentBirth = incarnation(parent).birth;
    requireFact(parent > 1);
    const node = fs.realpathSync(selection.nodeFile);
    const pin = (path, directory = false) => {
      requireFact(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/|$)/.test(path));
      const rootFd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const rootEntry = { fd: rootFd, path: "/", directory: true, before: undefined };
      pins.push(rootEntry);
      rootEntry.before = fs.fstatSync(rootFd, { bigint: true });
      requireFact(rootEntry.before.isDirectory() && rootEntry.before.uid === 0n && (rootEntry.before.mode & 0o022n) === 0n);
      let previous = rootFd, current = "";
      const parts = path.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index++) {
        const isDirectory = index < parts.length - 1 || directory;
        const fd = fs.openSync(`/proc/self/fd/${previous}/${parts[index]}`,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (isDirectory ? fs.constants.O_DIRECTORY : 0));
        const entry = { fd, path: current += `/${parts[index]}`, directory: isDirectory, before: undefined };
        pins.push(entry);
        entry.before = fs.fstatSync(fd, { bigint: true });
        requireFact(entry.before.uid === 0n && entry.before.nlink > 0n && (isDirectory ? entry.before.isDirectory() : entry.before.isFile()));
        if (entry.path === "/nix/store") requireFact((entry.before.mode & 0o022n) === 0n || (entry.before.mode & 0o1000n) !== 0n && (entry.before.mode & 0o002n) === 0n);
        else requireFact((entry.before.mode & (index >= 2 ? 0o222n : 0o022n)) === 0n);
        previous = fd;
      }
    };
    phase = "immutable selection pins";
    for (const path of [selection.bootstrapFile, selection.selectionFile, selection.entryFile, selection.hostModule, node]) pin(path);
    pin(selection.packageRoot, true);
    const assertProcessAndPins = () => {
      const now = incarnation("self");
      requireFact(pid === process.pid && now.birth === own.birth && now.parent === parent && incarnation(parent).birth === parentBirth);
      requireFact(fs.realpathSync(`/proc/${parent}/exe`) === selection.entryFile);
      requireFact(fs.statSync(`/proc/${parent}`).uid === process.getuid());
      const command = fs.readFileSync(`/proc/${parent}/cmdline`).toString("utf8").split("\0").filter(Boolean);
      requireFact(command.length === 1 && command[0] === selection.entryFile);
      const childCommand = fs.readFileSync("/proc/self/cmdline").toString("utf8").split("\0").filter(Boolean);
      requireFact(childCommand.length === 2 && childCommand[0] === selection.nodeFile && childCommand[1] === selection.bootstrapFile);
      requireFact(fs.realpathSync("/proc/self/exe") === node && !process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR);
      for (const entry of pins) {
        requireFact(same(entry.before, fs.fstatSync(entry.fd, { bigint: true }), entry.directory)
          && same(entry.before, fs.lstatSync(entry.path, { bigint: true }), entry.directory)
          && fs.realpathSync(`/proc/self/fd/${entry.fd}`) === entry.path);
      }
    };
    phase = "native parent custody";
    assertProcessAndPins();
    // This producer imports AND invokes the selected actual host. No alleged
    // runner callback/peer dependency/environment is accepted as that association.
    phase = "actual selected host API";
    host = await import(pathToFileURL(selection.hostModule).href);
    requireFact(host.VERSION === selection.piVersion && typeof host.main === "function" && typeof host.createReadToolDefinition === "function");
    requireFact(fs.realpathSync(host.getPackageDir()) === selection.packageRoot);
    assertProcessAndPins();
    active = true;
    process.once("exit", onExit);
    const binding = Object.freeze({ packageRoot: selection.packageRoot, assertStable() {
      requireFact(active && !lifetime.signal.aborted);
      assertProcessAndPins();
      requireFact(fs.realpathSync(host.getPackageDir()) === selection.packageRoot);
    } });
    const selectedScope = path => path === `${selection.packageRoot}/README.md`
      || path.startsWith(`${selection.packageRoot}/docs/`) || path.startsWith(`${selection.packageRoot}/examples/`);
    let factories = 0;
    const factory = async pi => {
      phase = "actual inline reader registration";
      binding.assertStable(); requireFact(++factories === 1);
      pi.on("session_shutdown", () => { active = false; lifetime.abort(); });
      const definition = bindLocalReadTool(host.createReadToolDefinition, acquireLocalSourceFile);
      const registered = { ...definition, async execute(id, input, signal, update, context) {
        binding.assertStable();
        const owned = [], combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
        const reader = bindLocalReadTool(host.createReadToolDefinition, (path, patterns, acquisitionSignal) => {
          binding.assertStable();
          const source = selectedScope(path) ? acquireSelectedPiDocument(path, binding, patterns, acquisitionSignal)
            : acquireLocalSourceFile(path, patterns, acquisitionSignal);
          owned.push(source); leases.add(source);
          // Ownership transfers to this fixed native publisher. Keep pins across
          // ALL tool promise hops, not just inner formatting. No raw bytes escape.
          return { bytes: source.bytes, assertStable: source.assertStable, close() {} };
        });
        const result = await reader.execute(id, input, combined, update, context);
        results.set(result, { owned, signal: combined });
        return result;
      } };
      pi.registerTool(registered);
      // The qualification owns its actual byte-emission boundary, not an inner
      // promise commitment. Production Pi/PPA transport is NOT wired by this test.
      const publish = (name, result) => {
        const pending = results.get(result);
        requireFact(pending); results.delete(result);
        let failed = false;
        try { binding.assertStable(); for (const source of pending.owned) source.assertStable(); }
        catch { failed = true; }
        for (const source of pending.owned) { try { source.close(); } catch { failed = true; } leases.delete(source); }
        if (pending.signal.aborted) failed = true;
        const checked = failed ? localContentFailure(new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE")) : filterLocalToolResult("read", result);
        binding.assertStable();
        // No await/post-fence wrapper between the last lifetime check and the
        // fixed native sink. A later observer cannot retroactively revoke bytes.
        process.stdout.write(`${JSON.stringify({ schema: "pa-selected-document-qualification/v1", name, result: checked })}\n`);
        return checked;
      };
      const context = { cwd: process.cwd() };
      const read = async (name, path, extra = {}, signal) => {
        phase = name;
        return publish(name, await registered.execute(name, { path, ...extra }, signal, undefined, context));
      };
      const text = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const root = selection.packageRoot;
      requireFact(fs.statSync(`${root}/README.md`).nlink > 1);
      let result = await read("selected-readme", `${root}/README.md`);
      requireFact(!result.isError && text(result).includes("PAP-298 inert selected documentation"));
      result = await read("selected-docs-redaction", `${root}/docs/PAP-298-note.txt`, { offset: 3, limit: 1 });
      requireFact(!result.isError && !JSON.stringify(result).includes("INERT_DOCUMENT_CANARY") && text(result).includes("REDACTED"));
      result = await read("selected-example", `${root}/examples/PAP-298-example.ts`);
      requireFact(!result.isError && text(result).includes("inert selected example"));
      for (const [name, path, expected] of [
        ["outside-scope", `${root}/PAP-298-outside.txt`, "LOCAL_SOURCE_UNSUPPORTED_FILE"],
        ["hardlinked-image", `${root}/docs/PAP-298-image.gif`, "LOCAL_SOURCE_UNSUPPORTED_FILE"],
        ["invalid-utf8", `${root}/docs/PAP-298-invalid.txt`, "LOCAL_SOURCE_UNSUPPORTED_FILE"],
        ["symlink-route", `${root}/docs/PAP-298-symlink.md`, "LOCAL_SOURCE_UNSUPPORTED_FILE"],
        ["protected-name", `${root}/docs/.env`, "LOCAL_SOURCE_BLOCKED"],
      ]) {
        result = await read(name, path);
        requireFact(result.isError && result.details.code === expected && result.details.outputWithheld === true);
      }
      const directory = fs.mkdtempSync(join(process.env.TMPDIR, "inert-mutable-")), mutable = join(directory, "note.txt");
      fs.writeFileSync(mutable, "inert mutable alias body"); fs.linkSync(mutable, join(directory, "alias.txt"));
      result = await read("mutable-hardlink", mutable);
      requireFact(result.isError && result.details.code === "LOCAL_SOURCE_UNSUPPORTED_FILE");
      const caller = new AbortController();
      const pending = registered.execute("revoked-before-native-sink", { path: `${root}/README.md` }, caller.signal, undefined, context);
      const ready = await pending;
      caller.abort();
      result = publish("revoked-before-native-sink", ready);
      requireFact(result.isError && result.details.code === "LOCAL_SOURCE_UNAVAILABLE");
      requireFact(leases.size === 0);
      process.stdout.write(`${JSON.stringify({ schema: "pa-selected-document-qualification-summary/v1", cases: 10, registeredReader: true, productionEnabled: false })}\n`);
    };
    phase = "actual selected main";
    await host.main(["--offline", "--help", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes"], { extensionFactories: [factory] });
    requireFact(factories === 1);
  } finally {
    process.removeListener("exit", onExit);
    release();
  }
}
try { await qualify(); }
catch { process.stderr.write(`${new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE").message.replace("Reason: ", `Reason: Fixed document qualification did not complete during ${phase}. `)}\n`); process.exitCode = 1; }
