import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getPlatformHomeDir, getSkillsDir, getTeamsDir } from "../paths.js";
import { queryReadonlyDeploymentEvents, queryReadonlyIsolationLineage } from "../registry/index.js";
import { findSensitiveMatch, getSensitiveFilename } from "../sensitive-patterns.js";
import { SecurityPolicyError } from "../security-policy.js";
import { parseReviewEvidenceJson, readReviewEvidenceFile } from "../validation/review-contract.js";
import { parseTeamYamlContent } from "../yaml-parser.js";
import type { DeployMode, RuntimeName, TeamConfig } from "../types.js";
import type { DeployRequest } from "./control.js";
import type { EffectiveRuntimeConfig } from "./runtime-config.js";
import { getDeployPaths } from "./paths.js";
import { assertRepositoryIsolationResumeAvailable, readRecordedRuntimeSession } from "./repository-isolation.js";
import { ConfigScriptDependencies, CONFIG_RESOURCE_PREFIX, CONFIG_RESOURCE_ROOTS } from "./config-script-dependencies.js";
import { Lexer, walkTokens } from "marked";
import { agentSkillResource } from "../teams/index.js";

const VERSION = "pa-rogue-one-config/v1", FILE = "rogue-one-config.json", PREFIX = `${VERSION}:`;
const MAX_FILE = 1_048_576, MAX_TOTAL = 16 * MAX_FILE, MAX_FILES = 256, MAX_ARCHIVE = 24 * MAX_FILE;
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
type Cause = "selection" | "contract" | "resource" | "drift" | "snapshot" | "legacy" | "conflict" | "route" | "policy";
const reasons: Record<Cause, string> = {
  policy: "Required PA-owned security defaults are unavailable; retained configuration cannot replace current security policy.",
  route: "This configured Rogue-One route has no qualified full-retention consumer. Only foreground PPA CLI is supported; OpenCode, background and API launch are unavailable.",
  selection: "The selected mode is missing, unknown or ambiguous.",
  contract: "Rogue-One supports only ticket-optional, profile-free interactive configuration; configured content cannot grant native authority.",
  resource: "The selected configuration resource closure is missing, unsafe, unsupported or exceeds its bounds.",
  drift: "Selected configuration changed during capture; no coherent retained configuration was established.",
  snapshot: "The original native configuration snapshot or its deployment binding cannot be verified; current PAPC is not a substitute.",
  legacy: "The retained session has no verifiable original full-configuration snapshot; it cannot be silently migrated.",
  conflict: "The continuation request conflicts with the original configuration, runtime or repository identity.",
};
export class RogueOneConfigError extends Error {
  constructor(readonly cause: Cause, policy?: SecurityPolicyError) {
    super(cause === "policy" && policy instanceof SecurityPolicyError ? policy.message : `Rogue-One configuration is blocked.\nCondition: Configuration validation must succeed before runtime start.\nSource: Native retained-configuration owner.\nReason: ${reasons[cause]}\nCorrection: Ask the runtime/configuration owner to inspect the original selection and retained evidence. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs need their owner. Prerequisite: preserve the original session and partial results.\nResume Action: Recheck the same request only after owner reconciliation. Admission is checked again before any runtime start.`);
    this.name = "RogueOneConfigError";
  }
}
const fail = (cause: Cause): never => { throw new RogueOneConfigError(cause); };
function propagate(error: unknown, fallback: Cause): never {
  if (error instanceof RogueOneConfigError) throw error;
  if (error instanceof SecurityPolicyError) throw new RogueOneConfigError("policy", error);
  return fail(fallback);
}
function path(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_./-]+$/.test(value)
    || value.split("/").length > 16 || value.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
    || !CONFIG_RESOURCE_PREFIX.test(value)) fail("resource");
  return value;
}
function guardOriginalPath(root: string, relative: string): void {
  const original = join(root, path(relative));
  if (findSensitiveMatch("path", original) || findSensitiveMatch("filename", getSensitiveFilename(original))) fail("resource");
}
function body(raw: Uint8Array): string {
  try { const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); if (findSensitiveMatch("content", value)) fail("resource"); return value; }
  catch (error) { return propagate(error, "resource"); }
}
export function selectRogueOneMode(team: TeamConfig, requested?: string): DeployMode {
  const id = requested ?? team.default_mode, modes = team.deploy_modes?.filter(mode => mode.id === id);
  if (team.name !== "rogue-one" || typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || modes?.length !== 1) return fail("selection");
  const mode = modes[0]!;
  if (mode.mode_type !== "interactive" || mode.require_ticket === true || mode.document_profile !== undefined || mode.capability_policy !== undefined) fail("contract");
  if (!Array.isArray(team.agents) || new Set(team.agents.map(agent => agent.name)).size !== team.agents.length
    || mode.agents && (new Set(mode.agents).size !== mode.agents.length || mode.agents.some(name => !team.agents.some(agent => agent.name === name)))) fail("contract");
  return mode;
}
/** Literal config-owned references only. External/product/artifact links are not
 * selection authority. Bare prose references may be absent; links must resolve.
 * Static JavaScript dependencies have a separate parsing owner below. */
