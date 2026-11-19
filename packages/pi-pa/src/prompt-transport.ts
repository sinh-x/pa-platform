import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Transport integrity only. Native process, role and source admission remain the owners. */
export const PI_PROMPT_MAX_BYTES = 16 * 1024 * 1024;
const PREFIX = "pa-prompt-v1:";
interface PromptReference { path: string; bytes: number; sha256: string; dev: string; ino: string }
const headline = "Pi initial prompt could not be delivered safely.\n";
export function piPromptDiagnostic(): string {
  return headline + "Condition: Prompt delivery is blocked; target initialization has not completed.\nSource: Launcher-owned prompt snapshot validation (PI_PROMPT_INPUT).\nReason: The input is missing, unsafe, changed, invalid UTF-8 or exceeds the 16777216-byte limit. Its exact reviewed bytes cannot be established.\nCorrection: Ask the runtime owner to inspect this original launch and input. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs need their owner. Prerequisite: preserve original deployment and process evidence.\nResume Action: Reconcile the original operation and establish unchanged input before retrying an effect; native admission runs again.";
}
export function piPromptCleanupDiagnostic(): string {
  return "Pi prompt cleanup is incomplete.\nCondition: Input ownership or process termination could not be verified.\nSource: Launcher-owned prompt lifecycle (PI_PROMPT_CLEANUP).\nReason: The original input or an uncertain process may remain; no replacement launch is safe yet.\nCorrection: Ask the runtime owner to inspect this original launch and retained input. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs need their owner. Prerequisite: preserve original deployment, process and input evidence.\nResume Action: Reconcile the original outcome and cleanup before requesting another effect; native admission runs again.";
}
export class PiPromptCleanupError extends Error {
  constructor() { super(piPromptCleanupDiagnostic()); }
}
function rejected(): never { throw new Error(piPromptDiagnostic()); }

/** Atomically claim the public pathname before destruction. A concurrent public
 * replacement is retained, not deleted. The private directory is launcher-owned;
 * like existing deployment custody this does not isolate a hostile same uid. */
