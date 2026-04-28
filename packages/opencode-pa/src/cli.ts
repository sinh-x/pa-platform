#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoreCommand } from "@pa-platform/pa-core";
import { createOpencodeHooks } from "./deploy.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
  process.stdout.write(`opa ${pkg.version}\n`);
  process.exit(0);
}

const code = await runCoreCommand(process.argv.slice(2), { hooks: createOpencodeHooks(), binaryName: "opa" });
process.exitCode = code;
