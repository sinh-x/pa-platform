import { isAbsolute, join, posix, resolve } from "node:path";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { getPlatformHomeDir, getSkillsDir, getTeamsDir } from "../paths.js";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { CommittedConfigSource, type ConfigResource } from "../selected-config-source.js";
import { parseTeamYamlContent } from "../yaml-parser.js";
import type { TeamConfig } from "../types.js";
import { loadTemplateRegistry } from "../templates/registry.js";
import type { TemplateHost } from "../templates/service.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { array, digest, GIT_SHA, ID, JsonWorkflowError, literal, object, relativePath, SHA256, strictJson, text, unique, type ReviewBundle } from "./contracts.js";
import { loadSelectedWorkflows, type WorkflowSelection } from "./selected.js";
import type { WorkflowCaller, WorkflowState } from "./service.js";
import type { RegistryWorkflowJournal } from "../registry/workflows.js";

export interface WorkflowResources {
  schemaVersion: "pa-workflow-resources/v1"; configRoot: string; configRevision: string;
  repositoryKey: string; workflowSha256: string; registrySha256: string;
  routes: { team: string; mode: string }[]; files: { path: string; sha256: string }[];
  /** Inert bare-path prose references absent from this config commit, never a fallback grant. */
  absentReferences: string[];
}
export interface CapturedWorkflowResources { manifest: Uint8Array; files: readonly ConfigResource[]; assertCurrent(): void }
function blocked(): never { throw new JsonWorkflowError("WORKFLOW_SOURCE", "retained-resource-closure", "config-runtime-owner"); }
function managedPath(value: unknown): string {
  const path = relativePath(value);
  if (path.split("/").some(part => part.toLowerCase() === ".git")) blocked();
  if (!/^(?:contracts|workflows|teams|skills|docs|primers|policies)\//.test(path) && !["IDENTITY.md", "README.md", "CLAUDE.md"].includes(path)) blocked();
  return path;
}
function utf8(raw: Uint8Array): string {
  try { const value = new TextDecoder("utf-8", { fatal: true }).decode(raw); if (findSensitiveMatch("content", value)) blocked(); return value; } catch { return blocked(); }
}
export function parseWorkflowResources(raw: Uint8Array): WorkflowResources {
  const r = object(strictJson(raw), ["schemaVersion", "configRoot", "configRevision", "repositoryKey", "workflowSha256", "registrySha256", "routes", "files", "absentReferences"]);
  const root = text(r.configRoot); if (!isAbsolute(root) || resolve(root) !== root) blocked();
  const routes = array(r.routes, value => { const row = object(value, ["team", "mode"]); return { team: text(row.team, ID), mode: text(row.mode, ID) }; }, 4);
  unique(routes.map(route => `${route.team}/${route.mode}`));
  const files = array(r.files, value => { const row = object(value, ["path", "sha256"]); return { path: managedPath(row.path), sha256: text(row.sha256, SHA256) }; });
  const absentReferences = unique(array(r.absentReferences, managedPath));
  if (!routes.length || !files.length || files.length + absentReferences.length > 256 || absentReferences.some(path => files.some(file => file.path === path))) blocked(); unique(files.map(file => file.path));
  return { schemaVersion: literal(r.schemaVersion, "pa-workflow-resources/v1"), configRoot: root, configRevision: text(r.configRevision, GIT_SHA), repositoryKey: text(r.repositoryKey, ID), workflowSha256: text(r.workflowSha256, SHA256), registrySha256: text(r.registrySha256, SHA256), routes, files, absentReferences };
}
/** Closure of literal config-owned Markdown references, not filesystem discovery.
 * External links and product/artifact paths are not config selection authority. */
function references(path: string, body: string): { path: string; optional: boolean }[] {
  const refs = new Map<string, { path: string; optional: boolean }>();
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`((?:skills|teams|docs|primers|policies)\/[A-Za-z0-9_./-]+\.md)`/g)) {
    const target = (match[1] ?? match[2]!).split("#")[0]!;
    if (!target.endsWith(".md") || /^[a-z]+:|^\/|^#/.test(target)) continue;
    const relative = /^(?:skills|teams|docs|primers|policies)\//.test(target) ? target : posix.normalize(posix.join(posix.dirname(path), target));
    const resolved = managedPath(relative), optional = match[1] === undefined;
    if (!refs.has(resolved) || !optional) refs.set(resolved, { path: resolved, optional });
  }
  return [...refs.values()];
}
function teamClosure(read: (path: string, optional?: boolean) => Uint8Array | null, route: WorkflowResources["routes"][number], repoKey: string): TeamConfig {
  const pending: { path: string; optional: boolean }[] = [], seen = new Map<string, boolean>();
  const add = (value: unknown) => { if (typeof value !== "string") blocked(); pending.push({ path: managedPath(value), optional: false }); };
  const team = parseTeamYamlContent(utf8(read(`teams/${route.team}.yaml`) ?? blocked()));
  if (team.name !== route.team || !Array.isArray(team.agents) || !Array.isArray(team.deploy_modes)) blocked();
  const modes = team.deploy_modes.filter(mode => mode.id === route.mode); if (modes.length !== 1) blocked(); const mode = modes[0]!;
  const active = mode.agents ? team.agents.filter(agent => mode.agents!.includes(agent.name)) : team.agents;
  if (mode.agents && (new Set(mode.agents).size !== mode.agents.length || mode.agents.some(name => !active.some(agent => agent.name === name)))) blocked();
  for (const agent of active) { if (agent.instruction) add(agent.instruction); if (agent.skill) add(agent.skill); }
  const objective = mode.objective ?? team.objective;
  if (typeof objective !== "string") blocked();
  if (!objective.includes("\n") && objective.endsWith(".md")) add(objective);
  for (const path of [...(team.global_docs ?? []), ...(mode.global_docs ?? []), ...(mode.project_guides?.[repoKey] ?? [])]) add(path);
  for (const skill of mode.skills ?? []) { if (!["reference", "global-skill", "shared-skill"].includes(skill["inject-as"])) blocked(); add(`skills/global/${relativePath(skill.name)}/SKILL.md`); }
  while (pending.length) {
    const { path, optional } = pending.pop()!;
    if (seen.has(path) && (!seen.get(path) || optional)) continue;
    if (seen.size >= 256) blocked();
    const raw = read(path, optional); seen.set(path, raw === null);
    if (raw === null) { if (!optional) blocked(); continue; }
    pending.push(...references(path, utf8(raw)));
  }
  return team;
}
export function validateWorkflowResources(manifest: WorkflowResources, read: (sha256: string) => Uint8Array, subject: ReviewBundle): ReadonlyMap<string, Uint8Array> {
  if (manifest.configRevision.length !== 40 || manifest.workflowSha256 !== subject.workflow.sha256 || manifest.repositoryKey !== subject.repository.key
    || !manifest.routes.some(route => route.team === subject.route.team && route.mode === subject.route.mode)) blocked();
  const files = new Map<string, Uint8Array>(); let total = 0;
  for (const file of manifest.files) {
    const raw = read(file.sha256); total += raw.byteLength;
    if (raw.byteLength > 1_048_576 || total > 16_777_216 || digest(raw) !== file.sha256) blocked();
    utf8(raw); files.set(file.path, Buffer.from(raw));
  }
  const at = (path: string): Uint8Array => { const raw = files.get(managedPath(path)); if (!raw) return blocked(); return raw; };
  const loaded = loadTemplateRegistry({ root: manifest.configRoot, configRevision: manifest.configRevision, registrySha256: manifest.registrySha256 }, files);
  if (!loaded.registry.entries.some(entry => entry.id === "review-bundle" && entry.validation.kind === "review-bundle" && entry.capabilities.render && entry.capabilities.validate)) blocked();
  const selected = loadSelectedWorkflows({ root: () => manifest.configRoot, revision: () => manifest.configRevision, read: (_root, path) => at(path) });
  if (!selected.definitions.some(row => row.sha256 === subject.workflow.sha256 && row.definition.workflowId === subject.workflow.id && row.definition.version === subject.workflow.version)) blocked();
  for (const route of manifest.routes) teamClosure((path, optional) => optional && manifest.absentReferences.includes(path) ? null : at(path), route, manifest.repositoryKey);
  return files;
}
export function captureWorkflowResources(selection: WorkflowSelection, subject: ReviewBundle, caller: WorkflowCaller): CapturedWorkflowResources {
  try {
    const source = CommittedConfigSource.selected();
    if (source.root !== selection.configRoot || source.revision !== selection.configRevision || getSkillsDir() !== join(source.root, "skills/global")) blocked();
    const templates = loadTemplateRegistry(); if (templates.identity.root !== source.root || templates.identity.configRevision !== source.revision) blocked();
    const read = (path: string): Uint8Array => source.read(managedPath(path))!;
    const readInstruction = (path: string, optional = false) => source.read(managedPath(path), optional);
    read("contracts/templates-v1.json"); for (const entry of templates.registry.entries) read(entry.source.path);
    const manifestBytes = read("workflows/manifest.json"); if (digest(manifestBytes) !== selection.manifestSha256) blocked();
    const selected = object(strictJson(manifestBytes), ["schemaVersion", "definitions", "bindings"]);
    for (const definition of array(selected.definitions, value => object(value, ["workflowId", "version", "file", "sha256"]))) read(managedPath(definition.file));
    const definition = selection.definitions.find(row => row.sha256 === subject.workflow.sha256)?.definition; if (!definition) blocked();
    const consumers = definition.steps.some(step => step.operation.id === "check.matrix") ? [{ team: "requirements", mode: "review-auto" }] : [];
    const routes = [...new Map([{ team: caller.team, mode: caller.mode }, subject.route, ...consumers].map(route => [`${route.team}/${route.mode}`, route])).values()];
    for (const route of routes) teamClosure(readInstruction, route, subject.repository.key);
    const files = source.resources(), manifest: WorkflowResources = { schemaVersion: "pa-workflow-resources/v1", configRoot: source.root, configRevision: source.revision, repositoryKey: subject.repository.key, workflowSha256: subject.workflow.sha256, registrySha256: templates.identity.registrySha256, routes, files: files.map(({ path, sha256 }) => ({ path, sha256 })), absentReferences: source.absentResources() };
    const raw = Buffer.from(JSON.stringify(manifest)); parseWorkflowResources(raw);
    validateWorkflowResources(manifest, sha => { const file = files.find(file => file.sha256 === sha); if (!file) return blocked(); return file.raw; }, subject);
    source.assertCurrent(); return { manifest: raw, files, assertCurrent: () => source.assertCurrent() };
  } catch { return blocked(); }
}
export function requireWorkflowResources(state: WorkflowState): WorkflowResources { if (!state.resources) return blocked(); return state.resources; }
export function retainedTemplateHost(journal: RegistryWorkflowJournal, state: WorkflowState): TemplateHost {
  const manifest = requireWorkflowResources(state), resources = validateWorkflowResources(manifest, sha => journal.snapshot(sha), state.subject);
  return { selection: { root: manifest.configRoot, configRevision: manifest.configRevision, registrySha256: manifest.registrySha256 }, resources };
}
export function retainedWorkflowSelection(journal: RegistryWorkflowJournal, state: WorkflowState): WorkflowSelection {
  const host = retainedTemplateHost(journal, state);
  return loadSelectedWorkflows({ root: () => host.selection!.root, revision: () => state.configRevision, read: (_root, path) => host.resources!.get(path) ?? null });
}
export function retainedWorkflowTeam(journal: RegistryWorkflowJournal, state: WorkflowState, team: string, mode: string): TeamConfig {
  const manifest = requireWorkflowResources(state); if (!manifest.routes.some(route => route.team === team && route.mode === mode)) blocked();
  const host = retainedTemplateHost(journal, state); return teamClosure((path, optional) => optional && manifest.absentReferences.includes(path) ? null : host.resources!.get(path) ?? blocked(), { team, mode }, manifest.repositoryKey);
}
/** Only the configured physical namespace stays live; selected HEAD is NOT used
 * to migrate retained data, decisions or instructions. No authority is frozen. */
