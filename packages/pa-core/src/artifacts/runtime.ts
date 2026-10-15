import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
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

/** Only installed selected immutable closure. Never PATH or an env executable. */
export function selectedReviewAssets(): string {
  try {
    const closure = realpathSync(fileURLToPath(new URL("../../../../axi-tools/lavish-axi", import.meta.url)));
    if (!/^\/nix\/store\/[a-z0-9]{32}-lavish-axi-0\.1\.67$/.test(closure)) throw new Error();
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
    const immutable = /^\/nix\/store\/[a-z0-9]{32}-lavish-axi-0\.1\.67\/share\/lavish-axi\/review$/.test(directory)
      && (before.mode & 0o222n) === 0n;
    if (!before.isFile() || before.size > 2_097_152n || before.nlink !== 1n && !immutable) throw artifactDiagnostic("ARTIFACT_RUNTIME_REQUIRED");
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
    try { mkdirSync(`/proc/self/fd/${parent}/${path.slice(path.lastIndexOf("/") + 1)}`, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
    finally { closeSync(parent); }
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

export function withReviewLock<T>(context: ReviewContext, action: (root: number) => T): T {
  const root = privateDirectory(context.root, true);
  const lock = `/proc/self/fd/${root}/operation.lock`;
  try {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
    try { return action(root); }
    finally { rmdirSync(lock); }
  } finally { closeSync(root); }
}
export function sessionDirectory(context: ReviewContext, sessionId: string): number {
  if (!/^[a-f0-9]{48}$/.test(sessionId)) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  const root = privateDirectory(context.root);
  closeSync(root);
  return privateDirectory(join(context.root, sessionId));
}
