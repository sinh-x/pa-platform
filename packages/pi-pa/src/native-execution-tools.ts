import { createBashTool, createEditTool, createWriteTool, createEditToolDefinition, createWriteToolDefinition, defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { parseTestAuthorization, workflowDigest, workflowError, workflowObject, type TestAuthorization, type TestResource, type SourceVersion } from "@pa-platform/pa-core";
import { captureNativeScope, type NativeScopeSnapshot } from "./execution-native.js";
import { NativeExecutionEvidence, runNativeExecutionProcess, nativePublicText } from "./native-execution-evidence.js";
import type { PiNativeExecutionAdapter, NativeExecutionSession } from "./execution-native.js";
import type { PiRuntime, PiSessionLifecycle, PiToolDefinition, PiToolResult } from "./pi-extension/index.js";
import { createPiExecutionModule, PiExecutionParams } from "./pi-extension/prepared-workflow.js";

/** Lower SDK file operations: exact native paths, dirfd anchoring, no aliases.
 * This restricts exposed tools, NOT subprocess/host effects of approved code. */
export function requirementsTestFile(root: string, paths: readonly string[], path: string, content?: string, directoryOnly = false): Buffer | void {
  if (realpathSync(root) !== root || !isAbsolute(path) || /[\\\\\x00-\x1f\x7f]/.test(path)) throw workflowError();
  if (directoryOnly && path === root) return;
  const rel = relative(root, path);
  if (!rel || rel.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
    || (directoryOnly ? !paths.some((allowed) => allowed.startsWith(`${rel}/`)) : !paths.includes(rel))
    || (content !== undefined && Buffer.byteLength(content) > 1_048_576)) throw workflowError();
  let directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parts = rel.split("/");
  try {
    for (const part of directoryOnly ? parts : parts.slice(0, -1)) {
      const anchored = `/proc/self/fd/${directory}/${part}`;
      if (directoryOnly) { try { mkdirSync(anchored); fsyncSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const next = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(directory); directory = next;
    }
    if (directoryOnly) { fsyncSync(directory); return; }
    const fd = openSync(`/proc/self/fd/${directory}/${parts.at(-1)}`, constants.O_NOFOLLOW | (content === undefined ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT), 0o644);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw workflowError();
      if (content === undefined) return readFileSync(fd);
      writeFileSync(fd, content); ftruncateSync(fd, Buffer.byteLength(content)); fsyncSync(fd); fsyncSync(directory);
    } finally { closeSync(fd); }
  } finally { closeSync(directory); }
}

/** Actual Pi SDK definitions. No shell/deploy/lifecycle or environment/root
 * arguments are exposed. Every effect has a durable intent before SDK dispatch,
 * original native process evidence and complete before/after scope observation. */
function testReadingText(text: string): string {
  const excerpt = truncateHead(nativePublicText(text, []));
  return excerpt.content + (excerpt.truncated ? "\n[Reading excerpt truncated; complete private native evidence retained.]" : "");
}
function safeTestReading<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => typeof item === "string" ? testReadingText(item) : item) as T;
}
export class RequirementsTestTools {
  readonly authorization: TestAuthorization;
  readonly tools: ToolDefinition[];
  #known: NativeScopeSnapshot;
  #busy = false;
  #blocked = false;
  readonly #used = new Set<string>();
  readonly #paths: readonly string[];
  constructor(raw: string, readonly resource: TestResource, readonly evidence: NativeExecutionEvidence,
    readonly assertCustody: () => void, readonly environment: (checkId: string) => NodeJS.ProcessEnv) {
    this.authorization = parseTestAuthorization(raw);
    if (JSON.stringify(this.authorization.repository) !== JSON.stringify(resource.repository)) throw workflowError();
    this.#paths = this.authorization.paths.map((entry) => entry.path);
    this.#known = captureNativeScope(resource.worktreeRoot);
    if (this.#known.git.head !== resource.repository.selectedHeadSha || this.#known.git.branch !== resource.repository.branch || this.#known.git.dirty) throw workflowError();
    const root = resource.worktreeRoot;
    for (const entry of this.authorization.paths) {
      // Ignored paths would disappear from the complete ordinary Git inventory.
      // Reject instead of overwriting hidden pre-existing work or claiming a
      // complete audit. Normal Git config/hooks/trust are never rewritten.
      try {
        execFileSync("git", ["--no-optional-locks", "check-ignore", "--no-index", "--", entry.path], { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
        throw workflowError();
      } catch (error) { if ((error as { status?: number }).status !== 1) throw workflowError(); }
      if (entry.existence === "existing") {
        if (workflowDigest(requirementsTestFile(root, this.#paths, join(root, entry.path)) as Buffer) !== entry.beforeSha256) throw workflowError();
      } else {
        try { lstatSync(join(root, entry.path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw workflowError(); }
        throw workflowError();
      }
    }
    const write = createWriteToolDefinition(root, { operations: {
      mkdir: async (path) => { requirementsTestFile(root, this.#paths, path, undefined, true); },
      writeFile: async (path, content) => { requirementsTestFile(root, this.#paths, path, content); },
    } });
    const edit = createEditToolDefinition(root, { operations: {
      access: async (path) => { requirementsTestFile(root, this.#paths, path); },
      readFile: async (path) => requirementsTestFile(root, this.#paths, path) as Buffer,
      writeFile: async (path, content) => { requirementsTestFile(root, this.#paths, path, content); },
    } });
    this.tools = [write, edit].map((tool): ToolDefinition => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, executionMode: "sequential",
      execute: async (id, input, signal, update, context) => {
        const row = workflowObject(input, tool.name === "write" ? ["path", "content"] : ["path", "edits"]);
        const path = row.path;
        if (typeof path !== "string" || isAbsolute(path) || !this.authorization.paths.some((entry) => entry.path === path && entry.actions.includes(tool.name as "write" | "edit"))) throw workflowError();
        // Typed tool schemas remain SDK-owned; the wrapper does not reinterpret edits.
        return this.#execute(id, tool.name, input, signal, async () => safeTestReading(await tool.execute(id, input as never, signal, update ? (partial) => update(safeTestReading(partial)) : undefined, context)));
      },
    }));
    this.tools.push(defineTool({ name: "read", label: "Read approved test source", description: "Read an exact approved test/harness path only.", executionMode: "sequential",
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      execute: async (id, input, signal) => {
        const row = workflowObject(input, ["path"]);
        if (typeof row.path !== "string" || !this.#paths.includes(row.path)) throw workflowError();
        return this.#execute(id, "read", input, signal, async () => ({ content: [{ type: "text" as const, text: testReadingText((requirementsTestFile(root, this.#paths, join(root, row.path as string)) as Buffer).toString("utf8")) }], details: {} }));
      },
    }));
    this.tools.push(defineTool({ name: "check", label: "Approved test check", description: "Run one exact authorized check by ID, with its original time/output/environment limits. Not a shell.", executionMode: "sequential",
      parameters: Type.Object({ checkId: Type.String() }, { additionalProperties: false }),
      execute: async (id, input, signal) => {
        const row = workflowObject(input, ["checkId"]);
        const check = this.authorization.checks.find((entry) => entry.id === row.checkId);
        if (!check) throw workflowError();
        return this.#execute(id, "check", input, signal, async (intent) => {
          const cwd = check.cwd === "." ? root : join(root, check.cwd);
          if (realpathSync(cwd) !== cwd) throw workflowError();
          let part = cwd;
          while (part !== root) { if (!part.startsWith(`${root}/`) || lstatSync(part).isSymbolicLink()) throw workflowError(); part = dirname(part); }
          const remaining = (Date.parse(this.authorization.bounds.deadlineAt) - Date.now()) / 1000;
          const startedAt = new Date().toISOString();
          const result = await runNativeExecutionProcess({ evidence, intent, command: check.command, cwd, timeoutSeconds: Math.min(check.timeoutSeconds, remaining), maximumOutputBytes: check.maxOutputBytes, signal, env: environment(check.id) });
          evidence.publish("requirements-test-check", { authorizationSha256: workflowDigest(raw), check, candidate: this.#known.git.head, result, startedAt, finishedAt: new Date().toISOString() });
          if (!result.groupSettled || result.timedOut || result.aborted || result.outputLimitExceeded) { this.#blocked = true; throw workflowError(); }
          // A nonzero check stays raw RED; no expected-assertion classification is
          // guessed from exit/text and no product PASS is manufactured.
          return { content: [{ type: "text" as const, text: testReadingText(evidence.blob(result.stdout).toString("utf8") + evidence.blob(result.stderr).toString("utf8")) }], details: { exitCode: result.exitCode, productPass: false } };
        });
      },
    }));
  }
  #scope(): NativeScopeSnapshot {
    const current = captureNativeScope(this.resource.worktreeRoot);
    if (current.git.branch !== this.resource.repository.branch || (current.git.statusEntries ?? []).some((entry) => !this.#paths.includes(entry.path) || (entry.sourcePath && !this.#paths.includes(entry.sourcePath)))) throw workflowError();
    if (current.git.head !== this.#known.git.head) {
      const run = (...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: this.resource.worktreeRoot, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" }, timeout: 15_000, maxBuffer: 16_777_216 });
      run("merge-base", "--is-ancestor", this.#known.git.head, current.git.head);
      const commits = run("rev-list", "--reverse", `${this.#known.git.head}..${current.git.head}`).toString("utf8").trim().split("\n");
      if (!commits.length || commits.length > 128) throw workflowError();
      for (const sha of commits) {
        if (!/^[0-9a-f]{40}$/.test(sha)) throw workflowError();
        const parents = run("show", "-s", "--format=%P", sha).toString("utf8").trim();
        if (!/^[0-9a-f]{40}$/.test(parents)) throw workflowError();
        const paths = run("diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", parents, sha).toString("utf8").split("\0").filter(Boolean);
        this.evidence.publish("requirements-test-commit", { sha, parent: parents, paths, diff: run("diff", "--no-ext-diff", "--no-textconv", "--binary", parents, sha).toString("base64") });
        if (paths.some((path) => !this.#paths.includes(path))) throw workflowError();
      }
    }
    return current;
  }
  async #execute<T>(id: string, tool: string, input: unknown, signal: AbortSignal | undefined, action: (intent: SourceVersion) => Promise<T>): Promise<T> {
    if (this.#busy || this.#blocked || this.#used.has(id) || !id || id.length > 256 || signal?.aborted || Date.now() >= Date.parse(this.authorization.bounds.deadlineAt)) throw workflowError();
    this.assertCustody();
    const before = captureNativeScope(this.resource.worktreeRoot);
    if (JSON.stringify(before) !== JSON.stringify(this.#known)) {
      this.evidence.publish("requirements-test-scope-drift", { expected: this.#known, actual: before }); this.#blocked = true; throw workflowError();
    }
    const intent = this.evidence.publish("requirements-test-tool-intent", { id, tool, input, before: this.#known });
    this.#used.add(id); this.#busy = true;
    let result: T | undefined; let failure: unknown;
    try { result = await action(intent); } catch (error) { failure = error; if (tool === "check") this.#blocked = true; }
    try {
      const after = this.#scope(); this.assertCustody();
      this.evidence.publish("requirements-test-tool-result", { intent, after, failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack ?? null } : failure ? "unknown-native-failure" : null });
      this.#known = after;
    } catch { this.#blocked = true; throw workflowError(); }
    finally { this.#busy = false; }
    if (failure) throw workflowError(); return result as T;
  }
  settled(): SourceVersion {
    if (this.#busy || this.#blocked) throw workflowError();
    const actual = captureNativeScope(this.resource.worktreeRoot);
    this.evidence.publish("requirements-test-terminal-inventory", { expected: this.#known, actual });
    try { if (JSON.stringify(this.#scope()) !== JSON.stringify(this.#known)) throw workflowError(); }
    catch { this.#blocked = true; throw workflowError(); }
    return this.evidence.publish("requirements-test-tools-settled", { snapshot: this.#known, used: [...this.#used], arbitraryCodeConfinement: false });
  }
}

/** Dedicated SDK loadout reuses the actual native execution module and lower
 * builtins. The outer SDK definitions are inert until resolve authenticates the
 * exact new-version consumption. No extension/resource/credential discovery or
 * generic tool fallback participates. All calls traverse the same begin/finish
 * hooks inside this native wrapper, before any lower SDK effect. */
export function createRequirementsProductTools(cwd: string, oraclePaths: readonly string[], resolveNative: () => NativeExecutionSession): ToolDefinition[] {
  let installed: { native: NativeExecutionSession; definitions: Map<string, PiToolDefinition>; handlers: Map<string, ((event: unknown, context: unknown) => unknown)[]> } | undefined;
  let busy = false;
  const setup = () => {
    const native = resolveNative(); native.assertCaller({ cwd });
    if (installed) { if (installed.native !== native) throw workflowError(); return installed; }
    const definitions = new Map<string, PiToolDefinition>(), handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
    const pi: PiRuntime = { registerTool: (tool) => { definitions.set(tool.name, tool as unknown as PiToolDefinition); },
      on: ((event: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }) as PiRuntime["on"] };
    registerNativeExecutionBuiltins(pi, { resolve: (context) => { native.assertCaller(context); return native; } });
    createPiExecutionModule({ env: { PA_TEAM: "builder", PA_MODE: "orchestrator" }, resolveBinding: (context) => { native.assertCaller(context); return native.binding; } })(pi);
    for (const handler of handlers.get("session_start") ?? []) handler({}, { cwd });
    installed = { native, definitions, handlers }; return installed;
  };
  const templates = [createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd)];
  const schemas = [...templates.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters })),
    { name: "pa_execution", label: "Native product execution", description: "Record the bounded product plan, select this exact direct holder and observe native recovery evidence. No acceptance from developer checks.", parameters: PiExecutionParams },
    { name: "read", label: "Read product source", description: "Read an exact current plan or reviewed oracle path only.", parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }) }];
  return schemas.map((schema): ToolDefinition => ({ ...schema, executionMode: "sequential", execute: async (id, input, signal, update) => {
    if (busy || signal?.aborted) throw workflowError(); busy = true;
    try {
      const { native, definitions, handlers } = setup(), context = { cwd };
      if (schema.name === "read") {
        const row = workflowObject(input, ["path"]), paths = [...oraclePaths, ...(native.service.status(native.actor).plan?.paths ?? [])];
        if (typeof row.path !== "string" || !paths.includes(row.path)) throw workflowError();
        const text = (requirementsTestFile(cwd, paths, join(cwd, row.path)) as Buffer).toString("utf8");
        return { content: [{ type: "text", text: truncateHead(native.publicText(text)).content }], details: {} };
      }
      const definition = definitions.get(schema.name); if (!definition) throw workflowError();
      const event = { toolCallId: id, toolName: schema.name, input };
      for (const handler of handlers.get("tool_call") ?? []) {
        const decision = await handler(event, context) as { block?: boolean } | undefined;
        if (decision?.block) throw workflowError();
      }
      let result: PiToolResult | undefined, failure: unknown;
      try { result = await definition.execute(id, input as Record<string, unknown>, signal, update ? (partial) => update(partial) : undefined, context); }
      catch (error) { failure = error; }
      for (const handler of handlers.get("tool_execution_end") ?? []) await handler({ toolCallId: id, toolName: schema.name, result, isError: Boolean(failure) }, context);
      if (failure || !result) throw workflowError(); return result;
    } finally { busy = false; }
  } }));
}
function publicResult(result: unknown, session: NativeExecutionSession): PiToolResult {
  const value = JSON.parse(JSON.stringify(result), (_key, item: unknown) => typeof item === "string" ? session.publicText(item) : item) as PiToolResult;
  return { ...value, details: value.details ?? {} };
}
/** Install only after an authenticated consumed lineage is observed. Legacy and
 * inactive sessions retain Pi's actual built-ins, not merely equivalent mocks.
 * Native tool_call records precede these lower SDK operation boundaries. */
export function registerNativeExecutionBuiltins(pi: PiRuntime, adapter: Pick<PiNativeExecutionAdapter, "resolve">, lifecycle?: PiSessionLifecycle): void {
  let installed = false;
  pi.on?.("session_start", (_event, context) => {
    if (installed) return;
    const session = adapter.resolve(context); if (!session) return;
    const cwd = session.contract.worktreeRoot;
    for (const name of ["bash", "write", "edit"] as const) {
      const template = name === "bash" ? createBashTool(cwd) : name === "write" ? createWriteTool(cwd) : createEditTool(cwd);
      pi.registerTool?.({
        name, label: template.label, description: template.description, parameters: template.parameters,
        executionMode: "sequential",
        execute: async (id, input, signal, update, ctx) => {
          const execute = async (): Promise<PiToolResult> => {
            const current = adapter.resolve(ctx); if (!current) throw workflowError();
            return current.execute(id, input, async (native) => {
              const tool = name === "write" ? createWriteTool(cwd, { operations: {
                writeFile: async (path, content) => { native.file(path, content); },
                mkdir: async (path) => { native.file(path, undefined, true); },
              } }) : name === "edit" ? createEditTool(cwd, { operations: {
                readFile: async (path) => native.file(path) as Buffer,
                writeFile: async (path, content) => { native.file(path, content); },
                access: async (path) => { native.file(path); },
              } }) : createBashTool(cwd, { exposeSessionEnvironment: false, operations: {
                exec: async (command, directory, options) => {
                  const result = await native.runBash(id, input, command, directory, options.timeout ?? 1200, options.signal);
                  // Keep channels separate in private evidence. Only the whole-
                  // buffer redacted reading stream reaches Pi/log/temp output.
                  const text = native.publicText(native.evidence.blob(result.stdout).toString("utf8") + native.evidence.blob(result.stderr).toString("utf8"));
                  options.onData(Buffer.from(text));
                  if (!result.groupSettled || result.timedOut || result.aborted || result.outputLimitExceeded) throw workflowError();
                  return { exitCode: result.exitCode };
                },
              } });
              // SDK AgentTool has four execution arguments; Pi's ToolDefinition
              // adds context. Adapt that API boundary, not a tool-supplied port.
              const invoke = tool.execute as unknown as PiToolDefinition["execute"];
              const result = await invoke(id, input, signal, update ? (partial) => update(publicResult(partial, native)) : undefined, ctx);
              return publicResult(result, native);
            });
          };
          try { return await (lifecycle ? lifecycle.trackRegistryAccess(execute) : execute()); }
          catch { throw workflowError(); }
        },
      });
    }
    installed = true;
  });
}
