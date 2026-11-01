import { basename, isAbsolute, resolve } from "node:path";
import { workflowDigest, workflowObject } from "./deploy/prepared-workflow.js";
import { findSensitiveMatch } from "./sensitive-patterns.js";
import { parseReviewEvidenceJson } from "./validation/review-contract.js";

export const PROJECT_COMMAND_CATALOGUE_VERSION = "project-command-catalogue/v1";
export const PROJECT_COMMAND_CATALOGUE_PATH = ".pa/project-commands.json";
export const MAX_PROJECT_COMMAND_CATALOGUE_BYTES = 65_536;
const EFFECTS = Object.freeze(["project-read", "isolated-temp-write"] as const);
export interface CatalogueRepository { readonly key: string; readonly root: string }
export interface CatalogueCommand {
  readonly id: string;
  /** Exact display/matrix spelling, NOT a shell program or dispatch grant. */
  readonly command: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly readPaths: readonly string[];
  readonly prerequisites: readonly { readonly path: string; readonly sha256: string }[];
  readonly timeoutSeconds: number;
  readonly maximumOutputBytes: number;
}
export interface ProjectCommandCatalogue {
  readonly schemaVersion: typeof PROJECT_COMMAND_CATALOGUE_VERSION;
  readonly repository: CatalogueRepository;
  readonly sha256: string;
  readonly effects: typeof EFFECTS;
  readonly commands: readonly CatalogueCommand[];
}
export type ProjectCatalogueErrorCode = "CATALOGUE_SIZE" | "CATALOGUE_JSON" | "CATALOGUE_SCHEMA" | "CATALOGUE_REPOSITORY"
  | "CATALOGUE_COMMAND" | "CATALOGUE_TASK_CHECKS" | "CATALOGUE_IO";
/** Bounded, inert diagnostics: never expose command bodies, paths or parser errors. */
export class ProjectCatalogueError extends Error {
  constructor(readonly code: ProjectCatalogueErrorCode) { super(`Project command catalogue rejected: ${code}`); }
}
const reject = (code: ProjectCatalogueErrorCode): never => { throw new ProjectCatalogueError(code); };
const parsed = new WeakSet<ProjectCommandCatalogue>();
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return workflowObject(value, keys); } catch { return reject("CATALOGUE_SCHEMA"); }
}
function text(value: unknown, maximum = 4096, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || findSensitiveMatch("content", value)) return reject("CATALOGUE_COMMAND");
  return value;
}
function relativePath(value: unknown): string {
  const path = text(value);
  if (isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("-")
    || path.split("/").some(part => !part || part === "." || part === ".." || [".git", ".pa"].includes(part.toLowerCase()))
    || findSensitiveMatch("filename", basename(path)) || findSensitiveMatch("path", path)) return reject("CATALOGUE_COMMAND");
  return path;
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return reject("CATALOGUE_COMMAND");
  return value;
}
function unique<T>(values: T[]): readonly T[] {
  if (new Set(values).size !== values.length) return reject("CATALOGUE_COMMAND");
  return Object.freeze(values);
}
function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) return reject("CATALOGUE_COMMAND");
  return Number(value);
}
function repository(value: unknown): CatalogueRepository {
  const row = object(value, ["key", "root"]);
  if (typeof row.key !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.key)
    || typeof row.root !== "string" || !row.root || row.root.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(row.root)
    || !isAbsolute(row.root) || resolve(row.root) !== row.root || findSensitiveMatch("path", row.root)) return reject("CATALOGUE_REPOSITORY");
  return Object.freeze({ key: row.key, root: row.root });
}
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
function command(value: unknown): CatalogueCommand {
  const row = object(value, ["id", "executable", "argv", "environment", "readPaths", "prerequisites", "timeoutSeconds", "maximumOutputBytes"]);
  if (typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id)) return reject("CATALOGUE_COMMAND");
  const executable = text(row.executable);
  if (!isAbsolute(executable) || resolve(executable) !== executable || !/^(?:\/nix\/store\/|\/usr\/bin\/|\/bin\/)/.test(executable)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(basename(executable))) return reject("CATALOGUE_COMMAND");
  const argv = Object.freeze(list(row.argv, 128).map(arg => text(arg, 4096, true)));
  const rawEnvironment = row.environment;
  if (!rawEnvironment || typeof rawEnvironment !== "object" || Array.isArray(rawEnvironment) || Object.keys(rawEnvironment).length > 64) return reject("CATALOGUE_COMMAND");
  const environment = Object.freeze(Object.fromEntries(Object.entries(rawEnvironment).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /^(?:PA_|PI_|GIT_|NODE|NPM|LD_|BASH|ENV$|PATH$|HOME$|SHELL|PYTHON|RUBY|PERL)/.test(key)
      || /TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH|COOKIE/.test(key)) return reject("CATALOGUE_COMMAND");
    return [key, text(value, 1024, true)];
  })));
  const readPaths = unique(list(row.readPaths, 128).map(relativePath));
  const prerequisites = list(row.prerequisites, 128, 1).map(value => {
    const source = object(value, ["path", "sha256"]);
    if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256)) return reject("CATALOGUE_COMMAND");
    return Object.freeze({ path: relativePath(source.path), sha256: source.sha256 });
  });
  unique(prerequisites.map(source => source.path));
  return Object.freeze({ id: row.id, command: [basename(executable), ...argv.map(quoted)].join(" "), executable, argv, environment, readPaths,
    prerequisites: Object.freeze(prerequisites), timeoutSeconds: integer(row.timeoutSeconds, 1800), maximumOutputBytes: integer(row.maximumOutputBytes, 16 * 1024 * 1024) });
}
/** Static bytes only. This parser never reads project files, probes executables,
 * approves a catalogue or starts a command. Native approval/confinement/custody
 * remain separate necessary owners. Legacy contract/v1 is never reinterpreted. */
