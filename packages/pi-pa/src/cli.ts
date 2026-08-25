#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoreCommand } from "@pa-platform/pa-core";
import { createDefaultPiHooks } from "./deploy.js";
import { setupPi } from "./setup.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };
  process.stdout.write(`ppa ${pkg.version}\n`);
  process.exit(0);
}
if (process.argv[2] === "pi" && process.argv[3] === "setup") {
  process.exitCode = await setupPi({ local: process.argv.includes("--local") }).then((result) => { process.stdout.write(`${result.changed ? "Configured" : "Already configured"}: ${result.settingsPath}\n`); return 0; }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; });
} else {
process.exitCode = await runCoreCommand(process.argv.slice(2), { hooks: createDefaultPiHooks(), binaryName: "ppa" });
}
