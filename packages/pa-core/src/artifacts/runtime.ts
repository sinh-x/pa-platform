import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openArtifactDirectory, readArtifactFile } from "./manifest.js";
import { artifactDiagnostic, assertArtifactAbsolutePath, assertArtifactEnvironment } from "./policy.js";

export type ReviewAdapter = "pi" | "opencode" | "claudecode";
export interface ReviewContext {
  adapter: ReviewAdapter; deployment: string; root: string; ownerPid: number; ownerBirth: string;
}
export const REVIEW_IDLE_MS = 900_000;
export const REVIEW_START_MS = 10_000;
export const REVIEW_STOP_MS = 5_000;
export const REVIEW_JOURNAL_BYTES = 16_777_216;
export const REVIEW_JOURNAL_EVENTS = 1024;
export const opaqueId = (): string => randomBytes(24).toString("hex");

/** Linux birth identity, including boot identity. No signal is used as a probe. */
export function processBirth(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch { return undefined; }
}

function deploymentOwner(deployment: string, adapter: ReviewAdapter, dir: string, value: string | undefined): number {
  let owner = Number(value);
  if (value === "background") {
    const name = adapter === "pi" ? "pi-supervisor.json" : "background-supervisor.json";
    try {
      const row = JSON.parse(readArtifactFile(join(dir, name), 65_536, "ARTIFACT_OWNER_CONFLICT").toString()) as Record<string, unknown>;
      if (row["deploymentId"] !== deployment || row["state"] !== "active" || row["ready"] !== true) throw new Error();
      owner = Number(row["supervisorPid"]);
    } catch { throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
  }
  // Verify a real ancestor, without reading any process environment/credentials.
  let pid = process.ppid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === owner && processBirth(pid)) return pid;
    seen.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch { break; }
  }
  throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
}

export function reviewContext(env: NodeJS.ProcessEnv = process.env): ReviewContext {
  assertArtifactEnvironment(env);
  const adapter = env["PA_ARTIFACT_ADAPTER"];
  const deployment = env["PA_DEPLOYMENT_ID"];
  const dir = env["PA_DEPLOYMENT_DIR"];
  if (!(adapter === "pi" || adapter === "opencode" || adapter === "claudecode")
      || !deployment || !/^d-[a-f0-9]{6,32}$/.test(deployment) || !dir) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
  assertArtifactAbsolutePath(dir);
  const fd = openArtifactDirectory(dir, "ARTIFACT_OWNER_CONFLICT");
  try { if (fstatSync(fd).uid !== process.getuid?.()) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
  finally { closeSync(fd); }
  const ownerPid = deploymentOwner(deployment, adapter, dir, env["PA_ARTIFACT_OWNER_PID"]);
  const ownerBirth = processBirth(ownerPid);
  if (!ownerBirth) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
  return { adapter, deployment, root: join(dir, "artifact-review-v1"), ownerPid, ownerBirth };
}

/** Exact static-stdenv output names for the two evaluated Linux targets.
 * No generic suffix/glob or mutable-path fallback is accepted. */
export function isReviewClosurePath(path: string): boolean {
  return /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-lavish-axi-static-(?:x86_64|aarch64)-unknown-linux-musl-0\.1\.67$/.test(path);
}

/** Only installed selected immutable closure. Never PATH or an env executable. */
export function selectedReviewAssets(): string {
  try {
    const closure = realpathSync(fileURLToPath(new URL("../../../../axi-tools/lavish-axi", import.meta.url)));
    if (!isReviewClosurePath(closure)) throw new Error();
    const assets = `${closure}/share/lavish-axi/review`;
    const record = JSON.parse(readReviewAsset(assets, "provenance.json").toString()) as Record<string, unknown>;
    if (record["schema"] !== "pa-lavish-adaptation/v1" || record["archiveSha256"] !== "b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd") throw new Error();
    return assets;
  } catch { throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED"); }
}

/** Exact packaged filenames only. Nix may deduplicate immutable store files
 * with hardlinks; unlike mutable companions this is not a source alias. */
export function readReviewAsset(directory: string, name: string): Buffer {
  if (!["provenance.json", "outer.html", "outer.css", "review.js"].includes(name)) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
  const parent = openArtifactDirectory(directory, "ARTIFACT_RUNTIME_REQUIRED");
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    const immutable = directory.endsWith("/share/lavish-axi/review")
      && isReviewClosurePath(directory.slice(0, -"/share/lavish-axi/review".length))
      && before.uid === 0n && (before.mode & 0o222n) === 0n
      && fstatSync(parent).uid === 0 && (fstatSync(parent).mode & 0o222) === 0;
    if (!before.isFile() || before.size > 2_097_152n || before.nlink !== 1n && !immutable
        || directory.startsWith("/nix/store/") && !immutable) throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED");
    return bytes.subarray(0, length);
  } catch { throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED"); }
  finally { if (fd !== undefined) closeSync(fd); closeSync(parent); }
}

export function privateDirectory(path: string, create = false): number {
  if (create) {
    const parent = openArtifactDirectory(dirname(path), "ARTIFACT_OWNER_CONFLICT");
    let child: number | undefined;
    try {
      const pinned = `/proc/self/fd/${parent}/${path.slice(path.lastIndexOf("/") + 1)}`;
      try { mkdirSync(pinned, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      child = openSync(pinned, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = fstatSync(child);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || realpathSync(`/proc/self/fd/${child}`) !== path) throw new Error();
      // Also finish an interrupted earlier publication (EEXIST). The child's
      // own fsync does not persist its link in this pinned parent.
      fsyncSync(parent);
      return child;
    } catch {
      if (child !== undefined) closeSync(child);
      throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    } finally { closeSync(parent); }
  }
  const fd = openArtifactDirectory(path, "ARTIFACT_OWNER_CONFLICT");
  const stat = fstatSync(fd);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    closeSync(fd); throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
  }
  return fd;
}

export function readPrivate(fd: number, name: string, cap = REVIEW_JOURNAL_BYTES): Buffer {
  const file = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n
        || stat.nlink !== 1n || stat.size > BigInt(cap)) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(file, { bigint: true });
    if (length !== Number(stat.size) || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
        || after.size !== stat.size) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
    return bytes.subarray(0, length);
  } finally { closeSync(file); }
}

/** Atomic durable replacement, only inside a pinned private directory. */
export function replacePrivate(fd: number, name: string, bytes: Uint8Array): void {
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
  const tmp = `.pending-${opaqueId()}`;
  const path = `/proc/self/fd/${fd}/${tmp}`;
  let file: number | undefined;
  try {
    file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, bytes); fsyncSync(file); closeSync(file); file = undefined;
    renameSync(path, `/proc/self/fd/${fd}/${name}`); fsyncSync(fd);
  } finally {
    if (file !== undefined) closeSync(file);
    try { unlinkSync(path); } catch { /* already published or never created */ }
  }
}
export const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Fixed packaged util-linux, independent of the supervisor's minimal env.
 * The explicit argument is a source-test seam, still restricted to immutable
 * root-owned util-linux store bytes. No environment/PATH fallback exists. */
