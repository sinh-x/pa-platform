import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountCases, block, committedRead, digest, REQUIRED_TEST_FILES, trackedSource } from "./workflow_installed_support.mjs";

/** Qualification test CODE is pinned source; every implementation import is a
 * one-line bridge to the exact verified installed module. No implementation
 * source is copied/transpiled into this private harness, including child paths. */
export async function createHarness({ sourceRoot, sourceSha, moduleRoot, directory }) {
  const require = createRequire(join(sourceRoot, "package.json")), ts = require("typescript");
  const sourceFiles = trackedSource(sourceRoot), observed = {}, bridges = {};
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (path, body) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, body, { mode: 0o600, flag: "wx" }); };
  write(join(directory, "package.json"), '{"type":"module","private":true}\n');
  for (const path of sourceFiles) {
    if (path.endsWith(".d.ts")) continue;
    if (path.includes("/__tests__/")) {
      const raw = committedRead(sourceRoot, sourceSha, path); observed[path] = digest(raw);
      write(join(directory, path), raw);
      if (path.endsWith(".ts")) {
        const output = ts.transpileModule(raw.toString("utf8"), { fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true, sourceMap: false } });
        if (output.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) block("WORKFLOW_DRIVER_TRANSPILE", "drivers");
        write(join(directory, path.replace(/\.ts$/, ".js")), output.outputText);
      }
    } else if (path.endsWith(".ts")) {
      const installed = join(moduleRoot, path.replace("/src/", "/dist/").replace(/\.ts$/, ".js"));
      // The module inventory check has already checked these actual bytes.
      const source = committedRead(sourceRoot, sourceSha, path); observed[path] = digest(source);
      const target = pathToFileURL(installed).href;
      const bridge = `export * from ${JSON.stringify(target)};\n${/export\s+default|as\s+default/.test(source.toString()) ? `export { default } from ${JSON.stringify(target)};\n` : ""}`;
      write(join(directory, path), bridge); write(join(directory, path.replace(/\.ts$/, ".js")), bridge);
      // Existing child drivers may intentionally address the compiled tree.
      write(join(directory, path.replace("/src/", "/dist/").replace(/\.ts$/, ".js")), bridge);
      bridges[path] = { module: installed, bridgeSha256: digest(Buffer.from(bridge)) };
    }
  }
  for (const required of REQUIRED_TEST_FILES) if (!observed[required]) block("WORKFLOW_DRIVER_MISSING", "drivers");
  mkdirSync(join(directory, "node_modules/@pa-platform"), { recursive: true, mode: 0o700 });
  for (const name of ["pa-core", "pi-pa"]) symlinkSync(join(moduleRoot, `packages/${name}`), join(directory, `node_modules/@pa-platform/${name}`), "dir");
  const tsx = dirname(require.resolve("tsx/package.json")); symlinkSync(realpathSync(tsx), join(directory, "node_modules/tsx"), "dir");
  return { observed, bridges, compiler: { typescript: ts.version, tsx: realpathSync(tsx) }, tests: REQUIRED_TEST_FILES.map(path => join(directory, path.replace(/\.ts$/, ".js"))) };
}
export function runHarness({ directory, harness, node = process.execPath, env, reporter, evidenceRoot }) {
  const result = spawnSync(node, ["--test", "--test-concurrency=1", `--test-reporter=${reporter}`, ...harness.tests], {
    cwd: directory, env, encoding: "utf8", timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL" });
  writeFileSync(join(evidenceRoot, "native-test-events.jsonl"), result.stdout ?? "", { mode: 0o600 });
  writeFileSync(join(evidenceRoot, "native-test-stderr.log"), result.stderr ?? "", { mode: 0o600 });
  if (result.error || result.signal || result.status !== 0 || result.stderr) block("WORKFLOW_INSTALLED_CASE_RUN_FAILED", "native-cases");
  let events;
  try { events = result.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { block("WORKFLOW_TEST_EVENT_FRAMING", "native-cases"); }
  return { ...accountCases(events), exitCode: result.status, signal: result.signal, stderrSha256: digest(Buffer.from(result.stderr)),
    harnessSourceSha256: digest(Buffer.from(JSON.stringify(harness.observed))), implementationBridgesSha256: digest(Buffer.from(JSON.stringify(harness.bridges))),
    limitations: ["Native capture, original admission/provider and Treehouse seams are labelled fixtures, not human approval or live provider qualification.", "Test drivers are exact committed source; all product implementation modules resolve exclusively to the verified installed closure."] };
}
