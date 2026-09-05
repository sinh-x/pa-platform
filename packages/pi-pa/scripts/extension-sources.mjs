import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LOCK_FILENAME = "extension-sources.lock.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

function normalizedPath(root, path) {
  const absolute = resolve(root, path);
  const child = relative(root, absolute);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`Source path escapes pi-pa package root: ${path}`);
  }
  return absolute;
}

export function readSourceLock(packageRoot = PACKAGE_ROOT) {
  const lockPath = resolve(packageRoot, LOCK_FILENAME);
  if (!existsSync(lockPath)) throw new Error(`Missing Pi extension source lock: ${lockPath}`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources) || lock.sources.length !== 2) {
    throw new Error(`${LOCK_FILENAME} must record exactly two schema-v1 sources.`);
  }
  for (const source of lock.sources) {
    if (!source || typeof source !== "object" || typeof source.name !== "string") {
      throw new Error(`${LOCK_FILENAME} contains an invalid source record.`);
    }
    for (const field of ["repository", "submodulePath", "sourcePath", "entrypoint", "commit", "contentSha256", "bundle"]) {
      if (typeof source[field] !== "string" || source[field].length === 0) {
        throw new Error(`${LOCK_FILENAME} source ${source.name} has invalid ${field}.`);
      }
    }
    if (!SHA_PATTERN.test(source.commit)) throw new Error(`${source.name} commit must be an exact 40-character lowercase SHA.`);
  }
  return lock;
}

function hashEntry(hash, root, path) {
  const stat = lstatSync(path);
  const name = relative(root, path).split(sep).join("/");
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(readlinkSync(path), "utf8");
    hash.update(`link\0${name}\0${target.length}\0`);
    hash.update(target);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
      hashEntry(hash, root, resolve(path, entry.name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported source entry: ${path}`);
  const content = readFileSync(path);
  const executable = (stat.mode & 0o111) === 0 ? "file" : "exec";
  hash.update(`${executable}\0${name}\0${content.length}\0`);
  hash.update(content);
}

export function sourceContentSha256(sourceRoot) {
  if (!existsSync(sourceRoot)) throw new Error(`Missing Pi extension source: ${sourceRoot}`);
  const hash = createHash("sha256");
  hashEntry(hash, sourceRoot, sourceRoot);
  return hash.digest("hex");
}

function assertGitSource(packageRoot, repositoryRoot, source) {
  const superprojectPath = relative(repositoryRoot, normalizedPath(packageRoot, source.submodulePath)).split(sep).join("/");
  const configuredUrl = runGit(repositoryRoot, ["config", "-f", ".gitmodules", "--get", `submodule.${superprojectPath}.url`]);
  if (configuredUrl !== source.repository) {
    throw new Error(`${source.name} submodule URL drifted: expected ${source.repository}, found ${configuredUrl ?? "missing"}.`);
  }
  const indexEntry = runGit(repositoryRoot, ["ls-files", "--stage", "--", superprojectPath]);
  const match = indexEntry?.match(/^160000 ([0-9a-f]{40}) 0\t/);
  if (!match || match[1] !== source.commit) {
    throw new Error(`${source.name} gitlink drifted: expected ${source.commit}, found ${match?.[1] ?? "missing"}.`);
  }
  const submoduleRoot = normalizedPath(packageRoot, source.submodulePath);
  const head = runGit(submoduleRoot, ["rev-parse", "HEAD"]);
  if (head !== source.commit) {
    throw new Error(`${source.name} checkout drifted: expected ${source.commit}, found ${head ?? "missing or uninitialized"}.`);
  }
  const status = runGit(submoduleRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]);
  if (status === undefined) throw new Error(`${source.name} checkout is missing or unreadable: ${submoduleRoot}.`);
  if (status.length > 0) throw new Error(`${source.name} checkout has local source drift; restore the exact clean submodule before building.`);
}

export function validateExtensionSources({ packageRoot = PACKAGE_ROOT } = {}) {
  const lock = readSourceLock(packageRoot);
  const repositoryRoot = runGit(packageRoot, ["rev-parse", "--show-toplevel"]);
  for (const source of lock.sources) {
    const sourceRoot = normalizedPath(packageRoot, source.sourcePath);
    const entrypoint = normalizedPath(packageRoot, source.entrypoint);
    if (!existsSync(entrypoint)) {
      throw new Error(`Missing ${source.name} entrypoint: ${entrypoint}. Run git submodule update --init --recursive.`);
    }
    if (repositoryRoot) assertGitSource(packageRoot, repositoryRoot, source);
    const digest = sourceContentSha256(sourceRoot);
    if (digest !== source.contentSha256) {
      throw new Error(`${source.name} content drifted: expected sha256:${source.contentSha256}, found sha256:${digest}.`);
    }
  }
  return lock;
}
