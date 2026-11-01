import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { withPreparedTicketCapacity } from "./deploy/ticket-concurrency.js";
import { withVacantRepositorySetup } from "./deploy/repository-admission.js";
import { workflowObject } from "./deploy/prepared-workflow.js";
import { inspectLocalProjectCommandCatalogue } from "./project-command-catalogue-files.js";
import { MAX_PROJECT_COMMAND_CATALOGUE_BYTES, parseProjectCommandCatalogue, PROJECT_COMMAND_CATALOGUE_PATH, type CatalogueRepository } from "./project-command-catalogue.js";
import { loadRepoEntry, resolveRepoExecutionPath } from "./repos.js";
import { parseReviewEvidenceJson, readReviewEvidenceFile } from "./validation/review-contract.js";

export const MAX_REPO_SETUP_REQUEST_BYTES = 256 * 1024;
export type RepoSetupErrorCode = "SETUP_REQUEST" | "SETUP_ACTOR" | "SETUP_REPOSITORY" | "SETUP_BUSY" | "SETUP_SOURCE_CONFLICT" | "SETUP_TRACKED" | "SETUP_CANDIDATE" | "SETUP_STALE" | "SETUP_IO";
export class RepoSetupError extends Error {
  constructor(readonly code: RepoSetupErrorCode) { super(`Repository setup rejected: ${code}`); }
}
export interface RepoSetupCandidateReference {
  readonly schemaVersion: "repo-setup-candidate/v1";
  readonly repository: CatalogueRepository;
  readonly path: typeof PROJECT_COMMAND_CATALOGUE_PATH;
  readonly sha256: string;
}
/** Native embedding seam only. Never populated from tool/CLI request fields.
 * Authentication must reobserve the registry, launch incarnation, primary root
 * and managed role each time; a team name or environment alone is not authority.
 */