function references(from: string, value: string, inline = false, instruction = true): { path: string; optional: boolean }[] {
  const result = new Map<string, { path: string; optional: boolean }>();
  const add = (href: string, optional = false) => {
    const target = href.split("#")[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(target)) return;
    const relative = path(CONFIG_RESOURCE_PREFIX.test(target) ? target : posix.normalize(posix.join(posix.dirname(from), target)));
    if (!result.has(relative) || !optional) result.set(relative, { path: relative, optional });
  };
  const prose = inline || /\.(?:md|txt|html)$/.test(from);
  if (prose) {
    walkTokens(Lexer.lex(value), token => { if (token.type === "link" || token.type === "image") add(token.href); });
  }
  // Literal config-owned locators inside commands/prose are finite supporting
  // references too; absent illustrative bare paths never become live fallbacks.
  const literal = new RegExp(`(?:^|[\\s\x60\"'(])(${CONFIG_RESOURCE_ROOTS}/[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)`, "gm");
  if (prose && instruction) for (const match of value.matchAll(literal)) add(match[1]!, true);
  if (from.endsWith(".html")) {
    if (/<script\b|\bon[a-z]+\s*=/i.test(value)) fail("resource");
    for (const match of value.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) add(match[1]!);
  }
  if (from.endsWith(".json")) {
    const scan = (node: unknown, depth = 0): void => {
      if (depth > 64) fail("resource");
      if (!node || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node)) { if (key === "$ref" && typeof child === "string") add(child); else scan(child, depth + 1); }
    };
    scan(parseReviewEvidenceJson(Buffer.from(value), "config resource"));
  }
  return [...result.values()];
}
interface Resource { path: string; sha256: string; content: string }
interface Snapshot {
  schemaVersion: typeof VERSION; deploymentId: string; runtime: RuntimeName; configRoot: string;
  repoKey: string; repoRoot: string; worktreeRoot: string; ticket: string | null; mode: string;
  request: Pick<DeployRequest, "objective" | "provider" | "model" | "teamModel" | "agentModel" | "timeout" | "autonomy">;
  runtimeConfig: EffectiveRuntimeConfig; files: Resource[]; absent: string[];
}
export interface RogueOneConfigContext { deploymentId: string; runtime: RuntimeName; repoKey: string; repoRoot: string; worktreeRoot: string; ticket?: string }
function closure(team: TeamConfig, mode: DeployMode, repoKey: string, read: (relative: string, optional: boolean) => string | null): void {
  const pending: { path: string; optional: boolean }[] = [], seen = new Set<string>();
  const scripts = new ConfigScriptDependencies(read), instructions = new Set<string>();
  const add = (relative: string) => { instructions.add(path(relative)); pending.push({ path: relative, optional: false }); };
  const addInline = (value: string) => { for (const reference of references("teams/rogue-one.yaml", value, true)) { instructions.add(reference.path); pending.push(reference); } };
  const objective = mode.objective ?? team.objective;
  if (typeof objective !== "string") fail("contract");
  const objectiveFile = !objective.includes("\n") && objective.endsWith(".md");
  if (objectiveFile) add(objective);
  for (const value of [objectiveFile ? "" : objective, team.description, team.context?.organization, team.context?.notes, ...Object.values(team.variables ?? {})]) {
    if (value) addInline(value);
  }
  for (const file of [...team.global_docs ?? [], ...mode.global_docs ?? [], ...mode.project_guides?.[repoKey] ?? []]) add(file);
  for (const agent of team.agents.filter(agent => !mode.agents || mode.agents.includes(agent.name))) {
    addInline(agent.role);
    if (agent.instruction) add(agent.instruction);
    if (agent.skill) add(agentSkillResource(agent.skill));
  }
  for (const skill of mode.skills ?? []) {
    if (!["reference", "global-skill", "shared-skill"].includes(skill["inject-as"])) fail("contract");
    add(`skills/global/${path(`skills/${skill.name}`).slice(7)}/SKILL.md`);
  }
  while (pending.length) {
    const next = pending.pop()!, key = `${next.path}:${next.optional}`;
    if (seen.has(key)) continue;
    if (seen.size >= MAX_FILES * 2) fail("resource");
    seen.add(key);
    const content = read(next.path, next.optional);
    if (content === null) { if (!next.optional) fail("resource"); continue; }
    if (/\.(?:mjs|cjs|js)$/.test(next.path)) {
      for (const dependency of scripts.references(next.path, content)) add(dependency);
    } else {
      if (!/\.(?:md|txt|json|ya?ml|html)$/.test(next.path)) fail("resource");
      // Linked manuals/examples retain their literal links and full bytes, but
      // do not select their bare command examples as this mode's instructions.
      // Selected instructions and their actual helper imports still close fully.
      pending.push(...references(next.path, content, false, instructions.has(next.path)));
    }
  }
}
function physical(root: string, relative: string): string {
  const parts = path(relative).split("/"); let at = root;
  if (realpathSync(root) !== root) fail("resource");
  for (const part of parts.slice(0, -1)) {
    at = join(at, part); const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(at) !== at) fail("resource");
  }
  return join(at, parts.at(-1)!);
}
const fingerprint = (file: string) => {
  const s = lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) fail("resource");
  return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
};
function directory(file: string): void {
  const s = lstatSync(file);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(file) !== file || (s.mode & 0o022) || s.uid !== process.getuid?.()) fail("snapshot");
}
function retainedRead(file: string, limit: number): Uint8Array {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o222) || s.uid !== process.getuid?.()) fail("snapshot");
  return readReviewEvidenceFile(file, limit, "rogue-one retained configuration");
}
function put(file: string, raw: Uint8Array): void {
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (hash(retainedRead(file, raw.byteLength)) !== hash(raw)) fail("snapshot");
}
/** Content retention only: no native permission, caller authentication or sandbox.
 * The launcher still owns current admission, session identity and revocation. */
