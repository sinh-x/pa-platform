import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PHASE 1 SCAFFOLD, not the independent matrix runner delivered in Phase 5.
 * All ten expansions remain CLOSED, including apparently simple typecheck/build.
 * No shell executor, installs, network, worktree/branch/lease operations or success stub.
 */
export const CHECKS = Object.freeze(["typecheck", "build", "runtime", "pi", "regression", "paired", "completions", "secrets", "packaging", "closure"] as const);
export type Check = typeof CHECKS[number];
export type FixedCommand = readonly string[];
const coreBuild = ["corepack", "pnpm", "--filter", "@pa-platform/pa-core", "build"];
const piTests = ["corepack", "pnpm", "exec", "tsx", "--test", "--test-concurrency=1", "packages/pi-pa/src/__tests__/pi-prepared-workflow.test.ts", "packages/pi-pa/src/__tests__/pi-execution-custody.test.ts", "packages/pi-pa/src/__tests__/pi-phase-report.test.ts"];
const commands: Record<Check, readonly FixedCommand[]> = {
  typecheck: [["corepack", "pnpm", "typecheck"]],
  build: [["corepack", "pnpm", "build"]],
  runtime: [coreBuild, ["corepack", "pnpm", "exec", "tsx", "--test", "packages/pa-core/src/__tests__/prepared-workflow.test.ts", "packages/pa-core/src/__tests__/execution-custody.test.ts", "packages/pa-core/src/__tests__/phase-report.test.ts"]],
  pi: [coreBuild, piTests],
  regression: [["corepack", "pnpm", "test"]],
  paired: [coreBuild, ["corepack", "pnpm", "verify:paired-config", "--", "--require-origin-develop"], ["corepack", "pnpm", "test:paired-gate"], ["corepack", "pnpm", "test:paired"]],
  completions: [["corepack", "pnpm", "completions"]],
  secrets: [["corepack", "pnpm", "secrets:scan"]],
  packaging: [coreBuild, ["node", "packages/pi-pa/scripts/validate-extension-sources.mjs"], piTests],
  closure: [["corepack", "pnpm", "exec", "tsx", "--test", "scripts/dev/validate_prepared_workflow.test.mts"]],
};
for (const list of Object.values(commands)) { for (const command of list) Object.freeze(command); Object.freeze(list); }
Object.freeze(commands);
export function parseCheck(value: unknown): Check {
  if (typeof value !== "string" || !CHECKS.includes(value as Check)) throw new Error("unknown fixed check");
  return value as Check;
}
export function fixedExpansion(value: unknown): readonly FixedCommand[] { return commands[parseCheck(value)]; }
export const PHASE5_DEBT = Object.freeze([
  "pinned tool/native/submodule and dependency-closure verification",
  "safe materialization of pnpm/workspace aliases as independent ordinary copies",
  "paired source origin/develop containment and producer/baseline/adoption fixtures",
  "exact protected candidate/matrix/reviewer authorization at runner entry",
  "fixed subprocess execution/timeouts/bounded durable stdout/stderr",
  "all five generated completion byte comparisons",
  "complete base/candidate delta and disposable staged secrets fixture",
  "automated AC1-AC20 case coverage with zero fail/cancel/skip",
  "complete before/after source and isolated-output integrity ledger",
  "nonrecursive closure and prior independent-ledger validation",
]);
export const INVENTORY_CALLS = Object.freeze([
  Object.freeze(["rev-parse", "--show-toplevel"]),
  Object.freeze(["rev-parse", "HEAD"]),
  Object.freeze(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
  Object.freeze(["ls-files", "-z"]),
]);
export interface FileIdentity {
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
  readonly sha256: string;
}
export interface InputIdentity {
  readonly schemaVersion: "prepared-runner-input/v1";
  readonly head: string;
  readonly root: string;
  readonly files: readonly FileIdentity[];
  readonly sha256: string;
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function exactSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("full candidate/config SHA required");
  return value;
}
function physicalDirectory(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw new Error("physical absolute root required");
  let current = root;
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("directory aliases forbidden");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return root;
}
export function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").some((piece) => !piece || piece === "." || piece === ".." || piece === ".git")) throw new Error("source escape or metadata path");
  const full = resolve(root, path);
  if (!full.startsWith(`${root}${sep}`)) throw new Error("source escape");
  physicalDirectory(dirname(full));
  return full;
}
function fileIdentity(root: string, path: string): FileIdentity {
  const full = containedPath(root, path); const before = lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("ordinary single-link files required; dependency alias unsupported in Phase 1");
  const bytes = readFileSync(full); const after = lstatSync(full);
  if (bytes.length !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.ctimeMs !== after.ctimeMs) throw new Error("source changed during inventory");
  return Object.freeze({ path, size: bytes.length, executable: Boolean(before.mode & 0o111), sha256: digest(bytes) });
}
/** No candidate checks: four fixed read-only inventory calls only. */
function gitInventory(root: string, args: readonly string[], home: string): Buffer {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd: root, maxBuffer: 16_777_216, stdio: ["ignore", "pipe", "pipe"],
    // Fixture inventory never borrows deployment identity, production HOME/PA state or Git environment.
    env: { PATH: process.env["PATH"], HOME: physicalDirectory(home), LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}
export function inspectInput(root: string, expectedHead: string, isolatedHome: string): InputIdentity {
  physicalDirectory(root); exactSha(expectedHead);
  const top = gitInventory(root, INVENTORY_CALLS[0]!, isolatedHome).toString("utf8").trimEnd();
  const head = gitInventory(root, INVENTORY_CALLS[1]!, isolatedHome).toString("utf8").trimEnd();
  if (top !== root || head !== expectedHead) throw new Error("candidate/config identity mismatch");
  if (gitInventory(root, INVENTORY_CALLS[2]!, isolatedHome).length !== 0) throw new Error("complete clean candidate/config required");
  const bytes = gitInventory(root, INVENTORY_CALLS[3]!, isolatedHome);
  const paths = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
  if (paths.pop() !== "" || !paths.length || new Set(paths).size !== paths.length) throw new Error("invalid tracked inventory");
  const files = Object.freeze(paths.sort().map((path) => fileIdentity(root, path)));
  return Object.freeze({ schemaVersion: "prepared-runner-input/v1", head, root, files, sha256: digest(JSON.stringify(files)) });
}
function verifyFiles(identity: InputIdentity): void {
  if (digest(JSON.stringify(identity.files)) !== identity.sha256) throw new Error("forged input inventory");
  for (const file of identity.files) {
    if (JSON.stringify(fileIdentity(identity.root, file.path)) !== JSON.stringify(file)) throw new Error("source bytes or mode changed");
  }
}
/** Copies only inventoried source files, never source .git or checkout metadata. */
export function copyInput(identity: InputIdentity, destination: string): void {
  physicalDirectory(identity.root); physicalDirectory(dirname(destination));
  if (resolve(destination) !== destination || !isAbsolute(destination)
    || destination === identity.root || destination.startsWith(`${identity.root}${sep}`) || identity.root.startsWith(`${destination}${sep}`)) throw new Error("source/output overlap");
  verifyFiles(identity);
  mkdirSync(destination, { mode: 0o700 }); // absent-only: preexisting/symlink destinations reject
  for (const file of identity.files) {
    const output = join(destination, file.path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    copyFileSync(containedPath(identity.root, file.path), output, constants.COPYFILE_EXCL);
    const copied = fileIdentity(destination, file.path);
    const outputStat = lstatSync(output); const inputStat = lstatSync(join(identity.root, file.path));
    if (JSON.stringify(copied) !== JSON.stringify(file) || (outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)) throw new Error("copy identity/independence mismatch");
  }
  verifyFiles(identity);
}
/**
 * Dependency scaffold accepts ordinary trees ONLY. Real pnpm symlinks/native closure
 * are Phase 5 debt, not silently dereferenced, shared, skipped or claimed supported.
 */
export function copyOrdinaryDependencies(source: string, destination: string): string {
  physicalDirectory(source);
  if (destination === source || resolve(destination).startsWith(`${source}${sep}`) || source.startsWith(`${resolve(destination)}${sep}`)) throw new Error("dependency source/output overlap");
  const files: FileIdentity[] = [];
  function walk(path: string): void {
    for (const name of readdirSync(join(source, path)).sort()) {
      if (name === ".git") throw new Error("dependency metadata forbidden");
      const next = path ? `${path}/${name}` : name; const stat = lstatSync(join(source, next));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(next);
      else files.push(fileIdentity(source, next));
    }
  }
  walk("");
  if (!files.length) throw new Error("missing dependency inputs");
  const identity: InputIdentity = { schemaVersion: "prepared-runner-input/v1", root: source, head: "0".repeat(40), files, sha256: digest(JSON.stringify(files)) };
  copyInput(identity, destination);
  return identity.sha256;
}
export interface ScaffoldLedger {
  readonly schemaVersion: "prepared-runner-ledger/v1";
  readonly stage: "phase-1-scaffold";
  readonly check: Check;
  readonly status: "blocked";
  readonly candidate: Readonly<{ head: string; sha256: string }> | null;
  readonly config: Readonly<{ head: string; sha256: string }> | null;
  readonly plannedCommands: readonly FixedCommand[];
  readonly executedCommands: readonly never[];
  readonly exit: null;
  readonly stdoutRef: null;
  readonly stderrRef: null;
  readonly automatedCoverage: "unknown";
  readonly debt: readonly string[];
}
/** Unknown/missing later inputs never become success, even for typecheck. */
export function scaffoldLedger(checkInput: unknown, candidate: InputIdentity | null = null, config: InputIdentity | null = null): ScaffoldLedger {
  const check = parseCheck(checkInput);
  return Object.freeze({ schemaVersion: "prepared-runner-ledger/v1", stage: "phase-1-scaffold", check, status: "blocked",
    candidate: candidate ? Object.freeze({ head: exactSha(candidate.head), sha256: candidate.sha256 }) : null,
    config: config ? Object.freeze({ head: exactSha(config.head), sha256: config.sha256 }) : null,
    plannedCommands: fixedExpansion(check), executedCommands: Object.freeze([]), exit: null, stdoutRef: null, stderrRef: null,
    automatedCoverage: "unknown", debt: PHASE5_DEBT });
}
export function assertInputPair(candidate: InputIdentity, config: InputIdentity): void {
  if (candidate.root === config.root || candidate.root.startsWith(`${config.root}${sep}`) || config.root.startsWith(`${candidate.root}${sep}`)) throw new Error("candidate/config roots overlap");
  verifyFiles(candidate); verifyFiles(config);
  const pin = candidate.files.find((file) => file.path === ".pa-platform-config.sha");
  if (!pin || readFileSync(join(candidate.root, pin.path), "utf8") !== `${config.head}\n`) throw new Error("missing/mismatched exact config pin");
}
/** Fixture-only boundary builder; caller owns retention. It executes zero validation commands. */
export function prepareScaffold(candidate: InputIdentity, config: InputIdentity, parent: string): Readonly<{ root: string; sourceDigests: readonly string[] }> {
  assertInputPair(candidate, config); physicalDirectory(parent);
  if (parent === candidate.root || parent.startsWith(`${candidate.root}${sep}`) || parent === config.root || parent.startsWith(`${config.root}${sep}`)) throw new Error("isolated parent overlaps inputs");
  const root = mkdtempSync(join(parent, "prepared-workflow-"));
  for (const name of ["home", "cache", "pa-state", "outputs"]) mkdirSync(join(root, name), { mode: 0o700 });
  copyInput(candidate, join(root, "candidate")); copyInput(config, join(root, "config"));
  assertInputPair(candidate, config);
  return Object.freeze({ root, sourceDigests: Object.freeze([candidate.sha256, config.sha256]) });
}
export function parseArguments(args: readonly string[]): Check {
  if (args.length !== 2 || args[0] !== "--check") throw new Error("only --check <fixed-name> is supported");
  return parseCheck(args[1]);
}
/** No runtime identity substitution or input-path override is provided by this scaffold CLI. */
export function main(args: readonly string[]): number {
  try {
    const check = parseArguments(args);
    const ledger = scaffoldLedger(check);
    const root = mkdtempSync(join(tmpdir(), "prepared-runner-blocked-"));
    writeFileSync(join(root, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stderr.write(`Condition: validation blocked. Source: Phase 1 scaffold. Reason: all ten Phase 5 expansions remain unimplemented; inputs and coverage are unknown. Correction: deliver the approved Phase 5 runner before independent review. Resume Action: retain ledger ${root}/ledger.json; do not count this as a check pass.\n`);
    return 1;
  } catch {
    process.stderr.write("Condition: validation rejected. Source: fixed runner arguments. Reason: unknown or expanded command. Correction: use the exact approved check. Resume Action: preserve candidate; no command executed.\n");
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