export interface RepoSetupHost { authenticate(): CatalogueRepository }
const fail = (code: RepoSetupErrorCode): never => { throw new RepoSetupError(code); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try { return workflowObject(value, fields); } catch { return fail("SETUP_REQUEST"); }
}
function reference(repository: CatalogueRepository, sha256: string): RepoSetupCandidateReference {
  return Object.freeze({ schemaVersion: "repo-setup-candidate/v1", repository: Object.freeze({ ...repository }), path: PROJECT_COMMAND_CATALOGUE_PATH, sha256 });
}
function parseReference(value: unknown, repository: CatalogueRepository): RepoSetupCandidateReference | null {
  if (value === null) return null;
  const row = object(value, ["schemaVersion", "repository", "path", "sha256"]), repo = object(row.repository, ["key", "root"]);
  if (row.schemaVersion !== "repo-setup-candidate/v1" || row.path !== PROJECT_COMMAND_CATALOGUE_PATH || repo.key !== repository.key || repo.root !== repository.root
    || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) return fail("SETUP_REQUEST");
  return reference(repository, row.sha256);
}
function snapshot(stat: Stats): string { return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function authenticate(host: RepoSetupHost, expected?: CatalogueRepository): CatalogueRepository {
  try {
    const actor = host.authenticate();
    const resolved = resolveRepoExecutionPath(actor.key);
    if (resolved.repoKey !== actor.key || resolved.repoRoot !== actor.root || resolved.worktreeRoot !== actor.root || (expected && !same(actor, expected))) return fail("SETUP_REPOSITORY");
    return Object.freeze({ key: actor.key, root: actor.root });
  } catch (error) { if (error instanceof RepoSetupError) throw error; return fail("SETUP_ACTOR"); }
}
function gitUntracked(repository: CatalogueRepository): void {
  // Metadata only; no status, hooks, filters, source scripts, index refresh or
  // remote access. Caller environment cannot redirect the Git repository/index.
  const env = Object.fromEntries(["PATH", "LANG", "LC_ALL"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  try {
    const tracked = execFileSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", "-z", "--", ".pa"], {
      cwd: repository.root, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    if (tracked.length) fail("SETUP_TRACKED");
  } catch (error) { if (error instanceof RepoSetupError) throw error; fail("SETUP_IO"); }
}
function source(repository: CatalogueRepository, worktrees: readonly string[]): RepoSetupCandidateReference | null {
  if (loadRepoEntry(repository.key)?.projectCommands) return fail("SETUP_SOURCE_CONFLICT");
  for (const root of worktrees.filter(root => root !== repository.root)) {
    try { lstatSync(join(root, ".pa", "project-commands.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return fail("SETUP_SOURCE_CONFLICT"); }
    return fail("SETUP_SOURCE_CONFLICT");
  }
  try {
    const parent = join(repository.root, ".pa");
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || realpathSync(parent) !== parent || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) return fail("SETUP_IO");
      if (readdirSync(parent).some(name => /^\.pa-setup-.*\.tmp$/.test(name))) return fail("SETUP_IO");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const current = inspectLocalProjectCommandCatalogue(repository.key, repository.root);
    return current ? reference(repository, current.sha256) : null;
  } catch (error) { if (error instanceof RepoSetupError) throw error; return fail("SETUP_CANDIDATE"); }
}
/** Only candidate data at one fixed path. No command probe, approval, ignore
 * effect, credential, source/Git write, executable run or dispatch is provided.
 * Uncertain temporary/publication state is retained for operator reconciliation.
 */
export function repoSetupService(request: string, host: RepoSetupHost): Record<string, unknown> {
  try {
    if (typeof request !== "string" || !request.length || Buffer.byteLength(request) > MAX_REPO_SETUP_REQUEST_BYTES) return fail("SETUP_REQUEST");
    let parsed: unknown;
    try { parsed = parseReviewEvidenceJson(Buffer.from(request), "repository setup"); } catch { return fail("SETUP_REQUEST"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("SETUP_REQUEST");
    const action = (parsed as Record<string, unknown>).action;
    const row = object(parsed, action === "inspect" ? ["action"] : ["action", "expected", "candidate"]);
    if (action !== "inspect" && action !== "stage") return fail("SETUP_REQUEST");
    const repository = authenticate(host);
    const expected = action === "stage" ? parseReference(row.expected, repository) : null;
    let bytes: Buffer | undefined;
    if (action === "stage") {
      if (typeof row.candidate !== "string" || Buffer.byteLength(row.candidate) > MAX_PROJECT_COMMAND_CATALOGUE_BYTES) return fail("SETUP_REQUEST");
      bytes = Buffer.from(row.candidate);
      try { parseProjectCommandCatalogue(bytes, repository); } catch { return fail("SETUP_CANDIDATE"); }
    }
    let entered = false;
    try {
      return withPreparedTicketCapacity({ canonicalRepoKey: repository.key, canonicalRepoRoot: repository.root }, capacity =>
        withVacantRepositorySetup(repository.root, capacity, worktrees => {
          entered = true; authenticate(host, repository); gitUntracked(repository);
          const current = source(repository, worktrees);
          if (action === "inspect") return { ok: true, state: current ? "candidate-unapproved" : "missing", candidate: current, executionReady: false };
          if (!same(current, expected)) return fail("SETUP_STALE");
          const file = join(repository.root, PROJECT_COMMAND_CATALOGUE_PATH), parent = dirname(file);
          const rootStat = lstatSync(repository.root), fileIdentity = current ? snapshot(lstatSync(file)) : null;
          try { mkdirSync(parent, { mode: 0o700 }); syncDirectory(repository.root); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          const parentStat = lstatSync(parent);
          if (!parentStat.isDirectory() || realpathSync(parent) !== parent || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o7777) !== 0o700) return fail("SETUP_IO");
          const temporary = join(parent, `.pa-setup-${randomUUID()}.tmp`);
          const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, bytes!); fsyncSync(fd); } finally { closeSync(fd); }
          // All cooperating writers are still excluded. Reobserve authority,
          // registration, bytes, index and physical parents immediately before
          // publication. Never chmod/repair/adopt an existing insecure object.
          authenticate(host, repository); gitUntracked(repository);
          if (lstatSync(repository.root).dev !== rootStat.dev || lstatSync(repository.root).ino !== rootStat.ino
            || realpathSync(parent) !== parent || lstatSync(parent).ino !== parentStat.ino || lstatSync(parent).dev !== parentStat.dev) return fail("SETUP_IO");
          const observed = inspectLocalProjectCommandCatalogue(repository.key, repository.root);
          if (!same(observed ? reference(repository, observed.sha256) : null, expected)) return fail("SETUP_STALE");
          const stagedStat = lstatSync(temporary);
          if (!stagedStat.isFile() || stagedStat.nlink !== 1 || stagedStat.uid !== process.getuid?.() || (stagedStat.mode & 0o7777) !== 0o600
            || !Buffer.from(readReviewEvidenceFile(temporary, MAX_PROJECT_COMMAND_CATALOGUE_BYTES, "setup staged candidate")).equals(bytes!)
            || snapshot(lstatSync(temporary)) !== snapshot(stagedStat)) return fail("SETUP_IO");
          if (expected === null) { linkSync(temporary, file); unlinkSync(temporary); }
          else {
            if (snapshot(lstatSync(file)) !== fileIdentity) return fail("SETUP_STALE");
            renameSync(temporary, file);
          }
          syncDirectory(parent);
          const written = source(repository, worktrees), digest = parseProjectCommandCatalogue(bytes!, repository).sha256;
          if (!written || written.sha256 !== digest) return fail("SETUP_IO");
          authenticate(host, repository); gitUntracked(repository);
          return { ok: true, state: "candidate-unapproved", candidate: written, executionReady: false };
        }));
    } catch (error) { if (error instanceof RepoSetupError) throw error; return fail(entered ? "SETUP_IO" : "SETUP_BUSY"); }
  } catch (error) {
    return { ok: false, error: { code: error instanceof RepoSetupError ? error.code : "SETUP_IO" }, executionReady: false };
  }
}
