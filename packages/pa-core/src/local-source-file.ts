import fs, { type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { assertImmutableDocumentText, assertSelectedPiDocumentPath, type SelectedPiDocumentBinding } from "./immutable-document-policy.js";
import { assertLocalFileSource, MAX_LOCAL_SECURITY_BYTES, SourceContentSecurityError } from "./source-content-security.js";
import type { SensitivePatternSet } from "./sensitive-patterns.js";

/** Owned acquisition, not artifact adoption or permission to publish raw bytes.
 * Call assertStable immediately before delivery and close in finally. Ordinary
 * ingress is single-link; selected-host provenance is a separate consumer gate. */
export interface LocalSourceFile {
  readonly bytes: Buffer;
  assertStable(): void;
  close(): void;
}
const fail = (code: "LOCAL_SOURCE_UNAVAILABLE" | "LOCAL_SOURCE_UNSUPPORTED_FILE" | "LOCAL_CONTENT_LIMIT"): never => {
  throw new SourceContentSecurityError(code);
};
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  // Mutable ordinary parents may gain unrelated entries while we read. Their
  // entry timestamps aren't a source-file identity; owner/mode/inode still are.
  return b.isDirectory() && a.dev === b.dev && a.ino === b.ino
    && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function unavailable(error: unknown): never {
  if (error instanceof SourceContentSecurityError) throw error;
  return fail("LOCAL_SOURCE_UNAVAILABLE");
}

/** Facts for the ordinary immutable-store route. Decision input only; the
 * descriptor-pinned caller supplies them from the descriptors it owns. */
export interface ImmutableSourceFacts {
  readonly path: string;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly mode: bigint;
}

/** Ordinary multi-link ingress is limited to an exact `/nix/store` spelling whose
 * whole ancestry is root-owned and not writable. This is a source-integrity
 * route, not an origin or confidentiality grant: sensitive path/filename rules
 * still run, matched content is still redacted, and the bytes must be text.
 * Pure so the policy decision is testable without a writable Nix store. */
export function assertImmutableStoreSource(physical: string, logical: string, ancestors: readonly ImmutableSourceFacts[], file: ImmutableSourceFacts): void {
  if (physical !== logical || !physical.startsWith("/nix/store/")) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
  for (const entry of [...ancestors, file]) {
    if (entry.uid !== 0n || entry.nlink === 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    if (entry.path === "/nix/store") {
      if ((entry.mode & 0o022n) !== 0n && !((entry.mode & 0o1000n) !== 0n && (entry.mode & 0o002n) === 0n)) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    } else if (entry.path.startsWith("/nix/store/")) {
      if ((entry.mode & 0o222n) !== 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    } else if ((entry.mode & 0o022n) !== 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
  }
}

/** Linux descriptor-pinned, bounded, regular-file source ingress. Ordinary links
 * are accepted only as a single link or as an exact immutable `/nix/store` text
 * file. Other aliases retain their path checks; no physical component symlink is
 * followed. No caller root, filesystem backend or trust override. */
export function acquireLocalSourceFile(path: string, patterns?: SensitivePatternSet, signal?: AbortSignal): LocalSourceFile {
  return acquirePinnedSource(path, patterns, signal);
}

/** Internal selected-host ingress mechanics. The binding is not provenance by
 * itself: only the native fixed-build producer may supply it to its private
 * consumer. Ordinary tools never accept roots/bindings or use this route. */
export function acquireSelectedPiDocument(path: string, binding: SelectedPiDocumentBinding, patterns?: SensitivePatternSet, signal?: AbortSignal): LocalSourceFile {
  return acquirePinnedSource(path, patterns, signal, binding);
}

function acquirePinnedSource(path: string, patterns?: SensitivePatternSet, signal?: AbortSignal, binding?: SelectedPiDocumentBinding): LocalSourceFile {
  const directories: Array<{ fd: number; path: string; name: string; stat: BigIntStats }> = [];
  const ownedDirectories: number[] = [];
  let fd: number | undefined, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Attempt every close even if one fails; never replace a denial with content.
    let failed = false;
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { failed = true; } }
    for (let index = ownedDirectories.length - 1; index >= 0; index--) {
      try { fs.closeSync(ownedDirectories[index]!); } catch { failed = true; }
    }
    if (failed) fail("LOCAL_SOURCE_UNAVAILABLE");
  };
  try {
    if (signal?.aborted || process.platform !== "linux") fail("LOCAL_SOURCE_UNAVAILABLE");
    if (binding) { binding.assertStable(); assertSelectedPiDocumentPath(path, binding.packageRoot); }
    assertLocalFileSource(path, patterns);
    const physical = fs.realpathSync(path);
    assertLocalFileSource(physical, patterns);
    const immutableMetadata = (entry: string, observed: BigIntStats) => {
      if (!binding) return;
      if (observed.uid !== 0n || observed.nlink === 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
      if (entry === "/nix/store") {
        if ((observed.mode & 0o022n) !== 0n && !((observed.mode & 0o1000n) !== 0n && (observed.mode & 0o002n) === 0n)) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
      } else if (entry.startsWith("/nix/store/")) {
        if ((observed.mode & 0o222n) !== 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
      } else if ((observed.mode & 0o022n) !== 0n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    };
    const root = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    ownedDirectories.push(root);
    directories.push({ fd: root, path: "/", name: "", stat: fs.fstatSync(root, { bigint: true }) });
    let parent = root, current = "";
    for (const name of dirname(physical).split("/").filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${parent}/${name}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      // Register ownership before any observation that can fail.
      ownedDirectories.push(next);
      directories.push({ fd: next, path: current += `/${name}`, name, stat: fs.fstatSync(next, { bigint: true }) });
      parent = next;
    }
    fd = fs.openSync(`/proc/self/fd/${parent}/${basename(physical)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    if (before.nlink === 0n) fail("LOCAL_SOURCE_UNAVAILABLE");
    if (before.nlink !== 1n) {
      // Decide the link route on the very descriptor whose bytes are acquired.
      // Single-link aliases/images retain ordinary behavior; only the multi-
      // link routes require exact spelling, immutable ancestry and text bytes.
      if (physical !== path) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
      if (binding) {
        immutableMetadata(physical, before);
        for (const directory of directories) immutableMetadata(directory.path, directory.stat);
      } else {
        assertImmutableStoreSource(physical, path,
          directories.map(directory => ({ path: directory.path, uid: directory.stat.uid, nlink: directory.stat.nlink, mode: directory.stat.mode })),
          { path: physical, uid: before.uid, nlink: before.nlink, mode: before.mode });
      }
    }
    if (before.size > BigInt(MAX_LOCAL_SECURITY_BYTES)) fail("LOCAL_CONTENT_LIMIT");
    const assertStable = () => {
      try {
        if (closed || signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE");
        if (binding) { binding.assertStable(); assertSelectedPiDocumentPath(path, binding.packageRoot); }
        assertLocalFileSource(path, patterns);
        assertLocalFileSource(physical, patterns);
        if (fs.realpathSync(path) !== physical) fail("LOCAL_SOURCE_UNAVAILABLE");
        for (let index = 0; index < directories.length; index++) {
          const directory = directories[index]!;
          if (!sameDirectory(directory.stat, fs.fstatSync(directory.fd, { bigint: true }))
            || fs.realpathSync(`/proc/self/fd/${directory.fd}`) !== directory.path) fail("LOCAL_SOURCE_UNAVAILABLE");
          if (index && !sameDirectory(directory.stat, fs.lstatSync(`/proc/self/fd/${directories[index - 1]!.fd}/${directory.name}`, { bigint: true }))) fail("LOCAL_SOURCE_UNAVAILABLE");
        }
        const after = fs.fstatSync(fd!, { bigint: true });
        if (after.size > BigInt(MAX_LOCAL_SECURITY_BYTES)) fail("LOCAL_CONTENT_LIMIT");
        if (!sameFile(before, after) || !sameFile(before, fs.lstatSync(`/proc/self/fd/${parent}/${basename(physical)}`, { bigint: true }))) fail("LOCAL_SOURCE_UNAVAILABLE");
      } catch (error) { unavailable(error); }
    };
    // Validate path association before reading, not only before publication.
    assertStable();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      if (signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE");
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    assertStable();
    if (length !== Number(before.size)) fail("LOCAL_SOURCE_UNAVAILABLE");
    const complete = bytes.subarray(0, length);
    if (before.nlink > 1n) assertImmutableDocumentText(complete);
    assertStable();
    return { bytes: complete, assertStable, close };
  } catch (error) {
    close();
    return unavailable(error);
  }
}
