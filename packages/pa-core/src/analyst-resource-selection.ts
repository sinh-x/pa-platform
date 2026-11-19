import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Lexer, walkTokens } from "marked";
import { MODE_CAPABILITY_MAX_BYTES, MODE_CAPABILITY_PROFILE, ModeCapabilityError, READONLY_DOCUMENT_PROFILE, hasModeResources, modePublicName, ANALYST_NATIVE_IDENTITY, modeResourcePath, parseModeCapabilityBinding, type ModeCapabilityPolicy, type ModeResourceSnapshot } from "./mode-capabilities.js";
import { CommittedConfigSource } from "./selected-config-source.js";
import type { TeamConfig } from "./types.js";
import { parseTeamYamlContent } from "./yaml-parser.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const deny = (): never => { throw new ModeCapabilityError("CAPABILITY_BINDING"); };
function decode(raw: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return deny(); } }
/** One source, no contract-manifest authority, selected-root overlay or directory discovery. */
export function selectAnalystResources(expected: ModeCapabilityPolicy, source: CommittedConfigSource, selection: { team: TeamConfig; repoKey: string; mode?: string }) {
  const generic = selection.mode !== undefined && selection.team.deploy_modes?.some(mode => mode.id === selection.mode && mode.document_profile === READONLY_DOCUMENT_PROFILE);
  const resourcePath = generic ? `teams/${modePublicName(selection.team.name)}.yaml` : "teams/analyst.yaml";
  const raw = source.read(resourcePath);
  if (!raw || raw.byteLength > MODE_CAPABILITY_MAX_BYTES) return deny();
  const team = parseTeamYamlContent(decode(raw)), modes = team.deploy_modes?.filter(mode => mode.id === (generic ? selection.mode : "analyze")) ?? [], mode = modes[0];
  if ((!generic && team.name !== "analyst") || !isDeepStrictEqual(team, selection.team) || modes.length !== 1 || !mode
    || mode.document_profile !== (generic ? READONLY_DOCUMENT_PROFILE : MODE_CAPABILITY_PROFILE) || !isDeepStrictEqual(mode.capability_policy, expected)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(selection.repoKey)) return deny();
  const contents = new Map<string, string>([[resourcePath, decode(raw)]]), pending = new Set<string>();
  const add = (path: unknown) => { pending.add(modeResourcePath(path)); if (pending.size + contents.size > 128) deny(); };
  // Public v2 requires a real objective resource, never an inline/path fallback.
  add(mode.objective);
  const agents = mode.agents ?? team.agents.map(agent => agent.name);
  if (!Array.isArray(agents) || agents.length > 64 || new Set(agents).size !== agents.length) return deny();
  for (const name of agents) {
    const matching = team.agents.filter(agent => agent.name === name);
    if (matching.length !== 1) return deny();
    if (matching[0]!.instruction !== undefined) add(matching[0]!.instruction);
    if (matching[0]!.skill !== undefined) add(`skills/global/${modeResourcePath(matching[0]!.skill)}/SKILL.md`);
  }
  for (const list of [team.global_docs ?? [], mode.global_docs ?? [], mode.project_guides?.[selection.repoKey] ?? []]) {
    if (!Array.isArray(list) || list.length > 64) return deny();
    for (const path of list) add(path);
  }
  if (!Array.isArray(mode.skills ?? []) || (mode.skills?.length ?? 0) > 64) return deny();
  for (const skill of mode.skills ?? []) {
    if (!["global-skill", "shared-skill", "reference"].includes(skill["inject-as"])) return deny();
    add(`skills/global/${modeResourcePath(skill.name)}/SKILL.md`);
  }
  // Follow Markdown destinations (including reference definitions) and explicit
  // repository-root resource locators in code spans. Never execute/fetch links.
  while (pending.size) {
    const path = pending.values().next().value!; pending.delete(path);
    if (contents.has(path)) continue;
    const bytes = source.read(path); if (!bytes) return deny();
    const body = decode(bytes); contents.set(path, body);
    const reference = (href: string) => {
      if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
      const clean = href.split("#", 1)[0]!;
      if (!clean || clean.startsWith("/") || /[%?\\\s]/.test(clean)) return deny();
      const target = /^(?:docs|skills|primers|teams|contracts)\//.test(clean) ? clean : posix.join(posix.dirname(path), clean);
      add(target);
    };
    if (/\.(md|txt)$/.test(path)) {
      walkTokens(Lexer.lex(body), token => { if (token.type === "link" || token.type === "image") reference(token.href); });
      for (const match of body.matchAll(/`((?:skills|docs|primers)\/[A-Za-z0-9_./-]+\.(?:md|json|yaml|txt))`/g)) reference(match[1]!);
    }
  }
  const resources = source.resources().filter(file => contents.has(file.path)).map(({ path, sha256 }) => ({ path, sha256 }));
  const binding = parseModeCapabilityBinding({ schemaVersion: generic ? "pa-mode-capability-binding/v3" : "pa-mode-capability-binding/v2", configRoot: source.root, configRevision: source.revision,
    resourcePath, resourceSha256: hash(raw), profile: mode.document_profile, policy: expected, repoKey: selection.repoKey,
    identity: generic ? { publicTeam: team.name, publicMode: mode.id, effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" } : ANALYST_NATIVE_IDENTITY, resources });
  if (!hasModeResources(binding)) return deny();
  const snapshot: ModeResourceSnapshot = Object.freeze({ binding, read(path: string) {
    const body = contents.get(path), expected = binding.resources.find(resource => resource.path === path);
    if (body === undefined || !expected || hash(Buffer.from(body)) !== expected.sha256) return deny();
    return body;
  } });
  source.assertCurrent();
  return { binding, resources: snapshot, assertCurrent: () => source.assertCurrent() };
}
