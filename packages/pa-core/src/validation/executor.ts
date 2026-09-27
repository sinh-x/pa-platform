import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { evaluateSafetyPolicy } from "../safety-policy.js";
import {
  MAX_RETAINED_STREAM_BYTES,
  MAX_VALIDATION_EVENT_CHARACTERS,
  VALIDATION_LEDGER_SCHEMA_VERSION,
  ValidationPreflightError,
  assertValidationAuthority,
  parseValidationHandoff,
  validationDiagnostic,
  type ValidationArtifactSpec,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationDiagnostic,
  type ValidationHandoff,
  type ValidationManifest,
} from "./schema.js";

const FIXED_SHELL = "bash";
const TERMINATION_GRACE_MS = 250;
const TERMINATION_VERIFY_MS = 2_000;

export type ValidationEventType = "manifest_start" | "command_start" | "command_finish" | "manifest_finish";

export interface ValidationEvent {
  schemaVersion: "pa-validation-event/v1";
  type: ValidationEventType;
  timestamp: string;
  manifestSha256: string;
  commandIndex?: number;
  commandId?: string;
  status?: ValidationCommandStatus | ValidationLedgerResult | "rejected";
  durationMs?: number;
  diagnostic?: ValidationDiagnostic;
}

export type ValidationCommandStatus =
  | "pending"
  | "passed"
  | "executor_crash"
  | "failed"
  | "signal"
  | "timeout"
  | "output_limit"
  | "artifact_failure"
  | "logging_failure"
  | "cleanup_failure"
  | "persistence_failure"
  | "skipped";

export type ValidationLedgerResult = "passed" | "failed" | "executor_crash";

export interface ValidationLogEvidence {
  path: string;
  bytes: number;
  sha256: string;
  retainedBytes: number;
}

export interface ValidationArtifactEvidence {
  path: string;
  bytes: number;
  sha256: string;
  expectedSha256?: string;
}

export interface ValidationCommandLedgerEntry {
  index: number;
  id: string;
  command: string;
  cwd: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  status: ValidationCommandStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  terminationSignals: NodeJS.Signals[];
  processGroupVerifiedDead?: boolean;
  stdout?: ValidationLogEvidence;
  stderr?: ValidationLogEvidence;
  artifacts: ValidationArtifactEvidence[];
  reason?: string;
}

export interface ValidationLedger {
  schemaVersion: typeof VALIDATION_LEDGER_SCHEMA_VERSION;
  manifestSchemaVersion: ValidationManifest["schemaVersion"];
  manifestSha256: string;
  ticketId: string;
  branch: string;
  featureSha: string;
  matrix: ValidationManifest["matrix"];
  repository: ValidationManifest["repository"];
  shell: typeof FIXED_SHELL;
  startedAt: string;
  finishedAt: string;
  result: ValidationLedgerResult;
  commands: ValidationCommandLedgerEntry[];
}

export interface ValidationExecutorOptions {
  authority: ValidationAuthorityBinding;
  evidenceRoot: string;
  ledgerPath: string;
  statePath?: string;
  emit?: (event: ValidationEvent) => void | Promise<void>;
  now?: () => Date;
  abortSignal?: AbortSignal;
  terminationGraceMs?: number;
  terminationVerifyMs?: number;
}

export interface ValidationExecutionResult {
  admitted: boolean;
  ledger?: ValidationLedger;
  ledgerPath?: string;
  diagnostic?: ValidationDiagnostic;
  events: ValidationEvent[];
}

export interface ValidationCrashRecoveryResult {
  ledger: ValidationLedger;
  ledgerPath: string;
  recovered: boolean;
}

interface StreamCapture {
  evidence?: ValidationLogEvidence;
  error?: Error;
}

interface StopState {
  status: "timeout" | "output_limit" | "logging_failure" | "executor_crash";
  reason: string;
  cleanup?: Promise<CleanupResult>;
}

