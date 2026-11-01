import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getPlatformHomeDir, getTeamsDir } from "./paths.js";
import { readReviewEvidenceFile } from "./validation/review-contract.js";

const MAX_BYTES = 1_048_576, MAX_FILES = 256, MAX_TOTAL = 16 * MAX_BYTES;
// Verified immutable objects only, never selection/working bytes, compatibility,
// authority or results. The commit and physical selection are reread each time.
const objectCache = new Map<string, Buffer>();
let cachedBytes = 0;
export class SelectedConfigError extends Error {
  constructor(readonly kind: "identity" | "resource" | "drift" | "limit") { super(`Selected config ${kind} cannot be authenticated`); }
}
function fail(kind: SelectedConfigError["kind"]): never { throw new SelectedConfigError(kind); }
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectId = (kind: string, bytes: Uint8Array) => createHash("sha1").update(`${kind} ${bytes.byteLength}\0`).update(bytes).digest("hex");
function text(bytes: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("resource"); } }
function physicalRead(path: string, maximum = MAX_BYTES): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) fail("resource");
  return Buffer.from(readReviewEvidenceFile(path, maximum, "selected-config.resource"));
}
/** Fixed bounded metadata grammar. No ref discovery, Git hooks or current-latest fallback. */
export function configSourceHead(root: string): string {
  try {
    if (resolve(root) !== root || realpathSync(root) !== root) fail("identity");
    const marker = join(root, ".git"), stat = lstatSync(marker);
    let gitDir = marker, commonDir = marker;
    if (stat.isFile()) {
      const match = /^gitdir: (\/[^\r\n]+)\n?$/.exec(text(physicalRead(marker, 4096)));
      if (!match || resolve(match[1]!) !== match[1]) fail("identity");
      gitDir = match[1]!;
      if (!/\/worktrees\/[^/]+$/.test(gitDir) || text(physicalRead(join(gitDir, "commondir"), 128)).trimEnd() !== "../..") fail("identity");
      commonDir = dirname(dirname(gitDir));
      if (text(physicalRead(join(gitDir, "gitdir"), 4096)).trimEnd() !== marker) fail("identity");
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) fail("identity");
    if (realpathSync(gitDir) !== gitDir || realpathSync(commonDir) !== commonDir) fail("identity");
    const head = text(physicalRead(join(gitDir, "HEAD"), 4096)).trimEnd();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/heads\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..") || ref.split("/").some(part => !part || part === ".")) fail("identity");
    const path = join(commonDir, ref);
    try {
      const value = text(physicalRead(path, 128)).trimEnd();
      if (!/^[a-f0-9]{40}$/.test(value)) fail("identity");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const lines = text(physicalRead(join(commonDir, "packed-refs"))).split("\n").filter(line => line.endsWith(` ${ref}`));
    if (lines.length !== 1 || !/^[a-f0-9]{40} refs\/heads\/[A-Za-z0-9_./-]+$/.test(lines[0]!)) fail("identity");
    return lines[0]!.slice(0, 40);
  } catch { return fail("identity"); }
}
export interface ConfigResource { readonly path: string; readonly sha256: string; readonly raw: Uint8Array }
interface Observed { raw: Buffer; fingerprint: string }
/** One coherent, committed physical selection. Data only: never execution, approval or adoption. */
export class CommittedConfigSource {
  readonly revision: string;
  readonly #tree: string;
  readonly #objects = new Map<string, Buffer>();
  readonly #observed = new Map<string, Observed>();
  readonly #absent = new Set<string>();
  #total = 0;
  #objectBytes = 0;
  private constructor(readonly root: string, private readonly selected: boolean, expected?: string) {
    try {
      this.revision = configSourceHead(root);
      if (expected !== undefined && expected !== this.revision) fail("identity");
      this.assertIdentity();
      const commit = this.object("commit", this.revision);
      const tree = /^tree ([a-f0-9]{40})\n/.exec(text(commit))?.[1];
      if (!tree) fail("identity");
      this.#tree = tree;
      this.assertIdentity();
    } catch (error) { if (error instanceof SelectedConfigError) throw error; fail("identity"); }
  }
  static selected(): CommittedConfigSource { return new CommittedConfigSource(getPlatformHomeDir(), true); }
  /** Trusted source/qualification owner seam, never a public path or revision override. */
  static at(root: string, revision?: string): CommittedConfigSource { return new CommittedConfigSource(root, false, revision); }
  private assertIdentity(): void {
    if (configSourceHead(this.root) !== this.revision) fail("drift");
    if (this.selected && (getPlatformHomeDir() !== this.root || getTeamsDir() !== join(this.root, "teams") || realpathSync(getTeamsDir()) !== getTeamsDir())) fail("identity");
  }
  private remember(key: string, raw: Buffer): Buffer {
    if (this.#objects.size >= 1024 || this.#objectBytes + raw.length > 32 * MAX_BYTES) fail("limit");
    this.#objects.set(key, raw); this.#objectBytes += raw.length; return raw;
  }
  private object(kind: "commit" | "tree" | "blob", id: string): Buffer {
    const key = `${kind}:${id}`, cached = this.#objects.get(key); if (cached) return cached;
    const sharedKey = `${this.root}:${key}`, shared = kind === "commit" ? undefined : objectCache.get(sharedKey);
    if (shared) return this.remember(key, shared);
    const env = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
    const raw = execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-C", this.root, "cat-file", kind, id], {
      env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeout: 5000, maxBuffer: MAX_BYTES + 1, stdio: ["ignore", "pipe", "ignore"],
    });
    if (raw.length > MAX_BYTES || objectId(kind, raw) !== id) fail("resource");
    if (kind !== "commit") {
      while (objectCache.size && (objectCache.size >= 1024 || cachedBytes + raw.length > 32 * MAX_BYTES)) {
        const [oldKey, old] = objectCache.entries().next().value!; objectCache.delete(oldKey); cachedBytes -= old.length;
      }
      objectCache.set(sharedKey, raw); cachedBytes += raw.length;
    }
    return this.remember(key, raw);
  }
  private blob(relative: string): Buffer | null {
    let tree = this.#tree;
    const parts = relative.split("/");
    for (let i = 0; i < parts.length; i++) {
      const raw = this.object("tree", tree), seen = new Set<string>();
      let offset = 0, found: { mode: string; id: string } | undefined;
      while (offset < raw.length) {
        const space = raw.indexOf(32, offset), nul = raw.indexOf(0, space + 1);
        if (space < offset || nul < space || nul + 21 > raw.length) fail("resource");
        const mode = raw.subarray(offset, space).toString("ascii"), name = raw.subarray(space + 1, nul), key = name.toString("hex");
        if (seen.has(key) || !name.length || name.includes(47)) fail("resource"); seen.add(key);
        const id = raw.subarray(nul + 1, nul + 21).toString("hex"); offset = nul + 21;
        if (name.equals(Buffer.from(parts[i]!))) found = { mode, id };
      }
      if (!found) return null;
      if (i === parts.length - 1) {
        if (found.mode !== "100644" && found.mode !== "100755") fail("resource");
        return this.object("blob", found.id);
      }
      if (found.mode !== "40000") fail("resource"); tree = found.id;
    }
    return fail("resource");
  }
  private path(relative: string): string {
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.length > 4096 || relative.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || relative.split("/").length > 16) fail("resource");
    const parts = relative.split("/"); let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try { const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) fail("resource"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
    return join(this.root, relative);
  }
  private fingerprint(path: string): string { const s = lstatSync(path, { bigint: true }); return [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs, s.nlink].join(":"); }
  read(relative: string, optional = false): Uint8Array | null {
    try {
      const path = this.path(relative); this.assertIdentity();
      const committed = this.blob(relative);
      let present = true;
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
      if (!committed && !present && optional) { if (!this.#absent.has(relative) && this.#absent.size + this.#observed.size >= MAX_FILES) fail("limit"); this.#absent.add(relative); return null; }
      if (!committed || !present) fail("resource");
      const before = this.fingerprint(path), raw = physicalRead(path);
      if (before !== this.fingerprint(path) || !raw.equals(committed)) fail("resource");
      const previous = this.#observed.get(relative);
      if (previous && (previous.fingerprint !== before || !previous.raw.equals(raw))) fail("drift");
      if (!previous) {
        if (this.#observed.size >= MAX_FILES || this.#total + raw.length > MAX_TOTAL) fail("limit");
        this.#total += raw.length; this.#observed.set(relative, { raw, fingerprint: before });
      }
      return Buffer.from(raw);
    } catch (error) { if (error instanceof SelectedConfigError) throw error; return fail("resource"); }
  }
  assertCurrent(): void {
    try {
      this.assertIdentity();
      for (const [relative, observed] of this.#observed) {
        const path = this.path(relative);
        if (this.fingerprint(path) !== observed.fingerprint || !physicalRead(path).equals(observed.raw)) fail("drift");
      }
      for (const relative of this.#absent) {
        try { lstatSync(this.path(relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        fail("drift");
      }
      this.assertIdentity();
    } catch (error) { if (error instanceof SelectedConfigError) throw error; fail("drift"); }
  }
  absentResources(): string[] { this.assertCurrent(); return [...this.#absent].sort(); }
  resources(): ConfigResource[] { this.assertCurrent(); return [...this.#observed].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => ({ path, sha256: sha256(value.raw), raw: Buffer.from(value.raw) })); }
}
