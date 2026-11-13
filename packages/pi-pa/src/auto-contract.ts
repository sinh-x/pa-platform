import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CommittedConfigSource, AutoWaitlistError, loadTeamConfig, resolveDeployMode, resolveRuntimeConfig,
  parseReviewEvidenceJson, type AutoItem,
} from "@pa-platform/pa-core";
import { resolvePiRuntimeConfig } from "./runtime-normalization.js";

export const AUTO_PAIR_VERSION = "pa-auto-pair/v1" as const;
export interface PiAutoPair {
  schemaVersion: typeof AUTO_PAIR_VERSION; configRoot: string; configRevision: string; resourcesSha256: string;
  producer: "pa-auto-draft/v1"; review: "pa-auto-start/v1"; draftInstructions: string;
  draft: { team: "requirements"; mode: string; provider: string; model: string };
  implementation: { team: "builder"; mode: "orchestrator"; provider: string; model: string };
  assertCurrent(): void;
}
/** Committed explicit pairing only. Config metadata enables no per-ticket grant.
 * No alternate config/root/model, retained-profile upgrade or automatic activation. */
export function selectedPiAutoPair(): PiAutoPair {
  try {
    const source = CommittedConfigSource.selected();
    const r = parseReviewEvidenceJson(source.read("contracts/auto-waitlist-v1.json")!, "auto.pair") as Record<string, unknown>;
    if (!r || Object.keys(r).sort().join(",") !== ["schemaVersion", "producer", "review", "draftMode", "resources", "enabled"].sort().join(",")
      || r.schemaVersion !== AUTO_PAIR_VERSION || r.producer !== "pa-auto-draft/v1" || r.review !== "pa-auto-start/v1" || r.enabled !== true
      || typeof r.draftMode !== "string" || !/^auto-draft(?:-[a-z0-9-]+)?$/.test(r.draftMode)
      || !Array.isArray(r.resources) || !r.resources.length || r.resources.length > 64 || r.resources.some(p => typeof p !== "string")) throw new Error();
    for (const name of ["requirements", "builder"]) source.read(`teams/${name}.yaml`);
    for (const path of r.resources as string[]) source.read(path);
    const resolve = (teamName: string, modeName: string) => {
      const team = loadTeamConfig(teamName), mode = resolveDeployMode(team, modeName);
      if (!mode || mode.id !== modeName || !mode.provider || !mode.model) throw new Error();
      // The producer is a new data-only route, not analyze or analyze-auto.
      if (teamName === "requirements" && mode.document_profile !== undefined) throw new Error();
      const config = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request: {}, team, mode }));
      if (!config.provider || !config.model) throw new Error();
      if (mode.objective) source.read(mode.objective);
      return { provider: config.provider, model: config.model };
    };
    const draft = resolve("requirements", r.draftMode), implementation = resolve("builder", "orchestrator");
    const draftMode = resolveDeployMode(loadTeamConfig("requirements"), r.draftMode);
    if (!draftMode?.objective) throw new Error();
    const draftInstructions = new TextDecoder("utf-8", { fatal: true }).decode(source.read(draftMode.objective)!);
    source.assertCurrent();
    const resourcesSha256 = createHash("sha256").update(JSON.stringify(source.resources().map(f => [f.path, f.sha256]))).digest("hex");
    return { schemaVersion: AUTO_PAIR_VERSION, configRoot: source.root, configRevision: source.revision, resourcesSha256,
      producer: "pa-auto-draft/v1", review: "pa-auto-start/v1", draftInstructions, draft: { team: "requirements", mode: r.draftMode, ...draft },
      implementation: { team: "builder", mode: "orchestrator", ...implementation }, assertCurrent: () => source.assertCurrent() };
  } catch { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); }
}
export function autoDraftDirectory(root: string, item: AutoItem): string {
  if (!item.draft) throw new AutoWaitlistError("AUTO_STORE");
  return join(root, "agent-teams/requirements/artifacts/drafts", item.draft.deploymentId);
}