export class RogueOneConfig {
  private constructor(private readonly snapshot: Snapshot, private readonly raw: Uint8Array, private readonly current: () => void) {}
  get team(): TeamConfig { return parseTeamYamlContent(this.read("teams/rogue-one.yaml")); }
  get mode(): DeployMode { return selectRogueOneMode(this.team, this.snapshot.mode); }
  get runtimeConfig(): EffectiveRuntimeConfig { return Object.freeze({ ...this.snapshot.runtimeConfig }); }
  get note(): string { return `${PREFIX}${hash(this.raw)}`; }
  get resources(): readonly Readonly<{ path: string; sha256: string }>[] {
    return Object.freeze(this.snapshot.files.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  }
  read(relative: string): string { return this.snapshot.files.find(file => file.path === path(relative))?.content ?? fail("resource"); }
  assertCurrent(): void {
    try { this.current(); }
    catch (error) { propagate(error, "snapshot"); }
  }
  /** Classify native originals before loading the requested team's configuration.
   * Isolation keeps its existing priority; neither public labels nor live PAPC
   * can turn a Rogue-One lineage into a generic historical continuation. */
  static assertResumeTeam(request: Pick<DeployRequest, "team" | "resume">, runtime: RuntimeName): void {
    if (!request.resume) return;
    let rogue = request.team === "rogue-one";
    let starts: ReturnType<typeof queryReadonlyDeploymentEvents>;
    let lineage: ReturnType<typeof queryReadonlyIsolationLineage>;
    try {
      const events = queryReadonlyDeploymentEvents(request.resume, true);
      rogue ||= events.some(event => event.team === "rogue-one" || event.rogue_one || event.note?.startsWith("pa-rogue-one-config/"));
      starts = events.filter(event => event.event === "started");
      lineage = queryReadonlyIsolationLineage(request.resume);
      rogue ||= lineage.some(prior => prior.team === "rogue-one" || prior.note?.startsWith("pa-rogue-one-config/"));
    } catch {
      // Generic historical requests retain strict mode selection precedence.
      // Their existing admission still rejects unavailable lineage afterwards.
      if (!rogue) return;
      assertRepositoryIsolationResumeAvailable(request.resume, request.team === "rogue-one" ? runtime : undefined);
      return fail("snapshot");
    }
    if (!rogue) return;
    assertRepositoryIsolationResumeAvailable(request.resume, request.team === "rogue-one" ? runtime : undefined);
    if (starts.length !== 1) fail("snapshot");
    if (request.team !== "rogue-one" || starts[0]!.team !== "rogue-one" || lineage.some(prior => prior.team !== "rogue-one")) fail("conflict");
  }
  static capture(context: RogueOneConfigContext, request: DeployRequest, selected: TeamConfig, runtimeConfig: EffectiveRuntimeConfig, observeResource?: (relative: string) => void): RogueOneConfig {
    try {
      const root = getPlatformHomeDir();
      if (!isAbsolute(root) || resolve(root) !== root || getTeamsDir() !== join(root, "teams") || getSkillsDir() !== join(root, "skills/global")) fail("contract");
      const observed = new Map<string, { fingerprint: string; content: string }>(), absent = new Set<string>(); let total = 0;
      const read = (relative: string, optional = false): string | null => {
        guardOriginalPath(root, relative); observeResource?.(relative);
        try {
          const file = physical(root, relative);
          const before = fingerprint(file), raw = readReviewEvidenceFile(file, MAX_FILE, "rogue-one selected configuration"), content = body(raw);
          if (before !== fingerprint(file)) fail("drift");
          const previous = observed.get(relative);
          if (previous && (previous.fingerprint !== before || previous.content !== content)) fail("drift");
          if (!previous) {
            if (observed.size + absent.size >= MAX_FILES || total + raw.byteLength > MAX_TOTAL) fail("resource");
            observed.set(relative, { fingerprint: before, content }); total += raw.byteLength;
          }
          return content;
        } catch (error) {
          if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") { if (observed.size + absent.size >= MAX_FILES) fail("resource"); absent.add(relative); return null; }
          throw error;
        }
      };
      const team = parseTeamYamlContent(read("teams/rogue-one.yaml") ?? fail("resource"));
      if (!isDeepStrictEqual(team, selected)) fail("drift");
      const mode = selectRogueOneMode(team, request.mode);
      closure(team, mode, context.repoKey, read);
      const assertCurrent = () => {
        if (getPlatformHomeDir() !== root || getTeamsDir() !== join(root, "teams") || getSkillsDir() !== join(root, "skills/global")) fail("drift");
        for (const [relative, old] of observed) {
          guardOriginalPath(root, relative);
          const file = physical(root, relative);
          if (fingerprint(file) !== old.fingerprint || body(readReviewEvidenceFile(file, MAX_FILE, "rogue-one capture recheck")) !== old.content) fail("drift");
        }
        for (const relative of absent) {
          guardOriginalPath(root, relative);
          try { lstatSync(physical(root, relative)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          fail("drift");
        }
      };
      const overrides: Snapshot["request"] = {};
      for (const key of ["objective", "provider", "model", "teamModel", "agentModel", "timeout", "autonomy"] as const) if (request[key] !== undefined) Object.assign(overrides, { [key]: request[key] });
      const snapshot: Snapshot = { schemaVersion: VERSION, ...context, ticket: context.ticket ?? null, configRoot: root, mode: mode.id, request: overrides, runtimeConfig,
        files: [...observed].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => ({ path, content: value.content, sha256: hash(Buffer.from(value.content)) })), absent: [...absent].sort() };
      assertCurrent(); const raw = Buffer.from(JSON.stringify(snapshot));
      if (raw.byteLength > MAX_ARCHIVE) fail("resource");
      return new RogueOneConfig(snapshot, raw, assertCurrent);
    } catch (error) { return propagate(error, "resource"); }
  }
  /** Native immutable start anchors the bytes. A disk manifest/hash alone does
   * not establish native origin. Never accept a caller-supplied digest/note. */
  static resume(id: string, request: DeployRequest, context: Omit<RogueOneConfigContext, "deploymentId">): RogueOneConfig {
    try {
      assertRepositoryIsolationResumeAvailable(id, context.runtime);
      const session = readRecordedRuntimeSession(id, `session-id-${context.runtime}.txt`);
      if (!session) fail("snapshot");
      const starts = queryReadonlyDeploymentEvents(id, true).filter(event => event.event === "started");
      if (starts.length !== 1) fail("snapshot");
      const start = starts[0]!;
      if (start.team !== "rogue-one" || !start.rogue_one || start.builder_authority || start.mode_capability_binding || start.parent_deployment_id) fail("snapshot");
      if (!start.note?.startsWith(PREFIX)) fail("legacy");
      const dir = getDeployPaths(id).deployDir; directory(dir);
      const raw = retainedRead(join(dir, FILE), MAX_ARCHIVE);
      if (start.note !== `${PREFIX}${hash(raw)}`) fail("snapshot");
      const value = parseReviewEvidenceJson(raw, "rogue-one retained configuration", MAX_ARCHIVE) as Snapshot;
      if (value.schemaVersion !== VERSION || value.deploymentId !== id || JSON.stringify(value) !== Buffer.from(raw).toString()
        || value.configRoot !== getPlatformHomeDir() || getTeamsDir() !== join(value.configRoot, "teams") || getSkillsDir() !== join(value.configRoot, "skills/global")
        || start.mode !== value.mode || start.runtime !== value.runtime || start.provider !== value.runtimeConfig.provider || start.models?.team !== value.runtimeConfig.model
        || value.runtime !== context.runtime || value.repoKey !== context.repoKey || value.repoRoot !== context.repoRoot || value.worktreeRoot !== context.worktreeRoot || value.ticket !== (context.ticket ?? null)
        || start.repo_root !== value.repoRoot || start.worktree_root !== value.worktreeRoot || (start.ticket_id ?? null) !== value.ticket) fail("snapshot");
      if (request.team !== "rogue-one" || request.mode !== undefined && request.mode !== value.mode) fail("conflict");
      for (const key of ["objective", "provider", "model", "teamModel", "agentModel", "timeout", "autonomy"] as const) if (request[key] !== undefined && request[key] !== value.request[key]) fail("conflict");
      if (!Array.isArray(value.files) || !Array.isArray(value.absent) || value.files.length + value.absent.length > MAX_FILES) fail("snapshot");
      const assertPolicy = () => {
        for (const file of value.files) { guardOriginalPath(value.configRoot, file.path); body(Buffer.from(file.content)); }
        for (const relative of value.absent) guardOriginalPath(value.configRoot, relative);
      };
      assertPolicy();
      const files = new Map<string, string>(); let total = 0;
      for (const file of value.files) {
        const raw = Buffer.from(file.content); total += raw.byteLength;
        if (raw.byteLength > MAX_FILE || total > MAX_TOTAL || hash(raw) !== file.sha256 || files.has(path(file.path))) fail("snapshot");
        files.set(file.path, file.content);
      }
      if (new Set(value.absent).size !== value.absent.length || value.absent.some(relative => files.has(path(relative)))) fail("snapshot");
      const read = (relative: string, optional: boolean) => files.get(relative) ?? (optional && value.absent.includes(relative) ? null : fail("snapshot"));
      const team = parseTeamYamlContent(read("teams/rogue-one.yaml", false)!);
      closure(team, selectRogueOneMode(team, value.mode), value.repoKey, read);
      return new RogueOneConfig(value, Buffer.from(raw), () => {
        assertRepositoryIsolationResumeAvailable(id, context.runtime);
        if (readRecordedRuntimeSession(id, `session-id-${context.runtime}.txt`) !== session) fail("snapshot");
        const current = queryReadonlyDeploymentEvents(id, true).filter(event => event.event === "started");
        if (current.length !== 1 || !isDeepStrictEqual(current[0], start) || hash(retainedRead(join(dir, FILE), MAX_ARCHIVE)) !== hash(raw)) fail("snapshot");
        assertPolicy();
      });
    } catch (error) { return propagate(error, "snapshot"); }
  }
  continuation(request: DeployRequest): DeployRequest {
    return { ...request, ...this.snapshot.request, mode: this.snapshot.mode };
  }
  /** A continuation gets a new native start binding, not a rewritten original. */
  forDeployment(deploymentId: string): RogueOneConfig {
    if (!/^d-[a-f0-9]{6}$/.test(deploymentId)) return fail("snapshot");
    const snapshot = { ...this.snapshot, deploymentId };
    return new RogueOneConfig(snapshot, Buffer.from(JSON.stringify(snapshot)), this.current);
  }
  /** Absent-only persistence and verified projection. Interrupted/competing
   * writes are retained, never replaced. The start note is emitted only later. */
  materialize(deploymentId: string): string {
    try {
      this.assertCurrent();
      if (deploymentId !== this.snapshot.deploymentId) fail("snapshot");
      const dir = getDeployPaths(deploymentId).deployDir; directory(dir);
      const root = join(dir, "rogue-one-config");
      try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      directory(root);
      for (const file of this.snapshot.files) {
        let parent = root;
        for (const part of path(file.path).split("/").slice(0, -1)) {
          parent = join(parent, part);
          try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          directory(parent);
        }
        put(join(root, file.path), Buffer.from(file.content));
      }
      put(join(dir, FILE), this.raw);
      const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.assertCurrent(); return root;
    } catch (error) { return propagate(error, "snapshot"); }
  }
}
