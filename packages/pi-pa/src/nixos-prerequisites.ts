import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { TicketStore, formatBoundedFiveFieldDiagnostic, getAiUsageDir } from "@pa-platform/pa-core";

import { extractMatrixAuthority } from "./matrix-compatibility.js";

export const NIXOS_BASELINE_VERSION = "nixos-prerequisites/v1" as const;
export const NIXOS_APPROVAL_VERSION = "nixos-prerequisite-approval/v1" as const;
export const NIXOS_PROBE_MS = 30_000;
export const NIXOS_TOTAL_MS = 300_000;
const MAX_BYTES = 1_048_576;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const AUTH = /^review-auth:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NIXOS_TOOLS = ["git", "bash", "python3", "rg", "nix", "ppa"] as const;
export type NixosTool = (typeof NIXOS_TOOLS)[number];
const ENVIRONMENT_NAMES = ["CI", "HOME", "LANG", "TZ", "PATH", "PA_REPO", "PA_TICKET_ID", "PA_FEATURE_SHA", "PA_MATRIX_SOURCE", "PA_MATRIX_AUTHORITY_SHA256", "PA_MATRIX_APPROVAL_EVIDENCE", "PA_APPROVED_BASE_SHA", "PA_EXPECTED_BRANCH", "PA_WORKTREE_ROOT"];

/** Authorization-bearing types belong only in the existing protected sidecar, never a ledger. */
export interface NixosBaselineReference {
  source: string;
  digest: string;
  approvalEvidence: string;
}
export interface NixosLaunchTuple {
  repoKey: string;
  canonicalRoot: string;
  worktreeRoot: string;
  ticket: string;
  branch: string;
  featureSha: string;
  matrixSource: string;
  matrixDigest: string;
  matrixApprovalEvidence: string;
  authorizationId: string;
  reviewDeploymentId: string;
}
export interface NixosLocalInput { path: string; topLevel: string; head: string; status: string }
export interface NixosToolExpectation { name: NixosTool; executable: string; version: string }
export interface NixosStorage { path: string; minimumFreeBytes: number }
export interface NixosInventory {
  localInputs: readonly string[];
  upstreams: readonly string[];
  caches: readonly string[];
  builders: readonly string[];
  daemon: string;
  storage: readonly string[];
}
export interface NixosBaseline {
  schemaVersion: typeof NIXOS_BASELINE_VERSION;
  tuple: NixosLaunchTuple;
  environment: Readonly<Record<string, string>>;
  localInputs: readonly NixosLocalInput[];
  tools: readonly NixosToolExpectation[];
  inventory: NixosInventory;
  storage: readonly NixosStorage[];
}
export interface NixosDurableComment { id: string; author: string; content: string }
/** Produced by the trusted runtime reread, not the caller or the baseline. No boolean verification flags. */
export interface NixosAuthorityRead {
  tuple: NixosLaunchTuple;
  environment: Readonly<Record<string, string>>;
  canonicalRepository: { repoKey: string; repoRoot: string };
  authorizationReceipt: { authorizationId: string; reviewDeploymentId: string };
  prerequisiteStartedMs: number;
}
export interface NixosProbeCommand {
  tool: NixosTool;
  args: readonly string[];
  cwd: string;
}
export interface NixosProbeResult { stdout: string; stderr: string; exitCode: number; executable: string }
export interface NixosObservation {
  phase: "initial" | "final";
  probe: string;
  startedMs: number;
  finishedMs: number;
  status: "verified" | "failed";
  /** Bounded non-authority failure classification; raw service output is deliberately excluded. */
  reason?: string;
}
export interface NixosPrerequisiteDependencies {
  /** Kernel monotonic milliseconds, shared across subprocess handoff; never wall-clock time. */
  monotonicMs: () => number;
  /** Protected prerequisite-start anchor, retained across retries and process handoff. */
  budgetStartedMs: number;
  readSource: (source: string, signal: AbortSignal) => Promise<Uint8Array>;
  readComments: (ticket: string, signal: AbortSignal) => Promise<readonly NixosDurableComment[]>;
  rereadAuthority: (signal: AbortSignal) => Promise<NixosAuthorityRead>;
  run: (command: NixosProbeCommand, signal: AbortSignal) => Promise<NixosProbeResult>;
  physicalPath: (path: string, signal: AbortSignal) => Promise<string>;
  freeBytes: (path: string, signal: AbortSignal) => Promise<number>;
  httpsHead: (endpoint: string, signal: AbortSignal) => Promise<{ endpoint: string; status: number }>;
  /** Injectable scheduler pairs with the monotonic clock in isolated tests. */
  schedule?: (delayMs: number, expire: () => void) => () => void;
}

