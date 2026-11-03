import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { findSensitiveMatch } from "./sensitive-patterns.js";
import type { CatalogueRepository, ProjectCommandCatalogue } from "./project-command-catalogue.js";

export const MAX_SETUP_INPUT_BYTES = 1_048_576;
export const MAX_SETUP_TOTAL_BYTES = 8 * MAX_SETUP_INPUT_BYTES;
export const MAX_SETUP_INPUTS = 128;
export class RepoSetupInputError extends Error {
  constructor(readonly code: "SETUP_INPUT" | "SETUP_STALE") { super(code); }
}
const fail = (code: "SETUP_INPUT" | "SETUP_STALE" = "SETUP_INPUT"): never => { throw new RepoSetupInputError(code); };
const identity = (s: Stats) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
function safePath(value: unknown, directory = false): string {
  if (directory && value === ".") return ".";
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_./-]+$/.test(value) || value.startsWith("-")
    || value.split("/").some(p => !p || p === "." || p === ".." || [".git", ".pa"].includes(p.toLowerCase()))
    || value.split("/").some(part => findSensitiveMatch("filename", part)) || findSensitiveMatch("path", value)) return fail();
  return value;
}
function owned(s: Stats): void {
  if (s.uid !== process.getuid?.() || (s.mode & 0o022)) fail();
}
/** Linux descriptor-relative traversal. No symlink component is followed, even
 * during a rename race. Other hosts fail closed instead of degrading to path-only checks.
 * The caller owns authentication/capacity. Nothing here executes project content.
 */
function confined<T>(repository: CatalogueRepository, relative: string, directory: boolean, run: (fd: number) => T): T {
  const descriptors: number[] = [], parents: { path: string; stat: Stats }[] = [];
  try {
    if (process.platform !== "linux" || realpathSync(repository.root) !== repository.root) fail();
    const root = openSync(repository.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(root);
    const initial = fstatSync(root); owned(initial); parents.push({ path: repository.root, stat: initial });
    let fd = root, physical = repository.root;
    const parts = relative === "." ? [] : relative.split("/");
    for (let index = 0; index < parts.length; index++) {
      const isDirectory = index < parts.length - 1 || directory;
      fd = openSync(`/proc/self/fd/${fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (isDirectory ? constants.O_DIRECTORY : 0));
      descriptors.push(fd); physical = join(physical, parts[index]!);
      const stat = fstatSync(fd); owned(stat);
      if (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail();
      parents.push({ path: physical, stat });
    }
    const result = run(fd);
    for (const parent of parents) {
      const current = lstatSync(parent.path);
      // Directory entries may be read, never changed by us. Reject observed drift.
      if (identity(current) !== identity(parent.stat) || realpathSync(parent.path) !== parent.path) fail("SETUP_STALE");
    }
    return result;
  } catch (error) { if (error instanceof RepoSetupInputError) throw error; return fail(); }
  finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
function readInput(repository: CatalogueRepository, path: string, maximum = MAX_SETUP_INPUT_BYTES): Buffer {
  return confined(repository, path, false, fd => {
    const before = fstatSync(fd);
    if (before.size > maximum) return fail();
    const bytes = Buffer.alloc(before.size + 1); let size = 0, count = 0;
    do { count = readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size < bytes.length);
    if (size !== before.size || identity(before) !== identity(fstatSync(fd))) return fail("SETUP_STALE");
    const result = bytes.subarray(0, size);
    if (findSensitiveMatch("content", result.toString("utf8"))) return fail();
    return result;
  });
}
export function observeRepoSetupInputs(repository: CatalogueRepository, values: unknown) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_SETUP_INPUTS) return fail();
  const paths = values.map(value => safePath(value)); if (new Set(paths).size !== paths.length) return fail();
  let total = 0;
  const files = paths.map(path => {
    const bytes = readInput(repository, path); total += bytes.length; if (total > MAX_SETUP_TOTAL_BYTES) fail();
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  });
  // Reobserve the complete batch: no mixed-time manifest survives detected input drift.
  for (const file of files) if (createHash("sha256").update(readInput(repository, file.path)).digest("hex") !== file.sha256) fail("SETUP_STALE");
  return { schemaVersion: "repo-setup-inputs/v1", repository, files };
}
export function verifyRepoSetupPrerequisites(repository: CatalogueRepository, catalogue: ProjectCommandCatalogue): void {
  const expected = new Map<string, string>();
  for (const command of catalogue.commands) for (const input of command.prerequisites) {
    if (expected.has(input.path) && expected.get(input.path) !== input.sha256) fail("SETUP_STALE");
    expected.set(input.path, input.sha256);
  }
  const observed = observeRepoSetupInputs(repository, [...expected.keys()]);
  for (const file of observed.files) if (expected.get(file.path) !== file.sha256) fail("SETUP_STALE");
}
export function discoverRepoSetupInputs(repository: CatalogueRepository, value: unknown) {
  const path = safePath(value, true);
  return confined(repository, path, true, fd => {
    const dir = opendirSync(`/proc/self/fd/${fd}`), entries: { path: string; kind: "directory" | "file" }[] = [];
    try {
      let entry, count = 0;
      while ((entry = dir.readSync()) !== null) {
        if (++count > 512) fail();
        if (!entry.isFile() && !entry.isDirectory()) continue;
        const relative = path === "." ? entry.name : `${path}/${entry.name}`;
        try { safePath(relative); } catch { continue; }
        entries.push({ path: relative, kind: entry.isDirectory() ? "directory" : "file" });
      }
    } finally { dir.closeSync(); }
    return { path, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
  });
}
export function readRepoSetupInput(repository: CatalogueRepository, value: unknown) {
  const path = safePath(value), bytes = readInput(repository, path, 32_768);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return fail();
  return { path, text, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}
