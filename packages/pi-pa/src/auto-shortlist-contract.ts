import { join } from "node:path";
import {
  CommittedConfigSource, AutoWaitlistError, assertLocalFileSource, assertNoSensitiveMatch, loadTeamConfig, resolveRuntimeConfig, parseReviewEvidenceJson, workflowDigest,
} from "@pa-platform/pa-core";
import { resolvePiRuntimeConfig } from "./runtime-normalization.js";

export interface AutoGoalSource {
  pathTemplate: string; dateFormat: "iso" | "underscore"; heading: string;
}
export interface PiAutoShortlistPair {
  schemaVersion: "pa-auto-shortlist-pair/v1";
  configRoot: string; configRevision: string; resourcesSha256: string; observationScopeSha256: string;
  reasoning: { team: "requirements"; mode: string; provider: string; model: string; instructions: string; objective: { path: string; sha256: string } };
  timezone: string; goalSources: AutoGoalSource[];
  assertCurrent(): void;
}
/** New observation/producer pairing ONLY. It cannot adopt delegation, select an
 * item, grant draft/implementation effects, or widen the retained v1 pair.
 * Missing/disabled/dirty/unsupported selection fails closed; no root/model fallback. */
export function selectedPiAutoShortlistPair(): PiAutoShortlistPair {
  try {
    const source = CommittedConfigSource.selected();
    const read = (path: string) => { assertLocalFileSource(join(source.root, path)); const raw = source.read(path); if (!raw) throw new Error(); return raw; };
    const raw = read("contracts/auto-shortlist-v1.json");
    const value = parseReviewEvidenceJson(raw, "auto.shortlist.pair") as Record<string, unknown>;
    if (!value || Object.keys(value).sort().join(",") !== "enabled,goalSources,mode,resources,schemaVersion,timezone" || value.schemaVersion !== "pa-auto-shortlist-pair/v1" || value.enabled !== true
      || typeof value.mode !== "string" || !/^auto-reasoning(?:-[a-z0-9-]+)?$/.test(value.mode) || !Array.isArray(value.resources) || !value.resources.length || value.resources.length > 64
      || value.resources.some(path => typeof path !== "string") || typeof value.timezone !== "string" || value.timezone.length > 128 || !Array.isArray(value.goalSources) || !value.goalSources.length || value.goalSources.length > 4) throw new Error();
    new Intl.DateTimeFormat("en-CA", { timeZone: value.timezone }).format();
    const goalSources: AutoGoalSource[] = value.goalSources.map(value => {
      const r = value as Record<string, unknown>;
      if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "dateFormat,heading,pathTemplate" || typeof r.pathTemplate !== "string"
        || !/^daily\/[a-zA-Z0-9_./{}-]+\.md$/.test(r.pathTemplate) || r.pathTemplate.split("{date}").length !== 2
        || r.pathTemplate.replace("{date}", "").includes("{") || r.pathTemplate.replace("{date}", "").includes("}")
        || r.pathTemplate.split("/").some(p => !p || p === "." || p === "..") || !["iso", "underscore"].includes(r.dateFormat as string)
        || typeof r.heading !== "string" || !r.heading.trim() || r.heading !== r.heading.trim() || r.heading.length > 128 || /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(r.heading)) throw new Error();
      return { pathTemplate: r.pathTemplate, dateFormat: r.dateFormat as AutoGoalSource["dateFormat"], heading: r.heading };
    });
    if (new Set(goalSources.map(s => `${s.pathTemplate}:${s.heading}`)).size !== goalSources.length) throw new Error();
    read("teams/requirements.yaml");
    const team = loadTeamConfig("requirements"), modes = team.deploy_modes?.filter(mode => mode.id === value.mode) ?? [];
    if (team.name !== "requirements" || modes.length !== 1 || modes[0]!.document_profile !== undefined || !modes[0]!.objective) throw new Error();
    const mode = modes[0]!, resolved = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request: {}, team, mode }));
    if (!resolved.provider || !/^[a-z][a-z0-9-]{0,63}$/.test(resolved.provider) || !resolved.model || !/^[A-Za-z0-9_][A-Za-z0-9_./:-]{0,255}$/.test(resolved.model)) throw new Error();
    for (const path of value.resources as string[]) read(path);
    const objectiveBytes = read(mode.objective!);
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(objectiveBytes);
    if (!instructions.trim() || Buffer.byteLength(instructions) > 65_536) throw new Error();
    assertNoSensitiveMatch("content", instructions); assertNoSensitiveMatch("content", `${resolved.provider}/${resolved.model}`);
    source.assertCurrent();
    const resourcesSha256 = workflowDigest(JSON.stringify(source.resources().map(f => [f.path, f.sha256])));
    const observationScopeSha256 = workflowDigest(JSON.stringify({ contract: workflowDigest(raw), configRevision: source.revision, resourcesSha256,
      projects: ["pa-platform", "pa-platform-config"], purpose: "shortlist-only-no-selection-or-delegation", limits: { wallMs: 600_000, sourceRequests: 32, fileBytes: 131_072, contextBytes: 1_048_576, outputBytes: 1_048_576 } }));
    return { schemaVersion: "pa-auto-shortlist-pair/v1", configRoot: source.root, configRevision: source.revision, resourcesSha256, observationScopeSha256,
      reasoning: { team: "requirements", mode: mode.id, provider: resolved.provider, model: resolved.model, instructions, objective: { path: mode.objective!, sha256: workflowDigest(objectiveBytes) } }, timezone: value.timezone, goalSources, assertCurrent: () => source.assertCurrent() };
  } catch { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); }
}
