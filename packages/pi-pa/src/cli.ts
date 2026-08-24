#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoreCommand, type CoreExecutionHooks } from "@pa-platform/pa-core";
import { composePpaExecutionHooks } from "./deploy.js";

interface OpencodeRuntimeModule { createDefaultOpencodeHooks: () => CoreExecutionHooks }

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };
  process.stdout.write(`ppa ${pkg.version}\n`);
  process.exit(0);
}
const opencode = await import("@pa-platform/opencode-pa" as string) as OpencodeRuntimeModule;
process.exitCode = await runCoreCommand(process.argv.slice(2), { hooks: composePpaExecutionHooks(opencode.createDefaultOpencodeHooks()), binaryName: "ppa" });
