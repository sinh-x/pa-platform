import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  AdvisoryFiles, assertNoSensitiveMatch, DocumentPackageError, getAiUsageDir, readArtifactFile,
  parseWorkflowRequest, workflowDigest, workflowObject,
} from "@pa-platform/pa-core";
import { authenticatePiDocumentCaller, assertSameDocumentCaller, workspaceDocumentCaller, confirmationDocumentCaller, type PiDocumentCaller } from "./document-session.js";
import type { PiWorkflowContext } from "./workflow-native.js";

export const WORKSPACE_LIMITS = Object.freeze({ requestBytes: 65536, fileBytes: 1048576, outputBytes: 32768, timeoutSeconds: 30, processes: 8192, addressSpaceBytes: 8589934592 });
function fail(code: DocumentPackageError["code"] = "DOCUMENT_INPUT"): never { throw new DocumentPackageError(code); }
function path(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !/^[a-zA-Z0-9_./-]+$/.test(value) || value.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) fail();
  assertNoSensitiveMatch("path", value); assertNoSensitiveMatch("filename", value.split("/").at(-1)!);
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > WORKSPACE_LIMITS.fileBytes || /[\u0000\p{Cs}]/u.test(value)) fail();
  assertNoSensitiveMatch("content", value); return value;
}
/** Resolve only root-owned immutable Nix programs. No caller executable/env port. */
function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    try {
      const actual = realpathSync(join(directory, name)), stat = lstatSync(actual);
      if (actual.startsWith("/nix/store/") && stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022) && (stat.mode & 0o111)) return actual;
    } catch { /* absence does not authorize a fallback */ }
  }
  return fail("DOCUMENT_UNAVAILABLE");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function clearActiveHelper(root: string): void { unlinkSync(join(root, "active-helper.json")); syncDirectory(root); }
