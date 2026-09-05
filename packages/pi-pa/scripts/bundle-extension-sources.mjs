#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, version as esbuildVersion } from "esbuild";
import { PACKAGE_ROOT, validateExtensionSources } from "./extension-sources.mjs";

export const EXTERNAL_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "sharp",
  "typebox",
];

const outputRoot = resolve(PACKAGE_ROOT, "dist/pi-extension/vendor");
const lock = validateExtensionSources();
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const source of lock.sources) {
  await build({
    entryPoints: [resolve(PACKAGE_ROOT, source.entrypoint)],
    outfile: resolve(outputRoot, source.bundle),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    sourcesContent: true,
    external: EXTERNAL_PACKAGES,
    logLevel: "warning",
  });
}

const provenance = {
  schemaVersion: 1,
  buildTool: { name: "esbuild", version: esbuildVersion },
  externalPackages: EXTERNAL_PACKAGES,
  sources: lock.sources.map(({ name, repository, commit, entrypoint, contentSha256, bundle }) => ({
    name,
    repository,
    commit,
    entrypoint,
    contentSha256,
    bundle,
  })),
};
await writeFile(resolve(outputRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
for (const source of lock.sources) console.log(`[pi-pa] bundled ${source.name} -> dist/pi-extension/vendor/${source.bundle}`);
