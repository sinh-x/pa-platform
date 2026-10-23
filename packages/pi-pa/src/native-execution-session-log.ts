import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { workflowError } from "@pa-platform/pa-core";

export const MAX_EXECUTION_SESSION_LOG_BYTES = 512 * 1024;
export interface ExecutionLogIdentity { readonly deploymentId: string; readonly ticket: string; readonly aiUsageRoot?: string; readonly sourceRoots?: readonly string[] }

/** A lexical self-namespace, not a caller-selected write root. The root comes
 * from the authenticated deployment directory; alias checks happen at IO. */
export function ownExecutionSessionLog(path: string, identity: ExecutionLogIdentity): string | null {
  const root = identity.aiUsageRoot;
  if (!root || !isAbsolute(root) || typeof path !== "string" || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
  const rel = isAbsolute(path) ? relative(root, path) : path;
  if (path !== (isAbsolute(path) ? join(root, rel) : rel)) return null;
  for (const source of identity.sourceRoots ?? []) {
    const fromSource = relative(source, join(root, rel));
    if (fromSource === "" || (fromSource !== ".." && !fromSource.startsWith("../") && !isAbsolute(fromSource))) return null;
  }
  const match = /^sessions\/(\d{4})\/(\d{2})\/agent-team\/(\d{4}-\d{2}-\d{2})-(d-[a-f0-9]{6})-builder--(?:builder-agent|team-manager)--([A-Z][A-Z0-9]*-\d+)--[a-z0-9][a-z0-9-]{0,100}\.md$/.exec(rel);
  if (!match || match[3]!.slice(0, 4) !== match[1] || match[3]!.slice(5, 7) !== match[2]
    || match[4] !== identity.deploymentId || match[5] !== identity.ticket
    || !Number.isFinite(Date.parse(`${match[3]}T00:00:00Z`)) || new Date(`${match[3]}T00:00:00Z`).toISOString().slice(0, 10) !== match[3]) return null;
  return rel;
}
function sameInode(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateFile(fd: number): ReturnType<typeof fstatSync> {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_EXECUTION_SESSION_LOG_BYTES) throw workflowError();
  return stat;
}
function withParent<T>(identity: ExecutionLogIdentity, rel: string, create: boolean, action: (parent: number, name: string) => T): T {
  if (ownExecutionSessionLog(rel, identity) !== rel || realpathSync(identity.aiUsageRoot!) !== identity.aiUsageRoot) throw workflowError();
  let directory = openSync(identity.aiUsageRoot!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parts = rel.split("/");
  try {
    for (const part of parts.slice(0, -1)) {
      const parentStat = fstatSync(directory);
      if ((parentStat.mode & 0o022) || (process.getuid && parentStat.uid !== process.getuid())) throw workflowError();
      const path = `/proc/self/fd/${directory}/${part}`;
      if (create) {
        try { mkdirSync(path, { mode: 0o700 }); fsyncSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const next = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(directory); directory = next;
    }
    const stat = fstatSync(directory);
    if ((stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw workflowError();
    return action(directory, parts.at(-1)!);
  } finally { closeSync(directory); }
}
function readPinned(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = privateFile(fd); const buffer = Buffer.alloc(MAX_EXECUTION_SESSION_LOG_BYTES + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const after = privateFile(fd); const current = lstatSync(path);
    if (length > MAX_EXECUTION_SESSION_LOG_BYTES || length !== after.size || !sameInode(before, after) || !sameInode(after, current) || current.isSymbolicLink()
      || current.nlink !== 1 || (current.mode & 0o777) !== 0o600 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw workflowError();
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
export function assertOwnExecutionSessionLog(identity: ExecutionLogIdentity, rel: string): void {
  withParent(identity, rel, false, (parent, name) => { readPinned(`/proc/self/fd/${parent}/${name}`); });
}
/** Publish a complete private file without replacement. Only byte-identical
 * retry is allowed. No chmod/repair, hardlink adoption or arbitrary directory. */
export function writeOwnExecutionSessionLog(identity: ExecutionLogIdentity, rel: string, content: string): void {
  const bytes = Buffer.from(content);
  if (!bytes.length || bytes.length > MAX_EXECUTION_SESSION_LOG_BYTES) throw workflowError();
  withParent(identity, rel, true, (parent, name) => {
    const target = `/proc/self/fd/${parent}/${name}`;
    const temp = `/proc/self/fd/${parent}/.pa-session-log-${randomUUID()}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const owned = fstatSync(fd);
    try {
      writeFileSync(fd, bytes); fsyncSync(fd);
      try { linkSync(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally {
      closeSync(fd);
      // Never remove an entry that no longer names our own temporary inode.
      if (!sameInode(owned, lstatSync(temp))) throw workflowError();
      unlinkSync(temp); fsyncSync(parent);
    }
    if (!readPinned(target).equals(bytes)) throw workflowError();
  });
}