export function reviewFlock(executable = realpathSync(fileURLToPath(new URL("../../../../artifact-review-flock", import.meta.url)))): string {
  if (!/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-util-linux-[0-9][a-zA-Z0-9.+-]*-bin\/bin\/flock$/.test(executable)) throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED");
  const parent = openArtifactDirectory(dirname(executable), "ARTIFACT_RUNTIME_REQUIRED");
  let file: number | undefined;
  try {
    file = openSync(`/proc/self/fd/${parent}/flock`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(file);
    const dir = fstatSync(parent);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o222) !== 0 || (stat.mode & 0o111) === 0
        || dir.uid !== 0 || (dir.mode & 0o222) !== 0) throw new Error();
    return executable;
  } catch { throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED"); }
  finally { if (file !== undefined) closeSync(file); closeSync(parent); }
}
export type ReviewLock = <T>(context: ReviewContext, action: (root: number) => T) => T;
export function withReviewLock<T>(context: ReviewContext, action: (root: number) => T, fixtureExecutable?: string): T {
  let executable: string;
  try { executable = reviewFlock(fixtureExecutable); }
  catch { throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED"); }
  const root = privateDirectory(context.root, true);
  let file: number | undefined;
  try {
    try {
      file = openSync(`/proc/self/fd/${root}/operation.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size !== 0) throw new Error();
      // Child fd 3 shares the parent's open-file description. flock survives
      // this child exiting, but is released by parent close/crash. Never unlink
      // or replace the lock inode, and never infer ownership from a stale PID.
      const result = spawnSync(executable, ["--exclusive", "--nonblock", "3"], {
        env: { LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", file], timeout: 1000,
      });
      if (result.error || result.status !== 0) throw new Error();
    } catch { throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
    return action(root);
  } finally { if (file !== undefined) closeSync(file); closeSync(root); }
}
export function sessionDirectory(context: ReviewContext, sessionId: string): number {
  if (!/^[a-f0-9]{48}$/.test(sessionId)) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  const root = privateDirectory(context.root);
  closeSync(root);
  return privateDirectory(join(context.root, sessionId));
}
