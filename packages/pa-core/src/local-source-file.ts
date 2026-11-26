import fs, { type BigIntStats } from "node:fs";
import type { LocalSourceDiagnosticReference, LocalSourceUnsupportedCause } from "./local-source-diagnostic.js";
import { basename, dirname } from "node:path";
import { assertImmutableDocumentText, assertSelectedPiDocumentPath, type SelectedPiDocumentBinding } from "./immutable-document-policy.js";
import { assertLocalFileSource, MAX_LOCAL_SECURITY_BYTES, SourceContentSecurityError, type LocalSourceFailureClass } from "./source-content-security.js";
import type { SensitivePatternSet } from "./sensitive-patterns.js";

/** Owned acquisition, not artifact adoption or permission to publish raw bytes.
 * Call assertStable immediately before delivery and close in finally. Ordinary
 * ingress mechanics do not themselves establish selected-host provenance. */
export interface LocalSourceFile {
  readonly bytes: Buffer;
  assertStable(): void;
  close(): void;
}
const fail = (code: "LOCAL_SOURCE_UNAVAILABLE" | "LOCAL_SOURCE_UNSUPPORTED_FILE" | "LOCAL_CONTENT_LIMIT", failureClass: LocalSourceFailureClass = "source-changed"): never => {
  throw new SourceContentSecurityError(code, failureClass);
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
function unavailable(error: unknown, failureClass: LocalSourceFailureClass): never {
  if (error instanceof SourceContentSecurityError) throw error;
  return fail("LOCAL_SOURCE_UNAVAILABLE", failureClass);
}

/** Linux descriptor-pinned, bounded, regular/single-link ordinary ingress.
 * A store spelling, root owner or read-only mode grants no multi-link exception.
 * Logical single-link aliases retain path checks; no physical component symlink
 * is followed. No caller root, filesystem backend or trust override. */
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
  let failureClass: LocalSourceFailureClass = "source-open";
  let reference: LocalSourceDiagnosticReference | undefined;
  let readState: "not-started" | "attempted" = "not-started";
  const withUnsupportedContext = (error: unknown): unknown => {
    if (error instanceof SourceContentSecurityError && error.code === "LOCAL_SOURCE_UNSUPPORTED_FILE" && error.unsupportedObservation) {
      return new SourceContentSecurityError(error.code, undefined, undefined, { ...error.unsupportedObservation, reference, readState });
    }
    return error;
  };
  const unsupported = (cause: LocalSourceUnsupportedCause, links?: bigint, entry?: "file" | "ancestor"): never => {
    throw new SourceContentSecurityError("LOCAL_SOURCE_UNSUPPORTED_FILE", undefined, undefined, { cause, reference, links, entry, readState });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    // Attempt every close even if one fails; never replace a denial with content.
    let failed = false;
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { failed = true; } }
    for (let index = ownedDirectories.length - 1; index >= 0; index--) {
      try { fs.closeSync(ownedDirectories[index]!); } catch { failed = true; }
    }
    if (failed) fail("LOCAL_SOURCE_UNAVAILABLE", "source-close");
  };
  try {
    if (signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE", "cancelled");
    if (process.platform !== "linux") fail("LOCAL_SOURCE_UNAVAILABLE", "unsupported-platform");
    if (binding) {
      try { binding.assertStable(); } catch (error) { unavailable(error, "read-publication"); }
      assertSelectedPiDocumentPath(path, binding.packageRoot);
    }
    const requestedReference = assertLocalFileSource(path, patterns);
    const physical = fs.realpathSync(path);
    const physicalReference = assertLocalFileSource(physical, patterns);
    if (requestedReference && physicalReference) reference = requestedReference;
    const immutableMetadata = (entry: string, observed: BigIntStats) => {
      if (!binding) return;
      const kind = entry === physical ? "file" : "ancestor";
      if (observed.uid !== 0n) unsupported("immutable-owner", undefined, kind);
      if (observed.nlink === 0n) unsupported("immutable-unlinked", undefined, kind);
      if (entry === "/nix/store") {
        if ((observed.mode & 0o022n) !== 0n && !((observed.mode & 0o1000n) !== 0n && (observed.mode & 0o002n) === 0n)) unsupported("store-directory-mode", undefined, kind);
      } else if (entry.startsWith("/nix/store/")) {
        if ((observed.mode & 0o222n) !== 0n) unsupported("store-entry-writable", undefined, kind);
      } else if ((observed.mode & 0o022n) !== 0n) unsupported("ancestor-writable", undefined, kind);
    };
    const root = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    ownedDirectories.push(root);
    failureClass = "source-stat";
    directories.push({ fd: root, path: "/", name: "", stat: fs.fstatSync(root, { bigint: true }) });
    let parent = root, current = "";
    for (const name of dirname(physical).split("/").filter(Boolean)) {
      failureClass = "source-open";
      const next = fs.openSync(`/proc/self/fd/${parent}/${name}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      // Register ownership before any observation that can fail.
      ownedDirectories.push(next);
      failureClass = "source-stat";
      directories.push({ fd: next, path: current += `/${name}`, name, stat: fs.fstatSync(next, { bigint: true }) });
      parent = next;
    }
    failureClass = "source-open";
    fd = fs.openSync(`/proc/self/fd/${parent}/${basename(physical)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    failureClass = "source-stat";
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) unsupported("not-regular");
    if (before.nlink === 0n) fail("LOCAL_SOURCE_UNAVAILABLE");
    if (before.nlink !== 1n) {
      // Only the private selected-Pi route may consider multi-link text. Its
      // finite scope/lifetime was checked above; ordinary ingress never retries
      // through that route merely because this file lives in the Nix store.
      if (!binding) unsupported("ordinary-multiple-links", before.nlink);
      if (physical !== path) unsupported("selected-alias", before.nlink);
      for (const directory of directories) immutableMetadata(directory.path, directory.stat);
      immutableMetadata(physical, before);
    }
    if (before.size > BigInt(MAX_LOCAL_SECURITY_BYTES)) fail("LOCAL_CONTENT_LIMIT");
    const assertStable = () => {
      try {
        // A failed earlier scope/lifetime recheck cannot reuse stale disclosure
        // evidence. Refresh only from the path checks this function already owns.
        reference = undefined;
        if (signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE", "cancelled");
        if (closed) fail("LOCAL_SOURCE_UNAVAILABLE");
        if (binding) {
          try { binding.assertStable(); } catch (error) { unavailable(error, "read-publication"); }
          assertSelectedPiDocumentPath(path, binding.packageRoot);
        }
        const requestedReference = assertLocalFileSource(path, patterns);
        const physicalReference = assertLocalFileSource(physical, patterns);
        if (requestedReference && physicalReference) reference = requestedReference;
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
      } catch (error) { unavailable(withUnsupportedContext(error), "source-stat"); }
    };
    // Validate path association before reading, not only before publication.
    assertStable();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    failureClass = "source-read";
    while (length < bytes.length) {
      if (signal?.aborted) fail("LOCAL_SOURCE_UNAVAILABLE", "cancelled");
      readState = "attempted";
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
    // Preserve original facts and read reach even when a repeated scope check
    // fails after reading. Only the originally admitted path may be disclosed.
    return unavailable(withUnsupportedContext(error), failureClass);
  }
}