interface CleanupResult {
  signals: NodeJS.Signals[];
  verifiedDead: boolean;
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

export async function executeValidationHandoff(
  input: unknown,
  options: ValidationExecutorOptions,
): Promise<ValidationExecutionResult> {
  const events: ValidationEvent[] = [];
  const now = options.now ?? (() => new Date());
  let manifestSha256 = unknownManifestDigest(input);

  const emit = async (event: ValidationEvent): Promise<void> => {
    if (JSON.stringify(event).length > MAX_VALIDATION_EVENT_CHARACTERS) {
      throw new Error("validation event exceeds 2000 JavaScript characters");
    }
    events.push(event);
    await options.emit?.(event);
  };

  await emit(eventOf("manifest_start", manifestSha256, now));

  let handoff: ValidationHandoff;
  try {
    handoff = parseValidationHandoff(input);
    manifestSha256 = handoff.manifestSha256;
    assertValidationAuthority(handoff, options.authority);
    await preflightFilesystem(handoff, options);
  } catch (error) {
    const diagnostic = diagnosticFor(error);
    await emit({
      ...eventOf("manifest_finish", manifestSha256, now),
      status: "rejected",
      diagnostic,
    });
    return { admitted: false, diagnostic, events };
  }

  const startedAt = now().toISOString();
  const commands = handoff.manifest.commands.map(pendingEntry);
  const ledgerBase = {
    schemaVersion: VALIDATION_LEDGER_SCHEMA_VERSION,
    manifestSchemaVersion: handoff.manifest.schemaVersion,
    manifestSha256,
    ticketId: handoff.manifest.ticketId,
    branch: handoff.manifest.branch,
    featureSha: handoff.manifest.featureSha,
    matrix: handoff.manifest.matrix,
    repository: handoff.manifest.repository,
    shell: FIXED_SHELL,
    startedAt,
  } as const;
  const statePath = options.statePath ?? `${options.ledgerPath}.state`;

  try {
    await atomicWriteJson(statePath, { ...ledgerBase, phase: "running", commands });
  } catch (error) {
    const reason = errorMessage(error);
    markAllSkipped(commands, `initial state persistence failed: ${reason}`);
    const ledger = terminalLedger(ledgerBase, commands, now, "failed");
    try {
      await atomicWriteJson(options.ledgerPath, ledger);
    } catch {
      // The original persistence failure remains the actionable result.
    }
    await emit({ ...eventOf("manifest_finish", manifestSha256, now), status: "failed" });
    return { admitted: true, ledger, ledgerPath: options.ledgerPath, events };
  }

  let failed = false;
  for (let index = 0; index < handoff.manifest.commands.length; index += 1) {
    if (failed) break;
    if (options.abortSignal?.aborted) throw new Error("validation executor interrupted by Pi supervisor");
    const spec = handoff.manifest.commands[index]!;
    const entry = commands[index]!;
    await emit({
      ...eventOf("command_start", manifestSha256, now),
      commandIndex: index,
      commandId: spec.id,
      status: "pending",
    });
    const commandStart = now();
    entry.startedAt = commandStart.toISOString();
    await atomicWriteJson(statePath, {
      ...ledgerBase,
      phase: "running",
      commands,
    });
    try {
      await executeCommand(spec, entry, index, options.evidenceRoot, handoff.manifest.environment, options);
    } catch (error) {
      entry.status = "logging_failure";
      entry.reason = errorMessage(error);
    }
    const commandFinish = now();
    entry.finishedAt = commandFinish.toISOString();
    entry.durationMs = Math.max(0, commandFinish.getTime() - commandStart.getTime());
    failed = entry.status !== "passed";
    if (failed) markAllSkipped(commands.slice(index + 1), `not started after command ${spec.id} ${entry.status}`);

    try {
      await atomicWriteJson(statePath, {
        ...ledgerBase,
        phase: failed ? "stopping" : "running",
        commands,
      });
    } catch (error) {
      if (!failed) {
        entry.status = "persistence_failure";
        entry.reason = errorMessage(error);
        failed = true;
        markAllSkipped(commands.slice(index + 1), `not started after command ${spec.id} persistence_failure`);
      }
    }

    await emit({
      ...eventOf("command_finish", manifestSha256, now),
      commandIndex: index,
      commandId: spec.id,
      status: entry.status,
      durationMs: entry.durationMs,
    });
    if (entry.status === "executor_crash") throw new Error("validation executor interrupted by Pi supervisor");
  }

  const result: ValidationLedgerResult = failed ? "failed" : "passed";
  const ledger = terminalLedger(ledgerBase, commands, now, result);
  try {
    await atomicWriteJson(statePath, { ...ledger, phase: "terminal" });
    await atomicWriteJson(options.ledgerPath, ledger);
  } catch (error) {
    const lastAttempted = [...commands].reverse().find((entry) => entry.status !== "skipped");
    if (lastAttempted && lastAttempted.status === "passed") {
      lastAttempted.status = "persistence_failure";
      lastAttempted.reason = errorMessage(error);
      ledger.result = "failed";
    }
    throw error;
  }
  await emit({ ...eventOf("manifest_finish", manifestSha256, now), status: ledger.result });
  return { admitted: true, ledger, ledgerPath: options.ledgerPath, events };
}

export async function finalizeValidationExecutorCrash(
  input: unknown,
  options: ValidationExecutorOptions,
): Promise<ValidationCrashRecoveryResult> {
  const handoff = parseValidationHandoff(input);
  assertValidationAuthority(handoff, options.authority);
  const evidenceRoot = resolve(options.evidenceRoot);
  const ledgerPath = resolve(options.ledgerPath);
  const statePath = resolve(options.statePath ?? `${options.ledgerPath}.state`);
  if (!isAbsolute(options.evidenceRoot) || !isAbsolute(options.ledgerPath)) {
    reject("executor.recovery.paths", "evidenceRoot and ledgerPath must be absolute");
  }
  assertWithin(evidenceRoot, ledgerPath, "executor.recovery.ledgerPath");
  assertWithin(evidenceRoot, statePath, "executor.recovery.statePath");

  const existing = await readRecoveryRecord(ledgerPath);
  if (existing) {
    const ledger = validationLedgerFromRecord(existing, handoff);
    return { ledger, ledgerPath, recovered: false };
  }

  const state = await readRecoveryRecord(statePath);
  const commands = state
    ? validationCommandsFromState(state, handoff)
    : handoff.manifest.commands.map(pendingEntry);
  const interrupted = commands.find((entry) => entry.status === "pending" && entry.startedAt !== undefined);
  if (interrupted) {
    interrupted.status = "executor_crash";
    interrupted.finishedAt = (options.now ?? (() => new Date()))().toISOString();
    interrupted.reason = "Pi validation supervisor interrupted before command completion";
  }
  markAllSkipped(commands, "not started after validation executor interruption");

  const now = options.now ?? (() => new Date());
  const base = {
    schemaVersion: VALIDATION_LEDGER_SCHEMA_VERSION,
    manifestSchemaVersion: handoff.manifest.schemaVersion,
    manifestSha256: handoff.manifestSha256,
    ticketId: handoff.manifest.ticketId,
    branch: handoff.manifest.branch,
    featureSha: handoff.manifest.featureSha,
    matrix: handoff.manifest.matrix,
    repository: handoff.manifest.repository,
    shell: FIXED_SHELL,
    startedAt: state && typeof state["startedAt"] === "string" ? state["startedAt"] : now().toISOString(),
  } as const;
  const ledger = terminalLedger(base, commands, now, "executor_crash");
  await atomicWriteJson(statePath, { ...ledger, phase: "terminal" });
  await atomicWriteJson(ledgerPath, ledger);
  return { ledger, ledgerPath, recovered: true };
}

async function preflightFilesystem(handoff: ValidationHandoff, options: ValidationExecutorOptions): Promise<void> {
  const worktree = handoff.manifest.repository.worktreeRoot;
  await assertDirectory(worktree, "manifest.repository.worktreeRoot");
  await assertDirectory(handoff.manifest.repository.canonicalRoot, "manifest.repository.canonicalRoot");
  const canonicalWorktree = await realpath(worktree);
  if (canonicalWorktree !== worktree) reject("manifest.repository.worktreeRoot", "must be a canonical path without symlink aliases");
  verifyGitBinding(worktree, handoff.manifest.branch, handoff.manifest.featureSha);

  if (!isAbsolute(options.evidenceRoot) || !isAbsolute(options.ledgerPath)) {
    reject("executor.paths", "evidenceRoot and ledgerPath must be absolute");
  }
  await mkdir(options.evidenceRoot, { recursive: true, mode: 0o700 });
  await chmod(options.evidenceRoot, 0o700);
  const evidenceCanonical = await realpath(options.evidenceRoot);
  if (evidenceCanonical !== resolve(options.evidenceRoot)) reject("executor.evidenceRoot", "must not resolve through a symlink alias");
  assertWithin(evidenceCanonical, options.ledgerPath, "executor.ledgerPath");
  if (options.statePath) assertWithin(evidenceCanonical, options.statePath, "executor.statePath");
  await assertCreatablePath(options.ledgerPath, evidenceCanonical, "executor.ledgerPath");
  await assertCreatablePath(options.statePath ?? `${options.ledgerPath}.state`, evidenceCanonical, "executor.statePath");

  for (const [index, command] of handoff.manifest.commands.entries()) {
    const source = `manifest.commands[${index}]`;
    const cwdDecision = evaluateSafetyPolicy({ kind: "path", value: command.cwd }, { cwd: worktree });
    if (!cwdDecision.allowed) reject(`${source}.cwd`, cwdDecision.reason ?? cwdDecision.code);
    await assertDirectory(command.cwd, `${source}.cwd`);
    const canonicalCwd = await realpath(command.cwd);
    assertWithin(canonicalWorktree, canonicalCwd, `${source}.cwd`);
    if (canonicalCwd !== resolve(command.cwd)) reject(`${source}.cwd`, "must not resolve through a symlink alias");
    const safety = evaluateSafetyPolicy(
      { kind: "shell", value: command.command },
      { cwd: command.cwd, env: { TMPDIR: handoff.manifest.environment["TMPDIR"] } },
    );
    if (!safety.allowed) reject(`${source}.command`, safety.reason ?? safety.code);
    for (const [artifactIndex, artifact] of command.artifacts.entries()) {
      const artifactSource = `${source}.artifacts[${artifactIndex}].path`;
      const pathDecision = evaluateSafetyPolicy({ kind: "path", value: artifact.path }, { cwd: command.cwd });
      if (!pathDecision.allowed) reject(artifactSource, pathDecision.reason ?? pathDecision.code);
      assertWithin(canonicalWorktree, artifact.path, artifactSource);
      await assertCreatablePath(artifact.path, canonicalWorktree, artifactSource, true);
    }
  }
}

function verifyGitBinding(worktree: string, branch: string, featureSha: string): void {
  const runGit = (args: string[]): string => {
    const result = spawnSync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      timeout: 10_000,
    });
    if (result.status !== 0) reject("repositoryEvidence", "authenticated worktree is not a readable Git repository");
    return result.stdout.trim();
  };
  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  const actualBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const actualSha = runGit(["rev-parse", "HEAD"]);
  if (topLevel !== worktree) reject("repositoryEvidence.worktreeRoot", "does not equal the current Git top-level");
  if (actualBranch !== branch) reject("repositoryEvidence.branch", "does not equal the current Git branch");
  if (actualSha !== featureSha) reject("repositoryEvidence.featureSha", "does not equal the current Git HEAD");
}

