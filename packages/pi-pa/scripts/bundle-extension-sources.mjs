#!/usr/bin/env node
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, version as esbuildVersion } from "esbuild";
import { PACKAGE_ROOT, readPluginSelection, selectedExtensionSources, validateExtensionSources } from "./extension-sources.mjs";

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
const pluginSelection = readPluginSelection(lock);
const selectedSources = selectedExtensionSources(lock, pluginSelection);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "licenses"), { recursive: true });

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
  await copyFile(resolve(PACKAGE_ROOT, source.licensePath), resolve(outputRoot, "licenses", `${source.name}-LICENSE.txt`));
}

const provenance = {
  schemaVersion: 1,
  buildTool: { name: "esbuild", version: esbuildVersion },
  externalPackages: EXTERNAL_PACKAGES,
  pluginSelection,
  selectedSources: selectedSources.map(({ name }) => name),
  sources: lock.sources.map(({ name, version, repository, commit, entrypoint, contentSha256, license, licensePath, licenseSha256, bundle }) => ({
    name,
    version,
    repository,
    commit,
    entrypoint,
    contentSha256,
    license,
    licensePath,
    licenseSha256,
    packagedLicense: `licenses/${name}-LICENSE.txt`,
    bundle,
  })),
};
await writeFile(resolve(outputRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
for (const source of lock.sources) console.log(`[pi-pa] bundled ${source.name} -> dist/pi-extension/vendor/${source.bundle}`);
