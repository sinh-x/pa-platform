import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Test transport only; this does not emulate or prove Bubblewrap isolation. */
export function installFakeBubblewrap(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const chdir = args.lastIndexOf("--chdir", separator);
if (separator < 0 || chdir < 0 || !args[chdir + 1] || !args[separator + 1]) process.exit(125);
const result = spawnSync(args[separator + 1], args.slice(separator + 2), {
  cwd: args[chdir + 1],
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(result.error.message + "\\n");
  process.exit(127);
}
process.exit(result.status ?? 1);
`, "utf8");
  chmodSync(join(bin, "bwrap"), 0o755);
  return bin;
}
