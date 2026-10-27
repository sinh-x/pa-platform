import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { executionFailure, findSensitiveMatch, loadRepoEntry, readReviewEvidenceFile, parseReviewEvidenceJson, workflowDigest, workflowObject, workflowSha, type RepoEntry } from "@pa-platform/pa-core";

export interface ProjectCheck {
  readonly id: string;
  readonly command: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly readPaths: readonly string[];
  readonly prerequisites: readonly { readonly path: string; readonly sha256: string }[];
  readonly timeoutSeconds: number;
  readonly maximumOutputBytes: number;
}
const invalid = () => executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID");
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return workflowObject(value, [...keys]); } catch { throw invalid(); }
}
function sha(value: unknown): string { try { return workflowSha(value); } catch { throw invalid(); } }
function json(bytes: Uint8Array): unknown {
  try { return parseReviewEvidenceJson(bytes, "project command contract"); } catch { throw invalid(); }
}
function path(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value) || !/^[A-Za-z0-9_./-]+$/.test(value)
    || value.startsWith("-") || findSensitiveMatch("filename", basename(value)) || findSensitiveMatch("path", value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw invalid();
  return value;
}
function installedExecutable(value: string): string {
  try {
    const actual = realpathSync(value), stat = lstatSync(actual);
    if (actual !== value || !/^(?:\/nix\/store\/|\/usr\/bin\/|\/bin\/)/.test(actual) || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || !(stat.mode & 0o111)) throw invalid();
    return actual;
  } catch { throw executionFailure("EXECUTION_PROJECT_PREREQUISITE"); }
}
function bubblewrap(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    try { return installedExecutable(realpathSync(join(dir, "bwrap"))); } catch { /* absent/untrusted executable is not a fallback */ }
  }
  throw executionFailure("EXECUTION_PROJECT_PREREQUISITE");
}
function read(root: string, relative: string): Uint8Array {
  try {
    const absolute = join(root, path(relative)), stat = lstatSync(absolute);
    if (realpathSync(absolute) !== absolute || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw invalid();
    const bytes = readReviewEvidenceFile(absolute, 1_048_576, "project command provenance");
    if (findSensitiveMatch("content", Buffer.from(bytes).toString("utf8"))) throw invalid();
    return bytes;
  } catch { throw executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID"); }
}
function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw invalid();
  return Number(value);
}
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A config-pinned manifest is a command contract, not an arbitrary-shell grant.
 * Current v1 checks get a read-only project, isolated temporary writes, no host
 * HOME/accounts/services, and new PID/IPC/network/user namespaces. Unsupported
 * namespace confinement fails closed; this never installs/reconfigures a host. */
export class ProjectCommandContract {
  readonly sha256: string;
  readonly checks: readonly ProjectCheck[];
  readonly #pin: NonNullable<RepoEntry["projectCommands"]>;
  readonly #bwrap: string;
  private constructor(readonly repoKey: string, readonly repoRoot: string, readonly worktreeRoot: string, pin: NonNullable<RepoEntry["projectCommands"]>) {
    const rawPin = object(pin, ["manifest", "sha256"]);
    this.#pin = Object.freeze({ manifest: path(rawPin.manifest), sha256: sha(rawPin.sha256) });
    const bytes = read(worktreeRoot, this.#pin.manifest);
    if (workflowDigest(bytes) !== this.#pin.sha256) throw invalid();
    const manifest = object(json(bytes), ["schemaVersion", "effects", "checks"]);
    if (manifest.schemaVersion !== "project-command-contract/v1" || JSON.stringify(manifest.effects) !== JSON.stringify(["project-read", "isolated-temp-write"])) throw invalid();
    if (!Array.isArray(manifest.checks) || !manifest.checks.length || manifest.checks.length > 64) throw invalid();
    this.checks = Object.freeze(manifest.checks.map((item): ProjectCheck => {
      const row = object(item, ["id", "executable", "argv", "environment", "readPaths", "prerequisites", "timeoutSeconds", "maximumOutputBytes"]);
      if (typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || typeof row.executable !== "string"
        || !Array.isArray(row.argv) || row.argv.length > 128 || row.argv.some((arg) => typeof arg !== "string" || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg) || findSensitiveMatch("content", arg))) throw invalid();
      const executable = installedExecutable(row.executable);
      // No ambient credential, runtime authority, PATH/HOME, loader, Git, Node
      // or package-manager injection. These are literal inert application values.
      if (!row.environment || typeof row.environment !== "object" || Array.isArray(row.environment)) throw invalid();
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.environment)) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /^(?:PA_|PI_|GIT_|NODE|NPM|npm|LD_|BASH|ENV$|PATH$|HOME$|SHELL|PYTHON|RUBY|PERL)/.test(key)
          || /TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH|COOKIE/.test(key)
          || typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value) || findSensitiveMatch("content", value)) throw invalid();
        environment[key] = value;
      }
      if (!Array.isArray(row.readPaths) || row.readPaths.length > 128) throw invalid();
      const readPaths = Object.freeze(row.readPaths.map(path));
      if (new Set(readPaths).size !== readPaths.length) throw invalid();
      if (!Array.isArray(row.prerequisites) || !row.prerequisites.length || row.prerequisites.length > 128) throw invalid();
      const prerequisites = row.prerequisites.map((value) => { const source = object(value, ["path", "sha256"]); return Object.freeze({ path: path(source.path), sha256: sha(source.sha256) }); });
      if (new Set(prerequisites.map((source) => source.path)).size !== prerequisites.length) throw invalid();
      const argv = Object.freeze([...row.argv] as string[]);
      return Object.freeze({ id: row.id, command: [basename(executable), ...argv.map(quoted)].join(" "), executable, argv,
        environment: Object.freeze(environment), readPaths, prerequisites: Object.freeze(prerequisites), timeoutSeconds: count(row.timeoutSeconds, 1800), maximumOutputBytes: count(row.maximumOutputBytes, 16 * 1024 * 1024) });
    }));
    if (new Set(this.checks.map((check) => check.id)).size !== this.checks.length || new Set(this.checks.map((check) => check.command)).size !== this.checks.length) throw invalid();
    this.sha256 = workflowDigest(bytes); this.#bwrap = bubblewrap(); this.assertCurrent();
    // A fixed native capability probe, not a project check or guessed pass. It
    // must succeed before admitting project dispatch; raw failure is not public.
    try { execFileSync(this.#bwrap, [...this.#sandbox(), "--", installedExecutable(realpathSync(process.execPath)), "--version"], { env: {}, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw executionFailure("EXECUTION_PROJECT_PREREQUISITE"); }
  }
  static resolve(repoKey: string, repoRoot: string, worktreeRoot: string): ProjectCommandContract | null {
    const repo = loadRepoEntry(repoKey);
    if (!repo || repo.path !== repoRoot || repoRoot === worktreeRoot || realpathSync(repoRoot) !== repoRoot || realpathSync(worktreeRoot) !== worktreeRoot) throw invalid();
    return repo.projectCommands === undefined ? null : new ProjectCommandContract(repoKey, repoRoot, worktreeRoot, repo.projectCommands);
  }
  assertCurrent(): void {
    const repo = loadRepoEntry(this.repoKey);
    if (repo?.path !== this.repoRoot || repo.projectCommands?.manifest !== this.#pin.manifest || repo.projectCommands.sha256 !== this.#pin.sha256
      || workflowDigest(read(this.worktreeRoot, this.#pin.manifest)) !== this.sha256) throw invalid();
    for (const check of this.checks) {
      for (const source of check.prerequisites) if (workflowDigest(read(this.worktreeRoot, source.path)) !== source.sha256) throw invalid();
      for (const input of check.readPaths) read(this.worktreeRoot, input);
    }
  }
  check(name: string): ProjectCheck | undefined { return this.checks.find((check) => check.id === name || check.command === name); }
  inputIdentity(check: ProjectCheck): string {
    if (!this.checks.includes(check)) throw invalid();
    const paths = [...new Set([...check.readPaths, ...check.prerequisites.map((source) => source.path)])].sort();
    return workflowDigest(JSON.stringify(paths.map((path) => {
      const content = read(this.worktreeRoot, path), sha256 = workflowDigest(content);
      const prerequisite = check.prerequisites.find((source) => source.path === path);
      if (prerequisite && prerequisite.sha256 !== sha256) throw invalid();
      return { path, sha256, mode: lstatSync(join(this.worktreeRoot, path)).mode };
    })));
  }
  #sandbox(check?: ProjectCheck): string[] {
    return ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/nix/store", "/nix/store",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/pa-check-home", "--tmpfs", this.worktreeRoot,
      ...[...new Set(check ? [...check.readPaths, ...check.prerequisites.map((source) => source.path)] : [])].flatMap((input) => ["--ro-bind", join(this.worktreeRoot, input), join(this.worktreeRoot, input)]),
      "--remount-ro", this.worktreeRoot, "--chdir", this.worktreeRoot, "--clearenv"];
  }
  program(check: ProjectCheck): { executable: string; argv: readonly string[]; environment: Readonly<Record<string, string>> } {
    this.assertCurrent(); if (!this.checks.includes(check)) throw invalid();
    const environment = { CI: "true", LANG: "C.UTF-8", TZ: "UTC", HOME: "/tmp/pa-check-home", PATH: dirname(check.executable), ...check.environment };
    return { executable: this.#bwrap, argv: [...this.#sandbox(check), ...Object.entries(environment).flatMap(([key, value]) => ["--setenv", key, value]), "--", check.executable, ...check.argv], environment };
  }
}
