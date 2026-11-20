import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { CommittedConfigSource } from "./selected-config-source.js";
import { hasModeResources, ModeCapabilityError, modePublicName, modeResourcePath, parseModeCapabilityBinding, type ModeCapabilityBinding, type ModeResourceSnapshot } from "./mode-capabilities.js";

export const SELECTED_PRIMER_BUDGET_PATH = "primers/budgets.yaml";
export const SELECTED_RESOURCE_PREFIX = "selected-resource:";
const deny = (): never => { throw new ModeCapabilityError("CAPABILITY_BINDING"); };
/** Read permission and live session authentication remain the adapter's responsibility.
 * Membership is checked before I/O; neither links nor reads extend this inventory. */
export function readSelectedModeResource(input: ModeCapabilityBinding, path: string): string {
  const binding = parseModeCapabilityBinding(input);
  if (!hasModeResources(binding)) return deny();
  const resource = binding.resources.find(entry => entry.path === modeResourcePath(path));
  if (!resource) throw new ModeCapabilityError("CAPABILITY_OMITTED");
  try {
    const raw = CommittedConfigSource.readPinned(binding.configRoot, binding.configRevision, resource.path);
    if (createHash("sha256").update(raw).digest("hex") !== resource.sha256) return deny();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch { return deny(); }
}
/** Only a fresh native snapshot opts in to lean composition. Retained snapshots
 * keep full capture/static budgets even if they happen to contain budget metadata. */
export function selectedPrimerBudget(resources: ModeResourceSnapshot): number | undefined {
  if (!resources.leanPrimer) return undefined;
  const binding = resources.binding;
  if (binding.schemaVersion !== "pa-mode-capability-binding/v3" || binding.identity.publicTeam !== "analyst") return deny();
  const resource = binding.resources.find(entry => entry.path === SELECTED_PRIMER_BUDGET_PATH);
  if (!resource) return deny();
  const body = resources.read(SELECTED_PRIMER_BUDGET_PATH);
  if (createHash("sha256").update(body).digest("hex") !== resource.sha256) return deny();
  return parseSelectedPrimerBudget(body, binding.identity.publicTeam, binding.identity.publicMode);
}
export function parseSelectedPrimerBudget(body: string, team: string, mode: string): number {
  try {
    if (Buffer.byteLength(body) > 65_536) return deny();
    const value: unknown = yaml.load(body, { schema: yaml.JSON_SCHEMA });
    if (!value || typeof value !== "object" || Array.isArray(value)) return deny();
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).sort().join(",") !== "$schema,contractVersion,defaultMax,kind,modes,unit"
      || raw.$schema !== "contracts/schemas/primer-budgets.schema.json" || raw.kind !== "pa-primer-budgets" || raw.contractVersion !== "1.0.0" || raw.unit !== "lines"
      || !validMax(raw.defaultMax) || !Array.isArray(raw.modes) || raw.modes.length > 128) return deny();
    const seen = new Set<string>(); let selected: number | undefined;
    for (const row of raw.modes) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "max,mode,team") return deny();
      const entry = row as Record<string, unknown>, key = `${modePublicName(entry.team)}/${modePublicName(entry.mode)}`;
      if (seen.has(key) || !validMax(entry.max)) return deny();
      seen.add(key); if (entry.team === team && entry.mode === mode) selected = entry.max;
    }
    // Do not label a missing selected pair with a guessed/default 9,000.
    return selected ?? deny();
  } catch { return deny(); }
}
function validMax(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000; }
