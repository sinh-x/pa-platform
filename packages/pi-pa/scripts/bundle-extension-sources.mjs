#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export async function bundleExtensionSources({
  packageRoot = PACKAGE_ROOT,
  outputRoot = resolve(packageRoot, "dist"),
  environment = process.env,
  generatedSourcePath,
} = {}) {
  const defaultOutputRoot = resolve(packageRoot, "dist");
  const sourcePath = generatedSourcePath === undefined && outputRoot === defaultOutputRoot
    ? resolve(packageRoot, "src/pi-extension/bundled-editor-factories.ts")
    : generatedSourcePath;
  const lock = validateExtensionSources({ packageRoot });
  const pluginSelection = readPluginSelection(lock, { environment });
  const selectedSources = selectedExtensionSources(lock, pluginSelection);
  const vendorRoot = resolve(outputRoot, "pi-extension/vendor");
  const sourceVendorRoot = typeof sourcePath === "string" ? resolve(dirname(sourcePath), "vendor") : undefined;
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const externalPackages = new Set();

  await rm(vendorRoot, { recursive: true, force: true });
  await mkdir(resolve(vendorRoot, "licenses"), { recursive: true });
  if (sourceVendorRoot) {
    await rm(sourceVendorRoot, { recursive: true, force: true });
    await mkdir(sourceVendorRoot, { recursive: true });
  }

  for (const source of selectedSources) {
    const result = await build({
      entryPoints: [resolve(packageRoot, source.entrypoint)],
      outfile: resolve(vendorRoot, source.bundle),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: true,
      sourcesContent: true,
      external: EXTERNAL_PACKAGES,
      metafile: true,
      logLevel: "warning",
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (imported.external) externalPackages.add(imported.path);
      }
    }
    await copyFile(resolve(packageRoot, source.licensePath), resolve(vendorRoot, "licenses", `${source.name}-LICENSE.txt`));
    if (sourceVendorRoot) {
      await copyFile(resolve(vendorRoot, source.bundle), resolve(sourceVendorRoot, source.bundle));
      await copyFile(resolve(vendorRoot, `${source.bundle}.map`), resolve(sourceVendorRoot, `${source.bundle}.map`));
      await writeFile(
        resolve(sourceVendorRoot, source.bundle.replace(/\.js$/, ".d.ts")),
        [
          'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
          "declare const registerEditor: (pi: ExtensionAPI) => void;",
          "export default registerEditor;",
          "",
        ].join("\n"),
        "utf8",
      );
    }
  }

  const provenance = {
    schemaVersion: 1,
    buildTool: { name: "esbuild", version: esbuildVersion },
    selectedSources: selectedSources.map(({ name }) => name),
    externalPackages: [...externalPackages].sort(),
    sources: selectedSources.map(({ name, version, repository, commit, entrypoint, contentSha256, license, licensePath, licenseSha256, bundle, import: importName, importTarget, registrationOrder }) => ({
      name,
      version,
      import: importName,
      importTarget,
      registrationOrder,
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
  await writeFile(resolve(vendorRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  const generatedImports = selectedSources
    .map((source, index) => `import registerEditor${index} from ${JSON.stringify(source.import)};`)
    .join("\n");
  const generatedSourceImports = selectedSources
    .map((source, index) => `import registerEditor${index} from ${JSON.stringify(`./vendor/${source.bundle}`)};`)
    .join("\n");
  const generatedFactories = selectedSources
    .map((source, index) => `  Object.freeze({ name: ${JSON.stringify(source.name)}, version: ${JSON.stringify(source.version)}, register: registerEditor${index} }),`)
    .join("\n");
  const generatedModule = [
    generatedImports,
    generatedImports ? "" : undefined,
    "export const SELECTED_EDITOR_FACTORIES = Object.freeze([",
    generatedFactories,
    "]);",
    "",
  ].filter((line) => line !== undefined).join("\n");
  await mkdir(resolve(outputRoot, "pi-extension"), { recursive: true });
  await writeFile(resolve(outputRoot, "pi-extension/bundled-editor-factories.js"), generatedModule, "utf8");
  if (typeof sourcePath === "string") {
    const generatedTypeScript = [
      'import type { BundledEditorFactory } from "./bundled-editors.js";',
      generatedSourceImports,
      "",
      "export const SELECTED_EDITOR_FACTORIES = Object.freeze([",
      generatedFactories,
      "]) satisfies readonly BundledEditorFactory[];",
      "",
    ].filter((line) => line !== undefined).join("\n");
    await writeFile(sourcePath, generatedTypeScript, "utf8");
  }

  packageJson.imports = Object.fromEntries(selectedSources.map((source) => [source.import, source.importTarget]));
  await writeFile(resolve(outputRoot, "pi-pa-package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const noticeLines = [
    "# pi-pa Third-Party Notices",
    "",
    selectedSources.length === 0
      ? "This build contains no bundled reviewed editor plugins."
      : "This build contains the following bundled reviewed editor plugins:",
  ];
  for (const source of selectedSources) {
    noticeLines.push(
      "",
      `## ${source.name} ${source.version}`,
      "",
      `- Repository: ${source.repository}`,
      `- Commit: \`${source.commit}\``,
      `- License: ${source.license}`,
      `- Packaged license: \`dist/pi-extension/vendor/licenses/${source.name}-LICENSE.txt\``,
    );
  }
  noticeLines.push("");
  await writeFile(resolve(outputRoot, "THIRD_PARTY_NOTICES.md"), noticeLines.join("\n"), "utf8");

  for (const source of selectedSources) console.log(`[pi-pa] bundled ${source.name} -> dist/pi-extension/vendor/${source.bundle}`);
  return { pluginSelection, selectedSources, outputRoot };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await bundleExtensionSources();