export function assertRetainedConfigIdentity(state: WorkflowState): void {
  const manifest = requireWorkflowResources(state);
  try {
    if (getPlatformHomeDir() !== manifest.configRoot || realpathSync(manifest.configRoot) !== manifest.configRoot || getTeamsDir() !== join(manifest.configRoot, "teams")) blocked();
    try { if (realpathSync(getTeamsDir()) !== getTeamsDir()) blocked(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch { blocked(); }
}
/** Read-only projection under the existing deployment workspace owner. It is
 * never a source/approval ledger; bytes are always verified against the journal. */
export function materializeWorkflowResources(journal: RegistryWorkflowJournal, state: WorkflowState, deploymentDir: string): string {
  const host = retainedTemplateHost(journal, state), root = join(deploymentDir, "pinned-workflow-config");
  if (realpathSync(deploymentDir) !== deploymentDir) blocked();
  const directory = (path: string) => { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path || (s.mode & 0o022) || (process.getuid && s.uid !== process.getuid())) blocked(); };
  directory(root);
  for (const [relative, raw] of host.resources!) {
    const parts = managedPath(relative).split("/"); let parent = root;
    for (const part of parts.slice(0, -1)) { parent = join(parent, part); directory(parent); }
    const path = join(parent, parts.at(-1)!);
    try { writeFileSync(path, raw, { mode: 0o400, flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o222) || (process.getuid && stat.uid !== process.getuid()) || digest(readReviewEvidenceFile(path, 1_048_576, "workflow.resource-projection")) !== digest(raw)) blocked();
  }
  return root;
}
