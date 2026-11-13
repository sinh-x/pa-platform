import fs, { type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { assertLocalFileSource, MAX_LOCAL_SECURITY_BYTES, SourceContentSecurityError } from "./source-content-security.js";
import type { SensitivePatternSet } from "./sensitive-patterns.js";

/** Owned acquisition, not artifact adoption or permission to publish raw bytes.
 * Call assertStable immediately before delivery and close in finally. No multi-
 * link exception exists here: selected-host provenance remains a separate gate. */
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

/** Linux descriptor-pinned, bounded, regular/single-link general source ingress.
 * Logical single-link aliases retain their path checks; no physical component
 * symlink is followed. No caller root, filesystem backend or trust override. */
export function acquireLocalSourceFile(path: string, patterns?: SensitivePatternSet, signal?: AbortSignal): LocalSourceFile {
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
    assertLocalFileSource(path, patterns);
    const physical = fs.realpathSync(path);
    assertLocalFileSource(physical, patterns);
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
    if (before.nlink !== 1n) fail("LOCAL_SOURCE_UNSUPPORTED_FILE");
    if (before.size > BigInt(MAX_LOCAL_SECURITY_BYTES)) fail("LOCAL_CONTENT_LIMIT");
    const assertStable = () => {
      try {
        if (closed || signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE");
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
    return { bytes: bytes.subarray(0, length), assertStable, close };
  } catch (error) {
    close();
    return unavailable(error);
  }
}
