import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { runCoreCommand, workflowError } from "@pa-platform/pa-core";
import type { PiToolCall } from "./pi-extension/index.js";
import { assertOwnExecutionSessionLog, MAX_EXECUTION_SESSION_LOG_BYTES, ownExecutionSessionLog, writeOwnExecutionSessionLog, type ExecutionLogIdentity } from "./native-execution-session-log.js";

export interface ExecutionAdministrationIdentity extends ExecutionLogIdentity { readonly worktreeRoot?: string }
type Observation = { readonly kind: "git" | "core-read"; readonly argv: readonly string[] }
  | { readonly kind: "cwd" | "roots" | "label" | "paths-label" }
  | { readonly kind: "environment"; readonly modeKey: "PA_MODE" | "PA_DEPLOY_MODE" };
type ParsedWords = { readonly argv: readonly string[]; readonly when: "always" | "success" };
export type ExecutionAdministration =
  | { readonly kind: "core"; readonly argv: readonly string[]; readonly logFile?: string }
  | { readonly kind: "date"; readonly utc: boolean }
  | { readonly kind: "preflight"; readonly observations: readonly (Observation & { readonly when: "always" | "success" })[]; readonly timeoutSeconds: number }
  | { readonly kind: "session-log"; readonly path: string; readonly content: string }
  | { readonly kind: "ticket-comment" };

/** Tokenization only: nothing is expanded or executed. Separators are accepted
 * solely when EVERY segment maps to the finite read-only observation grammar. */
function words(command: string): ParsedWords[] | null {
  if (!command || command !== command.trim() || Buffer.byteLength(command) > 16_384 || /[\u0000-\u001f\u007f]/.test(command)) return null;
  const commands: ParsedWords[] = []; let argv: string[] = []; let token = ""; let started = false; let quote = ""; let when: "always" | "success" = "always";
  const endWord = () => { if (started) argv.push(token); token = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (quote === '"' && c === "\\") {
        const next = command[++i]; if (next !== '"' && next !== "\\") return null; token += next;
      } else token += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === " ") endWord();
    else if (c === ";" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&") i++; endWord(); if (!argv.length) return null; commands.push({ argv, when }); argv = []; when = c === "&" ? "success" : "always";
    } else {
      if (/[|&<>$`\\(){}#*?]/.test(c)) return null;
      started = true; token += c;
    }
  }
  if (quote) return null; endWord(); if (!argv.length) return null; commands.push({ argv, when });
  return commands.length <= 16 ? commands : null;
}
const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);
function observation(argv: readonly string[]): Observation | null {
  if (same(argv, ["pwd"])) return { kind: "cwd" };
  if (same(argv, ["printf", "\\nRuntime roots\\n"])) return { kind: "label" };
  if (same(argv, ["printf", "PA_REPO=%s\\nPA_WORKTREE_ROOT=%s\\n", "$PA_REPO", "$PA_WORKTREE_ROOT"])) return { kind: "roots" };
  if (same(argv, ["printf", "\\nRuntime paths\\n"])) return { kind: "paths-label" };
  for (const modeKey of ["PA_MODE", "PA_DEPLOY_MODE"] as const) if (same(argv, ["printenv", "PA_REPO", "PA_WORKTREE_ROOT", modeKey])) return { kind: "environment", modeKey };
  if (same(argv, ["ppa", "repos", "list"])) return { kind: "core-read", argv: ["repos", "list"] };
  const git = [
    ["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["branch", "--show-current"], ["remote", "-v"],
    ["status"], ["status", "--short"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"], ["log", "-n", "5", "--oneline"],
  ].find((args) => same(argv, ["git", ...args]));
  return git ? { kind: "git", argv: git } : null;
}
function completion(argv: readonly string[], identity: ExecutionAdministrationIdentity): ExecutionAdministration | null {
  if (!same(argv.slice(0, 4), ["ppa", "registry", "complete", identity.deploymentId])) return null;
  const values = new Map<string, string>(); let logFile: string | undefined;
  for (let i = 4; i < argv.length; i += 2) {
    const key = argv[i]!; const value = argv[i + 1];
    if (value === undefined || values.has(key)) return null;
    if (key === "--status") { if (!["partial", "failed"].includes(value)) return null; }
    else if (key === "--summary") { if (!value.trim() || value.startsWith("-") || /[$`]/.test(value)) return null; }
    else if (key === "--log-file") { logFile = ownExecutionSessionLog(value, identity) ?? undefined; if (!logFile) return null; }
    else if (key === "--rating-source") { if (value !== "agent") return null; }
    else if (["--rating-overall", "--rating-productivity", "--rating-quality", "--rating-efficiency", "--rating-insight"].includes(key)) { if (!/^[0-5]$/.test(value)) return null; }
    else return null;
    values.set(key, value);
  }
  if (!values.has("--status") || !values.has("--summary")) return null;
  const normalized = argv.slice(1).map((value, index, all) => index > 0 && all[index - 1] === "--log-file" ? logFile! : value);
  return { kind: "core", argv: normalized, ...(logFile ? { logFile } : {}) };
}
/** Finite administrative language, NOT a shell allowlist. Matching operations
 * use native argv/core/file owners with the live authenticated identity. */