export class NixosPrerequisiteError extends Error {
  constructor(readonly kind: "schema" | "authority" | "observation" | "deadline", source: string, reason: string) {
    super(formatBoundedFiveFieldDiagnostic({
      condition: `NixOS prerequisite ${kind} failure`, source, reason,
      correction: "reconcile the immutable baseline, durable approval and fresh protected observations",
      resumeAction: "start no matrix command or reviewer; obtain fresh eligible authority before retrying",
    }));
    this.name = "NixosPrerequisiteError";
  }
}
function fail(kind: NixosPrerequisiteError["kind"], source: string, reason: string): never {
  throw new NixosPrerequisiteError(kind, source, reason);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("schema", "baseline record", "record is malformed");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) fail("schema", "baseline record", "missing or unsupported fields");
  return row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail("schema", "baseline value", "nonempty bounded text is required");
  return value;
}
function path(value: unknown): string {
  const result = text(value);
  if (!isAbsolute(result) || resolve(result) !== result) fail("schema", "baseline path", "path must be exact absolute and normalized");
  return result;
}
function artifact(value: unknown): string {
  const result = text(value);
  if (!/^agent-teams\/[A-Za-z0-9_./-]+\.(?:json|md)$/.test(result) || result.split("/").some((part) => ["", ".", ".."].includes(part))) fail("schema", "baseline source", "persistent AI-usage artifact path is required");
  return result;
}
function hash(value: unknown, pattern = DIGEST): string {
  const result = text(value);
  if (!pattern.test(result)) fail("schema", "baseline digest", "full lowercase digest or identity is malformed");
  return result;
}
function commentId(value: unknown): string {
  const result = text(value);
  if (!/^c-[a-zA-Z0-9-]+$/.test(result)) fail("schema", "approval evidence", "exact durable comment ID is required");
  return result;
}
function list<T>(value: unknown, parse: (item: unknown) => T, identity: (item: T) => string): T[] {
  if (!Array.isArray(value) || value.length > 1024) fail("schema", "baseline inventory", "explicit bounded inventory is required");
  const result = value.map(parse);
  if (new Set(result.map(identity)).size !== result.length) fail("schema", "baseline inventory", "duplicate or conflicting inventory entries");
  return result;
}
function environment(value: unknown): Record<string, string> {
  const row = record(value, ENVIRONMENT_NAMES);
  const result = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, text(value)]));
  if (Object.values(result).some((value) => value.includes("review-auth:"))) fail("schema", "baseline environment", "authorization-bearing values are forbidden");
  return result;
}
export function parseNixosLaunchTuple(value: unknown): NixosLaunchTuple {
  const row = record(value, ["repoKey", "canonicalRoot", "worktreeRoot", "ticket", "branch", "featureSha", "matrixSource", "matrixDigest", "matrixApprovalEvidence", "authorizationId", "reviewDeploymentId"]);
  const ticket = text(row["ticket"]);
  const branch = text(row["branch"]);
  if (!/^[A-Z]+-[0-9]+$/.test(ticket) || !branch.startsWith(`feature/${ticket}-`) || /[\s~^:?*\[\\]|\.\.|@\{/.test(branch)) fail("schema", "baseline tuple", "ticket-linked feature branch is malformed");
  const deployment = text(row["reviewDeploymentId"]);
  if (!/^d-[a-z0-9-]+$/.test(deployment)) fail("schema", "baseline tuple", "deployment binding is malformed");
  return {
    repoKey: text(row["repoKey"]), canonicalRoot: path(row["canonicalRoot"]), worktreeRoot: path(row["worktreeRoot"]),
    ticket, branch, featureSha: hash(row["featureSha"], SHA), matrixSource: artifact(row["matrixSource"]),
    matrixDigest: hash(row["matrixDigest"]), matrixApprovalEvidence: commentId(row["matrixApprovalEvidence"]),
    authorizationId: hash(row["authorizationId"], AUTH), reviewDeploymentId: deployment,
  };
}
export function parseNixosBaselineReference(value: unknown): NixosBaselineReference {
  const row = record(value, ["source", "digest", "approvalEvidence"]);
  return Object.freeze({ source: artifact(row["source"]), digest: hash(row["digest"]), approvalEvidence: commentId(row["approvalEvidence"]) });
}
function endpoint(value: unknown, kind: "store" | "upstream"): string {
  const result = text(value);
  if (kind === "store" && result === "daemon") return result;
  let url: URL;
  try { url = new URL(result); } catch { return fail("schema", "service endpoint", "endpoint is unresolved or malformed"); }
  const schemes = kind === "store" ? ["https:", "ssh:", "ssh-ng:"] : ["https:", "git+https:"];
  if (!schemes.includes(url.protocol) || !url.hostname || !/^[A-Za-z0-9.-]+$/.test(url.hostname) || url.password
    || (url.username && (!["ssh:", "ssh-ng:"].includes(url.protocol) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(url.username)))
    || (["ssh:", "ssh-ng:"].includes(url.protocol) && !["", "/"].includes(url.pathname)) || url.search || url.hash || /[\s\\]/.test(result)) fail("schema", "service endpoint", "unsupported endpoint scheme, options, credentials or redirects");
  return result;
}
function inventory(value: unknown): NixosInventory {
  const row = record(value, ["localInputs", "upstreams", "caches", "builders", "daemon", "storage"]);
  if (row["daemon"] !== "daemon") fail("schema", "Nix daemon", "only the local daemon store is supported");
  return {
    localInputs: list(row["localInputs"], path, String), upstreams: list(row["upstreams"], (item) => endpoint(item, "upstream"), String),
    caches: list(row["caches"], (item) => endpoint(item, "store"), String), builders: list(row["builders"], (item) => endpoint(item, "store"), String),
    daemon: "daemon", storage: list(row["storage"], path, String),
  };
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function nixosTupleDigest(tuple: NixosLaunchTuple): string { return createHash("sha256").update(canonical(tuple)).digest("hex"); }
function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length && same([...left].sort(), [...right].sort());
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** JSON.parse alone silently discards duplicate keys. Scan every object before parsing any authority. */
export function parseNixosStrictJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_BYTES) fail("schema", "baseline bytes", "record is oversized");
  let input: string;
  try { input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("schema", "baseline bytes", "invalid raw UTF-8"); }
  let i = 0;
  const white = (): void => { while (/\s/.test(input[i] ?? "") && i < input.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < input.length) {
      const ch = input[i++]!;
      if (ch === "\\") i++;
      else if (ch === '"') return JSON.parse(input.slice(start, i)) as string;
    }
    throw new Error("unterminated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("deep JSON");
    white();
    if (input[i] === '"') { string(); return; }
    if (input[i] === "{") {
      i++; white(); const keys = new Set<string>();
      if (input[i] !== "}") while (true) {
        white(); if (input[i] !== '"') throw new Error("JSON key");
        const key = string(); if (keys.has(key)) throw new Error("duplicate JSON key"); keys.add(key);
        white(); if (input[i++] !== ":") throw new Error("JSON colon"); value(depth + 1); white();
        if (input[i] !== ",") break; i++;
      }
      if (input[i++] !== "}") throw new Error("JSON object"); return;
    }
    if (input[i] === "[") {
      i++; white(); if (input[i] !== "]") while (true) { value(depth + 1); white(); if (input[i] !== ",") break; i++; }
      if (input[i++] !== "]") throw new Error("JSON array"); return;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(input.slice(i));
    if (!token) throw new Error("JSON value"); i += token[0].length;
  };
  try { value(0); white(); if (i !== input.length) throw new Error("trailing JSON"); return JSON.parse(input) as unknown; }
  catch { return fail("schema", "baseline JSON", "malformed, duplicate, ambiguous or unsupported JSON fields"); }
}

function completeStatus(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES) fail("schema", "local status", "complete bounded NUL-safe porcelain-v2 status is required");
  if (value === "") return value;
  if (!value.endsWith("\0")) fail("schema", "local status", "complete status lacks its terminal NUL");
  const records = value.slice(0, -1).split("\0");
  const prefix = "[.MADRCUT?!]{2} (?:N\\.\\.\\.|S[.C][.M][.U])";
  const modes = "[0-7]{6} [0-7]{6} [0-7]{6}";
  const hashes = "[0-9a-f]{40} [0-9a-f]{40}";
  for (let index = 0; index < records.length; index++) {
    const entry = records[index]!;
    if (/^\? [\s\S]+$/.test(entry) || new RegExp(`^1 ${prefix} ${modes} ${hashes} [\\s\\S]+$`).test(entry)) continue;
    if (new RegExp(`^2 ${prefix} ${modes} ${hashes} [RC][0-9]{1,3} [\\s\\S]+$`).test(entry) && records[index + 1]) { index++; continue; }
    if (new RegExp(`^u ${prefix} ${modes} [0-7]{6} ${hashes} [0-9a-f]{40} [\\s\\S]+$`).test(entry)) continue;
    fail("schema", "local status", "malformed, omitted or unsupported complete status record");
  }
  return value;
}

export function parseNixosBaseline(bytes: Uint8Array): NixosBaseline {
  const row = record(parseNixosStrictJson(bytes), ["schemaVersion", "tuple", "environment", "localInputs", "tools", "inventory", "storage"]);
  if (row["schemaVersion"] !== NIXOS_BASELINE_VERSION) fail("schema", "baseline version", "unsupported immutable baseline version");
  const tuple = parseNixosLaunchTuple(row["tuple"]);
  const env = environment(row["environment"]);
  const localInputs = list(row["localInputs"], (item): NixosLocalInput => {
    const entry = record(item, ["path", "topLevel", "head", "status"]);
    return { path: path(entry["path"]), topLevel: path(entry["topLevel"]), head: hash(entry["head"], SHA), status: completeStatus(entry["status"]) };
  }, (entry) => entry.path);
  const tools = list(row["tools"], (item): NixosToolExpectation => {
    const entry = record(item, ["name", "executable", "version"]);
    if (!NIXOS_TOOLS.includes(entry["name"] as NixosTool)) fail("schema", "baseline tools", "arbitrary executable or probe type is forbidden");
    const version = entry["version"];
    if (typeof version !== "string" || !version || version.length > 4096 || /[\x00-\x09\x0b-\x1f\x7f]/.test(version) || version.endsWith("\n")) fail("schema", "tool version", "exact bounded version output is required");
    return { name: entry["name"] as NixosTool, executable: path(entry["executable"]), version };
  }, (entry) => entry.name);
  const inv = inventory(row["inventory"]);
  const storage = list(row["storage"], (item): NixosStorage => {
    const entry = record(item, ["path", "minimumFreeBytes"]);
    const minimum = entry["minimumFreeBytes"];
    if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum <= 0) fail("schema", "storage threshold", "explicit positive safe free-byte threshold is required");
    return { path: path(entry["path"]), minimumFreeBytes: minimum };
  }, (entry) => entry.path);
  if (!exactSet(tools.map((entry) => entry.name), NIXOS_TOOLS) || !exactSet(localInputs.map((entry) => entry.path), inv.localInputs)
    || !exactSet(storage.map((entry) => entry.path), inv.storage) || storage.length === 0
    || env["PA_REPO"] !== tuple.worktreeRoot || env["PA_WORKTREE_ROOT"] !== tuple.worktreeRoot || env["PA_TICKET_ID"] !== tuple.ticket
    || env["PA_EXPECTED_BRANCH"] !== tuple.branch || env["PA_FEATURE_SHA"] !== tuple.featureSha || env["PA_MATRIX_SOURCE"] !== tuple.matrixSource
    || env["PA_MATRIX_AUTHORITY_SHA256"] !== tuple.matrixDigest || env["PA_MATRIX_APPROVAL_EVIDENCE"] !== tuple.matrixApprovalEvidence
    || env["CI"] !== "true" || !SHA.test(env["PA_APPROVED_BASE_SHA"]!)) fail("schema", "baseline completeness", "inventory, exact environment and tuple are missing or conflicting");
  path(env["HOME"]);
  if (env["PATH"]!.split(":").some((entry) => !entry || !isAbsolute(entry))) fail("schema", "baseline PATH", "exact absolute launcher search path is required");
  return freeze({ schemaVersion: NIXOS_BASELINE_VERSION, tuple, environment: env, localInputs, tools, inventory: inv, storage });
}

/** Discover from resolved Nix metadata/config, never from baseline declarations. Unknown types fail closed. */
export function discoverNixosInventory(metadataBytes: Uint8Array, configBytes: Uint8Array, root: string): NixosInventory {
  const metadata = parseNixosStrictJson(metadataBytes) as Record<string, unknown>;
  const config = parseNixosStrictJson(configBytes) as Record<string, unknown>;
  if (!metadata || !config || typeof metadata !== "object" || typeof config !== "object") fail("observation", "Nix inventory", "metadata/config are unresolved");
  const locks = metadata["locks"] as Record<string, unknown> | undefined;
  const nodes = locks?.["nodes"] as Record<string, unknown> | undefined;
  const rootNode = locks?.["root"];
  if (!nodes || typeof nodes !== "object" || typeof rootNode !== "string" || !Object.hasOwn(nodes, rootNode)) fail("observation", "Nix inventory", "complete resolved flake graph is absent");
  const locals = new Set<string>(); const upstreams = new Set<string>(); const visited = new Set<string>();
  const node = (name: string): Record<string, unknown> => {
    const result = nodes[name];
    if (!result || typeof result !== "object" || Array.isArray(result)) fail("observation", "Nix inventory", "flake node is unresolved");
    return result as Record<string, unknown>;
  };
  const follow = (reference: unknown, seen: Set<string> = new Set()): string => {
    if (typeof reference === "string") { node(reference); return reference; }
    if (!Array.isArray(reference) || reference.length === 0 || reference.some((part) => typeof part !== "string")) fail("observation", "Nix inventory", "flake input reference is unresolved");
    const key = JSON.stringify(reference); if (seen.has(key)) fail("observation", "Nix inventory", "cyclic flake follows reference"); seen.add(key);
    let current = rootNode;
    for (const part of reference as string[]) current = follow((node(current)["inputs"] as Record<string, unknown> | undefined)?.[part], seen);
    return current;
  };
  const visit = (name: string): void => {
    if (visited.has(name)) return; visited.add(name);
    const entry = node(name);
    if (name !== rootNode) {
      const locked = entry["locked"] as Record<string, unknown> | undefined;
      if (!locked) fail("observation", "Nix inventory", "input lacks resolved locked identity");
      switch (locked["type"]) {
        case "path": locals.add(path(locked["path"])); break;
        case "git": upstreams.add(endpoint(locked["url"], "upstream")); break;
        case "github": case "gitlab": {
          const owner = text(locked["owner"]); const repo = text(locked["repo"]);
          if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || locked["host"] !== undefined) fail("observation", "Nix inventory", "unsupported hosted upstream identity");
          upstreams.add(`https://${locked["type"] === "github" ? "github.com" : "gitlab.com"}/${owner}/${repo}.git`); break;
        }
        case "tarball": upstreams.add(endpoint(locked["url"], "upstream")); break;
        default: fail("observation", "Nix inventory", "unsupported or unresolved flake input type");
      }
    }
    const inputs = entry["inputs"];
    if (inputs !== undefined && (!inputs || typeof inputs !== "object" || Array.isArray(inputs))) fail("observation", "Nix inventory", "flake inputs are malformed");
    for (const reference of Object.values(inputs ?? {})) visit(follow(reference));
  };
  visit(rootNode);
  if (visited.size !== Object.keys(nodes).length) fail("observation", "Nix inventory", "unreachable inventory nodes cannot be silently omitted");
  const setting = (name: string): unknown => {
    const entry = config[name] as Record<string, unknown> | undefined;
    if (!entry || !Object.hasOwn(entry, "value")) fail("observation", "Nix configuration", "required inventory setting is unresolved");
    return entry["value"];
  };
  const cacheValue = setting("substituters");
  if (!Array.isArray(cacheValue)) fail("observation", "Nix caches", "complete cache list is unresolved");
  const caches = list(cacheValue, (entry) => endpoint(entry, "store"), String);
  const builderValue = setting("builders");
  if (typeof builderValue !== "string") fail("observation", "Nix builders", "complete builders configuration is unresolved");
  const builders = builderValue === "" ? [] : builderValue.split(/;|\n/).filter((entry) => entry.trim()).map((entry) => {
    // Nix builder machine lines: URI, systems, key, jobs, speed, supported/mandatory features, host key.
    // Configuration is observed data, never copied into argv except its validated URI.
    const parts = entry.trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 8 || parts[0]!.startsWith("@")) fail("observation", "Nix builders", "builder inventory is unresolved or unsupported");
    return endpoint(parts[0], "store");
  });
  if (new Set(builders).size !== builders.length) fail("observation", "Nix builders", "duplicate configured builder identities");
  if (setting("store") !== "daemon") fail("observation", "Nix daemon", "configured store is not the local daemon");
  const buildDir = setting("build-dir");
  const temporary = buildDir === "" ? "/tmp" : path(buildDir);
  return freeze({ localInputs: [...locals].sort(), upstreams: [...upstreams].sort(), caches, builders, daemon: "daemon", storage: [...new Set([path(root), ...locals, "/nix/store", temporary])].sort() });
}

