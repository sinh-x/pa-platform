#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoreCommand, type CoreExecutionHooks } from "@pa-platform/pa-core";

// TODO(PAP-051 Phase 2): replace this stub with deploy hooks that wire
// ClaudeCodeAdapter into runCoreCommand (parallel to createDefaultOpencodeHooks).
function createDefaultClaudeHooks(): CoreExecutionHooks {
  return {};
}

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
  process.stdout.write(`cpa ${pkg.version}\n`);
  process.exit(0);
}

const code = await runCoreCommand(process.argv.slice(2), { hooks: createDefaultClaudeHooks(), binaryName: "cpa" });
process.exitCode = code;
