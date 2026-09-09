import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LOCK_FILENAME = "extension-sources.lock.json";
export const PLUGIN_SELECTION_ENV = "PI_PA_PLUGIN_SELECTION";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_NAME_PATTERN = /^[a-z0-9-]+$/;

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

export function normalizePluginSelection(lock, selection = {}) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error(`${PLUGIN_SELECTION_ENV} must be a JSON object mapping reviewed plugin names to booleans.`);
  }
  const eligibleNames = new Set(lock.sources.map(({ name }) => name));
  for (const name of Object.keys(selection)) {
    if (!eligibleNames.has(name)) {
      throw new Error(`${PLUGIN_SELECTION_ENV} contains unknown reviewed plugin ${name}.`);
    }
  }
  const normalized = {};
  for (const { name } of lock.sources) {
    const enabled = Object.hasOwn(selection, name) ? selection[name] : false;
    if (typeof enabled !== "boolean") {
      throw new Error(`${PLUGIN_SELECTION_ENV} value for ${name} must be a boolean, received ${typeof enabled}.`);
    }
    normalized[name] = enabled;
  }
  return Object.freeze(normalized);
}

export function readPluginSelection(lock, { environment = process.env } = {}) {
  const encoded = environment[PLUGIN_SELECTION_ENV];
  if (encoded === undefined) return normalizePluginSelection(lock);
  let selection;
  try {
    selection = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`${PLUGIN_SELECTION_ENV} must contain valid JSON: ${error.message}`);
  }
  return normalizePluginSelection(lock, selection);
}

export function selectedExtensionSources(lock, selection) {
  const normalized = normalizePluginSelection(lock, selection);
  return lock.sources
    .filter(({ name }) => normalized[name])
    .toSorted((left, right) => left.registrationOrder - right.registrationOrder);
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
    for (const field of ["version", "import", "importTarget", "repository", "submodulePath", "sourcePath", "entrypoint", "commit", "contentSha256", "license", "licensePath", "licenseSha256", "bundle"]) {
      if (typeof source[field] !== "string" || source[field].length === 0) {
        throw new Error(`${LOCK_FILENAME} source ${source.name} has invalid ${field}.`);
      }
    }
    if (!Number.isSafeInteger(source.registrationOrder) || source.registrationOrder < 0) {
      throw new Error(`${LOCK_FILENAME} source ${source.name} has invalid registrationOrder.`);
    }
    if (!SOURCE_NAME_PATTERN.test(source.name)) throw new Error(`${source.name} is not a safe source name.`);
    if (!SHA_PATTERN.test(source.commit)) throw new Error(`${source.name} commit must be an exact 40-character lowercase SHA.`);
    if (!SHA256_PATTERN.test(source.contentSha256) || !SHA256_PATTERN.test(source.licenseSha256)) {
      throw new Error(`${source.name} content and license digests must be lowercase SHA-256 values.`);
    }
  }
  if (new Set(lock.sources.map((source) => source.import)).size !== lock.sources.length) {
    throw new Error(`${LOCK_FILENAME} source imports must be unique.`);
  }
  if (new Set(lock.sources.map((source) => source.registrationOrder)).size !== lock.sources.length) {
    throw new Error(`${LOCK_FILENAME} source registrationOrder values must be unique.`);
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

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    const licensePath = normalizedPath(packageRoot, source.licensePath);
    if (!existsSync(entrypoint)) {
      throw new Error(`Missing ${source.name} entrypoint: ${entrypoint}. Run git submodule update --init --recursive.`);
    }
    if (!existsSync(licensePath)) throw new Error(`Missing ${source.name} license: ${licensePath}.`);
    if (repositoryRoot) assertGitSource(packageRoot, repositoryRoot, source);
    const manifest = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
    if (manifest.version !== source.version || manifest.license !== source.license) {
      throw new Error(`${source.name} package identity drifted: expected ${source.version}/${source.license}, found ${manifest.version ?? "missing"}/${manifest.license ?? "missing"}.`);
    }
    const licenseDigest = fileSha256(licensePath);
    if (licenseDigest !== source.licenseSha256) {
      throw new Error(`${source.name} license drifted: expected sha256:${source.licenseSha256}, found sha256:${licenseDigest}.`);
    }
    const digest = sourceContentSha256(sourceRoot);
    if (digest !== source.contentSha256) {
      throw new Error(`${source.name} content drifted: expected sha256:${source.contentSha256}, found sha256:${digest}.`);
    }
  }
  return lock;
}