function saveHelperEvidence(parent: string, name: string, content: string): void {
  const directory = openSync(join(parent, "helper-results"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(directory, 0o700);
    const fd = openSync(`/proc/self/fd/${directory}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncSync(directory);
  } finally { closeSync(directory); }
}
export interface WorkspaceProcessResult { exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; outputLimited: boolean; cleanup: "settled" | "unknown"; stdout: string; stderr: string }
/** Namespace owns every child; group cancellation also kills the namespace init.
 * No host repository, HOME, credentials, sockets or foreign deployment is mounted.
 * This is not isolation from arbitrary hostile code already running as the host UID. */
export async function runWorkspaceHelper(root: string, program: "node" | "python3" | "bash", script: string, signal?: AbortSignal): Promise<WorkspaceProcessResult> {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || !(process.getuid?.())) fail("DOCUMENT_AUTHORITY");
  path(script); readArtifactFile(join(root, script), WORKSPACE_LIMITS.fileBytes, "ARTIFACT_STALE");
  const bwrap = executable("bwrap"), prlimit = executable("prlimit"), tool = executable(program);
  if (signal?.aborted) fail("DOCUMENT_STALE");
  const args = [`--nproc=${WORKSPACE_LIMITS.processes}`, `--as=${WORKSPACE_LIMITS.addressSpaceBytes}`, `--fsize=${WORKSPACE_LIMITS.fileBytes}`, "--nofile=128", "--cpu=30", "--", bwrap,
    "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/nix/store", "/nix/store", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", root, "/workspace", "--chdir", "/workspace", "--clearenv", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", dirname(tool),
    "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--", tool,
    ...(program === "node" ? ["--disable-wasm-trap-handler", "--max-old-space-size=256"] : program === "python3" ? ["-I"] : ["--noprofile", "--norc"]), `./${script}`];
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), total = 0, timedOut = false, cancelled = false, outputLimited = false, failed = false;
    const child = spawn(prlimit, args, { cwd: root, env: {}, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") failed = true; } } };
    const abort = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, WORKSPACE_LIMITS.timeoutSeconds * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (stream: "stdout" | "stderr", bytes: Buffer) => {
      const remaining = Math.max(0, WORKSPACE_LIMITS.outputBytes - total); total += bytes.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]); else stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
      if (total > WORKSPACE_LIMITS.outputBytes) { outputLimited = true; kill(); }
    };
    child.stdout.on("data", b => collect("stdout", b)); child.stderr.on("data", b => collect("stderr", b));
    child.on("error", () => { failed = true; });
    child.on("close", (exitCode, termination) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (!child.pid) { reject(new DocumentPackageError("DOCUMENT_UNAVAILABLE")); return; }
      // close proves the namespace init exited. Probe group settlement without
      // mistaking EPERM/unknown for absence; never return a guessed clean result.
      let settled = false;
      try { process.kill(-child.pid, 0); kill(); } catch (e) { settled = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      resolve({ exitCode, signal: termination, timedOut, cancelled, outputLimited, cleanup: settled && !failed ? "settled" : "unknown", stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

export class DocumentWorkspace {
  constructor(readonly root: string, readonly repository: string, private readonly authenticate: () => PiDocumentCaller) {}
  async execute(raw: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const before = this.authenticate();
    if (Buffer.byteLength(raw) > WORKSPACE_LIMITS.requestBytes) fail();
    const parsed = parseWorkflowRequest(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
    const request = parsed as Record<string, unknown>, action = request.action;
    const fields: Record<string, string[]> = { capabilities: [], read: ["path"], write: ["path", "content", "expectedSha256"], import: ["path", "destination"], run: ["program", "path"] };
    if (typeof action !== "string" || !Object.hasOwn(fields, action)) fail();
    workflowObject(request, ["action", ...fields[action]!]);
    if (action === "capabilities") return { schemaVersion: "pa-workspace/v1", root: this.root, limits: WORKSPACE_LIMITS, programs: ["node", "python3", "bash"], confinement: "required-per-run", productSourceMounted: false, capture: "unavailable-host-attestation-required" };
    // The root is native-derived. Refuse aliases/foreign roots, never create a
    // missing hierarchy through a symlink. Parent creation is descriptor-confined.
    const inside = (root: string, target: string) => { const r = relative(root, target); return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r)); };
    if (realpathSync(this.root) !== this.root || realpathSync(this.repository) !== this.repository || inside(this.root, this.repository) || inside(this.repository, this.root)) fail("DOCUMENT_AUTHORITY");
    const files = new AdvisoryFiles(this.root), selected = path(request.path);
    // A crashed/unsettled helper must not be overlapped by another writer.
    const evidence = new AdvisoryFiles(dirname(this.root));
    if (action !== "read") {
      try { evidence.file("active-helper.json"); fail("DOCUMENT_UNCERTAIN"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const same = () => { assertSameDocumentCaller(before, this.authenticate()); if (signal?.aborted) fail("DOCUMENT_STALE"); };
    same();
    if (action === "read") {
      const bytes = readArtifactFile(join(this.root, selected), WORKSPACE_LIMITS.fileBytes, "ARTIFACT_STALE");
      const content = text(bytes.toString("utf8")); same();
      return { path: selected, sha256: workflowDigest(bytes), content: content.slice(0, 16000), excerpt: content.length > 16000 };
    }
    if (action === "write" || action === "import") {
      const destination = action === "write" ? selected : path(request.destination);
      const content = action === "write" ? text(request.content) : text(readArtifactFile(join(this.repository, selected), WORKSPACE_LIMITS.fileBytes, "ARTIFACT_STALE").toString("utf8"));
      const expected = action === "import" ? null : request.expectedSha256;
      if (expected !== null && (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))) fail();
      let current: string | null = null;
      try { current = workflowDigest(files.file(destination) as Buffer); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== expected) fail("DOCUMENT_CONFLICT");
      same(); files.file(dirname(destination), undefined, true); files.file(destination, content);
      return { path: destination, sha256: workflowDigest(content), state: "unsigned-workspace-file", imported: action === "import" };
    }
    if (!["node", "python3", "bash"].includes(String(request.program))) fail();
    const operationId = `helper-${randomUUID()}`;
    const scriptSha256 = workflowDigest(readArtifactFile(join(this.root, selected), WORKSPACE_LIMITS.fileBytes, "ARTIFACT_STALE"));
    evidence.file("helper-results", undefined, true);
    const intent = JSON.stringify({ operationId, caller: before.identitySha256, program: request.program, path: selected, scriptSha256 });
    saveHelperEvidence(dirname(this.root), `${operationId}.intent.json`, intent);
    let active: number;
    try { active = openSync(join(dirname(this.root), "active-helper.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { fail("DOCUMENT_UNCERTAIN"); }
    try { writeFileSync(active, intent); fsyncSync(active); } finally { closeSync(active); }
    syncDirectory(dirname(this.root));
    let result: WorkspaceProcessResult;
    try { result = await runWorkspaceHelper(this.root, request.program as "node" | "python3" | "bash", selected, signal); }
    catch (error) {
      // The runner rejects only before a child exists; an emitted close with an
      // actual child always returns settlement facts instead of throwing.
      saveHelperEvidence(dirname(this.root), `${operationId}.json`, JSON.stringify({ operationId, completion: "not-started" }));
      clearActiveHelper(dirname(this.root)); throw error;
    }
    // Retain real results outside the helper mount; no script can forge this
    // record. Same-UID limits are unchanged; this is evidence, never authority.
    saveHelperEvidence(dirname(this.root), `${operationId}.json`, JSON.stringify({ operationId, caller: before.identitySha256, program: request.program, path: selected, scriptSha256, ...result }));
    if (result.cleanup === "settled") clearActiveHelper(dirname(this.root));
    same();
    // Never expose protected output merely because the process could print it.
    let output: string;
    try { output = text(result.stdout + result.stderr); } catch { output = "[Output retained privately; public content check rejected it.]"; }
    return { operationId, ...result, stdout: undefined, stderr: undefined, output, evidence: `helper-results/${operationId}.json`, passed: result.exitCode === 0 && result.cleanup === "settled" && !result.timedOut && !result.cancelled && !result.outputLimited };
  }
}
export async function mutatePiWorkspace(raw: string, context: PiWorkflowContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const authenticate = () => authenticatePiDocumentCaller(context);
  const caller = authenticate();
  if (!workspaceDocumentCaller(caller)) fail("DOCUMENT_AUTHORITY");
  const base = getAiUsageDir();
  if (realpathSync(base) !== base || !relative(caller.repoRoot, base).startsWith("..")) fail("DOCUMENT_AUTHORITY");
  const parent = new AdvisoryFiles(base), folder = `agent-teams/requirements/artifacts/drafts/${caller.deploymentId}`;
  parent.file(`${folder}/workspace`, undefined, true);
  const result = await new DocumentWorkspace(join(base, folder, "workspace"), caller.repoRoot, authenticate).execute(raw, signal);
  if (confirmationDocumentCaller(caller) && Object.hasOwn(result, "capture")) result.capture = "use-pa-document-capabilities";
  return result;
}
