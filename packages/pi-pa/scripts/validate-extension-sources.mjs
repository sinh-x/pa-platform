#!/usr/bin/env node
import { resolve } from "node:path";
import { PACKAGE_ROOT, readSourceLock, sourceContentSha256, validateExtensionSources } from "./extension-sources.mjs";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--package-root");
const packageRoot = rootIndex === -1 ? PACKAGE_ROOT : resolve(args[rootIndex + 1] ?? "");

try {
  if (args.includes("--print-digests")) {
    const lock = readSourceLock(packageRoot);
    for (const source of lock.sources) {
      console.log(`${source.name} ${sourceContentSha256(resolve(packageRoot, source.sourcePath))}`);
    }
  } else {
    const lock = validateExtensionSources({ packageRoot });
    for (const source of lock.sources) console.log(`[pi-pa] verified ${source.name} at ${source.commit}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[pi-pa] extension source validation failed: ${message}`);
  process.exitCode = 1;
}
