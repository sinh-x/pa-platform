import { join } from "node:path";
import { AutoWaitlistError, CommittedConfigSource, loadTeamConfig, resolveRuntimeConfig, resolveDeployMode, parseReviewEvidenceJson, assertLocalFileSource, assertNoSensitiveMatch, workflowDigest } from "@pa-platform/pa-core";
import { resolvePiRuntimeConfig } from "./runtime-normalization.js";

export interface PiAutoDelegatedPair {
  schemaVersion: "pa-auto-delegated-pair/v1"; configRoot: string; configRevision: string; resourcesSha256: string;
  policySource: string; policyBytes: Uint8Array;
  draft: { team: "requirements"; mode: string; provider: string; model: string; instructions: string };
  implementation: { team: "builder"; mode: "orchestrator"; provider: string; model: string };
  assertCurrent(): void;
}
/** NEW finite delegated route. Pair selection is not policy adoption, caller
 * authentication, a ticket choice or launch authority. Old pairs stay intact. */
export function selectedPiAutoDelegatedPair(): PiAutoDelegatedPair {
  try {
    const source = CommittedConfigSource.selected();
    const read = (path: string) => { assertLocalFileSource(join(source.root, path)); const raw = source.read(path); if (!raw) throw new Error(); return raw; };
    const value = parseReviewEvidenceJson(read("contracts/auto-delegated-v1.json"), "auto.delegated.pair") as Record<string, unknown>;
    if (!value || Object.keys(value).sort().join(",") !== "draftMode,enabled,policySource,resources,schemaVersion" || value.schemaVersion !== "pa-auto-delegated-pair/v1" || value.enabled !== true
      || typeof value.draftMode !== "string" || !/^auto-draft-delegated(?:-[a-z0-9-]+)?$/.test(value.draftMode) || typeof value.policySource !== "string"
      || !/^policies\/[a-z0-9_./-]+\.json$/.test(value.policySource) || value.policySource.split("/").some(p => !p || p === "." || p === "..")
      || !Array.isArray(value.resources) || !value.resources.length || value.resources.length > 64 || value.resources.some(path => typeof path !== "string")) throw new Error();
    read("teams/requirements.yaml"); read("teams/builder.yaml");
    const requirements = loadTeamConfig("requirements"), builder = loadTeamConfig("builder"), modes = requirements.deploy_modes?.filter(mode => mode.id === value.draftMode) ?? [];
    const implementationMode = resolveDeployMode(builder, "orchestrator");
    if (requirements.name !== "requirements" || builder.name !== "builder" || modes.length !== 1 || !modes[0]!.objective || modes[0]!.document_profile !== undefined || !implementationMode) throw new Error();
    const draftConfig = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request: {}, team: requirements, mode: modes[0]! }));
    const implementationConfig = resolvePiRuntimeConfig(resolveRuntimeConfig({ runtime: "pi", request: {}, team: builder, mode: implementationMode }));
    for (const config of [draftConfig, implementationConfig]) if (!config.provider || !/^[a-z][a-z0-9-]{0,63}$/.test(config.provider) || !config.model || !/^[A-Za-z0-9_][A-Za-z0-9_./:-]{0,255}$/.test(config.model)) throw new Error();
    for (const path of value.resources as string[]) read(path);
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(read(modes[0]!.objective!)), policyBytes = read(value.policySource);
    if (!instructions.trim() || Buffer.byteLength(instructions) > 65_536 || policyBytes.length > 65_536) throw new Error();
    assertNoSensitiveMatch("content", instructions); assertNoSensitiveMatch("content", new TextDecoder("utf-8", { fatal: true }).decode(policyBytes));
    source.assertCurrent();
    return { schemaVersion: "pa-auto-delegated-pair/v1", configRoot: source.root, configRevision: source.revision,
      resourcesSha256: workflowDigest(JSON.stringify(source.resources().map(f => [f.path, f.sha256]))), policySource: value.policySource, policyBytes,
      draft: { team: "requirements", mode: modes[0]!.id, provider: draftConfig.provider!, model: draftConfig.model!, instructions },
      implementation: { team: "builder", mode: "orchestrator", provider: implementationConfig.provider!, model: implementationConfig.model! }, assertCurrent: () => source.assertCurrent() };
  } catch { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); }
}
