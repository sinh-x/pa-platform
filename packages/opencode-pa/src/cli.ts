#!/usr/bin/env node
import { runCoreCommand } from "@pa-platform/pa-core";
import { createOpencodeHooks } from "./deploy.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write("opa 0.1.0\n");
  process.exit(0);
}

const code = await runCoreCommand(process.argv.slice(2), { hooks: createOpencodeHooks(), binaryName: "opa" });
process.exitCode = code;