export function parseProjectCommandCatalogue(bytes: Uint8Array, expected: CatalogueRepository): ProjectCommandCatalogue {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_PROJECT_COMMAND_CATALOGUE_BYTES) return reject("CATALOGUE_SIZE");
  const snapshot = Buffer.from(bytes);
  let value: unknown;
  try { value = parseReviewEvidenceJson(snapshot, "project command catalogue"); } catch { return reject("CATALOGUE_JSON"); }
  const row = object(value, ["schemaVersion", "repository", "effects", "commands"]);
  if (row.schemaVersion !== PROJECT_COMMAND_CATALOGUE_VERSION || JSON.stringify(row.effects) !== JSON.stringify(EFFECTS)) return reject("CATALOGUE_SCHEMA");
  const identity = repository(row.repository), context = repository(expected);
  if (identity.key !== context.key || identity.root !== context.root) return reject("CATALOGUE_REPOSITORY");
  const commands = list(row.commands, 64, 1).map(command);
  unique(commands.map(command => command.id)); unique(commands.map(command => command.command));
  const catalogue = Object.freeze({ schemaVersion: PROJECT_COMMAND_CATALOGUE_VERSION, repository: identity, sha256: workflowDigest(snapshot), effects: EFFECTS,
    commands: Object.freeze(commands) });
  parsed.add(catalogue); return catalogue;
}
/** Match every exact task-required matrix command, in task order. Unused catalogue
 * entries are NOT mandatory. This subset is data, never approval/execution scope. */
export function selectCatalogueTaskChecks(catalogue: ProjectCommandCatalogue, taskCommands: readonly string[]): readonly CatalogueCommand[] {
  if (!parsed.has(catalogue) || !Array.isArray(taskCommands) || !taskCommands.length || taskCommands.length > 64
    || taskCommands.some(value => typeof value !== "string") || new Set(taskCommands).size !== taskCommands.length) return reject("CATALOGUE_TASK_CHECKS");
  return Object.freeze(taskCommands.map(required => {
    const found = catalogue.commands.find(command => command.command === required);
    return found ?? reject("CATALOGUE_TASK_CHECKS");
  }));
}