async function executeCommand(
  spec: ValidationCommandSpec,
  entry: ValidationCommandLedgerEntry,
  index: number,
  evidenceRoot: string,
  environment: Record<string, string>,
  options: ValidationExecutorOptions,
): Promise<void> {
  const commandDirectory = resolve(evidenceRoot, "commands");
  await mkdir(commandDirectory, { recursive: true, mode: 0o700 });
  await chmod(commandDirectory, 0o700);
  const basename = `${String(index + 1).padStart(3, "0")}-${spec.id}`;
  const stdoutPath = resolve(commandDirectory, `${basename}.stdout.log`);
  const stderrPath = resolve(commandDirectory, `${basename}.stderr.log`);
  const stdoutHandle = await open(stdoutPath, "wx", 0o600);
  let stderrHandle;
  try {
    stderrHandle = await open(stderrPath, "wx", 0o600);
  } catch (error) {
    await stdoutHandle.close();
    throw error;
  }

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(FIXED_SHELL, ["-c", spec.command], {
      cwd: spec.cwd,
      env: { ...environment },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
    throw error;
  }

  let outputBytes = 0;
  let stop: StopState | undefined;
  const requestStop = (status: StopState["status"], reason: string): void => {
    if (stop) return;
    stop = { status, reason };
    if (child.pid) {
      stop.cleanup = terminateProcessGroup(
        child.pid,
        options.terminationGraceMs ?? TERMINATION_GRACE_MS,
        options.terminationVerifyMs ?? TERMINATION_VERIFY_MS,
      );
    }
  };
  const timer = setTimeout(
    () => requestStop("timeout", `exceeded timeoutSeconds=${spec.timeoutSeconds}`),
    spec.timeoutSeconds * 1_000,
  );
  const onAbort = (): void => requestStop("executor_crash", "Pi validation supervisor interrupted execution");
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted) onAbort();

  const stdoutCapture = captureStream(child.stdout, stdoutHandle, stdoutPath, (count) => {
    outputBytes += count;
    if (outputBytes > spec.maxOutputBytes) requestStop("output_limit", `exceeded maxOutputBytes=${spec.maxOutputBytes}`);
  }, (error) => requestStop("logging_failure", error.message));
  const stderrCapture = captureStream(child.stderr, stderrHandle, stderrPath, (count) => {
    outputBytes += count;
    if (outputBytes > spec.maxOutputBytes) requestStop("output_limit", `exceeded maxOutputBytes=${spec.maxOutputBytes}`);
  }, (error) => requestStop("logging_failure", error.message));

  const outcome = await waitForChild(child);
  clearTimeout(timer);
  options.abortSignal?.removeEventListener("abort", onAbort);
  const [stdout, stderr] = await Promise.all([stdoutCapture, stderrCapture]);
  entry.stdout = stdout.evidence;
  entry.stderr = stderr.evidence;
  const activeStop = stop as StopState | undefined;
  const cleanup = activeStop?.cleanup ? await activeStop.cleanup : undefined;
  if (cleanup) {
    entry.terminationSignals = cleanup.signals;
    entry.processGroupVerifiedDead = cleanup.verifiedDead;
  }

  if (stdout.error || stderr.error) {
    entry.status = "logging_failure";
    entry.reason = (stdout.error ?? stderr.error)?.message;
  } else if (activeStop) {
    entry.status = cleanup?.verifiedDead === false ? "cleanup_failure" : activeStop.status;
    entry.reason = cleanup?.verifiedDead === false ? `process group cleanup could not be verified: ${activeStop.reason}` : activeStop.reason;
  } else if (outcome.spawnError) {
    entry.status = "failed";
    entry.reason = outcome.spawnError.message;
  } else if (outcome.signal) {
    entry.status = "signal";
    entry.signal = outcome.signal;
    entry.reason = `terminated by ${outcome.signal}`;
  } else if (outcome.code !== 0) {
    entry.status = "failed";
    if (outcome.code !== null) entry.exitCode = outcome.code;
    entry.reason = `exit code ${outcome.code ?? "unknown"}`;
  } else {
    entry.exitCode = 0;
    try {
      entry.artifacts = await collectArtifacts(spec.artifacts, spec.cwd);
      entry.status = "passed";
    } catch (error) {
      entry.status = "artifact_failure";
      entry.reason = errorMessage(error);
    }
  }
}

