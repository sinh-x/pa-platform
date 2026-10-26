import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  findSensitiveMatch, parseSourceVersion, readProcessFingerprint, readReviewEvidenceFile,
  workflowDigest, workflowError, workflowObject, workflowSha, withPreparedWorkflowLocks, type PreparedLockOwners, type ProcessFingerprint,
  type ProtectedWorkflowStore, type SensitivePatternSet, type SourceVersion,
} from "@pa-platform/pa-core";

const VERSION = "native-execution-evidence/v1";
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
export interface NativeBlob { readonly name: string; readonly bytes: number; readonly sha256: string }
export class NativeProcessEvidenceError extends Error {
  constructor(readonly evidence: SourceVersion) { super(workflowError().message); this.name = "NativeProcessEvidenceError"; }
}
export interface NativeProcessResult {
  readonly frame: SourceVersion;
  readonly stdout: NativeBlob;
  readonly stderr: NativeBlob;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly groupSettled: boolean;
}
/** Private, immutable native observations. No public tool can supply a record or
 * choose its pathname. Records alone grant no execution/admission authority. */
export class NativeExecutionEvidence {
  constructor(readonly store: ProtectedWorkflowStore, readonly root: string, readonly locks: PreparedLockOwners) {}
  publish(kind: string, payload: unknown): SourceVersion {
    const value = { schemaVersion: VERSION, kind, payload };
    const id = workflowDigest(JSON.stringify(value));
    withPreparedWorkflowLocks(this.locks, (scope) => this.store.publish(scope, `${id}.intent.json`, value));
    return parseSourceVersion({ ref: `native-execution-evidence:${id}`, version: VERSION, sha256: id });
  }
  read(reference: SourceVersion, kind: string): unknown {
    const ref = parseSourceVersion(reference);
    const match = /^native-execution-evidence:([0-9a-f]{64})$/.exec(ref.ref);
    if (!match || ref.version !== VERSION || ref.sha256 !== match[1]) throw workflowError();
    const value = this.store.read(`${match[1]}.intent.json`);
    const row = workflowObject(value, ["schemaVersion", "kind", "payload"]);
    if (row.schemaVersion !== VERSION || row.kind !== kind || workflowDigest(JSON.stringify(value)) !== ref.sha256) throw workflowError();
    return row.payload;
  }
  blob(reference: NativeBlob): Buffer {
    if (!/^[0-9a-f]{64}\.(?:stdout|stderr)\.log$/.test(reference.name) || !Number.isSafeInteger(reference.bytes)
      || reference.bytes < 0 || reference.bytes > MAX_STREAM_BYTES) throw workflowError();
    const bytes = Buffer.from(readReviewEvidenceFile(join(this.root, reference.name), MAX_STREAM_BYTES, "native execution stream"));
    const info = lstatSync(join(this.root, reference.name));
    if ((info.mode & 0o777) !== 0o600 || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())
      || bytes.length !== reference.bytes || workflowDigest(bytes) !== workflowSha(reference.sha256)) throw workflowError();
    return bytes;
  }
  sink(id: string, stream: "stdout" | "stderr", maximum = MAX_STREAM_BYTES): { write(data: Buffer): boolean; close(): NativeBlob } {
    workflowSha(id);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_STREAM_BYTES) throw workflowError();
    // Anchor creation to the already validated private directory, never through
    // a caller-selected path or a replacement symlink.
    const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let fd: number;
    const name = `${id}.${stream}.log`;
    try {
      if (realpathSync(`/proc/self/fd/${directory}`) !== this.root) throw workflowError();
      fd = openSync(`/proc/self/fd/${directory}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fsyncSync(directory);
    } finally { closeSync(directory); }
    let closed = false; let length = 0; const hash = createHash("sha256");
    return {
      write(data) {
        if (closed) throw workflowError();
        const accepted = data.subarray(0, Math.max(0, maximum - length));
        let offset = 0; while (offset < accepted.length) offset += writeSync(fd, accepted, offset);
        hash.update(accepted); length += accepted.length;
        return accepted.length === data.length;
      },
      close() {
        if (closed) throw workflowError(); closed = true;
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return Object.freeze({ name, bytes: length, sha256: hash.digest("hex") });
      },
    };
  }
}

/** Resolve only a root-owned installed shell; never accept a model/env pathname
 * as the interpreter for the custody handshake. */
function trustedBash(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    try {
      const path = realpathSync(join(directory, "bash")); const stat = lstatSync(path);
      if ((path.startsWith("/nix/store/") || path.startsWith("/usr/bin/") || path.startsWith("/bin/"))
        && stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022) && (stat.mode & 0o111)) return path;
    } catch { /* not an eligible installed interpreter */ }
  }
  throw workflowError();
}
interface GroupMember { readonly pid: number; readonly session: number; readonly state: string }
function members(group: number): GroupMember[] {
  const result: GroupMember[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") result.push({ pid: Number(entry), session: Number(fields[3]), state: fields[0]! });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw workflowError(); }
  }
  return result;
}
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Native process runner. The child waits for its incarnation/group frame to be
 * fsynced before executing the requested command. Both original channels remain
 * private. A quiet log or an exit-looking string is never completion evidence.
 * This manages its process group; it is not confinement of arbitrary OS code. */
export async function runNativeExecutionProcess(input: {
  evidence: NativeExecutionEvidence; intent: SourceVersion; command: string; cwd: string;
  timeoutSeconds: number; maximumOutputBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
  /** Trusted native command contract only; never sourced from tool arguments. */
  program?: { readonly executable: string; readonly argv: readonly string[]; readonly environment: Readonly<Record<string, string>> };
}): Promise<NativeProcessResult> {
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > 14_400 || !input.command || Buffer.byteLength(input.command) > 16_384
    || realpathSync(input.cwd) !== input.cwd) throw workflowError();
  const maximum = input.maximumOutputBytes ?? MAX_STREAM_BYTES;
  const id = workflowDigest(JSON.stringify([input.intent, "native-process-streams/v1"]));
  const stdout = input.evidence.sink(id, "stdout", maximum);
  let stderr: ReturnType<NativeExecutionEvidence["sink"]>;
  try { stderr = input.evidence.sink(id, "stderr", maximum); } catch (error) { stdout.close(); throw error; }
  let child: ReturnType<typeof spawn> | undefined; let fingerprint: ProcessFingerprint | undefined;
  let frame: SourceVersion | undefined; let timedOut = false; let aborted = input.signal?.aborted ?? false;
  let outputLimitExceeded = false; let capturedOutputBytes = 0; let ioFailed = false; let exitCode: number | null = null; let exitSignal: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined; let escalation: ReturnType<typeof setTimeout> | undefined;
  let nativeError: unknown;
  const stop = (): void => {
    if (!child?.pid || !fingerprint) return;
    try {
      const group = members(child.pid);
      if (!group.length) return;
      if (group.some((member) => member.session !== child!.pid)) throw workflowError();
      // The recorded session/group remains reserved while any member exists;
      // never kill an unrelated freshly sampled PID after leader death.
      process.kill(-child.pid, "SIGTERM");
      if (!escalation) escalation = setTimeout(() => {
        try { const remaining = members(child!.pid!); if (remaining.length && remaining.every((member) => member.session === child!.pid)) process.kill(-child!.pid!, "SIGKILL"); }
        catch { ioFailed = true; }
      }, 250);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") ioFailed = true; }
  };
  const abort = () => { aborted = true; stop(); };
  try {
    const bash = trustedBash();
    const env = { ...(input.env ?? process.env) };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_") || name.startsWith("BASH") || ["ENV", "SHELLOPTS", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(name)) delete env[name];
    const program = input.program ? [input.program.executable, ...input.program.argv] : [bash, "--noprofile", "--norc", "-c", input.command];
    child = spawn(bash, ["--noprofile", "--norc", "-c", 'IFS= read -r pa_native_start <&3 || exit 125; exec 3<&-; exec "$@"', "pa-native-execution", ...program], {
      cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const completed = new Promise<void>((resolve) => {
      child!.once("error", (error) => { nativeError = error; resolve(); });
      child!.once("exit", () => {
        try { if (frame && child?.pid && members(child.pid).length) { ioFailed = true; stop(); } }
        catch { ioFailed = true; stop(); }
      });
      child!.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
    });
    const channel = (sink: typeof stdout) => (data: Buffer) => {
      try {
        const accepted = data.subarray(0, Math.max(0, maximum - capturedOutputBytes));
        capturedOutputBytes += accepted.length;
        if (!sink.write(accepted) || accepted.length !== data.length) { outputLimitExceeded = true; stop(); }
      }
      catch { ioFailed = true; stop(); }
    };
    child.stdout!.on("data", channel(stdout)); child.stderr!.on("data", channel(stderr));
    if (!child.pid) { await completed; throw workflowError(); }
    fingerprint = readProcessFingerprint(child.pid);
    const initial = members(child.pid);
    if (!fingerprint || !same(readProcessFingerprint(child.pid), fingerprint) || !initial.some((member) => member.pid === child!.pid && member.session === child!.pid)) throw workflowError();
    frame = input.evidence.publish("process-frame", { intent: input.intent, process: fingerprint, groupId: child.pid, sessionId: child.pid, executable: bash,
      command: input.command, cwd: input.cwd, program: input.program ?? null, environment: input.program ? {} : { declaration: "legacy sanitized inherited environment" } });
    const start = child.stdio[3] as import("node:stream").Writable;
    start.on("error", () => { ioFailed = true; stop(); });
    if (aborted) { start.end(); stop(); }
    else start.end("execute\n");
    input.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { timedOut = true; stop(); }, Math.ceil(input.timeoutSeconds * 1000));
    await completed;
    if (nativeError) throw nativeError;
    if (members(child.pid).length) { ioFailed = true; stop(); }
    for (let attempt = 0; attempt < 50 && members(child.pid).length; attempt += 1) await pause(20);
  } catch (error) { nativeError = error; stop(); }
  finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    // If spawning/frame publication failed, never let the waiting child run.
    if (nativeError && child?.pid) { child.stdio[3]?.destroy(); stop(); for (let attempt = 0; attempt < 50 && members(child.pid).length; attempt += 1) await pause(20); }
    if (escalation) clearTimeout(escalation);
  }
  if (nativeError) { try { stderr.write(Buffer.from(`\nNative infrastructure failure: ${nativeError instanceof Error ? nativeError.message : String(nativeError)}\n`)); } catch { ioFailed = true; } }
  const out = stdout.close(); const err = stderr.close();
  // A missing durable frame or a failed native observation leaves the caller's
  // started barrier intact. Streams already written are deliberately retained.
  if (!frame || !child?.pid || nativeError) {
    const proof = input.evidence.publish("process-unproven", { intent: input.intent, frame: frame ?? null, stdout: out, stderr: err, groupSettled: false });
    throw new NativeProcessEvidenceError(proof);
  }
  return Object.freeze({ frame, stdout: out, stderr: err, exitCode, signal: exitSignal, timedOut, aborted, outputLimitExceeded,
    groupSettled: !ioFailed && members(child.pid).length === 0 });
}

/** Literal redaction is whole-buffer (secrets can cross pipe chunks). A content
 * pattern with unknown extent withholds the entire public output, not just a
 * private-key header while leaking its body. Raw evidence is untouched. */
export function nativePublicText(input: string, privateValues: readonly string[], patterns?: SensitivePatternSet): string {
  let value = input;
  for (const secret of [...new Set(privateValues)].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join("[REDACTED]");
  if (findSensitiveMatch("content", value, patterns)) return "[Output withheld by sensitive-content policy; original bytes retained in private native evidence.]";
  return value;
}
