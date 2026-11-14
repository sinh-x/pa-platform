import { object, strictJson, text, integer, oneOf, SHA256 } from "../workflows/contracts.js";
import { parseAutoSourceScope, AUTO_LOCAL_EFFECTS, AUTO_EXCLUDED_EFFECTS, type AutoStartIntent } from "../auto/intent.js";
import { AutoWaitlistError, type AutoProject } from "../auto/waitlist.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";

export const AUTO_POLICY_LIMITS = Object.freeze({ scanSeconds: 120, reasoningSeconds: 600, draftSeconds: 1800, implementationSeconds: 1800,
  sourceRequests: 32, fileBytes: 131072, contextBytes: 1048576, responseBytes: 1048576, metadataBytes: 65536, scanFiles: 20000, pageRows: 100, shortlist: 10, briefWords: 1000, briefBytes: 16384 });
export const AUTO_POLICY_EFFECTS = Object.freeze(["draft.source-read", "draft.own-unsigned-artifacts", "draft.own-nonprimary-ticket-append", "document.delegated-publication", "ticket.delegated-queue", "repository.finite-preparation", ...AUTO_LOCAL_EFFECTS]);
export interface AutoDelegationDefinition {
  schemaVersion: "pa-auto-delegation-definition/v1"; lifetimeSeconds: number;
  repositories: Array<{ key: AutoProject; sourceScope: AutoStartIntent["sourceScope"]; checkIds: string[] }>;
}
export interface AutoPolicyRole { team: "requirements" | "builder"; mode: string; provider: string; model: string; objective: { path: string; sha256: string } }
export interface AutoDelegationPolicy {
  schemaVersion: "pa-auto-delegation-policy/v1"; policyId: string;
  domain: { aiUsageRoot: string; registryPath: string; principal: string };
  runtime: { sourceSha: string; packageVersion: string; storeRoot: string };
  pairing: { configRoot: string; configRevision: string; resourcesSha256: string; definitionSha256: string };
  goalRules: { timezone: string; sources: Array<{ pathTemplate: string; dateFormat: "iso" | "underscore"; heading: string }> };
  repositories: Array<{ key: AutoProject; root: string; repositoryConfigSha256: string; sourceScope: AutoStartIntent["sourceScope"]; checkProfileSha256: string; commands: string[] }>;
  roles: { reasoning: AutoPolicyRole; draft: AutoPolicyRole; implementation: AutoPolicyRole };
  limits: typeof AUTO_POLICY_LIMITS; localEffects: readonly string[]; excludedEffects: readonly string[];
  guardrails: { repositoryProtection: "instruction-only"; cleanupScope: "observed-process-group-no-escaped-descendant-guarantee"; finalReview: "human-before-integration" };
  clock: { bootId: string; startedNs: string }; createdAt: string; expiresAt: string;
}
export const autoPolicyTime = (value: unknown): number => {
  const s = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), n = Date.parse(s);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== s) throw new AutoWaitlistError("AUTO_SOURCE"); return n;
};
const root = (value: unknown) => {
  const p = text(value, /^\//, 4096); if (/[\u2028\u2029]/u.test(p) || p === "/" || p.includes("\\") || p.slice(1).split("/").some(s => !s || s === "." || s === "..")) throw new AutoWaitlistError("AUTO_SOURCE"); return p;
};
const list = (value: unknown, max: number, pattern?: RegExp, size = 4096): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new AutoWaitlistError("AUTO_SOURCE");
  const result = value.map(v => { const s = text(v, pattern, size); if (/[\u2028\u2029]/u.test(s)) throw new AutoWaitlistError("AUTO_SOURCE"); return s; }); if (new Set(result).size !== result.length) throw new AutoWaitlistError("AUTO_SOURCE"); return result;
};
export function parseAutoDelegationDefinition(raw: Uint8Array): AutoDelegationDefinition {
  try {
    const r = object(strictJson(raw, 65536), ["schemaVersion", "lifetimeSeconds", "repositories"]);
    if (r.schemaVersion !== "pa-auto-delegation-definition/v1" || !Array.isArray(r.repositories) || r.repositories.length !== 2) throw new Error();
    const repositories = r.repositories.map(value => {
      const p = object(value, ["key", "sourceScope", "checkIds"]);
      return { key: oneOf(p.key, ["pa-platform", "pa-platform-config"]), sourceScope: parseAutoSourceScope(p.sourceScope), checkIds: list(p.checkIds, 1000, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 128) };
    });
    if (new Set(repositories.map(r => r.key)).size !== 2) throw new Error();
    return { schemaVersion: "pa-auto-delegation-definition/v1", lifetimeSeconds: integer(r.lifetimeSeconds, 60, 86400), repositories };
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
/** Closed native subject shape ONLY. A configuration proposal or parsed policy
 * is never adoption, qualification, selection or permission to execute. */
export function parseAutoDelegationPolicy(raw: Uint8Array): AutoDelegationPolicy {
  try {
    const r = object(structuredClone(strictJson(raw, 65536)), ["schemaVersion", "policyId", "domain", "runtime", "pairing", "goalRules", "repositories", "roles", "limits", "localEffects", "excludedEffects", "guardrails", "clock", "createdAt", "expiresAt"]);
    const d = object(r.domain, ["aiUsageRoot", "registryPath", "principal"]), runtime = object(r.runtime, ["sourceSha", "packageVersion", "storeRoot"]), pair = object(r.pairing, ["configRoot", "configRevision", "resourcesSha256", "definitionSha256"]);
    if (r.schemaVersion !== "pa-auto-delegation-policy/v1" || autoPolicyTime(r.expiresAt) <= autoPolicyTime(r.createdAt) || autoPolicyTime(r.expiresAt) - autoPolicyTime(r.createdAt) > 86400000) throw new Error();
    text(r.policyId, /^policy-[a-f0-9-]{36}$/); root(d.aiUsageRoot); root(d.registryPath); text(d.principal, /^local-uid:\d{1,20}$/); root(runtime.storeRoot); text(runtime.sourceSha, /^[a-f0-9]{40}$/); text(runtime.packageVersion, /^[a-zA-Z0-9._+-]{1,128}$/);
    root(pair.configRoot); text(pair.configRevision, /^[a-f0-9]{40}$/); text(pair.resourcesSha256, SHA256); text(pair.definitionSha256, SHA256);
    const goals = object(r.goalRules, ["timezone", "sources"]); text(goals.timezone, undefined, 128); new Intl.DateTimeFormat("en-CA", { timeZone: goals.timezone as string }).format();
    if (!Array.isArray(goals.sources) || !goals.sources.length || goals.sources.length > 4) throw new Error();
    for (const source of goals.sources) {
      const g = object(source, ["pathTemplate", "dateFormat", "heading"]), path = text(g.pathTemplate, /^daily\/[a-zA-Z0-9_./{}-]+\.md$/);
      if (path.split("{date}").length !== 2 || /[{}]/.test(path.replace("{date}", "")) || path.split("/").some(s => !s || s === "." || s === "..")) throw new Error();
      oneOf(g.dateFormat, ["iso", "underscore"]); text(g.heading, undefined, 128); if (/[\u2028\u2029]/u.test(g.heading as string)) throw new Error();
    }
    if (new Set(goals.sources.map(s => JSON.stringify(s))).size !== goals.sources.length || !Array.isArray(r.repositories) || r.repositories.length !== 2) throw new Error();
    for (const repo of r.repositories) {
      const p = object(repo, ["key", "root", "repositoryConfigSha256", "sourceScope", "checkProfileSha256", "commands"]);
      oneOf(p.key, ["pa-platform", "pa-platform-config"]); root(p.root); text(p.repositoryConfigSha256, SHA256); text(p.checkProfileSha256, SHA256); parseAutoSourceScope(p.sourceScope); list(p.commands, 1000);
    }
    if (new Set(r.repositories.map(p => (p as { key: string }).key)).size !== 2) throw new Error();
    const roles = object(r.roles, ["reasoning", "draft", "implementation"]);
    for (const kind of ["reasoning", "draft", "implementation"] as const) {
      const role = object(roles[kind], ["team", "mode", "provider", "model", "objective"]);
      const objective = object(role.objective, ["path", "sha256"]), path = text(objective.path, /^[a-zA-Z0-9_./-]+$/);
      if (path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error(); text(objective.sha256, SHA256);
      if (role.team !== (kind === "implementation" ? "builder" : "requirements")) throw new Error();
      text(role.mode, kind === "implementation" ? /^orchestrator$/ : kind === "draft" ? /^auto-draft-delegated(?:-[a-z0-9-]+)?$/ : /^auto-reasoning(?:-[a-z0-9-]+)?$/);
      text(role.provider, /^[a-z][a-z0-9-]{0,63}$/); text(role.model, /^[a-zA-Z0-9_][a-zA-Z0-9_./:-]{0,255}$/);
    }
    const limits = object(r.limits, Object.keys(AUTO_POLICY_LIMITS)); for (const [key, value] of Object.entries(AUTO_POLICY_LIMITS)) if (limits[key] !== value) throw new Error();
    if (JSON.stringify(r.localEffects) !== JSON.stringify(AUTO_POLICY_EFFECTS) || JSON.stringify(r.excludedEffects) !== JSON.stringify(AUTO_EXCLUDED_EFFECTS)) throw new Error();
    const guard = object(r.guardrails, ["repositoryProtection", "cleanupScope", "finalReview"]);
    if (guard.repositoryProtection !== "instruction-only" || guard.cleanupScope !== "observed-process-group-no-escaped-descendant-guarantee" || guard.finalReview !== "human-before-integration") throw new Error();
    const clock = object(r.clock, ["bootId", "startedNs"]); text(clock.bootId, /^[a-f0-9-]{36}$/); text(clock.startedNs, /^\d{1,30}$/);
    assertNoSensitiveMatch("content", JSON.stringify(r)); return r as unknown as AutoDelegationPolicy;
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
