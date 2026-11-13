import { AutoWaitlistError, AUTO_PROJECTS, type AutoProject } from "./waitlist.js";
import { digest, object, strictJson, text, oneOf, integer, SHA256 } from "../workflows/contracts.js";
export const AUTO_LOCAL_EFFECTS = ["source.inspect", "source.edit-scoped", "check.execute-scoped", "repair.same-scope", "git.commit-local"] as const;
export const AUTO_EXCLUDED_EFFECTS = ["remote.push", "pull-request", "merge", "release", "deploy", "ticket.done", "checkout.return", "human-uat.signoff"] as const;
export interface AutoStartIntent {
  schemaVersion: "pa-auto-start/v1"; itemId: string; ticket: string; repository: { key: AutoProject; root: string };
  materialTicketSha256: string; ticketVersion: string; initialStatus: string; initialAssignee: string;
  subjectSha256: string; documentRevision: number;
  runtime: "pi"; team: "builder"; mode: "orchestrator"; provider: string; model: string;
  configRoot: string; configRevision: string; configResourcesSha256: string;
  objective: string; timeoutSeconds: number; deadlineAt: string;
  branch: { name: string; baseSha: string; state: "planned" | "materialized"; headSha: string | null };
  validation: { matrixSha256: string; commands: string[] };
  sourceScope: { files: string[]; directories: string[]; newPaths: string[] };
  localEffects: readonly string[]; excludedEffects: readonly string[];
  documentScope: "none" | "queue-only" | "publish-and-queue";
}
export function parseAutoStartIntent(raw: Uint8Array): AutoStartIntent {
  try {
    const r = object(strictJson(raw, 65_536), ["schemaVersion", "itemId", "ticket", "repository", "materialTicketSha256", "ticketVersion", "initialStatus", "initialAssignee", "subjectSha256", "documentRevision", "runtime", "team", "mode", "provider", "model", "configRoot", "configRevision", "configResourcesSha256", "objective", "timeoutSeconds", "deadlineAt", "branch", "validation", "sourceScope", "localEffects", "excludedEffects", "documentScope"]);
    const repo = object(r.repository, ["key", "root"]), key = oneOf(repo.key, ["pa-platform", "pa-platform-config"]);
    const branch = object(r.branch, ["name", "baseSha", "state", "headSha"]), validation = object(r.validation, ["matrixSha256", "commands"]);
    const sourceScope = parseAutoSourceScope(r.sourceScope);
    if (r.schemaVersion !== "pa-auto-start/v1" || r.runtime !== "pi" || r.team !== "builder" || r.mode !== "orchestrator"
      || JSON.stringify(r.localEffects) !== JSON.stringify(AUTO_LOCAL_EFFECTS) || JSON.stringify(r.excludedEffects) !== JSON.stringify(AUTO_EXCLUDED_EFFECTS)
      || !Array.isArray(validation.commands) || !validation.commands.length || validation.commands.length > 1000
      || validation.commands.some(c => typeof c !== "string" || !c.trim() || c.length > 4096 || /[\u0000-\u001f\u007f]/.test(c))) throw new Error();
    const deadlineAt = text(r.deadlineAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (!Number.isFinite(Date.parse(deadlineAt))) throw new Error();
    return { schemaVersion: "pa-auto-start/v1", itemId: text(r.itemId, /^auto-[0-9a-f-]{36}$/), ticket: text(r.ticket, new RegExp(`^${AUTO_PROJECTS[key]}-\\d+$`), 64), repository: { key, root: text(repo.root, /^\//) },
      materialTicketSha256: text(r.materialTicketSha256, SHA256), ticketVersion: text(r.ticketVersion, SHA256), initialStatus: oneOf(r.initialStatus, ["idea", "requirement-review", "pending-approval", "pending-implementation"]), initialAssignee: typeof r.initialAssignee === "string" && r.initialAssignee === "" ? "" : text(r.initialAssignee, /^(?:sinh|requirements\/team-manager|builder\/team-manager)$/), subjectSha256: text(r.subjectSha256, SHA256), documentRevision: integer(r.documentRevision, 1),
      runtime: "pi", team: "builder", mode: "orchestrator", provider: text(r.provider, /^[a-z][a-z0-9-]{0,63}$/), model: text(r.model, /^[A-Za-z0-9_./:-]{1,256}$/),
      configRoot: text(r.configRoot, /^\//), configRevision: text(r.configRevision, /^[a-f0-9]{40}$/), configResourcesSha256: text(r.configResourcesSha256, SHA256),
      objective: text(r.objective, undefined, 16384), timeoutSeconds: integer(r.timeoutSeconds, 60, 7200), deadlineAt,
      branch: { name: text(branch.name, /^feature\/[A-Za-z0-9._/-]+$/, 256), baseSha: text(branch.baseSha, /^[a-f0-9]{40}$/), state: oneOf(branch.state, ["planned", "materialized"]), headSha: branch.headSha === null ? null : text(branch.headSha, /^[a-f0-9]{40}$/) },
      validation: { matrixSha256: text(validation.matrixSha256, SHA256), commands: validation.commands as string[] }, sourceScope, localEffects: [...AUTO_LOCAL_EFFECTS], excludedEffects: [...AUTO_EXCLUDED_EFFECTS], documentScope: oneOf(r.documentScope, ["none", "queue-only", "publish-and-queue"]) };
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
export function parseAutoSourceScope(value: unknown): AutoStartIntent["sourceScope"] {
  const r = object(value, ["files", "directories", "newPaths"]);
  const paths = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 1024 || v.some(p => typeof p !== "string" || !/^[A-Za-z0-9_./-]+$/.test(p) || p.length > 4096 || p.startsWith("/") || p.split("/").some(s => !s || s === "." || s === ".." || s.toLowerCase() === ".git"))) throw new AutoWaitlistError("AUTO_SOURCE");
    return [...new Set(v as string[])];
  };
  const result = { files: paths(r.files), directories: paths(r.directories), newPaths: paths(r.newPaths) };
  if (!result.files.length && !result.directories.length && !result.newPaths.length) throw new AutoWaitlistError("AUTO_SOURCE");
  return result;
}
export function autoSourceScopeFromRequirements(bytes: Uint8Array): AutoStartIntent["sourceScope"] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const matches = [...text.matchAll(/^## Auto Execution Scope\r?\n\s*```json\r?\n([\s\S]*?)\r?\n```/gm)];
  if (matches.length !== 1) throw new AutoWaitlistError("AUTO_SOURCE");
  return parseAutoSourceScope(strictJson(Buffer.from(matches[0]![1]!), 65_536));
}
export const autoStartSha256 = (intent: AutoStartIntent): string => digest(JSON.stringify(parseAutoStartIntent(Buffer.from(JSON.stringify(intent)))));
/** Ranking, comments, updatedAt and owner-permitted publication/status changes
 * do not silently rebind scope or manufacture a second approval. */
export function autoMaterialTicketSha256(ticket: { id: string; project: string; title: string; summary: string; description: string; blockedBy: string[] }): string {
  return digest(JSON.stringify({ id: ticket.id, project: ticket.project, title: ticket.title, summary: ticket.summary, description: ticket.description, blockedBy: ticket.blockedBy }));
}
export interface AutoTaskBaseline {
  schemaVersion: "auto-task-baseline/v1"; repoKey: string; repoRoot: string; ticket: string; branch: string; baseSha: string;
  subjectSha256: string; decisionId: string; startSha256: string;
}
