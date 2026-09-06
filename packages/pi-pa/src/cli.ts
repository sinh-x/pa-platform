#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoreCommand } from "@pa-platform/pa-core";
import { createDefaultPiHooks } from "./deploy.js";
import { removePi, setupPi, statusPi } from "./setup.js";
import { PiAdapter } from "./adapter.js";
import { probePiNativeRegistryAddon, runPiManagedToolSmoke } from "./native-host.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };
  process.stdout.write(`ppa ${pkg.version}\n`);
  process.exit(0);
}
if (process.argv[2] === "pi" && ["setup", "status", "remove", "preflight", "smoke-tools", "teardown-smoke"].includes(process.argv[3] ?? "")) {
  const local = process.argv.includes("--local");
  const action = process.argv[3];
  process.exitCode = await (action === "setup"
    ? setupPi({ local }).then((result) => { process.stdout.write(`${result.changed ? "Configured" : "Already configured"}: ${result.settingsPath}\nPackages:\n${result.packages.join("\n")}\nReload active Pi sessions with /reload.\n`); })
    : action === "status"
      ? Promise.resolve(statusPi({ local })).then((result) => { process.stdout.write(`Settings: ${result.settingsPath}\nExtension source: ${result.extensionPath}\nConfig source: ${result.configDir}\nConfigured: ${result.configured ? "yes" : "no"}\nPackages:\n${result.packages.length > 0 ? result.packages.join("\n") : "(none)"}\nReload active Pi sessions with /reload.\n`); })
      : action === "preflight"
        ? new PiAdapter().preflight().then(() => { process.stdout.write(`${JSON.stringify(probePiNativeRegistryAddon())}\n`); })
        : action === "smoke-tools"
          ? Promise.resolve(runPiManagedToolSmoke()).then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); })
          : action === "teardown-smoke"
            ? new PiAdapter().preflight().then(() => { runTeardownSmoke(process.argv.slice(4)); })
            : removePi({ local }).then((result) => { process.stdout.write(`${result.changed ? "Removed" : "Nothing removed"}: ${result.settingsPath}\n`); })
  ).then(() => 0).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; });
} else {
process.exitCode = await runCoreCommand(process.argv.slice(2), { hooks: createDefaultPiHooks(), binaryName: "ppa" });
}

function runTeardownSmoke(args: string[]): void {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/pap-167-pi-retry-smoke.mjs");
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, PAP167_PPA_INVOKED: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Installed Pi teardown smoke terminated with signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Installed Pi teardown smoke exited with status ${result.status ?? 1}.`);
}