/** One session owns one non-resettable budget. Initial/final probes and authority rereads share it. */
export class NixosPrerequisiteSession {
  readonly reference: NixosBaselineReference;
  private readonly startedMs: number;
  private lastMs: number;
  private state: "new" | "observed" | "executed" | "failed" = "new";
  private baseline?: NixosBaseline;
  private readonly evidence: NixosObservation[] = [];
  constructor(reference: NixosBaselineReference, private readonly dependencies: NixosPrerequisiteDependencies) {
    this.reference = parseNixosBaselineReference(reference);
    this.startedMs = dependencies.budgetStartedMs; this.lastMs = dependencies.monotonicMs();
    if (!Number.isFinite(this.startedMs) || !Number.isFinite(this.lastMs) || this.startedMs < 0 || this.startedMs > this.lastMs) fail("deadline", "monotonic clock", "protected budget anchor or clock is invalid");
  }
  /** Contains no tuple, authorization, raw service output or copied expectation. Safe for ordinary evidence. */
  get observations(): readonly NixosObservation[] { return this.evidence.map((entry) => Object.freeze({ ...entry })); }
  private now(): number {
    const now = this.dependencies.monotonicMs();
    if (!Number.isFinite(now) || now < this.lastMs) fail("deadline", "monotonic clock", "clock regressed or became invalid");
    this.lastMs = now; return now;
  }
  private async probe<T>(phase: NixosObservation["phase"], name: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const started = this.now();
    const remaining = NIXOS_TOTAL_MS - (started - this.startedMs);
    const controller = new AbortController();
    let cancel: (() => void) | undefined;
    let expired = false;
    try {
      if (remaining <= 0) fail("deadline", name, "300-second aggregate budget exhausted");
      const delay = Math.min(NIXOS_PROBE_MS, remaining);
      const deadline = new Promise<never>((_resolve, reject) => {
        const expire = (): void => { expired = true; controller.abort(); reject(new NixosPrerequisiteError("deadline", name, remaining <= NIXOS_PROBE_MS ? "300-second aggregate deadline reached" : "30-second probe deadline reached")); };
        cancel = this.dependencies.schedule ? this.dependencies.schedule(delay, expire) : (() => { const timer = setTimeout(expire, delay); return () => clearTimeout(timer); })();
      });
      const result = await Promise.race([operation(controller.signal), deadline]);
      const finished = this.now();
      if (expired || finished - started >= NIXOS_PROBE_MS || finished - this.startedMs >= NIXOS_TOTAL_MS) {
        controller.abort(); fail("deadline", name, "probe or aggregate deadline reached");
      }
      this.evidence.push({ phase, probe: name, startedMs: started, finishedMs: finished, status: "verified" });
      return result;
    } catch (error) {
      this.state = "failed";
      this.evidence.push({ phase, probe: name, startedMs: started, finishedMs: this.now(), status: "failed", reason: error instanceof NixosPrerequisiteError ? error.kind : "unavailable" });
      if (error instanceof NixosPrerequisiteError) throw error;
      return fail("observation", name, "fixed probe is unavailable or returned invalid evidence; raw output is redacted");
    } finally { cancel?.(); }
  }
  private async authenticate(phase: NixosObservation["phase"]): Promise<NixosBaseline> {
    return this.probe(phase, "baseline-authority", async (signal) => {
      const bytes = await this.dependencies.readSource(this.reference.source, signal);
      if (createHash("sha256").update(bytes).digest("hex") !== this.reference.digest) fail("authority", "baseline digest", "persistent raw bytes drifted or source was substituted");
      const baseline = parseNixosBaseline(bytes);
      const fresh = await this.dependencies.rereadAuthority(signal);
      const tuple = parseNixosLaunchTuple(fresh.tuple);
      if (!same(tuple, baseline.tuple) || !same(environment(fresh.environment), baseline.environment)
        || fresh.canonicalRepository.repoKey !== tuple.repoKey || fresh.canonicalRepository.repoRoot !== tuple.canonicalRoot
        || fresh.authorizationReceipt.authorizationId !== tuple.authorizationId || fresh.authorizationReceipt.reviewDeploymentId !== tuple.reviewDeploymentId
        || fresh.prerequisiteStartedMs !== this.startedMs) fail("authority", "protected tuple", "fresh canonical identity, consumed receipt, environment or launch tuple disagrees");
      if (this.reference.approvalEvidence === tuple.matrixApprovalEvidence) fail("authority", "baseline approval", "matrix and baseline approval must be separate");
      const comments = await this.dependencies.readComments(tuple.ticket, signal);
      const approvals = comments.filter((entry) => entry.id === this.reference.approvalEvidence);
      const matrices = comments.filter((entry) => entry.id === tuple.matrixApprovalEvidence);
      if (approvals.length !== 1 || matrices.length !== 1 || approvals[0]!.author.toLowerCase() !== "sinh" || matrices[0]!.author.toLowerCase() !== "sinh") fail("authority", "durable approvals", "unique separate durable Sinh approvals are absent");
      const approval = record(parseNixosStrictJson(Buffer.from(approvals[0]!.content)), ["schemaVersion", "source", "digest", "tupleDigest"]);
      if (approval["schemaVersion"] !== NIXOS_APPROVAL_VERSION || approval["source"] !== this.reference.source || approval["digest"] !== this.reference.digest || approval["tupleDigest"] !== nixosTupleDigest(tuple)) fail("authority", "baseline approval", "durable approval does not bind exact source, raw digest and protected tuple");
      const matrixContent = matrices[0]!.content;
      if (matrixContent.split(tuple.matrixSource).length !== 2 || matrixContent.split(tuple.matrixDigest).length !== 2) fail("authority", "matrix approval", "durable matrix approval does not uniquely bind source and digest");
      const matrixBytes = await this.dependencies.readSource(tuple.matrixSource, signal);
      let matrixAuthority: string;
      try { matrixAuthority = extractMatrixAuthority(matrixBytes); }
      catch { return fail("authority", "matrix source", "fresh persistent matrix boundary is malformed or unavailable"); }
      if (createHash("sha256").update(matrixAuthority, "utf8").digest("hex") !== tuple.matrixDigest) fail("authority", "matrix source", "fresh raw matrix authority drifted from the separately approved digest");
      return baseline;
    });
  }
  private async run(phase: NixosObservation["phase"], name: string, command: NixosProbeCommand, check: (result: NixosProbeResult) => void): Promise<void> {
    await this.probe(phase, name, async (signal) => {
      const result = await this.dependencies.run(command, signal);
      if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_BYTES) fail("observation", name, "fixed subprocess failed or exceeded its output bound");
      check(result);
    });
  }
  private async observe(phase: NixosObservation["phase"], baseline: NixosBaseline): Promise<void> {
    const cwd = baseline.tuple.worktreeRoot;
    const git = async (name: string, location: string, args: string[], expected: string): Promise<void> => this.run(phase, name, { tool: "git", args: ["-C", location, ...args], cwd }, (result) => {
      if (result.stdout !== expected) fail("observation", name, "exact Git identity or complete tracked/untracked status mismatched");
    });
    const physical = async (name: string, location: string): Promise<void> => this.probe(phase, name, async (signal) => {
      if (await this.dependencies.physicalPath(location, signal) !== location) fail("observation", name, "path is missing, aliased or physically mismatched");
    });
    await physical("candidate-path", cwd);
    await git("candidate-top-level", cwd, ["rev-parse", "--show-toplevel"], `${cwd}\n`);
    await git("candidate-branch", cwd, ["branch", "--show-current"], `${baseline.tuple.branch}\n`);
    await git("candidate-head", cwd, ["rev-parse", "HEAD"], `${baseline.tuple.featureSha}\n`);
    await git("candidate-status", cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], "");
    for (const tool of baseline.tools) await this.run(phase, `tool-${tool.name}`, { tool: tool.name, args: ["--version"], cwd }, (result) => {
      if (result.executable !== tool.executable || result.stdout !== `${tool.version}\n` || result.stderr !== "") fail("observation", "tool version", "exact fixed executable availability, identity or version mismatched");
    });
    let metadata: Uint8Array = Buffer.alloc(0); let config: Uint8Array = Buffer.alloc(0);
    await this.run(phase, "nix-metadata", { tool: "nix", args: ["flake", "metadata", "--json", "--no-update-lock-file", "--no-write-lock-file", cwd], cwd }, (result) => { metadata = Buffer.from(result.stdout); });
    await this.run(phase, "nix-config", { tool: "nix", args: ["config", "show", "--json"], cwd }, (result) => { config = Buffer.from(result.stdout); });
    await this.probe(phase, "complete-inventory", async () => {
      const discovered = discoverNixosInventory(metadata, config, cwd);
      for (const key of ["localInputs", "upstreams", "caches", "builders", "storage"] as const) if (!exactSet(discovered[key], baseline.inventory[key])) fail("observation", "complete inventory", "independently discovered and approved sets differ");
      if (discovered.daemon !== baseline.inventory.daemon) fail("observation", "Nix daemon", "daemon identity differs");
    });
    for (const local of baseline.localInputs) {
      await physical("local-path", local.path);
      await git("local-top-level", local.path, ["rev-parse", "--show-toplevel"], `${local.topLevel}\n`);
      await git("local-head", local.path, ["rev-parse", "HEAD"], `${local.head}\n`);
      await git("local-status", local.path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], local.status);
    }
    for (const store of [baseline.inventory.daemon, ...baseline.inventory.caches, ...baseline.inventory.builders]) await this.run(phase, "store-ping", { tool: "nix", args: ["store", "ping", "--store", store, "--json"], cwd }, (result) => {
      const ping = parseNixosStrictJson(Buffer.from(result.stdout)) as Record<string, unknown>;
      if (!ping || typeof ping !== "object" || ping["url"] !== store) fail("observation", "store-ping", "service observation does not identify the approved exact store");
    });
    for (const upstream of baseline.inventory.upstreams) {
      if (upstream.startsWith("git+") || upstream.endsWith(".git")) {
        await this.run(phase, "upstream", { tool: "git", args: ["-c", "http.followRedirects=false", "ls-remote", "--", upstream.replace(/^git\+/, "")], cwd: "/" }, (result) => {
          if (!result.stdout || result.stdout.split("\n").filter(Boolean).some((line) => !/^[0-9a-f]{40,64}\t[^\s]+$/.test(line))) fail("observation", "upstream", "upstream is unavailable or did not resolve valid references");
        });
      } else await this.probe(phase, "upstream-head", async (signal) => {
        const result = await this.dependencies.httpsHead(upstream, signal);
        if (result.endpoint !== upstream || result.status < 200 || result.status >= 300) fail("observation", "upstream HEAD", "exact upstream is unavailable or redirects to an unapproved endpoint");
      });
    }
    for (const storage of baseline.storage) await this.probe(phase, "storage", async (signal) => {
      const available = await this.dependencies.freeBytes(storage.path, signal);
      if (!Number.isSafeInteger(available) || available < storage.minimumFreeBytes) fail("observation", "storage", "filesystem is unavailable or below explicit approved free-byte threshold");
    });
    // Metadata/cache probes must not modify candidate or local project files/locks.
    await git("candidate-final-top-level", cwd, ["rev-parse", "--show-toplevel"], `${cwd}\n`);
    await git("candidate-final-branch", cwd, ["branch", "--show-current"], `${baseline.tuple.branch}\n`);
    await git("candidate-final-head", cwd, ["rev-parse", "HEAD"], `${baseline.tuple.featureSha}\n`);
    await git("candidate-final-status", cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], "");
    for (const local of baseline.localInputs) {
      await physical("local-final-path", local.path);
      await git("local-final-top-level", local.path, ["rev-parse", "--show-toplevel"], `${local.topLevel}\n`);
      await git("local-final-head", local.path, ["rev-parse", "HEAD"], `${local.head}\n`);
      await git("local-final-status", local.path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], local.status);
    }
  }
  async verify(): Promise<void> {
    if (this.state !== "new") fail("authority", "prerequisite session", "initial verification cannot be replayed");
    try { this.baseline = await this.authenticate("initial"); await this.observe("initial", this.baseline); this.state = "observed"; }
    catch (error) { this.state = "failed"; throw error; }
  }
  /** Phase 3 composes this around the existing matrix-start/executor boundary, not around accounting. */
  async executeImmediately<T>(start: () => T): Promise<T> {
    if (this.state !== "observed" || !this.baseline) fail("authority", "prerequisite session", "unverified, failed or consumed observations cannot authorize execution");
    try {
      const fresh = await this.authenticate("final");
      if (!same(this.baseline, fresh)) fail("authority", "baseline reread", "immutable expectations drifted");
      await this.observe("final", fresh);
      await this.authenticate("final");
      if (this.now() - this.startedMs >= NIXOS_TOTAL_MS) fail("deadline", "final revalidation", "aggregate deadline reached before execution");
      this.state = "executed";
      return start(); // no await or caller-controlled work between final reread and the execution boundary
    } catch (error) { this.state = "failed"; throw error; }
  }
}