async function captureStream(
  stream: Readable,
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  onBytes: (count: number) => void,
  onError: (error: Error) => void,
): Promise<StreamCapture> {
  const hash = createHash("sha256");
  let bytes = 0;
  let retainedBytes = 0;
  let captureError: Error | undefined;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      await handle.write(chunk);
      hash.update(chunk);
      bytes += chunk.length;
      retainedBytes = Math.min(MAX_RETAINED_STREAM_BYTES, retainedBytes + chunk.length);
      onBytes(chunk.length);
    }
    await handle.sync();
  } catch (error) {
    captureError = asError(error);
    onError(captureError);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!captureError) {
        captureError = asError(error);
        onError(captureError);
      }
    }
  }
  return captureError
    ? { error: captureError }
    : { evidence: { path, bytes, sha256: hash.digest("hex"), retainedBytes } };
}

async function waitForChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<ChildOutcome> {
  return new Promise((resolveOutcome) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolveOutcome({ code, signal, ...(spawnError ? { spawnError } : {}) }));
  });
}

async function terminateProcessGroup(pid: number, graceMs: number, verifyMs: number): Promise<CleanupResult> {
  const signals: NodeJS.Signals[] = [];
  if (sendGroupSignal(pid, "SIGTERM")) signals.push("SIGTERM");
  await delay(graceMs);
  if (groupAlive(pid)) {
    if (sendGroupSignal(pid, "SIGKILL")) signals.push("SIGKILL");
  }
  const deadline = Date.now() + verifyMs;
  while (groupAlive(pid) && Date.now() < deadline) await delay(25);
  return { signals, verifiedDead: !groupAlive(pid) };
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return false;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function collectArtifacts(specs: ValidationArtifactSpec[], cwd: string): Promise<ValidationArtifactEvidence[]> {
  const artifacts: ValidationArtifactEvidence[] = [];
  for (const spec of specs) {
    const file = await lstat(spec.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`artifact is not an exact regular file: ${spec.path}`);
    const canonical = await realpath(spec.path);
    if (canonical !== resolve(spec.path)) throw new Error(`artifact resolves through a symlink: ${spec.path}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(spec.path, "r");
    try {
      for await (const rawChunk of handle.createReadStream({ autoClose: false })) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        hash.update(chunk);
        bytes += chunk.length;
      }
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest("hex");
    if (spec.expectedSha256 && sha256 !== spec.expectedSha256) {
      throw new Error(`artifact checksum mismatch: ${spec.path}`);
    }
    artifacts.push({ path: spec.path, bytes, sha256, ...(spec.expectedSha256 ? { expectedSha256: spec.expectedSha256 } : {}) });
  }
  return artifacts;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${path.split(sep).at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function assertDirectory(path: string, source: string): Promise<void> {
  try {
    const value = await stat(path);
    if (!value.isDirectory()) reject(source, "must be an existing directory");
  } catch (error) {
    if (error instanceof ValidationPreflightError) throw error;
    reject(source, "must be an existing readable directory");
  }
}

async function assertCreatablePath(path: string, root: string, source: string, allowExisting = false): Promise<void> {
  if (!isAbsolute(path) || path.split(sep).includes("..")) reject(source, "must be an absolute normalized path without traversal");
  const resolvedPath = resolve(path);
  if (resolvedPath !== path) reject(source, "must be normalized");
  assertWithin(root, resolvedPath, source);
  try {
    const existing = await lstat(resolvedPath);
    if (!allowExisting) reject(source, "must not already exist");
    if (existing.isSymbolicLink()) reject(source, "must not be a symbolic link");
    const canonical = await realpath(resolvedPath);
    assertWithin(root, canonical, source);
    return;
  } catch (error) {
    if (error instanceof ValidationPreflightError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(source, "cannot be safely inspected");
  }
  let cursor = resolve(resolvedPath, "..");
  while (true) {
    try {
      const canonicalParent = await realpath(cursor);
      assertWithin(root, canonicalParent, source);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(source, "parent boundary cannot be verified");
      const parent = resolve(cursor, "..");
      if (parent === cursor) reject(source, "has no verifiable parent boundary");
      cursor = parent;
    }
  }
}

function assertWithin(root: string, target: string, source: string): void {
  const child = relative(root, resolve(target));
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return;
  reject(source, `must stay inside approved root ${root}`);
}

async function readRecoveryRecord(path: string): Promise<Record<string, unknown> | undefined> {
  let file;
  try {
    file = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600) {
    reject("executor.recovery.evidence", "must be one mode-0600 regular file without aliases");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("executor.recovery.evidence", "is malformed");
  }
  return value as Record<string, unknown>;
}

function validationLedgerFromRecord(record: Record<string, unknown>, handoff: ValidationHandoff): ValidationLedger {
  if (record["schemaVersion"] !== VALIDATION_LEDGER_SCHEMA_VERSION
    || record["result"] !== "passed" && record["result"] !== "failed" && record["result"] !== "executor_crash"
    || typeof record["finishedAt"] !== "string") {
    reject("executor.recovery.ledger", "is not a complete terminal validation ledger");
  }
  const commands = validationCommandsFromState(record, handoff);
  return { ...record, commands } as unknown as ValidationLedger;
}

function validationCommandsFromState(record: Record<string, unknown>, handoff: ValidationHandoff): ValidationCommandLedgerEntry[] {
  if (record["schemaVersion"] !== VALIDATION_LEDGER_SCHEMA_VERSION
    || record["manifestSchemaVersion"] !== handoff.manifest.schemaVersion
    || record["manifestSha256"] !== handoff.manifestSha256
    || record["ticketId"] !== handoff.manifest.ticketId
    || record["branch"] !== handoff.manifest.branch
    || record["featureSha"] !== handoff.manifest.featureSha
    || record["shell"] !== FIXED_SHELL
    || JSON.stringify(record["matrix"]) !== JSON.stringify(handoff.manifest.matrix)
    || JSON.stringify(record["repository"]) !== JSON.stringify(handoff.manifest.repository)
    || typeof record["startedAt"] !== "string") {
    reject("executor.recovery.state", "does not match the admitted manifest");
  }
  const rawCommands = record["commands"];
  if (!Array.isArray(rawCommands) || rawCommands.length !== handoff.manifest.commands.length) {
    reject("executor.recovery.state.commands", "does not match the admitted manifest");
  }
  const statuses = new Set<ValidationCommandStatus>([
    "pending", "passed", "executor_crash", "failed", "signal", "timeout", "output_limit",
    "artifact_failure", "logging_failure", "cleanup_failure", "persistence_failure", "skipped",
  ]);
  return rawCommands.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      reject(`executor.recovery.state.commands[${index}]`, "is malformed");
    }
    const entry = raw as Record<string, unknown>;
    const spec = handoff.manifest.commands[index]!;
    if (entry["index"] !== index || entry["id"] !== spec.id || entry["command"] !== spec.command
      || entry["cwd"] !== spec.cwd || entry["timeoutSeconds"] !== spec.timeoutSeconds
      || entry["maxOutputBytes"] !== spec.maxOutputBytes || !statuses.has(entry["status"] as ValidationCommandStatus)
      || !Array.isArray(entry["terminationSignals"]) || !Array.isArray(entry["artifacts"])) {
      reject(`executor.recovery.state.commands[${index}]`, "does not match the admitted manifest");
    }
    return entry as unknown as ValidationCommandLedgerEntry;
  });
}

function pendingEntry(spec: ValidationCommandSpec, index: number): ValidationCommandLedgerEntry {
  return {
    index,
    id: spec.id,
    command: spec.command,
    cwd: spec.cwd,
    timeoutSeconds: spec.timeoutSeconds,
    maxOutputBytes: spec.maxOutputBytes,
    status: "pending",
    terminationSignals: [],
    artifacts: [],
  };
}

function markAllSkipped(entries: ValidationCommandLedgerEntry[], reason: string): void {
  for (const entry of entries) {
    if (entry.status === "pending") {
      entry.status = "skipped";
      entry.reason = reason;
    }
  }
}

function terminalLedger(
  base: Omit<ValidationLedger, "finishedAt" | "result" | "commands">,
  commands: ValidationCommandLedgerEntry[],
  now: () => Date,
  result: ValidationLedgerResult,
): ValidationLedger {
  return { ...base, finishedAt: now().toISOString(), result, commands };
}

function eventOf(type: ValidationEventType, manifestSha256: string, now: () => Date): ValidationEvent {
  return {
    schemaVersion: "pa-validation-event/v1",
    type,
    timestamp: now().toISOString(),
    manifestSha256,
  };
}

function unknownManifestDigest(input: unknown): string {
  try {
    return createHash("sha256").update(Buffer.from(JSON.stringify(input), "utf8")).digest("hex");
  } catch {
    return "0".repeat(64);
  }
}

function diagnosticFor(error: unknown): ValidationDiagnostic {
  if (error instanceof ValidationPreflightError) return error.diagnostic;
  return validationDiagnostic("validation.preflight", errorMessage(error));
}

function reject(source: string, reason: string): never {
  throw new ValidationPreflightError(validationDiagnostic(source, reason));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return asError(error).message;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
