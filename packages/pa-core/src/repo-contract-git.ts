import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowDigest } from "./deploy/prepared-workflow.js";
import { readReviewEvidenceFile } from "./validation/review-contract.js";
import { resolveRepoExecutionPath } from "./repos.js";
import type { CatalogueRepository } from "./project-command-catalogue.js";

const fail = (): never => { throw new Error("Repository contract Git metadata rejected"); };
function git(repo: CatalogueRepository, args: string[]): Buffer {
  const env = Object.fromEntries(["PATH", "LANG", "LC_ALL"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return execFileSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo.root, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    timeout: 5000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"],
  });
}
function sync(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function assertCatalogueUntracked(repo: CatalogueRepository): void {
  if (git(repo, ["ls-files", "-z", "--", ".pa"]).length) fail();
}
export interface LocalExcludeSnapshot { readonly sha256: string | null; readonly appendRequired: boolean }
function exclude(repo: CatalogueRepository, ownTemporary?: string): { directory: string; file: string; bytes: Buffer | null; mode: number } {
  const identity = resolveRepoExecutionPath(repo.key);
  if (identity.repoRoot !== repo.root || identity.gitDir !== join(repo.root, ".git") || identity.gitCommonDir !== identity.gitDir) return fail();
  const directory = join(identity.gitDir, "info"), file = join(directory, "exclude");
  try { const stat = lstatSync(directory); if (!stat.isDirectory() || realpathSync(directory) !== directory || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail();
    if (readdirSync(directory).some(name => name.startsWith(".pa-contract-exclude-") && name !== ownTemporary)) fail(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { directory, file, bytes: null, mode: 0o600 }; }
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || realpathSync(file) !== file || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail();
    const bytes = Buffer.from(readReviewEvidenceFile(file, 65536, "repository local exclude"));
    new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (bytes.includes(0)) fail();
    return { directory, file, bytes, mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { directory, file, bytes: null, mode: 0o600 }; }
}
export function previewCatalogueExclude(repo: CatalogueRepository): LocalExcludeSnapshot {
  assertCatalogueUntracked(repo);
  const observed = exclude(repo), text = observed.bytes?.toString("utf8") ?? "";
  return Object.freeze({ sha256: observed.bytes === null ? null : workflowDigest(observed.bytes), appendRequired: !text.split(/\r?\n/).includes("/.pa/") });
}
export function assertCatalogueIgnored(repo: CatalogueRepository): void {
  assertCatalogueUntracked(repo);
  // Do not infer ignored status from a rule's presence: tracked sources and
  // project negations can override the local exclude rule.
  git(repo, ["check-ignore", "-q", "--", ".pa/project-commands.json"]);
  if (previewCatalogueExclude(repo).appendRequired) fail();
}
/** Exact operator-reviewed metadata effect only. Existing entries/mode preserved;
 * conflicting negations fail after readback without approval or silent repair.
 * The native caller owns capacity/all-worktree exclusion and drift rechecks.
 */
export function reconcileCatalogueExclude(repo: CatalogueRepository, expected: LocalExcludeSnapshot): void {
  if (JSON.stringify(previewCatalogueExclude(repo)) !== JSON.stringify(expected)) fail();
  const observed = exclude(repo);
  if (expected.appendRequired) {
    if (!observed.bytes || observed.bytes.length < 65520) {
      try { mkdirSync(observed.directory, { mode: 0o700 }); sync(join(repo.root, ".git")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const bytes = Buffer.concat([observed.bytes ?? Buffer.alloc(0), Buffer.from(observed.bytes?.length && !observed.bytes.subarray(-1).equals(Buffer.from("\n")) ? "\n/.pa/\n" : "/.pa/\n")]);
      const temporary = join(observed.directory, `.pa-contract-exclude-${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, observed.mode);
      try { fchmodSync(fd, observed.mode); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      assertCatalogueUntracked(repo);
      const current = exclude(repo, temporary.slice(observed.directory.length + 1));
      if ((current.bytes === null ? null : workflowDigest(current.bytes)) !== expected.sha256) fail();
      if (observed.bytes === null) { linkSync(temporary, observed.file); unlinkSync(temporary); }
      else renameSync(temporary, observed.file);
      sync(observed.directory);
      if (!Buffer.from(readReviewEvidenceFile(observed.file, 65536, "repository local exclude readback")).equals(bytes)) fail();
    } else fail();
  }
  assertCatalogueIgnored(repo);
}
