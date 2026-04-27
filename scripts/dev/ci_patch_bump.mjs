#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const VERSION_FILES = [
  "package.json",
  "packages/pa-core/package.json",
  "packages/opencode-pa/package.json",
];

const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
if (args.has("--help") || args.has("-h")) {
  process.stdout.write(`Usage: node scripts/dev/ci_patch_bump.mjs [--dry-run]\n\nIncrements the patch version by exactly one in:\n${VERSION_FILES.map((file) => `  - ${file}`).join("\n")}\n\nOptions:\n  --dry-run  Print the planned bump without writing files\n`);
  process.exit(0);
}

for (const arg of args) {
  if (arg !== "--dry-run") {
    process.stderr.write(`Unknown option: ${arg}\nUsage: node scripts/dev/ci_patch_bump.mjs [--dry-run]\n`);
    process.exit(1);
  }
}

const packages = VERSION_FILES.map((file) => {
  const text = readFileSync(file, "utf8");
  return { file, text, json: JSON.parse(text) };
});

const versions = new Set(packages.map(({ json }) => json.version));
if (versions.size !== 1) {
  process.stderr.write(`Version files are out of sync:\n${packages.map(({ file, json }) => `  ${file}: ${json.version}`).join("\n")}\n`);
  process.exit(1);
}

const current = packages[0].json.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) {
  process.stderr.write(`Unsupported version format: ${current}\nExpected X.Y.Z\n`);
  process.exit(1);
}

const [, major, minor, patch] = match;
const next = `${major}.${minor}.${Number(patch) + 1}`;
const dryRun = args.has("--dry-run");

for (const pkg of packages) {
  pkg.json.version = next;
  const nextText = `${JSON.stringify(pkg.json, null, 2)}\n`;
  if (!dryRun) {
    writeFileSync(pkg.file, nextText);
  }
}

process.stdout.write(`${dryRun ? "Would bump" : "Bumped"} ${current} -> ${next}\n`);
for (const file of VERSION_FILES) {
  process.stdout.write(`  ${file}\n`);
}