/** Fixed argv executor: executable paths/environment come from the trusted launcher, never baseline data. */
export function createNixosProbeRunner(tools: Readonly<Record<NixosTool, string>>, env: Readonly<Record<string, string>>): NixosPrerequisiteDependencies["run"] {
  for (const tool of NIXOS_TOOLS) path(tools[tool]);
  const allowed = ["PATH", "HOME", "LANG", "TZ"];
  if (!exactSet(Object.keys(env), allowed) || Object.values(env).some((value) => /review-auth:|\0/.test(value))) fail("schema", "probe environment", "only the exact non-authority launcher environment is allowed");
  return async (command, signal) => {
    assertFixedCommand(command);
    return new Promise<NixosProbeResult>((resolveResult, reject) => {
      if (signal.aborted) { reject(new Error("probe aborted")); return; }
      const child = spawn(tools[command.tool], [...command.args], { cwd: command.cwd,
        env: { ...env, ...(command.tool === "git" ? { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } : {}) },
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let failure = false;
      const kill = (): void => { failure = true; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
      signal.addEventListener("abort", kill, { once: true });
      const collect = (chunks: Buffer[]) => (chunk: Buffer): void => { size += chunk.length; if (size > MAX_BYTES) kill(); else chunks.push(chunk); };
      child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
      child.once("error", (error) => { signal.removeEventListener("abort", kill); reject(error); });
      child.once("close", (code) => {
        signal.removeEventListener("abort", kill);
        if (failure || signal.aborted) reject(new Error("probe terminated"));
        else resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1, executable: tools[command.tool] });
      });
    });
  };
}
function assertFixedCommand(command: NixosProbeCommand): void {
  path(command.cwd);
  const args = command.args;
  if (!NIXOS_TOOLS.includes(command.tool) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) fail("schema", "fixed probe", "arbitrary executable or arguments are forbidden");
  if (same(args, ["--version"])) return;
  if (command.tool === "git") {
    if (args[0] === "-C" && args[1]) {
      path(args[1]);
      if ([["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["branch", "--show-current"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"]].some((fixed) => same(args.slice(2), fixed))) return;
    }
    if (args.length === 5 && same(args.slice(0, 4), ["-c", "http.followRedirects=false", "ls-remote", "--"])) { endpoint(args[4], "upstream"); return; }
  }
  if (command.tool === "nix") {
    if (same(args, ["config", "show", "--json"])) return;
    if (args.length === 6 && same(args.slice(0, 5), ["flake", "metadata", "--json", "--no-update-lock-file", "--no-write-lock-file"])) { path(args[5]); return; }
    if (args.length === 5 && same(args.slice(0, 3), ["store", "ping", "--store"]) && args[4] === "--json") { endpoint(args[3], "store"); return; }
  }
  fail("schema", "fixed probe", "only launcher-built read-only catalog commands are permitted");
}

/** Production I/O; phase 3 supplies the existing protected reservation/authorization reread closure. */
export function createNixosPrerequisiteDependencies(input: {
  tools: Readonly<Record<NixosTool, string>>;
  probeEnvironment: Readonly<Record<string, string>>;
  budgetStartedMs: number;
  rereadAuthority: NixosPrerequisiteDependencies["rereadAuthority"];
}): NixosPrerequisiteDependencies {
  return {
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    budgetStartedMs: input.budgetStartedMs,
    rereadAuthority: input.rereadAuthority,
    run: createNixosProbeRunner(input.tools, input.probeEnvironment),
    readSource: async (source, signal) => {
      const root = await realpath(getAiUsageDir()); const expected = resolve(root, artifact(source));
      if (await realpath(expected) !== expected) fail("authority", "persistent source", "source must not be aliased or substituted");
      const info = await lstat(expected);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) fail("authority", "persistent source", "source is not a bounded persistent regular file");
      return readFile(expected, { signal });
    },
    readComments: async (ticket) => new TicketStore().get(ticket)?.comments ?? [],
    httpsHead: async (location, signal) => {
      endpoint(location, "upstream");
      if (!location.startsWith("https://")) fail("schema", "HTTPS HEAD", "only exact HTTPS endpoints are permitted");
      return new Promise((resolveHead, reject) => {
        const request = httpsRequest(location, { method: "HEAD", signal }, (response) => {
          response.resume();
          resolveHead({ endpoint: location, status: response.statusCode ?? 0 });
        });
        request.on("error", reject); request.end();
      });
    },
    physicalPath: async (location) => realpath(location),
    freeBytes: async (location) => {
      const info = await statfs(location, { bigint: true });
      const available = info.bavail * info.bsize;
      if (available > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
      return Number(available);
    },
  };
}
