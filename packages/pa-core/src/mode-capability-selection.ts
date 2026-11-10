import { isDeepStrictEqual } from "node:util";
import { CommittedConfigSource } from "./selected-config-source.js";
import { parseTeamYamlContent } from "./yaml-parser.js";
import { createModeCapabilityBinding, ModeCapabilityError, MODE_CAPABILITY_MAX_BYTES, MODE_CAPABILITY_PROFILE, type ModeCapabilityBinding, type ModeCapabilityPolicy } from "./mode-capabilities.js";

/** Native launch owner only. No caller path, revision, environment or permission override. */
export function selectModeCapabilities(expected: ModeCapabilityPolicy, source = CommittedConfigSource.selected()): { binding: ModeCapabilityBinding; assertCurrent(): void } {
  const raw = source.read("teams/requirements.yaml");
  if (!raw || raw.byteLength > MODE_CAPABILITY_MAX_BYTES) throw new ModeCapabilityError("CAPABILITY_BINDING");
  const team = parseTeamYamlContent(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const modes = team.deploy_modes?.filter(mode => mode.id === "analyze") ?? [];
  if (team.name !== "requirements" || modes.length !== 1 || modes[0]!.document_profile !== MODE_CAPABILITY_PROFILE || !isDeepStrictEqual(modes[0]!.capability_policy, expected)) throw new ModeCapabilityError("CAPABILITY_BINDING");
  const binding = createModeCapabilityBinding(source.revision, raw, expected);
  source.assertCurrent();
  return { binding, assertCurrent: () => source.assertCurrent() };
}
