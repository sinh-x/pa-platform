import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { evaluateSafetyPolicy } from "../safety-policy.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Lower native file boundary extracted from retained execution. SDK edit
 * matching/queues remain with the SDK; paths require no plan or catalogue. */
export class AdvisoryFiles {
  uncertain = false;
  constructor(readonly root: string) {}
  assertPath(path: string, directoryOnly = false): string {
    if (typeof path !== "string" || !path || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => part === ".." || part.toLowerCase() === ".git")) throw new Error("OPERATION_PATH_DENIED");
    const absolute = isAbsolute(path) ? path : resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if ((!rel && !directoryOnly) || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !evaluateSafetyPolicy({ kind: "path", value: absolute }, { cwd: this.root }).allowed) throw new Error("OPERATION_PATH_DENIED");
    return rel;
  }
  file(path: string, content?: string, directoryOnly = false): Buffer | void {
    const rel = this.assertPath(path, directoryOnly);
    if (!rel && directoryOnly) return;
    if (content !== undefined && Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("OPERATION_FILE_LIMIT");
    let directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parts = rel.split("/"), ancestors = directoryOnly ? parts : parts.slice(0, -1);
    try {
      for (const part of ancestors) {
        const anchored = `/proc/self/fd/${directory}/${part}`;
        if (directoryOnly) {
          try { mkdirSync(anchored); fsyncSync(directory); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") { this.uncertain = true; throw error; } }
        }
        const next = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(directory); directory = next;
      }
      if (directoryOnly) { fsyncSync(directory); return; }
      const target = `/proc/self/fd/${directory}/${parts.at(-1)}`;
      let mode = 0o644;
      let fd: number | undefined;
      try {
        fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("OPERATION_FILE_DENIED");
        mode = stat.mode & 0o777;
        if (content === undefined) {
          const chunks: Buffer[] = []; let size = 0;
          for (;;) {
            const buffer = Buffer.alloc(64 * 1024), count = readSync(fd, buffer);
            if (!count) return Buffer.concat(chunks);
            size += count; if (size > MAX_FILE_BYTES) throw new Error("OPERATION_FILE_LIMIT"); chunks.push(buffer.subarray(0, count));
          }
        }
      } catch (error) { if (content === undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
      const temporary = `/proc/self/fd/${directory}/.pa-write-${randomUUID()}`;
      let created = false;
      try {
        const out = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); created = true;
        try { writeFileSync(out, content!); fsyncSync(out); } finally { closeSync(out); }
        this.uncertain = true;
        renameSync(temporary, target); created = false; fsyncSync(directory);
        this.uncertain = false;
      } finally { if (created) unlinkSync(temporary); }
    } finally { closeSync(directory); }
  }
}