export function executionAdministration(call: PiToolCall, identity: ExecutionAdministrationIdentity): ExecutionAdministration | null {
  const raw = call.toolName ?? call.name;
  const name = raw?.startsWith("functions.") ? raw.slice(10) : raw;
  const input = call.input;
  if (name === "pa_ticket") {
    if (Object.keys(input).some((key) => !["action", "id", "author", "content"].includes(key))
      || input.action !== "comment" || input.id !== identity.ticket || input.author !== "builder/team-manager"
      || typeof input.content !== "string" || !input.content.trim() || Buffer.byteLength(input.content) > 16_384) return null;
    return { kind: "ticket-comment" };
  }
  if (name === "write") {
    if (Object.keys(input).some((key) => !["path", "content"].includes(key)) || typeof input.path !== "string" || !isAbsolute(input.path) || typeof input.content !== "string"
      || !input.content.length || Buffer.byteLength(input.content) > MAX_EXECUTION_SESSION_LOG_BYTES) return null;
    const path = ownExecutionSessionLog(input.path, identity);
    return path ? { kind: "session-log", path, content: input.content } : null;
  }
  if (name !== "bash" || typeof input.command !== "string" || Object.keys(input).some((key) => !["command", "timeout"].includes(key))
    || (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 14_400))) return null;
  const commands = words(input.command); if (!commands) return null;
  if (identity.worktreeRoot) {
    const observations = commands.map(({ argv, when }) => { const item = observation(argv); return item ? { ...item, when } : null; });
    if (observations.every((item): item is Observation & { when: "always" | "success" } => item !== null)) return { kind: "preflight", observations, timeoutSeconds: Math.min(Number(input.timeout ?? 30), 30) };
  }
  if (commands.length !== 1) return null;
  const argv = commands[0]!.argv;
  if (same(argv, ["date"]) || same(argv, ["date", "-u"])) return { kind: "date", utc: argv.length === 2 };
  const exact = [
    ["bulletin", "list"], ["repos", "list"], ["ticket", "show", identity.ticket], ["ticket", "show", identity.ticket, "--json"],
    ["status", identity.deploymentId], ["status", identity.deploymentId, "--json"],
  ].find((args) => same(argv, ["ppa", ...args]));
  return exact ? { kind: "core", argv: exact } : completion(argv, identity);
}

/** Native-only runner after live session authorization. No shell, network,
 * arbitrary Git option, inherited Git override, or caller-selected cwd. */
export async function runExecutionAdministration(request: Exclude<ExecutionAdministration, { kind: "ticket-comment" }>, identity: ExecutionAdministrationIdentity): Promise<{ text: string; exitCode: number }> {
  if (request.kind === "date") {
    const now = new Date(); return { text: `${request.utc ? now.toUTCString() : now.toString()}\n`, exitCode: 0 };
  }
  if (request.kind === "session-log") {
    writeOwnExecutionSessionLog(identity, request.path, request.content);
    return { text: `Saved private session log: ${request.path}`, exitCode: 0 };
  }
  if (request.kind === "preflight") {
    const output: string[] = []; const cwd = identity.worktreeRoot!; const deadline = Date.now() + request.timeoutSeconds * 1000; let exitCode = 0;
    for (const item of request.observations) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw workflowError();
      if (item.when === "success" && exitCode !== 0) continue;
      exitCode = 0;
      if (item.kind === "cwd") output.push(`${cwd}\n`);
      else if (item.kind === "roots") output.push(`PA_REPO=${cwd}\nPA_WORKTREE_ROOT=${cwd}\n`);
      else if (item.kind === "label") output.push("\nRuntime roots\n");
      else if (item.kind === "paths-label") output.push("\nRuntime paths\n");
      else if (item.kind === "environment") {
        output.push(`${cwd}\n${cwd}\n`);
        const mode = process.env[item.modeKey]; if (mode === undefined) exitCode = 1; else output.push(`${mode}\n`);
      } else if (item.kind === "core-read") {
        exitCode = await runCoreCommand([...item.argv], { binaryName: "ppa", io: { stdout: (line) => output.push(`${line}\n`), stderr: (line) => output.push(`${line}\n`) } });
      } else if (item.kind === "git") {
        const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
        output.push(execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", ...item.argv],
          { cwd, env, timeout: Math.min(5000, remaining), maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8"));
      }
      if (output.reduce((total, text) => total + Buffer.byteLength(text), 0) > 1024 * 1024) throw workflowError();
    }
    return { text: output.join(""), exitCode };
  }
  if (request.logFile) assertOwnExecutionSessionLog(identity, request.logFile);
  const output: string[] = [];
  const exitCode = await runCoreCommand([...request.argv], { binaryName: "ppa", io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) } });
  return { text: output.join("\n"), exitCode };
}
