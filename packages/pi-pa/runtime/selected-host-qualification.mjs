// PAP-298 qualification-only native producer. Not a deployment launcher or a
// source-read service. selection.mjs is emitted by the fixed Nix derivation;
// no environment, argv, JSON, callback or exported setter can choose its root.
import fs from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selection } from "./selection.mjs";

let started = false;
const denied = (stage = "startup") => new Error(`Selected-host qualification did not complete.\nCondition: No selected-host read eligibility was granted.\nSource: Fixed bootstrap qualification boundary (SELECTED_HOST_QUALIFICATION).\nReason: The startup, immutable selection or native host contract was not established during ${stage}.\nCorrection: Ask the runtime owner to inspect this exact qualification candidate. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: retain this result and keep hard-link support disabled.\nResume Action: Repeat qualification only after the owner resolves the contract mismatch. All checks run again; this is not installation or permission to read denied files.`);
const requireFact = fact => { if (!fact) throw denied(); };
const stat = fd => fs.fstatSync(fd, { bigint: true });
const same = (a, b) => ["dev", "ino", "size", "uid", "gid", "mode", "nlink", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
function birth() {
  const raw = fs.readFileSync("/proc/self/stat", "utf8");
  const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
  requireFact(/^\d+$/.test(fields[19] ?? ""));
  return fields[19];
}

/** A fixed offline help operation only. There is intentionally no generic args,
 * extension factory, grant handle or document-acquisition parameter/export. */
export async function runQualification() {
  const owned = [];
  let active = false, exited = false, stage = "startup";
  const release = () => {
    active = false;
    if (exited) return;
    exited = true;
    let failed = false;
    for (let index = owned.length - 1; index >= 0; index--) {
      try { fs.closeSync(owned[index].fd); } catch { failed = true; }
    }
    if (failed) throw denied("descriptor cleanup");
  };
  const onExit = () => { try { release(); } catch { /* process death cannot grant eligibility */ } };
  try {
    requireFact(!started);
    started = true;
    requireFact(process.platform === "linux" && process.argv.length === 2 && process.execArgv.length === 0);
    requireFact(!process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR);
    requireFact(import.meta.url === pathToFileURL(selection.bootstrapFile).href && process.argv[1] === selection.bootstrapFile);
    stage = "native process verification";
    const command = fs.readFileSync("/proc/self/cmdline").toString("utf8").split("\0").filter(Boolean);
    requireFact(command.length === 2 && command[1] === selection.bootstrapFile);
    requireFact(process.versions.node === selection.nodeVersion);
    const node = fs.realpathSync(selection.nodeFile);
    requireFact(fs.realpathSync(process.execPath) === node && fs.realpathSync("/proc/self/exe") === node);
    const processBirth = birth(), pid = process.pid;
    const pin = (path, directory) => {
      requireFact(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/|$)/.test(path));
      const parts = path.split("/").filter(Boolean);
      let parent, current = "";
      for (let index = 0; index < parts.length; index++) {
        const isDirectory = index < parts.length - 1 || directory;
        const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (isDirectory ? fs.constants.O_DIRECTORY : 0);
        const fd = fs.openSync(parent === undefined ? `/${parts[index]}` : `/proc/self/fd/${parent}/${parts[index]}`, flags);
        const entry = { fd, path: current += `/${parts[index]}`, before: undefined, directory: isDirectory };
        owned.push(entry); // own the fd even if its first observation fails
        entry.before = stat(fd);
        requireFact(entry.before.uid === 0n && entry.before.nlink > 0n);
        requireFact(isDirectory ? entry.before.isDirectory() : entry.before.isFile());
        // The exact /nix/store boundary is root-owned, with no group/other write
        // or sticky/no-other-write semantics. Immutable objects below it have
        // no write bits at all; this is not a generic source-file exception.
        if (entry.path === "/nix/store") requireFact((entry.before.mode & 0o022n) === 0n || (entry.before.mode & 0o1000n) !== 0n && (entry.before.mode & 0o002n) === 0n);
        else if (index >= 2) requireFact((entry.before.mode & 0o222n) === 0n);
        else requireFact((entry.before.mode & 0o022n) === 0n);
        parent = fd;
      }
    };
    stage = "immutable path verification";
    pin(selection.bootstrapFile, false);
    pin(selection.selectionFile, false);
    pin(selection.packageRoot, true);
    pin(selection.hostModule, false);
    pin(node, false);
    const assertStable = () => {
      requireFact(!exited && pid === process.pid && processBirth === birth());
      requireFact(!process.env.NODE_OPTIONS && !process.env.PI_PACKAGE_DIR);
      for (const entry of owned) {
        const now = stat(entry.fd), live = fs.lstatSync(entry.path, { bigint: true });
        const stable = observed => entry.directory
          ? observed.isDirectory() && ["dev", "ino", "uid", "gid", "mode"].every(key => entry.before[key] === observed[key])
          : same(entry.before, observed);
        requireFact(stable(now) && stable(live));
        requireFact(fs.realpathSync(`/proc/self/fd/${entry.fd}`) === entry.path);
      }
    };
    assertStable();
    // Native import of the selected bundle/index, then the actual public main.
    // The normal CLI wrapper does not await main, so importing that wrapper is
    // deliberately NOT used as the lifetime boundary.
    stage = "selected host import";
    const host = await import(pathToFileURL(selection.hostModule).href);
    stage = "selected host association";
    requireFact(typeof host.main === "function" && host.VERSION === selection.piVersion);
    requireFact(fs.realpathSync(host.getPackageDir()) === selection.packageRoot);
    assertStable();
    active = true;
    process.once("exit", onExit);
    const factory = pi => {
      stage = "native inline factory";
      requireFact(active);
      assertStable();
      requireFact(fs.realpathSync(host.getPackageDir()) === selection.packageRoot);
      pi.on("session_shutdown", () => { active = false; });
      // A native closure observation from the actual host's inline loader. This
      // finite record is qualification evidence only, never a capability/grant.
      process.stdout.write(`${JSON.stringify({ schema: "pa-selected-pi-qualification/v1", stage: "native-inline-factory", pi: host.VERSION, node: process.versions.node, closureCustody: true, readExceptionEnabled: false })}\n`);
    };
    stage = "selected main execution";
    await host.main(["--offline", "--help", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes"], { extensionFactories: [factory] });
    assertStable();
  } catch { throw denied(stage); }
  finally {
    process.removeListener("exit", onExit);
    release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await runQualification(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