function claim(input: PromptReference): { path: string; directory: string } {
  const directory = mkdtempSync(`${input.path}.cleanup-`);
  const path = join(directory, "input");
  try {
    renameSync(input.path, path);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== input.dev || String(stat.ino) !== input.ino || stat.uid !== BigInt(process.getuid!())) rejected();
    return { path, directory };
  } catch (error) {
    try { rmdirSync(directory); } catch { /* Mismatched claimed evidence remains private for its owner. */ }
    throw error;
  }
}
function removeClaim(owned: { path: string; directory: string }): void {
  const fd = openSync(owned.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    unlinkSync(owned.path);
    if (fstatSync(fd, { bigint: true }).nlink !== 0n) rejected();
    rmdirSync(owned.directory);
  } finally { closeSync(fd); }
}
const same = (before: BigIntStats, after: BigIntStats): boolean =>
  (["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const).every(key => before[key] === after[key]);
function directory(root: string): void {
  const stat = lstatSync(root);
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) rejected();
}
function readExact(path: string, snapshot: boolean, expected?: PromptReference): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o022n) !== 0n
      || (snapshot && (before.mode & 0o7777n) !== 0o400n) || (before.mode & 0o400n) === 0n
      || before.size > BigInt(PI_PROMPT_MAX_BYTES) || (expected && (String(before.dev) !== expected.dev || String(before.ino) !== expected.ino || before.size !== BigInt(expected.bytes)))) rejected();
    const body = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < body.length) { const count = readSync(fd, body, offset, body.length - offset, offset); if (!count) rejected(); offset += count; }
    if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true })) || realpathSync(path) !== path) rejected();
    if (expected && createHash("sha256").update(body).digest("hex") !== expected.sha256) rejected();
    // Buffer decoding would silently replace malformed bytes; preserve exact UTF-8 instead.
    const text = body.toString("utf8"); if (!Buffer.from(text, "utf8").equals(body)) rejected();
    return body;
  } finally { closeSync(fd); }
}
export function readPiPrimer(path: string): string {
  try { directory(dirname(path)); return readExact(path, false).toString("utf8"); } catch { return rejected(); }
}
export function preparePiPrompt(primerPath: string, composed?: string): string {
  let fd: number | undefined, owned: PromptReference | undefined;
  let created = false, closeFailed = false;
  try {
    const root = dirname(primerPath); directory(root);
    const source = readExact(primerPath, false);
    const body = composed === undefined ? source : Buffer.from(composed, "utf8");
    if (body.length > PI_PROMPT_MAX_BYTES) rejected();
    const path = join(root, `pi-prompt-${randomUUID()}.input`);
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    // Capture physical ownership immediately, before any partial write/chmod/fsync.
    const identity = fstatSync(fd, { bigint: true });
    owned = { path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), dev: String(identity.dev), ino: String(identity.ino) };
    writeFileSync(fd, body); fchmodSync(fd, 0o400); fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== identity.dev || after.ino !== identity.ino || !same(after, lstatSync(path, { bigint: true }))) rejected();
    const closing = fd; fd = undefined;
    try { closeSync(closing); } catch { closeFailed = true; throw new PiPromptCleanupError(); }
    return PREFIX + Buffer.from(JSON.stringify(owned)).toString("base64url");
  } catch {
    let uncertain = created && !owned || closeFailed;
    if (owned) {
      try { removeClaim(claim(owned)); }
      catch { uncertain = true; } // Never delete an uncreated/substituted public path.
    }
    if (fd !== undefined) { try { closeSync(fd); } catch { uncertain = true; } }
    if (uncertain) throw new PiPromptCleanupError();
    return rejected();
  }
}
function reference(arg: string, root: string): PromptReference {
  if (arg.length > 8192 || !arg.startsWith(PREFIX)) rejected();
  const raw = JSON.parse(Buffer.from(arg.slice(PREFIX.length), "base64url").toString("utf8")) as PromptReference;
  if (!raw || Object.keys(raw).sort().join(",") !== "bytes,dev,ino,path,sha256" || typeof raw.path !== "string" || dirname(raw.path) !== root
    || !/^pi-prompt-[a-f0-9-]{36}\.input$/.test(raw.path.slice(root.length + 1)) || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || raw.bytes > PI_PROMPT_MAX_BYTES
    || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) || !/^\d+$/.test(raw.dev) || !/^\d+$/.test(raw.ino)) rejected();
  return raw;
}
/** Called only after the existing inert/native admission. No later read-later instruction or file wrapper. */
export function consumePiPromptArgs(args: readonly string[], root: string | undefined): string[] {
  try {
    const positions = args.flatMap((arg, index) => arg.startsWith(PREFIX) ? [index] : []);
    if (!positions.length) return [...args];
    if (positions.length !== 1 || positions[0] !== args.length - 1 || !root) rejected();
    directory(root);
    const input = reference(args[positions[0]!]!, root), owned = claim(input);
    let body: Buffer;
    try { body = readExact(owned.path, true, input); }
    catch (error) { removeClaim(owned); throw error; }
    // Full content now lives in this admitted process. No subsequent pathname reopen is used by Pi.
    removeClaim(owned);
    return [...args.slice(0, -1), body.toString("utf8")];
  } catch { return rejected(); }
}
/** Only after consumption or verified termination; never delete a substituted pathname. */
export function cleanupPiPromptArgs(args: readonly string[], root: string): void {
  try {
    for (const arg of args.filter(arg => arg.startsWith(PREFIX))) {
      const input = reference(arg, root);
      let stat: BigIntStats;
      try { stat = lstatSync(input.path, { bigint: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (readdirSync(root).some(path => path.startsWith(`${basename(input.path)}.cleanup-`))) rejected();
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== input.dev || String(stat.ino) !== input.ino || stat.uid !== BigInt(process.getuid!())) rejected();
      removeClaim(claim(input));
    }
  } catch { rejected(); }
}
